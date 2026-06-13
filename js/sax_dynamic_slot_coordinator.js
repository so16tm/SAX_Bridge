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
 * @property {boolean} [linkPreserving]
 *           link-preserving 再構築 (#restoreLinkPreserving) を主経路とするかの明示 opt-in。
 *           true は「entity 1 件 → 出力ピン 1 件 (1:1) かつ出力ピンが Coordinator 管理対象
 *           (syncSlotStructure が add/remove で増減させる)」ノード (PrimitiveStore / TextCatalog) のみ指定する。
 *           この経路は entity 数に合わせて出力ピンを addOutput/removeOutput し、生存 link の上流端
 *           (origin_slot) のみ in-place で付け替えて下流端を保つ。
 *           固定出力を持つ Image/Pipe Collector (direction="output" だが出力ピンが Python 定義で
 *           Coordinator 非管理・syncSlotStructure が no-op) では **指定してはならない** (固定出力ピンが
 *           addOutput/removeOutput で破壊される)。未指定 (falsy) のノードは従来の remove-all + connect
 *           再接続経路 (#restoreByReconnect) に入る。
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

    /**
     * G1: absIdx (物理スロット位置) → 接続情報。entity identity 解決に失敗したスロットを
     * 「同一物理位置」の capture 済みリンクで復元するための positional snapshot。
     * 新オブジェクト化 (`{...e, x}`) で entity identity が壊れても 1:1 output では切断を
     * 非致命化する構造的セーフティネット。#captureSnapshots の度に再構築する。
     * @type {Map<number, Array<{ targetId: number, targetSlot: number }>>}
     */
    #positionalSnapshots = new Map();

    /** G1: capture 時点の物理スロット総数。restore 時の「slot 数不変」判定に使う。 */
    #capturedSlotCount = 0;

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

            asyncScheduled = this.#syncAndRestore(slotCountBefore, capturedEntityIds, hintsForAsync);
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
            didScheduleAsync = this.#syncAndRestore(slotCountBefore, capturedEntityIds, hintsForAsync);
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
            didScheduleAsync = this.#syncAndRestore(slotCountBefore, capturedEntityIds, hintsForAsync);
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
     * 1:1 link-preserving 再構築を主経路とするか。
     * true の場合、ピンの add/remove と link 再ポイントは #restoreLinkPreserving が一括制御する
     * ため、restore 前の破壊的 syncSlotStructure 呼出 (removeOutput で下流を切る) を抑止する。
     *
     * 判定は **spec.linkPreserving === true の明示 opt-in** に限定する。direction="output" かつ
     * resolver 両未定義という条件は Image/Pipe Collector (固定出力・syncSlotStructure no-op) も満たすため、
     * !hasResolvers での暗黙判定では固定出力ピンが addOutput/removeOutput で破壊される回帰となる。
     * 明示フラグにより link-preserving 経路を PrimitiveStore / TextCatalog のみに限定する。
     * @returns {boolean}
     */
    #isLinkPreserving() {
        if (this.#spec.direction !== "output") return false;
        if (this.#spec.linkPreserving !== true) return false;
        const hasResolvers
            = typeof this.#spec.resolveLocalSlotBySlotName === "function"
            || typeof this.#spec.resolveLocalSlotByGlobalIdx === "function";
        return !hasResolvers;
    }

    /**
     * action / setEntities 完了後の「構造同期 + restore」フェーズを実行する。
     * mutate / applyAfterCapture / commitState の 3 経路で共通利用する。
     *
     * - link-preserving 経路 (1:1): 破壊的 syncSlotStructure を経由せず、
     *   #restoreLinkPreserving が「ピン add/remove + link in-place 再ポイント + name/type 更新」を
     *   **同期で** 一括実行する。in-place 再ポイントは既存 link を直接操作するため、
     *   従来の connect ベース restore が必要とした setTimeout(0) link 確定待ちが不要。
     *   ピン構造も同期で確定するため UX 上の遅延も生じない。常に false (同期) を返す。
     * - 従来経路 (1:N / input): syncSlotStructure を同期実行し、slot 数が変動した場合のみ
     *   setTimeout(0) で connect ベース restore を遅延する (LiteGraph link 確定待ち)。
     *
     * @param {number} slotCountBefore     action 前の slot 数 (従来経路の変動判定に使用)
     * @param {number[]} capturedEntityIds  cleanup 対象 ID (非同期経路の setTimeout で消費)
     * @param {Map<object, object> | null} hintsForAsync  非同期 restore 用に退避した hints
     * @returns {boolean} 非同期 restore をスケジュールしたか (true なら呼出側 finally は cleanup しない)
     */
    #syncAndRestore(slotCountBefore, capturedEntityIds, hintsForAsync) {
        if (this.#isLinkPreserving()) {
            // 1:1: 構造確定 + link 再ポイントを同期で完結する (#restoreFromSnapshots →
            // #restoreLinkPreserving 内で syncSlotStructure を 1 回だけ呼ぶ)。
            this.#restoreFromSnapshots();
            return false;
        }

        // 従来経路 (1:N): syncSlotStructure を同期実行し、slot 数変動時のみ非同期 restore。
        this.#spec.syncSlotStructure();
        const slotCountAfter = this.#getSlotCount();
        if (slotCountAfter === slotCountBefore) {
            this.#restoreFromSnapshots();
            return false;
        }
        setTimeout(() => {
            this.#hints = hintsForAsync;
            try {
                this.#restoreFromSnapshots();
            } finally {
                for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                this.#hints = null;
            }
        }, 0);
        return true;
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
        // G1: positional snapshot を毎 capture で再構築する (absIdx キー、stale 防止)。
        // restore は capture 直後に同一トランザクションで実行されるため、capture 開始時の
        // clear で常に最新の物理配置を反映する。
        this.#positionalSnapshots.clear();
        this.#capturedSlotCount = outputs.length;
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
                            // linkId: 1:1 link-preserving 再構築 (#restoreLinkPreserving) で
                            // graph.links[linkId].origin_slot を in-place 付け替えするために保持する。
                            // 1:N (resolver 定義済) 経路では参照されない (従来 connect ベース)。
                            linkId,
                            targetId: link.target_id,
                            targetSlot: link.target_slot,
                            globalSlotIdx,
                            slotName,
                            localSlotIdx,
                        });
                        // G1: 同一物理位置 (absIdx) の positional snapshot も併記する。
                        const posConns = this.#positionalSnapshots.get(absIdx) ?? [];
                        posConns.push({ targetId: link.target_id, targetSlot: link.target_slot });
                        this.#positionalSnapshots.set(absIdx, posConns);
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

        // 適用範囲判定は #isLinkPreserving() に一元化する (#syncAndRestore と同一判定)。
        // link-preserving 経路 (PrimitiveStore / TextCatalog: spec.linkPreserving === true) は
        // 下流端 (target_*) を一切触らず、動的入力下流 (Autogrow 等) を縮小・再採番させずに
        // リンクを維持する。それ以外 (Image/Pipe/Node Collector) は従来の remove-all + connect
        // 再接続経路 (#restoreByReconnect) を維持する。
        if (this.#isLinkPreserving()) {
            this.#restoreLinkPreserving(entities, graph);
            return;
        }
        this.#restoreByReconnect(entities, graph);
    }

    /**
     * 従来の remove-all + connect 再接続による復元 (link-preserving 非対象ノード専用)。
     *
     * 到達するのは spec.linkPreserving !== true のノード:
     * - NodeCollector (1:N, resolver 定義済): snapshot 1 件ごとに段階1/2/3 で localSlotIdx を解決する
     *   (旧 `_restoreDownstream` のロジック準拠)。
     * - Image/Pipe Collector (固定出力, resolver 未定義): 段階3 (ds.localSlotIdx をそのまま採用) で
     *   従来通り全出力 slot を remove-all → connect 再接続する (固定出力ピンは破壊しない)。
     * 1:1 link-preserving 経路は #restoreLinkPreserving に分離済。
     *
     * @param {object[]} entities
     * @param {object} graph
     */
    #restoreByReconnect(entities, graph) {
        // 本経路は spec.linkPreserving !== true のノードのみ到達する。positional fallback (G1) は
        // 1:1 link-preserving 専用のため #restoreLinkPreserving 側で処理し、本経路では使わない。

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

            // resolver の有無で段階3 (ds.localSlotIdx 直接採用) の扱いが変わる。
            // NodeCollector (resolver 定義済) は段階1/2 で解決し、失敗時は skip (誤接続防止)。
            // Image/Pipe Collector (resolver 未定義) は段階3 で ds.localSlotIdx をそのまま採用する
            // (固定出力に対し localSlotIdx は capture 時点の物理位置と一致、旧 _restoreDownstream 互換)。
            const hasResolvers
                = typeof this.#spec.resolveLocalSlotBySlotName === "function"
                || typeof this.#spec.resolveLocalSlotByGlobalIdx === "function";

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
                // 段階 3: resolver 未定義 (Image/Pipe Collector) は ds.localSlotIdx を直接採用する。
                // resolver 定義済 (NodeCollector) で段階1/2 が両方失敗した場合は skip し誤接続を防ぐ
                // (enabledSlots 編集で globalIdx が消失したケース)。
                if (localSlotIdx < 0) {
                    if (hasResolvers) continue;
                    localSlotIdx = ds.localSlotIdx;
                }
                if (localSlotIdx < 0) continue;

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
     * 1:1 output 専用の link-preserving 再構築 (恒久対策の中核)。
     *
     * 生存 entity の下流リンクは「上流端 (出力ピン = origin_slot) だけ in-place 付け替え」し、
     * 下流端 (target_id / target_slot / 下流 inputs[].link) を一切触らない。これにより
     * 下流の動的入力 (Autogrow 等) は onConnectionsChange を受けず縮小・再採番しない。
     * LiteGraph 自身が decrementSlots で行う native パターンであり、asSerialisable は live
     * フィールド直読みのため保存にも反映される。
     *
     * 手順 (D11 純粋関数 computeLinkRepointPlan で写像を計算 → 本メソッドが副作用適用):
     *   1. 削除 entity の下流リンクのみ graph.removeLink (切れてよい唯一の対象)
     *   2. 生存 entity 数までピン成長 (末尾 addOutput、既存ピン/リンク不変)
     *   3. 各生存 link の graph.links[linkId].origin_slot を新ピン index へ in-place 代入
     *   4. 各 outputs[i].links を graph.links から再構築 (順序非依存・reorder 交差に対応)
     *   5. 縮小は必ず末尾 (最高 index) から removeOutput (native origin_slot-- 再採番が
     *      発火しない位置のため二重補正を回避)
     *   6. syncSlotStructure で name/type/widget value/size を更新 (ピン数は一致済で while no-op)
     *   7. identity 破壊 entity (id 未採番) は G1 positional fallback で救済
     *
     * @param {object[]} entities  mutation 後の entity 配列 (新順序)
     * @param {object} graph       LiteGraph グラフ
     */
    #restoreLinkPreserving(entities, graph) {
        const node = this.#node;
        const links = graph.links ?? {};

        // 写像計算 (app 非依存の純粋関数)。capture と restore の間に link が外部で
        // 変化した場合に備え、生存確認は副作用適用フェーズで再度行う。
        // computeLinkRepointPlan は invariant として「同一 linkId が repoints と
        // linksToRemove の両方に入らない」ことを保証する (削除 entity と生存 entity は
        // entity identity で排他のため。詳細は computeLinkRepointPlan のコメント参照)。
        const plan = computeLinkRepointPlan({
            entities,
            entityIds: this.#entityIds,
            linkSnapshots: this.#linkSnapshots,
            graphLinks: links,
            nodeId: node.id,
        });

        // 主要手順を try/catch で包み、例外時に診断ログを出してから re-throw する
        // (呼出側の atomic rollback / cleanup を妨げない)。
        try {
            // 手順1: 削除 entity の下流リンクを除去 (切れてよい唯一の対象)。
            // ゴーストリンク防御: graph.removeLink が未定義/非関数でも、除去対象 linkId は
            // 手順4 の linksByPin 再構築から確実に除外する (removedLinkIds)。これにより
            // 「graph.links から消えないのに outputs[].links から外れる/その逆」の不整合を防ぐ。
            const removedLinkIds = new Set();
            for (const linkId of plan.linksToRemove) {
                removedLinkIds.add(linkId);
                if (typeof graph.removeLink === "function") {
                    graph.removeLink(linkId);
                }
            }

            // 手順2: 生存 entity 数までピンを末尾成長 (既存ピン/リンク不変・下流影響ゼロ)。
            while ((node.outputs?.length ?? 0) < entities.length) {
                node.addOutput?.("", "*");
            }

            // 手順3: 生存 link の origin_slot を新ピン index へ in-place 付け替え。
            // 生存確認 (links[linkId] が依然存在) を維持する。
            for (const rp of plan.repoints) {
                const link = links[rp.linkId];
                if (!link) continue;
                link.origin_slot = rp.newOriginSlot;
            }

            // 手順4: 各 outputs[i].links を graph.links から再構築する。
            // 「このノードが origin かつ origin_slot===i の生存 linkId」を集約する。
            // 旧/新ピンが交差する reorder でも順序非依存に整合する。
            // 重要: 現存する**全**ピン (縮小予定の末尾ピンを含む) を対象に再構築する。
            // 生存 link は手順3 で newPin (< newPinCount) へ origin_slot を移動済みのため、
            // 縮小予定の末尾ピンには生存 link が割り当たらず .links が空になる。これにより
            // 手順5 の removeOutput が生存 link を誤って removeLink する事故を防ぐ
            // (末尾ピンに stale な旧 .links 配列が残ると removeOutput がそれを切ってしまう)。
            // removedLinkIds の linkId は (removeLink 不発でも) ここで除外しゴーストを防ぐ。
            const newPinCount = entities.length;
            const linksByPin = new Map();
            for (const link of Object.values(links)) {
                if (link?.origin_id !== node.id) continue;
                if (removedLinkIds.has(link.id)) continue;
                const slot = link.origin_slot;
                const arr = linksByPin.get(slot) ?? [];
                arr.push(link.id);
                linksByPin.set(slot, arr);
            }
            const currentPinCount = node.outputs?.length ?? 0;
            for (let i = 0; i < currentPinCount; i++) {
                if (!node.outputs?.[i]) continue;
                // in-place 代入: outputs[].links を新配列に置換する (LiteGraph も
                // decrementSlots 等で配列を作り直す)。当ノード外参照は保持されない。
                node.outputs[i].links = linksByPin.get(i) ?? [];
            }

            // 手順5: 縮小は必ず末尾 (最高 index) から行う。
            // 末尾ピンは手順4 で生存リンクを移動済みのため links は空 →
            // removeOutput の disconnectOutput は空振り、native origin_slot-- 再採番も
            // 「除去 index より後ろ」が無いため発火しない (二重補正回避の要)。
            while ((node.outputs?.length ?? 0) > newPinCount) {
                node.removeOutput?.(node.outputs.length - 1);
            }

            // 手順6: name/type/widget value/size を更新 (ピン数一致済で while は no-op)。
            this.#spec.syncSlotStructure();

            // 手順7: identity 破壊 entity (id 未採番) かつ slot 数不変時のみ、
            // 同一物理位置の positional snapshot で救済する (G1 階層化・下位 fallback)。
            // identity 生存 entity は手順3/4 の in-place 再ポイントで既に処理済のため
            // ここでは positional を発火させない。
            if ((node.outputs?.length ?? 0) === this.#capturedSlotCount) {
                let baseOffset = 0;
                for (const entity of entities) {
                    const id = this.#entityIds.get(entity);
                    if (id === undefined) {
                        this.#restorePositional(baseOffset, 1, graph);
                    }
                    baseOffset += 1;
                }
            }
        } catch (e) {
            console.warn("[SAX_Bridge] #restoreLinkPreserving failed:", e);
            throw e;
        }
    }

    /**
     * G1: entity identity 解決失敗時の positional fallback。
     * baseOffset から slotCount 分の物理スロットを、capture 時の同一 absIdx に記録した
     * positional snapshot で再接続する。1:1 output・slot 数不変時のみ #restoreFromSnapshots から呼ばれる。
     *
     * @param {number} baseOffset  entity の先頭物理スロット位置
     * @param {number} slotCount   entity が占める物理スロット数 (1:1 なら 1)
     * @param {object} graph       LiteGraph グラフ
     */
    #restorePositional(baseOffset, slotCount, graph) {
        for (let localSlotIdx = 0; localSlotIdx < slotCount; localSlotIdx++) {
            const absIdx = baseOffset + localSlotIdx;
            const posConns = this.#positionalSnapshots.get(absIdx);
            if (!posConns?.length) continue;
            for (const pc of posConns) {
                const targetNode = graph.getNodeById?.(pc.targetId);
                if (targetNode && this.#node.outputs?.[absIdx]) {
                    this.#node.connect?.(absIdx, targetNode, pc.targetSlot);
                }
            }
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
 * @typedef {object} LinkRepointPlanInput
 * @property {object[]} entities
 *           mutation 後の entity 配列 (新順序)。各 entity の新ピン index = 配列内 index (1:1)。
 * @property {WeakMap<object, number>} entityIds
 *           entity → 内部 ID。identity 生存判定に使う (id 未取得 = identity 破壊)。
 * @property {Map<number, Array<{ linkId: number }>>} linkSnapshots
 *           capture 済み snapshot。id → 接続情報 (linkId を含む)。
 * @property {object} graphLinks
 *           graph.links (id → link)。生存 link 判定に使う。
 * @property {number} nodeId
 *           当ノードの id。
 */

/**
 * @typedef {object} LinkRepointPlan
 * @property {Array<{ linkId: number, newOriginSlot: number }>} repoints
 *           生存 entity の生存 link を新ピン index へ付け替える指示。
 * @property {number[]} linksToRemove
 *           削除 entity (capture 時に存在し新配列に無い) の下流リンク id。
 */

/**
 * 1:1 link-preserving 再構築の写像を計算する純粋関数 (app 非依存・D11)。
 *
 * 副作用を持たず、入力から「どの link をどの新ピンへ再ポイントするか」「どの link を
 * 削除するか」を算出する。LiteGraph や app への依存はないため単体テスト可能。
 *
 * アルゴリズム:
 *   1. 新 entity 配列を走査し、identity 解決成功 (entityIds.get(entity) 定義済) かつ
 *      snapshot ありの entity を「生存」とみなし、その linkId 群を新ピン index へ repoint。
 *   2. snapshot を持つが新配列に生存しない id (= 削除された entity の id) の linkId 群を
 *      linksToRemove に集約する。
 *   3. 生存判定・削除判定とも graphLinks に依然存在する linkId のみ対象とする
 *      (capture と restore の間に外部で消えた link は無視)。
 *
 * Invariant: 同一 linkId が repoints と linksToRemove の両方に入らない。
 *   - repoints は aliveId (生存 entity) の linkId のみ。
 *   - linksToRemove は !aliveId の id の linkId のみ。
 *   両者は entity id で排他のため通常は交差しないが、想定外の snapshot 重複に対する
 *   防御として、linksToRemove に積む前に repoints の linkId を除外する。
 *
 * @param {LinkRepointPlanInput} input
 * @returns {LinkRepointPlan}
 */
export function computeLinkRepointPlan(input) {
    const { entities, entityIds, linkSnapshots, graphLinks, nodeId } = input;
    const links = graphLinks ?? {};

    const repoints = [];
    const aliveIds = new Set();

    for (let newPin = 0; newPin < entities.length; newPin++) {
        const entity = entities[newPin];
        const id = entityIds.get(entity);
        if (id === undefined) continue; // identity 破壊 → G1 positional fallback に委譲
        const conns = linkSnapshots.get(id);
        if (!conns?.length) {
            // snapshot ありで link なしの生存 entity も aliveId として記録する
            // (id がある = 生存。下記の削除判定から除外する)。
            if (linkSnapshots.has(id)) aliveIds.add(id);
            continue;
        }
        aliveIds.add(id);
        for (const ds of conns) {
            const linkId = ds.linkId;
            if (linkId == null) continue;
            const link = links[linkId];
            if (!link || link.origin_id !== nodeId) continue;
            repoints.push({ linkId, newOriginSlot: newPin });
        }
    }

    // 削除 entity の link を集約する: snapshot を持つが生存していない id。
    // 防御: repoints に積んだ linkId は (invariant 上発生しないが) linksToRemove から除外し、
    // 生存 link を誤って removeLink する事故を防ぐ。
    const repointedLinkIds = new Set(repoints.map(rp => rp.linkId));
    const linksToRemove = [];
    for (const [id, conns] of linkSnapshots) {
        if (aliveIds.has(id)) continue;
        for (const ds of conns ?? []) {
            const linkId = ds.linkId;
            if (linkId == null) continue;
            if (repointedLinkIds.has(linkId)) continue;
            if (links[linkId]) linksToRemove.push(linkId);
        }
    }

    return { repoints, linksToRemove };
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
