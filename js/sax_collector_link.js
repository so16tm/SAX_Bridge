/**
 * sax_collector_link.js — Collector 入力リンク維持の app 非依存ロジック
 *
 * makeSourceListWidget (sax_ui_base.js) の内部実装拡張。`app` に依存しない純粋関数を
 * 切り出し、Collector 系の「意図しないリンク切断」恒久対策 (B1/B2/B3) の中核ロジックを
 * 単体テスト可能にする。新規共通基盤 public API ではなく、makeSourceListWidget 内部から
 * 利用される framework 内部実装に分類する (docs/spec/canvas-ui.md には API 表面を追加しない)。
 *
 * 設計根拠: docs/plans/20260613-dynamic-slot-disconnect-permanent-fix.md
 *   - B1: ノード削除イベント駆動 + 遅延再確認 (一時 null では削除しない)
 *   - B2: 入力リンク再接続を位置 index から (name, type, originalSlotIndex) 複合アンカーへ
 *   - B3: NodeCollector 出力 resolver の identity アンカー共有
 *
 * Exports:
 *   sourceSignature(srcNode)                          — 座標非依存・出力構造依存の署名
 *   buildInputAnchors(srcNode, slotIndices)           — 複合アンカー配列を生成
 *   resolveAnchorToOutputSlot(srcNode, anchor)        — アンカーを現在の出力スロットへ段階解決
 *   resolveAnchorsToOutputSlots(srcNode, anchors)     — 複数アンカーを一括解決
 *   reconcileRemoval(removedId, sources, getNodeById) — B1 遅延再確認 (掃除対象 index を降順で返す)
 *   reconcileAllRemoved(sources, getNodeById)         — B1 全 source 走査版 (複数同時削除を網羅)
 *   partitionLiveSources(sources, getNodeById)        — sig rebuild の一時 null 温存分割
 *   mergeSourceAnchors(oldSource, newSource)          — H-1 rebuild 時の identity アンカー引継ぎ
 *   rebuildLiveSources({...})                         — H-1/H-3 rebuild の app 非依存中核 (live 再構築 + anchor 引継ぎ + missing 温存)
 *   resolveLocalSlotBySlotName(entity, name, gi)      — NodeCollector 下流リンク復元の段階1 resolver (同名出力を globalSlotIdx で判別)
 *   remapSlotIdentity(old, freshNames, freshTypes)    — 上流の出力増減/並べ替え時に旧スロットの identity を新出力へ対応付ける
 *   translateGlobalSlotIdx(entity, gi)                — rebuild 前の global index を rebuild 後の index へ写す (除去は -1)
 */

/**
 * ソースノードの出力構造から署名を生成する。座標 (pos) は含めない。
 * 出力スロットの改名/型変更/増減でのみ変化する。
 *
 * @param {{ outputs?: Array<{ name?: string, label?: string, type?: string }> }} srcNode
 * @returns {string}
 */
export function sourceSignature(srcNode) {
    return (srcNode?.outputs ?? [])
        .map(o => `${o.label ?? o.name ?? ""}:${o.type ?? ""}`)
        .join(",");
}

/**
 * 上流出力の identity アンカーを生成する。
 *
 * アンカーは (name, type, originalSlotIndex) の複合。同名出力衝突 (O-4) に備え
 * originalSlotIndex を保持し、上流改名/並べ替え/増減時の段階解決に用いる。
 * 初回作成時に保存し、rebuild で上書きしない (Plan 論点3)。
 *
 * @param {{ outputs?: Array<{ name?: string, label?: string, type?: string }> }} srcNode
 * @param {number[]} slotIndices  アンカー対象の上流出力 global index 配列
 * @returns {Array<{ name: string, type: string, originalSlotIndex: number }>}
 */
export function buildInputAnchors(srcNode, slotIndices) {
    const outputs = srcNode?.outputs ?? [];
    const anchors = [];
    for (const gi of slotIndices) {
        const out = outputs[gi];
        if (!out) continue;  // 範囲外は除外
        anchors.push({
            name: out.label ?? out.name ?? "",
            type: out.type ?? "*",
            originalSlotIndex: gi,
        });
    }
    return anchors;
}

/** 出力スロットの表示名 (label 優先・なければ name)。 */
function _outName(out) {
    return out?.label ?? out?.name ?? "";
}

/**
 * 保存済みアンカーを、上流ノードの現在の出力スロット index へ段階解決する。
 *
 * 段階1: name+type 一致 (複数一致時は originalSlotIndex に最も近いものを選ぶ)
 * 段階2: name のみ一致 (type 改名に追従)
 * 段階3: originalSlotIndex 位置 (name 改名に追従。位置が範囲内のときのみ)
 *
 * いずれも解決できない場合は null (誤接続を避け接続をスキップ。呼出側が console.warn する)。
 *
 * @param {{ outputs?: Array<object> }} srcNode
 * @param {{ name: string, type: string, originalSlotIndex: number } | null} anchor
 * @returns {{ slotIndex: number, fallback: "name+type" | "name" | "position" } | null}
 */
export function resolveAnchorToOutputSlot(srcNode, anchor) {
    if (!anchor) return null;
    const outputs = srcNode?.outputs ?? [];
    const { name, type, originalSlotIndex } = anchor;

    // 段階1: name + type 一致
    const nameTypeMatches = [];
    for (let i = 0; i < outputs.length; i++) {
        if (_outName(outputs[i]) === name && (outputs[i].type ?? "*") === type) {
            nameTypeMatches.push(i);
        }
    }
    if (nameTypeMatches.length > 0) {
        // 複数一致時は originalSlotIndex に最も近いものを選ぶ (同名出力衝突 O-4)
        const best = nameTypeMatches.reduce((a, b) =>
            Math.abs(b - originalSlotIndex) < Math.abs(a - originalSlotIndex) ? b : a);
        return { slotIndex: best, fallback: "name+type" };
    }

    // 段階2: name のみ一致 (type 改名)
    for (let i = 0; i < outputs.length; i++) {
        if (_outName(outputs[i]) === name) {
            return { slotIndex: i, fallback: "name" };
        }
    }

    // 段階3: originalSlotIndex 位置 (name 改名・位置維持)
    if (originalSlotIndex != null && originalSlotIndex >= 0 && originalSlotIndex < outputs.length) {
        return { slotIndex: originalSlotIndex, fallback: "position" };
    }

    return null;
}

/**
 * 複数アンカーを一括で現在の出力スロットへ解決する。解決順 (アンカー順) を保つ。
 *
 * @param {{ outputs?: Array<object> }} srcNode
 * @param {Array<{ name, type, originalSlotIndex } | null>} anchors
 * @returns {Array<{ slotIndex: number, fallback: string } | null>}
 */
export function resolveAnchorsToOutputSlots(srcNode, anchors) {
    return (anchors ?? []).map(a => resolveAnchorToOutputSlot(srcNode, a));
}

/**
 * B1 遅延再確認: ノード削除イベントを受けた後、依然 getNodeById が null の
 * source のみを掃除対象として返す。undo/redo/サブグラフ折畳で同 id が即復活した
 * 場合は対象から除外する。
 *
 * splice 安全のため index を降順で返す。
 *
 * @internal 単体テスト補助。プロダクション (sax_ui_base.js) は id 非依存・全走査の
 *           `reconcileAllRemoved` を使う (同フレームの複数同時削除を網羅するため)。
 * @param {number|string} removedId  削除イベントの対象ノード id
 * @param {Array<{ sourceId: number|string }>} sources  Collector の _remoteSources
 * @param {(id: number|string) => (object|null)} getNodeById  再確認用 (app.graph.getNodeById)
 * @returns {number[]}  掃除対象 source index (降順)
 */
export function reconcileRemoval(removedId, sources, getNodeById) {
    const out = [];
    const list = sources ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
        const src = list[i];
        if (src?.sourceId !== removedId) continue;
        // 依然 null の時のみ掃除 (復活していれば取り消す)
        if (getNodeById(src.sourceId) == null) out.push(i);
    }
    return out;
}

/**
 * B1 全 source 走査版 (H-2): 削除イベントの id に依存せず、Collector の全 source を
 * 走査して getNodeById が依然 null のものを掃除対象として返す。同フレームで複数の
 * 上流ノードが削除されてもゾンビ source を取りこぼさない。
 *
 * splice 安全のため index を降順で返す。
 *
 * @param {Array<{ sourceId: number|string }>} sources  Collector の _remoteSources
 * @param {(id: number|string) => (object|null)} getNodeById  再確認用 (app.graph.getNodeById)
 * @returns {number[]}  掃除対象 source index (降順)
 */
export function reconcileAllRemoved(sources, getNodeById) {
    const out = [];
    const list = sources ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
        const src = list[i];
        if (src == null) continue;
        // 依然 null の時のみ掃除 (復活していれば取り消す)
        if (getNodeById(src.sourceId) == null) out.push(i);
    }
    return out;
}

/**
 * H-1: rebuild 時に旧 source の identity (inputAnchors / slotNames / slotTypes) を
 * 新 source へ index 対応で引き継ぐ。buildSource は常に現在の srcNode から fresh に
 * アンカーを構築するため、改名追従の基準となる「初回接続時の identity」を保つには
 * rebuild 経路でこのマージが必須となる。
 *
 * マージ規則 (Plan H-1 / M-4):
 *   - 旧 source が無い (初回 addSource) 場合は newSource をそのまま返す (fresh が正)。
 *   - inputAnchors: 既存 index 分は旧アンカーを保持、増分 (M-4) は新 fresh を充てる。
 *     旧が現在の slot 数より多い場合は切り詰める。
 *   - slotNames / slotTypes (NodeCollector) は対象外。出力の増減/並べ替えで index がずれるため、
 *     buildSource 側で remapSlotIdentity により identity を対応付ける。
 *
 * 新オブジェクトを返さず newSource を in-place 更新する (Coordinator の entity identity を
 * 壊さないため。makeSourceListWidget は _addSourceInner で新 source を push 済みであり、
 * この関数はその push 済みオブジェクトのアンカー系フィールドのみを書き換える)。
 *
 * @param {object|null|undefined} oldSource  旧 source (savedSources の同 sourceId)
 * @param {object} newSource                 buildSource が fresh 生成した新 source (in-place 更新対象)
 * @returns {object} newSource (引継ぎ後)
 */
export function mergeSourceAnchors(oldSource, newSource) {
    if (!oldSource || !newSource) return newSource;

    newSource.inputAnchors = _mergeIndexed(oldSource.inputAnchors, newSource.inputAnchors);

    // slotNames / slotTypes (NodeCollector) は index 対応ではマージしない。上流の出力が
    // 途中で増減/並べ替えされると index がずれ、旧名を index で温存すると別スロットの
    // identity を引き継いでしまう。identity の引継ぎは buildSource が remapSlotIdentity で行う。
    return newSource;
}

/**
 * 「既存 index 分は旧を保持・増分は新 fresh・旧超過分は切り詰め」で配列をマージする。
 * 旧 / 新いずれかが配列でない場合はもう一方 (配列なら) を返す。
 *
 * @param {Array|undefined} oldArr
 * @param {Array|undefined} newArr  現スロット数に対応する fresh 配列 (長さの基準)
 * @returns {Array|undefined}
 */
function _mergeIndexed(oldArr, newArr) {
    if (!Array.isArray(newArr)) return Array.isArray(oldArr) ? oldArr : newArr;
    if (!Array.isArray(oldArr)) return newArr;
    // newArr の長さ (= 現在のスロット数) に合わせ、既存分は旧、増分は新を採用する。
    return newArr.map((freshVal, i) => (i < oldArr.length ? oldArr[i] : freshVal));
}

/**
 * sig rebuild 時の一時 null 温存 (B1 拡張): source を「上流が生存している (live)」と
 * 「一時 null (missing)」に分割する。呼出側は live のみ rebuild し、missing の入力
 * スロット/リンクは温存する (「ユーザーが消した時以外は消さない」を rebuild 経路にも適用)。
 *
 * @param {Array<{ sourceId: number|string }>} sources
 * @param {(id: number|string) => (object|null)} getNodeById
 * @returns {{ live: object[], missing: object[] }}
 */
export function partitionLiveSources(sources, getNodeById) {
    const live = [];
    const missing = [];
    for (const src of (sources ?? [])) {
        if (getNodeById(src.sourceId) != null) live.push(src);
        else missing.push(src);
    }
    return { live, missing };
}

/**
 * rebuild で fresh 生成した source を、**旧 source オブジェクトへ in-place で取り込む**。
 *
 * DynamicSlotCoordinator は entity (= source オブジェクト) の **参照** を WeakMap のキーに
 * して capture 済みリンクを解決する。rebuild で `buildSource` の戻り値 (新オブジェクト) を
 * そのまま `_remoteSources` に戻すと entity identity が毎回破壊され、Coordinator は
 * 「全 entity が削除された」と解釈して下流リンクを 1 本も復元できない。
 * 旧オブジェクトを器として使い回すことで、rebuild を挟んでも identity が保たれる
 * (TextCatalog / PrimitiveStore の in-place 更新と同型)。
 *
 * 取り込み規則:
 *   - アンカー系 (inputAnchors) は mergeSourceAnchors の規則で引継ぐ。
 *   - fresh が持たないキー (前回の sig / _connectRetries 等) は削除し、fresh の状態と一致させる
 *     (旧状態の残留による判定ズレを防ぐ)。
 *   - 旧 / fresh いずれかが無い場合は存在するほうをそのまま返す (初回 addSource は fresh が正)。
 *
 * @param {object|null|undefined} oldSource    rebuild 前の source (identity の器)
 * @param {object|null|undefined} freshSource  buildSource が生成した新 source
 * @returns {object} identity を保った source (oldSource があれば oldSource 自身)
 */
export function adoptSourceIdentity(oldSource, freshSource) {
    if (!oldSource || !freshSource) return freshSource ?? oldSource;
    if (oldSource === freshSource) return oldSource;

    mergeSourceAnchors(oldSource, freshSource);

    for (const key of Object.keys(oldSource)) {
        if (!Object.prototype.hasOwnProperty.call(freshSource, key)) delete oldSource[key];
    }
    Object.assign(oldSource, freshSource);
    return oldSource;
}

/**
 * H-1/H-3 rebuild の app 非依存中核ロジック。
 *
 * 保存済み source 配列を走査し、上流が live なものだけを `buildSourceFn` で fresh 再構築し、
 * 旧 source から identity アンカー (inputAnchors) を index 対応で
 * 引き継ぐ (mergeSourceAnchors)。上流が一時 null (missing) の source は再構築せず温存する
 * (H-3: missing があっても live の rebuild を凍結しない)。
 *
 * 本関数は `app` / LiteGraph に依存せず、純粋に「保存 source → 再構築後 source 配列」変換を
 * 行う。makeSourceListWidget 側はこの結果に基づき addInput / connectSource 等の副作用を行う。
 * これにより buildSource → rebuild merge 統合経路を単体テスト可能にする (今回の検出漏れ対策)。
 *
 * 注意 (offset セマンティクスの差異): 本関数は missing を offset 計算から除外する (詰める)。
 * 一方プロダクションの `sax_ui_base.js:rebuildAllSources` は missing 分も空スロットを物理生成し
 * offset に含める (詰めない)。本関数は merge/解決ロジックの単体検証用であり、プロダクション rebuild の
 * offset 実体とは意味が異なる。プロダクション rebuild に流用しないこと。
 *
 * @param {{
 *   savedSources: object[],                              // rebuild 前の source 配列
 *   getNodeById:  (id) => (object|null),                 // 上流ノード解決
 *   buildSourceFn:(srcNode, offset) => (object|null),    // fresh source 生成 (app 非依存に呼べる形)
 *   getSlotCount: (src) => number,                       // source 1 件のスロット数
 * }} args
 * @returns {{
 *   rebuilt: Array<{ source: object, srcNode: object, offset: number }>,  // live: 再構築 + offset
 *   missing: object[],                                                    // 一時 null で温存する source
 * }}
 */
export function rebuildLiveSources({ savedSources, getNodeById, buildSourceFn, getSlotCount }) {
    const rebuilt = [];
    const missing = [];
    let offset = 0;
    for (const oldSource of (savedSources ?? [])) {
        const srcNode = getNodeById(oldSource.sourceId);
        if (srcNode == null) {
            // 一時 null: 再構築せず温存 (offset には寄与させない=詰める)。
            missing.push(oldSource);
            continue;
        }
        let fresh;
        try {
            fresh = buildSourceFn(srcNode, offset);
        } catch (e) {
            // buildSource 失敗時は当該 source をスキップ (他の live は継続)。
            console.warn("[sax_collector_link] buildSourceFn error:", e);
            continue;
        }
        if (!fresh) continue;
        // identity の器は旧 source。プロダクション rebuild (_addSourceInner) と同じ
        // in-place 取り込みにすることで、Coordinator の entity identity 前提を本経路でも保つ。
        const adopted = adoptSourceIdentity(oldSource, fresh);
        rebuilt.push({ source: adopted, srcNode, offset });
        offset += getSlotCount(adopted);
    }
    return { rebuilt, missing };
}

/**
 * 上流の出力が増減/並べ替えされたとき、旧スロット (index) の identity を新しい出力へ対応付ける。
 *
 * 旧 identity (name/type) を index で温存すると、途中に出力が挿入/削除された時点で
 * 以降のスロットがすべて別の出力の identity を名乗り、後続スロットの下流リンクが切れる。
 * 対応付けは「name+type 一致 → name 一致 → 同一位置」の順に、旧スロットの昇順で
 * 未使用の新出力から最も近いものを 1 対 1 で選ぶ。対応先のない旧スロットは「除去された」とみなす。
 *
 * 戻り値:
 *   - slotNames / slotTypes: 対応付いた新出力は旧 identity を保持し、新規出力は fresh を採用
 *   - enabledSlots: 有効だった旧スロットの対応先 + 新規出力 (新スロットは既定で有効)
 *   - remap: 旧 global index → 新 global index (除去は -1)。下流リンク復元の index 写像に使う
 *
 * @param {{ names: string[], types: string[], enabledSlots: number[] }} old  rebuild 前の identity と有効スロット
 * @param {string[]} freshNames  現在の上流出力名
 * @param {string[]} freshTypes  現在の上流出力型
 * @returns {{ slotNames: string[], slotTypes: string[], enabledSlots: number[], remap: number[] }}
 */
export function remapSlotIdentity(old, freshNames, freshTypes) {
    const oldNames = old?.names ?? [];
    const oldTypes = old?.types ?? [];
    const n = freshNames.length;
    const used = new Array(n).fill(false);
    const remap = new Array(oldNames.length).fill(-1);

    const nearestUnused = (i, accept) => {
        let best = -1;
        for (let j = 0; j < n; j++) {
            if (used[j] || !accept(j)) continue;
            if (best < 0 || Math.abs(j - i) < Math.abs(best - i)) best = j;
        }
        return best;
    };
    const assign = (accept) => {
        for (let i = 0; i < oldNames.length; i++) {
            if (remap[i] >= 0) continue;
            const j = nearestUnused(i, (jj) => accept(i, jj));
            if (j >= 0) { remap[i] = j; used[j] = true; }
        }
    };
    assign((i, j) => freshNames[j] === oldNames[i] && freshTypes[j] === oldTypes[i]);
    assign((i, j) => freshNames[j] === oldNames[i]);
    assign((i, j) => j === i);   // 改名: 位置が同じ未対応の出力

    const slotNames = freshNames.slice();
    const slotTypes = freshTypes.slice();
    const enabled = new Set();
    for (let j = 0; j < n; j++) if (!used[j]) enabled.add(j);   // 新規出力は既定で有効
    for (const oi of (old?.enabledSlots ?? [])) {
        if (remap[oi] >= 0) enabled.add(remap[oi]);
    }
    remap.forEach((j, i) => {
        if (j < 0) return;
        slotNames[j] = oldNames[i];
        slotTypes[j] = oldTypes[i];
    });
    return {
        slotNames,
        slotTypes,
        enabledSlots: [...enabled].sort((a, b) => a - b),
        remap,
    };
}

/**
 * rebuild 前に捕捉した global index を、rebuild 後の index へ写す。
 * entity._slotRemap (remapSlotIdentity の remap) が無ければ恒等。除去されたスロットは -1。
 *
 * @param {{ _slotRemap?: number[] }} entity
 * @param {number | null} globalSlotIdx
 * @returns {number | null}  null は入力が null (index 情報なし)
 */
export function translateGlobalSlotIdx(entity, globalSlotIdx) {
    if (globalSlotIdx == null) return null;
    const remap = entity?._slotRemap;
    if (!Array.isArray(remap)) return globalSlotIdx;
    const mapped = remap[globalSlotIdx];
    return mapped == null ? -1 : mapped;
}

/**
 * NodeCollector 出力リンク復元の段階1 resolver: 出力名 → entity 内 localSlotIdx。
 *
 * 上流ノードは同名の出力を複数持ちうる (例: 2 つの "IMAGE")。`slotNames.indexOf` だけだと
 * 常に最初の一致へ解決され、同名の 2 本目以降のリンクが 1 本目のピンへ寄って
 * 並べ替え/再構築のたびに下流が誤接続・断線する。capture 時に記録した globalSlotIdx
 * (= その出力が元いた entity 内の位置) が分かる場合は、同名一致のうちそれに最も近いものを選ぶ。
 * globalSlotIdx が一致候補に含まれていればそれ自身が選ばれる。
 *
 * 選んだ global index が enabledSlots に無い (スロット選択で解除された) 場合は null を返し、
 * 呼出側 (Coordinator) は段階2 → 段階3 (リンク除去) へ進む。
 *
 * @param {{ slotNames?: string[], enabledSlots?: number[] }} entity
 * @param {string} slotName
 * @param {number | null} [globalSlotIdx]  capture 時の entity 内 global index (任意。rebuild で
 *                                          上流の出力が増減した場合は entity._slotRemap で写してから使う)
 * @returns {number | null}
 */
export function resolveLocalSlotBySlotName(entity, slotName, globalSlotIdx = null) {
    const names = entity?.slotNames ?? [];
    const target = translateGlobalSlotIdx(entity, globalSlotIdx);
    if (target === -1) return null;   // 上流で除去された出力 (同名の別出力へ寄せない)
    let best = -1;
    for (let i = 0; i < names.length; i++) {
        if (names[i] !== slotName) continue;
        if (best < 0) { best = i; continue; }
        if (target != null && Math.abs(i - target) < Math.abs(best - target)) best = i;
    }
    if (best < 0) return null;
    const localIdx = entity?.enabledSlots?.indexOf(best) ?? -1;
    return localIdx >= 0 ? localIdx : null;
}
