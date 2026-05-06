// DynamicSlotCoordinator — Phase 1.2.B
//
// 動的スロットの mutation トランザクション (capture → action → sync → restore) を
// 集約する Coordinator API。
//
// Phase 1.2.B での変更:
// - direction="output" 1:N 対応 (#captureSnapshots / #restoreFromSnapshots / #computeBaseOffset 経由)
// - snapshot 構造拡張: { targetId, targetSlot, globalSlotIdx, slotName, localSlotIdx } (旧 _captureDownstream 完全踏襲)
// - 段階1/段階2/段階3 fallback restore (spec.resolveLocalSlotBySlotName / spec.resolveLocalSlotByGlobalIdx 経由)
// - atomic rollback (#snapshotNodeState / #restoreNodeState) for action 内例外時 best-effort link 復元
// - asyncScheduled フラグベースの try/finally cleanup
// - ensureCoordinator(node, specFactory, key?) 共通ヘルパ export 追加
//
// Phase 1.2.A.0 での変更:
// - applyAfterCapture の非同期パスで #hints 退避・復元実装 (CR-MEDIUM-1 / TR-MEDIUM-1 解消、mutate と完全対称化)
// - #captureSnapshots に try/finally 防御コード追加 (NEW3-MEDIUM-1: ループ途中例外時の部分書込み cleanup)
//
// Phase 1.1.C での変更:
// - wrapper API (captureLinksRaw / restoreLinksRaw / #captureCalled /
//   applyAfterCapture の wrapper 分岐) を削除
//
// 参照プラン:
// - docs/plans/20260506-ui-phase1-2b-nodecollector-migration.md (本子プラン)
// - docs/plans/20260506-ui-phase1-2a-textcatalog-migration.md (Phase 1.2.A)
// - docs/plans/20260506-ui-phase1-1-coordinator-api-freeze.md (Phase 1.1)
// - docs/plans/20260504-ui-phase1-0-coordinator-prototype.md (Phase 1.0)
// - docs/plans/20260503-ui-architecture-overhaul.md (親プラン)

/**
 * @typedef {object} CoordinatorSpec
 * @property {"input" | "output"} direction
 *           動的スロットの方向。"output" は PrimitiveStore / TextCatalog のような出力スロット可変ノード、
 *           "input" は Collector 系の入力スロット可変ノード。
 * @property {() => object[]} getEntities
 *           現状の entity 配列を返すコールバック。entity は items / sources など各ノードの最小単位。
 *           identity 維持が前提 (WeakMap ベース ID 採番のため、毎回新しい配列を返してはならず、
 *           既存 entity オブジェクトを参照すること)。
 * @property {(entity: object, hints?: Map<object, object>) => Array<{ name: string, type: string }>} entityToSlots
 *           entity を slot 構造 (name / type のリスト) に変換する純粋関数。
 *           1:1 (PrimitiveStore) / 1:N (NodeCollector) 両方を表現できる。
 *           hints は mutate トランザクションスコープ内でのみ渡される (省略時は undefined)。
 *           Phase 1.0 の PrimitiveStore では両引数とも参照されないが API として保持する。
 * @property {() => void} syncSlotStructure
 *           getEntities() / entityToSlots() の現状値に従い、node.outputs / node.inputs の数・name・type を
 *           実際に揃える同期関数。LiteGraph の addInput/addOutput/removeInput/removeOutput を呼ぶ責任を持つ。
 * @property {(newEntities: object[]) => void} [setEntities]
 *           commitState / applyAfterCapture / applySaveOnly で entity 配列全体を差し替えるための setter。
 *           利用側で `node._primitiveItems = newEntities` のような差し替えを行う。
 * @property {(entity: object, slotName: string) => (number | null)} [resolveLocalSlotBySlotName]
 *           Phase 1.2.B 追加 (output 1:N 段階1 fallback)。entity と slotName から localSlotIdx を返す。
 *           NodeCollector では `slotNames.indexOf(slotName) → enabledSlots.indexOf(globalIdx) → localIdx` を実装。
 *           1:1 ノード (PrimitiveStore / TextCatalog) や enabledSlots 編集機能なしの Collector (Image / Pipe) では
 *           null 採用で段階1 を skip する (旧 _restoreDownstream L1287-1293 と互換)。
 *           本フィールド自体を `null` / `undefined` のままにすると段階3 fallback 経路に倒れる。
 * @property {(entity: object, globalSlotIdx: number) => (number | null)} [resolveLocalSlotByGlobalIdx]
 *           Phase 1.2.B 追加 (output 1:N 段階2 fallback)。entity と globalSlotIdx から localSlotIdx を返す。
 *           NodeCollector では `enabledSlots.indexOf(globalSlotIdx)` を実装。
 *           1:1 ノードや Collector (Image / Pipe) では null 採用で段階2 を skip する
 *           (旧 _restoreDownstream L1294-1297 と互換)。
 *           本フィールド自体を `null` / `undefined` のままにすると段階3 fallback 経路に倒れる。
 */

/**
 * @typedef {object} MutateOptions
 * @property {Map<object, object>} [entityHints]
 *           entity 単位の hint。NodeCollector の `_rebuildHints` 機構を一般化したもの。
 *           mutate トランザクションスコープ内でのみ参照され、終了時に破棄される。
 * @property {boolean} [skipCapture]
 *           true の場合、capture/restore をスキップする。SEED 自動ランダム化のように
 *           値のみ変わり slot 構造が不変な mutation で利用する。
 */

/**
 * 動的スロットの mutation トランザクションを集約する Coordinator。
 *
 * Phase 1.0 スコープ外 (継続):
 * - TextCatalog / NodeCollector の本番移行 (Phase 1.2)
 * - 二重 capture (sax_text_catalog.js:1413) の解消 (Phase 1.2)
 */
export class DynamicSlotCoordinator {
    /**
     * entity identity → 内部 ID。WeakMap により entity が GC されると ID も自動消失する。
     * @type {WeakMap<object, number>}
     */
    #entityIds = new WeakMap();

    /**
     * 内部 ID → 接続情報スナップショット。mutate トランザクション内のみ生存。
     *
     * Phase 1.2.B 拡張: 1:N 対応のため `globalSlotIdx` / `slotName` / `localSlotIdx` を追加保持。
     * 1:1 ノード (PrimitiveStore / TextCatalog) では `localSlotIdx === 0`、`globalSlotIdx === 0`、
     * `slotName === outputs[entityIdx].name` となる (segregator 関数経由の復元で互換維持)。
     *
     * 旧 `_captureDownstream` (sax_ui_base.js:1265-1272) のフィールド構成と完全一致:
     *   sourceId      → entityId (Coordinator 内部 ID)
     *   globalSlotIdx → src.enabledSlots?.[li] ?? li
     *   outName       → out.label ?? out.name ?? null  (slotName と命名統一)
     *   localSlot     → li (localSlotIdx と命名統一)
     *   targetId      → lnk.target_id
     *   targetSlot    → lnk.target_slot
     *
     * @type {Map<number, Array<{ targetId: number, targetSlot: number, globalSlotIdx: number | null, slotName: string | null, localSlotIdx: number }>>}
     */
    #linkSnapshots = new Map();

    /** 次の ID 採番カウンタ。セッション内のみ有効でシリアライズ対象外。 */
    #nextId = 1;

    /** @type {object} LiteGraph ノード */
    #node;

    /** @type {CoordinatorSpec} */
    #spec;

    /**
     * mutate スコープ内でのみ生存する entityHints。
     * action 開始時にセットし、syncSlotStructure 完了時に null クリアする。
     * @type {Map<object, object> | null}
     */
    #hints = null;

    /**
     * @param {object} node            LiteGraph ノード
     * @param {CoordinatorSpec} spec   Coordinator の仕様
     */
    constructor(node, spec) {
        this.#node = node;
        this.#spec = spec;
    }

    /**
     * 通常の mutation を実行する。capture → action → syncSlotStructure → restore の
     * トランザクションを Coordinator が一括管理する。
     *
     * 副作用:
     * - action 内で entity 配列を変更する (利用側責任)
     * - syncSlotStructure を呼び出して node.outputs / node.inputs を更新する
     * - capture したスナップショットから再接続する
     * - スロット数変動なし (toggle/move 等) → 同期 restore
     * - スロット数変動あり (add/del 等) → setTimeout(0) restore (LiteGraph 確定待ち)
     *
     * @param {(entities: object[]) => void} action
     * @param {MutateOptions} [opts]
     */
    mutate(action, opts) {
        const options = opts ?? {};
        const skipCapture = options.skipCapture === true;

        if (skipCapture) {
            this.#runSkipCapture(() => action(this.#spec.getEntities()), options.entityHints);
            return;
        }

        // capture: action 前のスロット数と接続スナップショットを記録
        const entitiesBefore = this.#spec.getEntities();
        const slotCountBefore = this.#getSlotCount();

        // hints は #captureSnapshots / #computeBaseOffset で entityToSlots(entity, hints) に
        // 渡されるため、capture 前に設定する必要がある (Phase 1.2.B: 1:N entityToSlots は
        // hints 経由で slot 数を変える可能性がある)。
        this.#hints = options.entityHints ?? null;

        this.#captureSnapshots(entitiesBefore);

        // atomic rollback 用の pre-action 構造スナップショット (Phase 1.2.B 戦略 β)。
        // action 内例外時に node.inputs/outputs/links を best-effort 復元する。
        const preState = this.#snapshotNodeState();

        const capturedEntityIds = this.#collectCapturedIds(entitiesBefore);
        // asyncScheduled フラグ: 非同期 restore がスケジュールされたか。
        // 早期 return / 同期 restore / 非同期 restore / 例外 の 4 経路で
        // #linkSnapshots / #hints cleanup の二重実行・漏れを防ぐ。
        let asyncScheduled = false;
        // 非同期 restore に切り替わるケースで、setTimeout コールバックが完了するまで
        // #hints を生存させる必要があるため、同期スコープでローカル変数に退避する。
        const hintsForAsync = this.#hints;

        // cleanup 経路 (asyncScheduled フラグで一元管理):
        // - 早期 return (skipCapture): #runSkipCapture が cleanup 不要 (snapshot 未取得)
        // - 同期 restore 成功: #restoreFromSnapshots 内で #linkSnapshots cleanup 完了
        // - 非同期 restore (setTimeout(0)): 内側の finally で cleanup
        // - action 内例外: outer catch で #restoreNodeState → outer finally で cleanup
        // - #captureSnapshots 内例外: 内側 try/finally で partial cleanup 済 → outer finally は空振り (実害なし)
        try {
            // action 実行。例外時は atomic rollback を試行してから rethrow。
            try {
                action(this.#spec.getEntities());
            } catch (actionError) {
                this.#restoreNodeState(preState);
                throw actionError;
            }

            this.#spec.syncSlotStructure();
            const slotCountAfter = this.#getSlotCount();
            const slotCountChanged = slotCountAfter !== slotCountBefore;

            if (slotCountChanged) {
                asyncScheduled = true;
                setTimeout(() => {
                    this.#hints = hintsForAsync;
                    try {
                        this.#restoreFromSnapshots();
                    } finally {
                        for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                        this.#hints = null;
                    }
                }, 0);
            } else {
                this.#restoreFromSnapshots();
            }
        } finally {
            // 同期 restore 経路 / 例外経路ではこの finally で cleanup する。
            // 非同期 restore 経路では setTimeout コールバック側で行う。
            if (!asyncScheduled) {
                this.#hints = null;
                for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
            }
        }
    }

    /**
     * 現状のスロット接続を内部スナップショットに記録する (mutation なし)。
     * onConfigure 直後 (LiteGraph link 復元後の setTimeout(0) 内) で利用する。
     */
    captureFromExisting() {
        const entities = this.#spec.getEntities();
        this.#captureSnapshots(entities);
    }

    /**
     * 直前に captureFromExisting() を呼んだ前提で、entity 配列差し替え + sync + restore を実行する。
     * makeItemListWidget の `beforeModify → in-place mutation → saveItemsCapturing` 動作モデルに対応。
     *
     * snapshot ライフサイクル契約: captureFromExisting → applyAfterCapture で消費 + cleanup。
     * 完了時に capturedEntityIds 範囲を #cleanupSnapshot で削除する。
     *
     * Phase 1.2 削除条件: makeItemListWidget が Coordinator を引数受領するよう仕様変更し、
     * saveItems 経路を mutate(action) で表現可能になった時点で mutate(action) に統合・削除。
     *
     * @param {object[]} newEntities  新しい entity 配列 (setEntities でノードに反映)
     * @param {{ entityHints?: Map<object, object> }} [opts]
     * @throws {Error} spec.setEntities が定義されていない場合
     */
    applyAfterCapture(newEntities, opts) {
        if (typeof this.#spec.setEntities !== "function") {
            throw new Error("DynamicSlotCoordinator.applyAfterCapture requires spec.setEntities");
        }
        const options = opts ?? {};

        // opts.entityHints の反映 (mutate / applySaveOnly と統一、null 明示クリア)
        this.#hints = options.entityHints ?? null;

        const capturedEntityIds = this.#collectCapturedIds(this.#spec.getEntities());
        const slotCountBefore = this.#getSlotCount();
        let didScheduleAsync = false;

        // 非同期 restore に切り替わるケースで、setTimeout コールバックが完了するまで
        // #hints を生存させる必要があるため、同期スコープでローカル変数に退避する
        // (mutate と同じパターン)。
        const hintsForAsync = this.#hints;

        try {
            this.#spec.setEntities(newEntities);
            this.#spec.syncSlotStructure();
            const slotCountAfter = this.#getSlotCount();
            if (slotCountAfter !== slotCountBefore) {
                didScheduleAsync = true;
                setTimeout(() => {
                    this.#hints = hintsForAsync;
                    try {
                        this.#restoreFromSnapshots();
                    } finally {
                        for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                        this.#hints = null;
                    }
                }, 0);
            } else {
                this.#restoreFromSnapshots();
            }
        } finally {
            // 同期 restore 経路ではこの finally で #hints をクリアし snapshot cleanup する。
            // 非同期 restore 経路 (didScheduleAsync=true) では setTimeout コールバック側で行う。
            if (!didScheduleAsync) {
                this.#hints = null;
                for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
            }
        }
    }

    /**
     * entity 配列を差し替えて syncSlotStructure のみ実行する。capture/restore は行わない。
     * makeItemListWidget の beforeModify を経由しない経路 (param drag / popup / leftElements onClick) で使用。
     *
     * snapshot ライフサイクル契約: #linkSnapshots を読まない・書かない・既存 snapshot 保持。
     * entity identity は entity object 参照 (#entityIds: WeakMap<object, number> の key 識別) で判定する。
     * 配列 literal が新規作成されても entity object 参照が不変なら同 ID が返るため #linkSnapshots 既存エントリはそのまま有効。
     *
     * Phase 1.2 削除条件: makeItemListWidget が Coordinator を引数受領するよう仕様変更し、
     * saveItems 経路を mutate(action) で表現可能になった時点で mutate(action) に統合・削除。
     *
     * @param {object[]} newEntities
     * @param {{ entityHints?: Map<object, object> }} [opts]
     * @throws {Error} spec.setEntities が定義されていない場合
     */
    applySaveOnly(newEntities, opts) {
        if (typeof this.#spec.setEntities !== "function") {
            throw new Error("DynamicSlotCoordinator.applySaveOnly requires spec.setEntities");
        }
        const options = opts ?? {};
        this.#hints = options.entityHints ?? null;
        try {
            this.#spec.setEntities(newEntities);
            this.#spec.syncSlotStructure();
        } finally {
            this.#hints = null;
        }
    }

    /**
     * 外部から entity 配列全体を差し込む。Manager Dialog Save 経路 (TextCatalog) で利用予定。
     *
     * @param {object[]} newEntities
     * @param {MutateOptions} [opts]
     * @throws {Error} spec.setEntities が定義されていない場合
     */
    commitState(newEntities, opts) {
        if (typeof this.#spec.setEntities !== "function") {
            throw new Error("DynamicSlotCoordinator.commitState requires spec.setEntities");
        }
        const options = opts ?? {};
        const skipCapture = options.skipCapture === true;

        if (skipCapture) {
            this.#runSkipCapture(() => this.#spec.setEntities(newEntities), options.entityHints);
            return;
        }

        const entitiesBefore = this.#spec.getEntities();
        const slotCountBefore = this.#getSlotCount();
        this.#captureSnapshots(entitiesBefore);
        const capturedEntityIds = this.#collectCapturedIds(entitiesBefore);

        this.#hints = options.entityHints ?? null;
        let didScheduleAsync = false;
        const hintsForAsync = this.#hints;
        try {
            this.#spec.setEntities(newEntities);
            this.#spec.syncSlotStructure();
            const slotCountAfter = this.#getSlotCount();
            if (slotCountAfter !== slotCountBefore) {
                didScheduleAsync = true;
                setTimeout(() => {
                    this.#hints = hintsForAsync;
                    try {
                        this.#restoreFromSnapshots();
                    } finally {
                        for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                        this.#hints = null;
                    }
                }, 0);
            } else {
                this.#restoreFromSnapshots();
            }
        } finally {
            if (!didScheduleAsync) {
                this.#hints = null;
                for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
            }
        }
    }

    // ------------------------------------------------------------------
    // 内部ヘルパ
    // ------------------------------------------------------------------

    /**
     * entity に対応する内部 ID を返す。未採番なら #nextId を採番し WeakMap に登録する。
     *
     * @param {object} entity
     * @returns {number}
     */
    #getOrCreateId(entity) {
        let id = this.#entityIds.get(entity);
        if (id === undefined) {
            id = this.#nextId++;
            this.#entityIds.set(entity, id);
        }
        return id;
    }

    /**
     * トランザクション完了時に #linkSnapshots から該当エントリを削除する。
     *
     * @param {number} entityId
     */
    #cleanupSnapshot(entityId) {
        this.#linkSnapshots.delete(entityId);
    }

    /**
     * skipCapture パスの共通処理を抽出したヘルパ。
     * mutate(skipCapture) と commitState(skipCapture) の重複を解消する (MEDIUM-2 対応)。
     *
     * @param {() => void} performMutation  mutation 主体を閉包で渡す
     * @param {Map<object, object> | undefined} entityHints
     */
    #runSkipCapture(performMutation, entityHints) {
        this.#hints = entityHints ?? null;
        try {
            performMutation();
            this.#spec.syncSlotStructure();
        } finally {
            this.#hints = null;
        }
    }

    /**
     * entityIdx に対応する slot の baseOffset を計算する。
     * direction="output" 1:1 (PrimitiveStore) では常に entityIdx と等価。
     * 1:N (Phase 1.2 NodeCollector) では各 entity の slot 数の累積和となる。
     *
     * @param {number} entityIdx
     * @returns {number}
     */
    #computeBaseOffset(entityIdx) {
        const entities = this.#spec.getEntities();
        let offset = 0;
        for (let i = 0; i < entityIdx; i++) {
            offset += this.#spec.entityToSlots(entities[i], this.#hints).length;
        }
        return offset;
    }

    /**
     * 現状スロット接続のスナップショット記録 (output direction、1:1 / 1:N 両対応)。
     * Phase 1.2.B で旧 `_captureDownstream` (sax_ui_base.js:1251-1278) のロジックを移植。
     *
     * 各 entity について `entityToSlots(entity, hints).length` 個の slot を baseOffset から走査し、
     * 各 slot の links を `{ targetId, targetSlot, globalSlotIdx, slotName, localSlotIdx }` 形式で snapshot。
     * `slotName` は `outputs[absIdx].label ?? outputs[absIdx].name ?? null`、`globalSlotIdx` は
     * `entityToSlots` 戻り値の対応エントリから (1:1 ノードは `null`、NodeCollector は entity.enabledSlots[localIdx])。
     *
     * @param {object[]} entities
     */
    #captureSnapshots(entities) {
        if (this.#spec.direction !== "output") {
            // input 方向は別 Phase で実装。現状は capture/restore せずに通過させる。
            return;
        }
        const outputs = this.#node.outputs ?? [];
        const graphLinks = this.#node.graph?.links ?? globalThis.app?.graph?.links ?? null;
        // 防御コード (NEW3-MEDIUM-1): ループ途中例外時に部分書込みスナップショットを cleanup する。
        const writtenIds = [];
        try {
            let baseOffset = 0;
            for (let entityIdx = 0; entityIdx < entities.length; entityIdx++) {
                const entity = entities[entityIdx];
                const id = this.#getOrCreateId(entity);
                const slots = this.#spec.entityToSlots(entity, this.#hints) ?? [];
                const conns = [];
                for (let localSlotIdx = 0; localSlotIdx < slots.length; localSlotIdx++) {
                    const absIdx = baseOffset + localSlotIdx;
                    const slot = outputs[absIdx];
                    const linkIds = slot?.links ?? [];
                    if (!linkIds.length) continue;
                    // slotName: 旧 _captureDownstream L1268 と同じく label > name の優先順位
                    const slotName = slot?.label ?? slot?.name ?? null;
                    // globalSlotIdx: 1:N ノードでは entity.enabledSlots[localSlotIdx] (NodeCollector)、
                    // 1:1 ノードでは null (段階2 fallback skip)
                    const globalSlotIdx = entity?.enabledSlots?.[localSlotIdx] ?? null;
                    for (const linkId of linkIds) {
                        const link = graphLinks?.[linkId];
                        if (!link) continue;
                        conns.push({
                            targetId: link.target_id,
                            targetSlot: link.target_slot,
                            globalSlotIdx,
                            slotName,
                            localSlotIdx,
                        });
                    }
                }
                this.#linkSnapshots.set(id, conns);
                writtenIds.push(id);
                baseOffset += slots.length;
            }
        } catch (e) {
            for (const id of writtenIds) this.#cleanupSnapshot(id);
            throw e;
        }
    }

    /**
     * #linkSnapshots に記録された接続を復元する。
     *
     * Phase 1.2.B で 1:N 対応: snapshot 1 件ごとに以下 3 段階で localSlotIdx を解決する
     * (旧 `_restoreDownstream` sax_ui_base.js:1279-1306 のロジック準拠):
     *   段階 1: spec.resolveLocalSlotBySlotName(entity, slotName) → localSlotIdx
     *   段階 2: spec.resolveLocalSlotByGlobalIdx(entity, globalSlotIdx) → localSlotIdx
     *   段階 3: skip (両 spec フィールド未定義時は ds.localSlotIdx をそのまま採用、
     *           1:1 ノードや Image/Pipe Collector の互換動作)
     *
     * 削除 entity (`_remoteSources.splice(idx, 1)` 等) は `getEntities()` ループで
     * 自動的に走査対象外となり partial restore が成立する (snapshot は cleanup 側で破棄)。
     */
    #restoreFromSnapshots() {
        if (this.#spec.direction !== "output") return;
        const entities = this.#spec.getEntities();
        const graph = this.#node.graph ?? globalThis.app?.graph ?? null;
        if (!graph) return;

        // 既存リンクをクリアしてから再接続 (capture 前の link は action 内で
        // syncSlotStructure 経由 removeOutput により graph.links からも除去済の想定だが、
        // 防御的に現状全 outputs 経由で残存 link を removeLink する)。
        // 前提: このノードの全出力 slot が Coordinator 管理対象であることを前提とする。
        // snapshot に記録されていない entity の link も一旦 removeLink される (capture 時に
        // link がなかった entity に capture 後追加された link は復元されない、防御的動作)。
        // static 接続と共存する場合は本ループのスコープを #linkSnapshots 記録分のみに
        // 限定する変更が必要 (現 Phase 1.2.B では発生しない)。
        const outputs = this.#node.outputs ?? [];
        for (let i = 0; i < outputs.length; i++) {
            const links = outputs[i]?.links ?? [];
            for (const linkId of [...links]) {
                graph.removeLink?.(linkId);
            }
        }

        let baseOffset = 0;
        for (let entityIdx = 0; entityIdx < entities.length; entityIdx++) {
            const entity = entities[entityIdx];
            const id = this.#entityIds.get(entity);
            const slots = this.#spec.entityToSlots(entity, this.#hints) ?? [];

            const conns = id !== undefined ? this.#linkSnapshots.get(id) : null;
            if (!conns?.length) {
                baseOffset += slots.length;
                continue;
            }

            for (const ds of conns) {
                let localSlotIdx = -1;
                // 段階 1: slotName → localSlotIdx
                if (ds.slotName != null && typeof this.#spec.resolveLocalSlotBySlotName === "function") {
                    const resolved = this.#spec.resolveLocalSlotBySlotName(entity, ds.slotName);
                    if (typeof resolved === "number" && resolved >= 0) localSlotIdx = resolved;
                }
                // 段階 2: globalSlotIdx → localSlotIdx
                if (localSlotIdx < 0
                    && ds.globalSlotIdx != null
                    && typeof this.#spec.resolveLocalSlotByGlobalIdx === "function") {
                    const resolved = this.#spec.resolveLocalSlotByGlobalIdx(entity, ds.globalSlotIdx);
                    if (typeof resolved === "number" && resolved >= 0) localSlotIdx = resolved;
                }
                // 段階 3 fallback: 両 spec 未定義 (1:1 ノード / Image・Pipe Collector) の場合、
                // capture 時の localSlotIdx をそのまま採用する。spec が定義されているのに
                // resolve に失敗したケース (NodeCollector で enabledSlots 編集により globalIdx が消失)
                // は restore skip。
                // 段階3 fallback 判定: spec の resolver が両方とも function でない場合
                // (null / undefined / 未定義) のみ ds.localSlotIdx をそのまま採用。
                // 1:1 ノード (PrimitiveStore / TextCatalog)・enabledSlots 編集機能なし Collector
                // (Image / Pipe) は両 resolver を null/未定義のままにすることでこの経路に倒れる。
                if (localSlotIdx < 0) {
                    const hasResolvers
                        = typeof this.#spec.resolveLocalSlotBySlotName === "function"
                        || typeof this.#spec.resolveLocalSlotByGlobalIdx === "function";
                    if (hasResolvers) continue;
                    localSlotIdx = ds.localSlotIdx;
                }

                const absIdx = baseOffset + localSlotIdx;
                const targetNode = graph.getNodeById?.(ds.targetId);
                if (targetNode && this.#node.outputs?.[absIdx]) {
                    this.#node.connect?.(absIdx, targetNode, ds.targetSlot);
                }
            }
            baseOffset += slots.length;
        }
    }

    /**
     * action 内例外時の atomic rollback 用に node.inputs / node.outputs / 関連 link を
     * deep clone snapshot する (Phase 1.2.B 戦略 β、子プラン v3 L317-389)。
     *
     * @returns {{ inputs: Array, outputs: Array, links: object }}
     */
    #snapshotNodeState() {
        const graph = this.#node.graph ?? globalThis.app?.graph ?? null;
        const linkIds = new Set();
        this.#node.inputs?.forEach(inp => { if (inp?.link != null) linkIds.add(inp.link); });
        this.#node.outputs?.forEach(out => { out?.links?.forEach(id => linkIds.add(id)); });
        const links = {};
        for (const id of linkIds) {
            const lnk = graph?.links?.[id];
            if (lnk) links[id] = { ...lnk };
        }
        return {
            inputs: this.#node.inputs?.map(inp => ({ name: inp.name, type: inp.type, link: inp.link })) ?? [],
            outputs: this.#node.outputs?.map(out => ({ name: out.name, type: out.type, links: out.links?.slice() ?? null })) ?? [],
            links,
        };
    }

    /**
     * action 内例外時に #snapshotNodeState の結果から node.inputs / node.outputs / 関連 link を
     * best-effort 復元する。LiteGraph 仕様上、`removeInput`/`removeOutput` 連鎖で
     * `app.graph.links` および上流 `outputs[].links` 配列の link id が同時除去されるため、
     * step1 (構造削除) → step2 (構造再構築) → step3 (link Map 再挿入) → step4 (slot 側 link 参照復元)
     * → step5 (上流 outputs[].links 再追加) の順序が必要 (Phase 1.2.B LOW-A 順序保証)。
     *
     * @param {{ inputs: Array, outputs: Array, links: object }} snap
     */
    #restoreNodeState(snap) {
        const graph = this.#node.graph ?? globalThis.app?.graph ?? null;
        // 1. 現 inputs/outputs を全削除 (LiteGraph が link を自動削除する)
        while ((this.#node.inputs?.length ?? 0) > 0) this.#node.removeInput?.(0);
        while ((this.#node.outputs?.length ?? 0) > 0) this.#node.removeOutput?.(0);
        // 2. 構造再構築
        for (const inp of snap.inputs) this.#node.addInput?.(inp.name, inp.type);
        for (const out of snap.outputs) this.#node.addOutput?.(out.name, out.type);
        // 3. graph.links Map 再挿入 (action 内 removeLink で消えたエントリを復活)
        if (graph?.links) {
            for (const [id, lnk] of Object.entries(snap.links)) {
                // Object.entries は数値キーを文字列化するため Number() で明示変換
                graph.links[Number(id)] = { ...lnk };
            }
        }
        // 4. inputs[i].link / outputs[i].links を復元
        for (let i = 0; i < snap.inputs.length; i++) {
            if (this.#node.inputs?.[i] && snap.inputs[i].link != null) {
                this.#node.inputs[i].link = snap.inputs[i].link;
            }
        }
        for (let i = 0; i < snap.outputs.length; i++) {
            if (this.#node.outputs?.[i] && snap.outputs[i].links) {
                this.#node.outputs[i].links = snap.outputs[i].links.slice();
            }
        }
        // 5. 上流ノードの outputs[origin_slot].links に link id 再追加
        // MEDIUM-A null ガード: LiteGraph 実装上 originOut.links は通常 [] だが
        // 異常状態 (link 復元中の partial state) では undefined の可能性があるため ??= で初期化。
        if (graph?.links) {
            for (const lnk of Object.values(snap.links)) {
                const originNode = graph.getNodeById?.(lnk.origin_id);
                const originOut = originNode?.outputs?.[lnk.origin_slot];
                if (!originOut) continue;
                // LiteGraph 内部 API: outputs[].links 配列は LiteGraph が参照保持するため、
                // .slice() で新配列に置換すると内部参照が壊れる。in-place push が必須。
                originOut.links ??= [];
                if (!originOut.links.includes(lnk.id)) {
                    originOut.links.push(lnk.id);
                }
            }
        }
    }

    /**
     * 現状の entity 配列を走査し、capture 済み ID を列挙する (cleanup 対象)。
     *
     * @param {object[]} entities
     * @returns {number[]}
     */
    #collectCapturedIds(entities) {
        const ids = [];
        for (const entity of entities) {
            const id = this.#entityIds.get(entity);
            if (id !== undefined && this.#linkSnapshots.has(id)) ids.push(id);
        }
        return ids;
    }

    /** direction に応じたスロット数を返す。 */
    #getSlotCount() {
        if (this.#spec.direction === "output") return this.#node.outputs?.length ?? 0;
        return this.#node.inputs?.length ?? 0;
    }
}

/**
 * `ensureCoordinator` で受け付けない key 名 (prototype pollution 防御)。
 * これらを許可すると `node.__proto__` 等への代入で Object prototype を汚染できる。
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * ノードに DynamicSlotCoordinator を 1 度だけ生成して返す共通ヘルパ (Phase 1.2.B 追加)。
 *
 * `specFactory` は **初回呼出時の 1 回のみ** 評価される。spec 内のクロージャ
 * (`getEntities` / `setEntities` 等) は lazy 参照 + null-safe フォールバック
 * (`?? defaultState()`) パターンで実装すること。これにより `ensureCoordinator` 呼出時点での
 * state 初期化保証が不要となる (lifecycle.md / 子プラン v3 L487-505 参照)。
 *
 * `key` は将来の 1 ノード複数 Coordinator 並立 (例: input 用 + output 用) 拡張時に使用。
 * Phase 1.2.B では既定値 `"_saxCoordinator"` 固定で API 表面のみ提供する。
 *
 * @param {object} node                        LiteGraph ノード
 * @param {(node: object) => CoordinatorSpec} specFactory  spec を生成する factory (1 回のみ評価)
 * @param {string} [key="_saxCoordinator"]     Coordinator を保管するノード上のキー
 * @returns {DynamicSlotCoordinator}
 */
export function ensureCoordinator(node, specFactory, key = "_saxCoordinator") {
    if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`ensureCoordinator: forbidden key "${key}"`);
    }
    if (node[key]) return node[key];
    const spec = specFactory(node);
    node[key] = new DynamicSlotCoordinator(node, spec);
    return node[key];
}
