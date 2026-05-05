// DynamicSlotCoordinator — Phase 1.2.A.0
//
// 動的スロットの mutation トランザクション (capture → action → sync → restore) を
// 集約する Coordinator API。
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
// - docs/plans/20260506-ui-phase1-1-coordinator-api-freeze.md (TODO 4)
// - docs/plans/20260504-ui-phase1-0-coordinator-prototype.md (子プラン)
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
     * @type {Map<number, Array<{ targetId: number, targetSlot: number }>>}
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
        this.#captureSnapshots(entitiesBefore);

        this.#hints = options.entityHints ?? null;

        // action 実行 + syncSlotStructure
        const capturedEntityIds = this.#collectCapturedIds(entitiesBefore);
        let didScheduleAsync = false;
        // 非同期 restore に切り替わるケースで、setTimeout コールバックが完了するまで
        // #hints を生存させる必要があるため、同期スコープでローカル変数に退避する。
        const hintsForAsync = this.#hints;

        // action 例外時は link 復元情報を保持したまま hints のみクリアして再スロー (CR-2-M1)
        let actionError = null;
        try {
            action(this.#spec.getEntities());
        } catch (e) {
            actionError = e;
        }

        if (actionError !== null) {
            this.#hints = null;
            throw actionError;
        }

        try {
            // 内蔵実装パス
            this.#spec.syncSlotStructure();
            const slotCountAfter = this.#getSlotCount();
            const slotCountChanged = slotCountAfter !== slotCountBefore;

            if (slotCountChanged) {
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
     * 1:1 (PrimitiveStore) を前提とした現状スロット接続のスナップショット記録。
     * direction に応じて outputs / inputs 側を読み出す。Phase 1.0 では PrimitiveStore のみ
     * 想定するため 1:N (NodeCollector の enabledSlots) は Phase 1.1 で対応する。
     *
     * @param {object[]} entities
     */
    #captureSnapshots(entities) {
        if (this.#spec.direction !== "output") {
            // input 方向は Phase 1.1 以降で実装。現状は capture/restore せずに通過させる。
            return;
        }
        const outputs = this.#node.outputs ?? [];
        const graphLinks = globalThis.app?.graph?.links ?? null;
        // 防御コード (NEW3-MEDIUM-1): ループ途中例外時に部分書込みスナップショットを cleanup する。
        const writtenIds = [];
        try {
            for (let i = 0; i < entities.length; i++) {
                const entity = entities[i];
                const id = this.#getOrCreateId(entity);
                const slot = outputs[i];
                const linkIds = slot?.links ?? [];
                const conns = [];
                for (const linkId of linkIds) {
                    const link = graphLinks?.[linkId];
                    if (link) conns.push({ targetId: link.target_id, targetSlot: link.target_slot });
                }
                this.#linkSnapshots.set(id, conns);
                writtenIds.push(id);
            }
        } catch (e) {
            for (const id of writtenIds) this.#cleanupSnapshot(id);
            throw e;
        }
    }

    /**
     * #linkSnapshots に記録された接続を復元する。Phase 1.0 では entity → 現在のスロット index の
     * 解決を「現 getEntities() 内での順序 index」で行う (1:1 前提)。
     */
    #restoreFromSnapshots() {
        if (this.#spec.direction !== "output") return;
        const entities = this.#spec.getEntities();
        const graph = globalThis.app?.graph ?? null;
        if (!graph) return;

        // 既存リンクをクリアしてから再接続
        const outputs = this.#node.outputs ?? [];
        for (let i = 0; i < outputs.length; i++) {
            const links = outputs[i]?.links ?? [];
            for (const linkId of [...links]) {
                graph.removeLink?.(linkId);
            }
        }

        for (let i = 0; i < entities.length; i++) {
            const id = this.#entityIds.get(entities[i]);
            if (id === undefined) continue;
            const conns = this.#linkSnapshots.get(id);
            if (!conns?.length) continue;
            for (const conn of conns) {
                const targetNode = graph.getNodeById?.(conn.targetId);
                if (targetNode && this.#node.outputs?.[i]) {
                    this.#node.connect?.(i, targetNode, conn.targetSlot);
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
