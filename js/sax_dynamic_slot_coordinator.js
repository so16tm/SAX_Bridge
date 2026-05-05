// DynamicSlotCoordinator — Phase 1.0 プロトタイプ
//
// 動的スロットの mutation トランザクション (capture → action → sync → restore) を
// 集約する Coordinator API。子プラン論点 1 (capture 戦略=候補 D) と論点 2
// (restore タイミング=候補 C: action 種別による使い分け) の暫定判定を実装する。
//
// 参照プラン:
// - docs/plans/20260504-ui-phase1-0-coordinator-prototype.md (子プラン)
// - docs/plans/20260503-ui-architecture-overhaul.md (親プラン)
//
// Phase 1.0 期間中は wrapper として動作する。spec.captureLinksRaw /
// spec.restoreLinksRaw が渡された場合は、Coordinator 内蔵実装の代わりに
// それらを呼び出す。これにより既存 captureOutputLinks / restoreOutputLinks の
// 振る舞いをそのまま流用しつつ、トランザクション境界 (try/finally で snapshot
// cleanup) を Coordinator が管理する。
//
// `_links` の items 直接埋込解消 (内部 Map への完全移行) と
// captureLinksRaw / restoreLinksRaw フィールド削除は Phase 1.1 で実施する。

/**
 * @typedef {object} CoordinatorSpec
 * @property {"input" | "output"} direction
 *           動的スロットの方向。"output" は PrimitiveStore / TextCatalog のような出力スロット可変ノード、
 *           "input" は Collector 系の入力スロット可変ノード。
 * @property {() => object[]} getEntities
 *           現状の entity 配列を返すコールバック。entity は items / sources など各ノードの最小単位。
 *           identity 維持が前提 (WeakMap ベース ID 採番のため、毎回新しい配列を返してはならず、
 *           既存 entity オブジェクトを参照すること)。
 * @property {(entity: object, baseOffset: number) => Array<{ name: string, type: string }>} entityToSlots
 *           entity を slot 構造 (name / type のリスト) に変換する純粋関数。
 *           1:1 (PrimitiveStore) / 1:N (NodeCollector) 両方を表現できる。
 *           baseOffset は当該 entity の slot が始まる絶対 index。
 *           Phase 1.0 の PrimitiveStore では参照されないが API として保持する。
 * @property {() => void} syncSlotStructure
 *           getEntities() / entityToSlots() の現状値に従い、node.outputs / node.inputs の数・name・type を
 *           実際に揃える同期関数。LiteGraph の addInput/addOutput/removeInput/removeOutput を呼ぶ責任を持つ。
 * @property {(newEntities: object[]) => void} [setEntities]
 *           commitState で entity 配列全体を差し替えるための setter。利用側で
 *           `node._primitiveItems = newEntities` のような差し替えを行う。
 *           Phase 1.0 で PrimitiveStore は commitState を使わないが API として保持する。
 * @property {(entities: object[]) => void} [captureLinksRaw]
 *           Phase 1.0 wrapper 用フィールド。Coordinator 内部の capture 実装ではなく
 *           既存 captureOutputLinks 等を呼ぶための逃げ口。Phase 1.1 で削除予定。
 *           @deprecated Phase 1.1 で削除予定
 * @property {(entities: object[], syncFn: () => void) => void} [restoreLinksRaw]
 *           Phase 1.0 wrapper 用フィールド。既存 restoreOutputLinks 等を呼ぶ。
 *           Phase 1.1 で削除予定。
 *           @deprecated Phase 1.1 で削除予定
 *
 * @typedef {object} MutateOptions
 * @property {Map<object, object>} [entityHints]
 *           entity 単位の hint。NodeCollector の `_rebuildHints` 機構を一般化したもの。
 *           mutate トランザクションスコープ内でのみ参照され、終了時に破棄される。
 *           Phase 1.0 では受け取って #hints に保持し syncSlotStructure 完了時に null クリアするのみ。
 *           本格利用は TextCatalog / NodeCollector 移行 (Phase 1.2) で行う。
 * @property {boolean} [skipCapture]
 *           true の場合、capture/restore をスキップする。SEED 自動ランダム化のように
 *           値のみ変わり slot 構造が不変な mutation で利用する。
 */

/**
 * 動的スロットの mutation トランザクションを集約する Coordinator。
 *
 * Phase 1.0 プロトタイプ。spec.captureLinksRaw / spec.restoreLinksRaw が渡されている
 * 場合は Coordinator 内部実装の代わりにそれらを呼び、wrapper として振る舞う。
 *
 * Phase 1.0 スコープ外:
 * - `_links` 内部 Map への完全移行 (Phase 1.1)
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
     * mutate スコープ内でのみ生存する entityHints (論点 9 暫定判定: Map 引数方式)。
     * action 開始時にセットし、syncSlotStructure 完了時に null クリアする。
     * @type {Map<object, object> | null}
     */
    #hints = null;

    /**
     * 直前に captureFromExisting() が呼ばれたかを示すフラグ。
     * applyAfterCapture の CR-H1 guard で利用。wrapper モードでは
     * captureLinksRaw 経由の capture でも #linkSnapshots は更新されないため
     * (TR-M3: 非対称性、Phase 1.1 で解消)、capture 実施シグナルを別途保持する。
     * applyAfterCapture 完了時に false に戻す (1 回の capture を 1 回の apply で消費する semantics)。
     * @type {boolean}
     */
    #captureCalled = false;

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
            // 値のみ変更で slot 構造不変。capture/restore 不要。
            const entities = this.#spec.getEntities();
            this.#hints = options.entityHints ?? null;
            try {
                action(entities);
                this.#spec.syncSlotStructure();
            } finally {
                this.#hints = null;
            }
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
        // 子プラン論点 2 (L156-158) の「entityHints は setTimeout コールバック完了まで延命」要件。
        // Phase 1.0 では #hints は実利用されないが、Phase 1.1 でバグ化しないよう設計時点で整合させる。
        const hintsForAsync = this.#hints;
        try {
            action(this.#spec.getEntities());

            if (this.#spec.restoreLinksRaw) {
                // Phase 1.0 wrapper: 既存 restoreOutputLinks に委譲。
                // restoreOutputLinks は内部で removeLink → syncFn → setTimeout(0) で再接続するため
                // Coordinator 側は同期スコープでは syncSlotStructure を呼ばず restoreLinksRaw に任せる。
                this.#spec.restoreLinksRaw(this.#spec.getEntities(), this.#spec.syncSlotStructure);
                // wrapper モードでは setTimeout 内で再接続が走るため snapshot cleanup も非同期に予約
                didScheduleAsync = true;
                setTimeout(() => {
                    // 非同期スコープで #hints を復元 → cleanup → 最後にクリア
                    this.#hints = hintsForAsync;
                    try {
                        for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                    } finally {
                        this.#hints = null;
                    }
                }, 0);
            } else {
                // 内蔵実装パス。Phase 1.1 で完全実装に切り替え予定。
                this.#spec.syncSlotStructure();
                const slotCountAfter = this.#getSlotCount();
                const slotCountChanged = slotCountAfter !== slotCountBefore;

                if (slotCountChanged) {
                    didScheduleAsync = true;
                    setTimeout(() => {
                        // 非同期 restore は子プラン論点 2 の延命要件に従い hints を復元してから実行
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
            }
        } finally {
            // 同期 restore 経路ではこの finally で #hints をクリアし snapshot cleanup する。
            // 非同期 restore 経路 (didScheduleAsync=true) では setTimeout コールバック側で
            // #hints 復元 → cleanup → クリアを行うため、ここではいずれも実行しない。
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
        if (this.#spec.captureLinksRaw) {
            this.#spec.captureLinksRaw(entities);
            // wrapper モードでは items[i]._links 側に書き込むため、内部スナップショット採番のみ行う
            for (const entity of entities) this.#getOrCreateId(entity);
            this.#captureCalled = true;
            return;
        }
        this.#captureSnapshots(entities);
        this.#captureCalled = true;
    }

    /**
     * 直前に captureFromExisting() を呼んだ前提で、entity 配列差し替え + sync + restore を実行する。
     * makeItemListWidget の `beforeModify → in-place mutation → saveItems` 動作モデル
     * (Phase 1.0 wrapper 期間中) に対応するための便宜 API。
     *
     * 利用フロー:
     *   1. makeItemListWidget の beforeModify で coordinator.captureFromExisting() を呼ぶ
     *   2. makeItemListWidget が items 配列を in-place mutation する
     *   3. saveItems で coordinator.applyAfterCapture(newItems) を呼ぶ
     *
     * Phase 1.1 で makeItemListWidget 自体を Coordinator 認識に書き換える際、
     * 上記 2 フェーズを mutate(action) 1 個に畳む。本メソッドはその移行期限定 API。
     *
     * @param {object[]} newEntities  新しい entity 配列 (setEntities でノードに反映)
     * @throws {Error} spec.setEntities が定義されていない場合
     */
    applyAfterCapture(newEntities) {
        if (typeof this.#spec.setEntities !== "function") {
            throw new Error("DynamicSlotCoordinator.applyAfterCapture requires spec.setEntities");
        }

        // CR-H1 guard: 直前に captureFromExisting() が呼ばれていない場合、
        // wrapper モードでは restoreLinksRaw を呼ばず syncSlotStructure のみ実行する。
        // onPopup / param drag / leftElements onClick 経路 (beforeModify なし) はこのパスを通る。
        // これにより値変更のみで slot 構造不変なケースで既存 link を誤削除しない。
        // (wrapper モードでは captureFromExisting でも #linkSnapshots は更新されないため、
        // capturedEntityIds 数ではなく明示的な #captureCalled フラグで判定する。TR-M3 参照)
        if (!this.#captureCalled && this.#spec.restoreLinksRaw) {
            this.#spec.setEntities(newEntities);
            this.#spec.syncSlotStructure();
            return;
        }

        const capturedEntityIds = this.#collectCapturedIds(this.#spec.getEntities());
        // slotCountBefore は内蔵実装パス (restoreLinksRaw 未指定) でのみ利用する。
        // wrapper モード (restoreLinksRaw あり) では restoreOutputLinks が内部で
        // setTimeout(0) を予約するため、Coordinator 側で slot 数差分を判定する必要はない。
        const slotCountBefore = this.#spec.restoreLinksRaw ? null : this.#getSlotCount();
        let didScheduleAsync = false;
        try {
            this.#spec.setEntities(newEntities);
            if (this.#spec.restoreLinksRaw) {
                this.#spec.restoreLinksRaw(this.#spec.getEntities(), this.#spec.syncSlotStructure);
                didScheduleAsync = true;
                setTimeout(() => {
                    for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                }, 0);
            } else {
                this.#spec.syncSlotStructure();
                const slotCountAfter = this.#getSlotCount();
                if (slotCountAfter !== slotCountBefore) {
                    didScheduleAsync = true;
                    setTimeout(() => {
                        try {
                            this.#restoreFromSnapshots();
                        } finally {
                            for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                        }
                    }, 0);
                } else {
                    this.#restoreFromSnapshots();
                }
            }
        } finally {
            // applyAfterCapture 完了で capture 状態を消費する (次回 capture が必要)。
            this.#captureCalled = false;
            if (!didScheduleAsync) {
                for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
            }
        }
    }

    /**
     * 外部から entity 配列全体を差し込む。Manager Dialog Save 経路 (TextCatalog) で利用予定。
     * Phase 1.0 では PrimitiveStore で未使用だが API として実装しておく。
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
            this.#hints = options.entityHints ?? null;
            try {
                this.#spec.setEntities(newEntities);
                this.#spec.syncSlotStructure();
            } finally {
                this.#hints = null;
            }
            return;
        }

        const entitiesBefore = this.#spec.getEntities();
        // slotCountBefore は内蔵実装パスでのみ利用 (wrapper モードでは未使用)。
        const slotCountBefore = this.#spec.restoreLinksRaw ? null : this.#getSlotCount();
        this.#captureSnapshots(entitiesBefore);
        const capturedEntityIds = this.#collectCapturedIds(entitiesBefore);

        this.#hints = options.entityHints ?? null;
        let didScheduleAsync = false;
        // mutate と同様、非同期 restore 経路向けに #hints を退避する (子プラン論点 2 整合)。
        const hintsForAsync = this.#hints;
        try {
            this.#spec.setEntities(newEntities);

            if (this.#spec.restoreLinksRaw) {
                this.#spec.restoreLinksRaw(this.#spec.getEntities(), this.#spec.syncSlotStructure);
                didScheduleAsync = true;
                setTimeout(() => {
                    this.#hints = hintsForAsync;
                    try {
                        for (const id of capturedEntityIds) this.#cleanupSnapshot(id);
                    } finally {
                        this.#hints = null;
                    }
                }, 0);
            } else {
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
            }
        } finally {
            // 同期 restore 経路でのみ #hints クリア + cleanup を実行する。
            // 非同期経路では setTimeout コールバック側で行うためここではスキップ。
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
     * WeakMap ベースのため entity が GC されれば ID も自動消失し、メモリリーク・衝突なし。
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
     * mutate / commitState / applyAfterCapture のトランザクション完了時に
     * #linkSnapshots から該当 entityId のスナップショットエントリを削除する。
     *
     * @param {number} entityId
     */
    #cleanupSnapshot(entityId) {
        this.#linkSnapshots.delete(entityId);
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

        // 既存リンクをクリアしてから再接続 (sax_ui_base.js の restoreOutputLinks と同じ方針)
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
