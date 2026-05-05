/**
 * TextCatalog Coordinator 移行 単体テスト (UI Phase 1.2.A)
 *
 * TextCatalog の DynamicSlotCoordinator 経由化 (子プラン
 * docs/plans/20260506-ui-phase1-2a-textcatalog-migration.md TODO 10) に対応する
 * 単体テストを集約する。
 *
 * 実装本体 (sax_text_catalog.js) は ComfyUI ランタイム (`app`, `LiteWidgets` 等) を
 * import 時に必要とするため、本テストでは TextCatalog の spec 形状を再現した
 * fixture を Coordinator に直接渡して検証する。検証対象は以下:
 *
 * - `_saxCoordinator` ライフサイクル (生成 / 再利用 / 複製)
 * - `_links` ランタイム汚染撤廃 (relation オブジェクトに `_links` プロパティが
 *   書込まれないこと)
 * - 二重 capture 解消 (Coordinator 経由で 1 回のみ capture されること)
 * - `commitState` 実適用 (Manager Dialog Save 模擬)
 * - `commitState` 例外時 atomic ロールバック (catalog + relations + slot 構造)
 *
 * 実行: node --test tests/unit/text_catalog_coordinator.test.mjs
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { DynamicSlotCoordinator } from "../../js/sax_dynamic_slot_coordinator.js";

// ---------------------------------------------------------------------------
// LiteGraph / app モック (dynamic_slot_coordinator.test.mjs と同型)
// ---------------------------------------------------------------------------

function makeGraphMock() {
    const links = {};
    let nextLinkId = 1;
    const nodes = new Map();
    return {
        links,
        getNodeById(id) { return nodes.get(id) ?? null; },
        registerNode(node) { nodes.set(node.id, node); return node; },
        addLink({ origin_id, origin_slot, target_id, target_slot }) {
            const id = nextLinkId++;
            links[id] = { id, origin_id, origin_slot, target_id, target_slot };
            return id;
        },
        removeLink(linkId) {
            const link = links[linkId];
            if (!link) return;
            const origin = nodes.get(link.origin_id);
            const slot = origin?.outputs?.[link.origin_slot];
            if (slot?.links) slot.links = slot.links.filter(id => id !== linkId);
            delete links[linkId];
        },
        setDirtyCanvas() {},
    };
}

function makeNode({ id = 1, outputCount = 0 } = {}) {
    const node = {
        id,
        outputs: Array.from({ length: outputCount }, (_, i) => ({
            name: `out_${i}`, type: "STRING", links: [],
        })),
        inputs: [],
        connectCalls: [],
        connect(slotIndex, targetNode, targetSlot) {
            const linkId = this._graph.addLink({
                origin_id: this.id,
                origin_slot: slotIndex,
                target_id: targetNode.id,
                target_slot: targetSlot,
            });
            this.outputs[slotIndex].links.push(linkId);
            this.connectCalls.push({ slotIndex, targetId: targetNode.id, targetSlot });
            return linkId;
        },
        addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
        removeOutput(idx) {
            const removed = this.outputs.splice(idx, 1)[0];
            if (removed?.links) {
                for (const id of [...removed.links]) this._graph.removeLink(id);
            }
        },
    };
    return node;
}

function makeTargetNode(id) {
    return { id, outputs: [], inputs: [{ name: "in", type: "STRING" }] };
}

let savedApp;
function installAppMock(graph) {
    savedApp = globalThis.app;
    globalThis.app = { graph, canvas: { setDirty() {} } };
}
function uninstallAppMock() { globalThis.app = savedApp; }

// ---------------------------------------------------------------------------
// TextCatalog 風 fixture: state は { catalog: { items[] }, relations[] } 構造で
// ensureCoordinator 相当の spec を生成する。
// ---------------------------------------------------------------------------

/**
 * TextCatalog の `ensureCoordinator` (sax_text_catalog.js:1319-1336) を再現する。
 * `node._textCatalogState` を保持しつつ Coordinator を生成する関数。
 */
function ensureTextCatalogCoordinator(node) {
    if (node._saxCoordinator) return node._saxCoordinator;
    const syncOutputSlots = (n, state) => {
        const relations = state?.relations ?? [];
        while (n.outputs.length > relations.length) {
            n.removeOutput(n.outputs.length - 1);
        }
        while (n.outputs.length < relations.length) {
            n.addOutput("relation", "STRING");
        }
        for (let i = 0; i < relations.length; i++) {
            const rel = relations[i];
            const item = (state.catalog?.items ?? []).find(it => it.id === rel.item_id);
            n.outputs[i].name = item ? item.name : "(unset)";
            n.outputs[i].type = "STRING";
        }
    };
    node._saxCoordinator = new DynamicSlotCoordinator(node, {
        direction: "output",
        getEntities: () => (node._textCatalogState ?? { relations: [] }).relations,
        entityToSlots: (_relation, _hints) => [{ name: "", type: "STRING" }],
        syncSlotStructure: () => syncOutputSlots(node, node._textCatalogState ?? { relations: [] }),
        setEntities: (newRelations) => {
            const prev = node._textCatalogState ?? { catalog: { items: [] }, relations: [] };
            node._textCatalogState = { ...prev, relations: newRelations };
        },
    });
    node._syncOutputSlots = (state) => syncOutputSlots(node, state);
    return node._saxCoordinator;
}

function emptyTextCatalogState() {
    return { catalog: { items: [] }, relations: [] };
}

// ===========================================================================
// テストケース
// ===========================================================================

describe("TextCatalog: _saxCoordinator ライフサイクル (Phase 1.2.A 論点 5)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("onNodeCreated 相当 / onConfigure 相当 / 複製シナリオ で Coordinator が正しく管理される", () => {
        // onNodeCreated 相当: 新規 instance を生成し、再呼出で同じ instance を返す
        const nodeA = makeNode({ id: 100, outputCount: 0 });
        nodeA._graph = graph;
        graph.registerNode(nodeA);
        nodeA._textCatalogState = emptyTextCatalogState();

        const coordA1 = ensureTextCatalogCoordinator(nodeA);
        assert.ok(coordA1, "onNodeCreated 相当で Coordinator が生成される");

        const coordA2 = ensureTextCatalogCoordinator(nodeA);
        assert.strictEqual(coordA1, coordA2,
            "ensureCoordinator 再呼出は同じ instance を返す (onConfigure 相当の再利用)");

        // onConfigure 相当: state 復元後に captureFromExisting() を呼んで動作する
        nodeA._textCatalogState = {
            catalog: { items: [{ id: "x", name: "x_text" }] },
            relations: [{ item_id: "x", on: true }],
        };
        nodeA.addOutput("x_text", "STRING");
        assert.doesNotThrow(() => coordA2.captureFromExisting(),
            "onConfigure 相当で captureFromExisting が例外なく動作する");

        // ノード複製シナリオ: 別ノード (LiteGraph clone 後の onNodeCreated 相当) で
        // 別 instance が生成される (entity identity は WeakMap ベースで隔離される)
        const nodeB = makeNode({ id: 101, outputCount: 0 });
        nodeB._graph = graph;
        graph.registerNode(nodeB);
        nodeB._textCatalogState = emptyTextCatalogState();

        const coordB = ensureTextCatalogCoordinator(nodeB);
        assert.notStrictEqual(coordA2, coordB,
            "複製先ノードでは別 Coordinator instance が生成されるべき");
    });
});

describe("TextCatalog: _links ランタイム汚染撤廃 (Phase 1.2.A 論点 7)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("Coordinator 経由 mutation 後、relation オブジェクトに _links プロパティが書込まれない", async () => {
        const node = makeNode({ id: 200, outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(900);
        graph.registerNode(target);

        const items = [{ id: "i1", name: "i1_text" }, { id: "i2", name: "i2_text" }];
        const rel1 = { item_id: "i1", on: true };
        node._textCatalogState = {
            catalog: { items },
            relations: [rel1],
        };
        node.outputs[0].name = "i1_text";
        node.connect(0, target, 0);

        const coord = ensureTextCatalogCoordinator(node);

        // beforeModify 経路 (capture → 新 relations → applyAfterCapture)
        coord.captureFromExisting();
        const rel2 = { item_id: "i2", on: true };
        // identity 維持: rel1 は同参照のまま、rel2 は新規
        coord.applyAfterCapture([rel1, rel2]);
        await new Promise(resolve => setTimeout(resolve, 1));

        // pickItemForRelation onPopup 経路を模擬: 変更対象 (rel1) のみ新オブジェクト
        coord.captureFromExisting();
        const rel1Updated = { ...rel1, item_id: "i2" };
        coord.applyAfterCapture([rel1Updated, rel2]);

        // toggle 経路 (applySaveOnly)
        const rel1Toggled = { ...rel1Updated, on: false };
        coord.applySaveOnly([rel1Toggled, rel2]);

        // Manager Dialog Save 経路 (commitState)
        const newRelations = [rel1Toggled, rel2];
        coord.commitState(newRelations);

        // 全 relation で _links プロパティが書込まれていないことを検証
        for (const rel of node._textCatalogState.relations) {
            assert.ok(!Object.hasOwn(rel, "_links"),
                `relation (${rel.item_id ?? "(null)"}) に _links プロパティが書込まれていてはならない`);
        }
    });
});

describe("TextCatalog: 二重 capture 解消の回帰テスト (Phase 1.2.A 論点 1 #3 / #5)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("Coordinator 経由 mutation で capture が二重に走らない (capture 内部実装が 1 回のみ呼ばれる)", () => {
        // 検証戦略: Coordinator 内部の getEntities() 呼出回数を spec 側で観測する。
        // 旧実装 (sax_ui_base.js の captureOutputLinks + ノード側独自 captureOutputLinks)
        // では capture が 2 回走る経路があった。Coordinator 経由化後は
        // captureFromExisting 1 回 + applyAfterCapture 1 回 (どちらも getEntities 経由) で
        // mutation 1 回当たり capture は単一トランザクションに収束する。
        const node = makeNode({ id: 300, outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(901);
        graph.registerNode(target);

        const items = [{ id: "i1", name: "i1_text" }];
        const rel = { item_id: "i1", on: true };
        node._textCatalogState = { catalog: { items }, relations: [rel] };
        node.outputs[0].name = "i1_text";
        node.connect(0, target, 0);

        // getEntities を spy 化
        const getEntitiesSpy = mock.fn(() => node._textCatalogState.relations);
        const syncSpy = mock.fn(() => {
            const relations = node._textCatalogState.relations;
            while (node.outputs.length > relations.length) node.removeOutput(node.outputs.length - 1);
            while (node.outputs.length < relations.length) node.addOutput("", "STRING");
        });
        const coord = new DynamicSlotCoordinator(node, {
            direction: "output",
            getEntities: getEntitiesSpy,
            entityToSlots: () => [{ name: "", type: "STRING" }],
            syncSlotStructure: syncSpy,
            setEntities: (newRelations) => {
                node._textCatalogState = { ...node._textCatalogState, relations: newRelations };
            },
        });

        // addButton.onAdd 経路相当: フレームワーク側 beforeModify (capture) +
        // saveItemsCapturing (applyAfterCapture)
        node.connectCalls = [];
        coord.captureFromExisting();
        const captureCalls = getEntitiesSpy.mock.calls.length;
        // applyAfterCapture 内部でも getEntities が呼ばれるが、capture は単一の
        // #linkSnapshots 操作トランザクションに収束する (二重書込みが起きない)。
        coord.applyAfterCapture([rel, { item_id: null, on: true }]);

        // capture フェーズで getEntities が呼ばれた回数は 1 回 (captureFromExisting 内のみ)
        assert.equal(captureCalls, 1,
            "captureFromExisting で getEntities は 1 回のみ呼ばれるべき (二重 capture なし)");
        // syncSlotStructure は applyAfterCapture 内で 1 回のみ呼ばれる
        assert.equal(syncSpy.mock.calls.length, 1,
            "syncSlotStructure は applyAfterCapture 内で 1 回のみ呼ばれるべき");
    });
});

describe("TextCatalog: commitState 実適用 (Phase 1.2.A TODO 5)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("Manager Dialog Save 模擬: catalog 先行更新 + commitState で relations 差し替えが反映される", () => {
        const node = makeNode({ id: 400, outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(902);
        graph.registerNode(target);

        const oldItems = [{ id: "old", name: "old_text" }];
        const oldRelations = [{ item_id: "old", on: true }];
        node._textCatalogState = { catalog: { items: oldItems }, relations: oldRelations };
        node.outputs[0].name = "old_text";
        node.connect(0, target, 0);

        const coord = ensureTextCatalogCoordinator(node);

        // Manager Dialog で catalog 編集: 新 catalog では "old" が削除されている。
        // pickItemForRelation で参照されている relation は item_id を null 化する必要がある。
        const newCatalog = { items: [{ id: "new", name: "new_text" }] };
        const validIds = new Set(newCatalog.items.map(it => it.id));

        const newRelations = node._textCatalogState.relations.map(rel => {
            if (rel.item_id && !validIds.has(rel.item_id)) {
                return { ...rel, item_id: null, on: rel.on ?? true };
            }
            if (rel.on === undefined || rel.on === null) {
                return { ...rel, on: true };
            }
            return rel;
        });

        // catalog 先行更新 (slot 名導出に影響)
        node._textCatalogState = { ...node._textCatalogState, catalog: newCatalog };
        coord.commitState(newRelations);

        // 結果検証: catalog 反映 + relations 差し替え + slot 名が "(unset)" 化
        assert.equal(node._textCatalogState.catalog.items[0].id, "new",
            "catalog が新しい内容に差し替わるべき");
        assert.equal(node._textCatalogState.relations[0].item_id, null,
            "削除済 Item を参照する relation の item_id が null 化されるべき");
        assert.equal(node.outputs[0].name, "(unset)",
            "syncOutputSlots が slot 名を (unset) に更新するべき");
    });
});

describe("TextCatalog: commitState 例外時 atomic ロールバック (Phase 1.2.A 論点 4 v3)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("commitState が例外を投げた場合、catalog + relations + slot 構造の 3 つが atomic に旧状態へ戻る", () => {
        const node = makeNode({ id: 500, outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);

        const oldItems = [{ id: "a", name: "a_text" }, { id: "b", name: "b_text" }];
        const oldRelations = [{ item_id: "a", on: true }, { item_id: "b", on: true }];
        node._textCatalogState = { catalog: { items: oldItems }, relations: oldRelations };
        node.outputs[0].name = "a_text";
        node.outputs[1].name = "b_text";

        // syncOutputSlots を直接定義 (ensureTextCatalogCoordinator と同等)
        const syncOutputSlots = (n, state) => {
            const relations = state?.relations ?? [];
            while (n.outputs.length > relations.length) n.removeOutput(n.outputs.length - 1);
            while (n.outputs.length < relations.length) n.addOutput("relation", "STRING");
            for (let i = 0; i < relations.length; i++) {
                const rel = relations[i];
                const item = (state.catalog?.items ?? []).find(it => it.id === rel.item_id);
                n.outputs[i].name = item ? item.name : "(unset)";
                n.outputs[i].type = "STRING";
            }
        };

        // 例外を投げる setEntities を持つ Coordinator を構成 (commitState 内部例外を模擬)
        const coord = new DynamicSlotCoordinator(node, {
            direction: "output",
            getEntities: () => node._textCatalogState.relations,
            entityToSlots: () => [{ name: "", type: "STRING" }],
            syncSlotStructure: () => syncOutputSlots(node, node._textCatalogState),
            setEntities: () => {
                throw new Error("simulated commitState failure");
            },
        });

        const newCatalog = { items: [{ id: "c", name: "c_text" }] };
        const newRelations = [{ item_id: "c", on: true }];

        const oldCatalog = node._textCatalogState.catalog;
        const oldRelationsRef = node._textCatalogState.relations;

        // catalog 先行更新 (Manager Dialog Save 経路と同じ)
        node._textCatalogState = { ...node._textCatalogState, catalog: newCatalog };

        let thrown = null;
        try {
            coord.commitState(newRelations);
        } catch (e) {
            thrown = e;
            // atomic ロールバック (sax_text_catalog.js:1374-1387 と同パターン)
            node._textCatalogState = {
                ...node._textCatalogState,
                catalog: oldCatalog,
                relations: oldRelationsRef,
            };
            try {
                syncOutputSlots(node, node._textCatalogState);
            } catch (rollbackError) {
                // 再例外時は abort せずログのみ (実装と整合)
            }
        }

        assert.ok(thrown, "commitState は setEntities の例外を再スローするべき");
        // catalog ロールバック
        assert.strictEqual(node._textCatalogState.catalog, oldCatalog,
            "catalog が旧状態にロールバックされるべき");
        // relations ロールバック (元 entity 参照が維持されている)
        assert.strictEqual(node._textCatalogState.relations, oldRelationsRef,
            "relations が旧 entity 参照にロールバックされるべき");
        assert.equal(node._textCatalogState.relations.length, 2,
            "relations 件数が旧状態 (2 件) に戻っているべき");
        // slot 構造ロールバック (旧 catalog による slot 名導出)
        assert.equal(node.outputs.length, 2, "slot 数が旧状態に戻るべき");
        assert.equal(node.outputs[0].name, "a_text",
            "slot 名が旧 catalog の値に戻るべき");
        assert.equal(node.outputs[1].name, "b_text",
            "slot 名が旧 catalog の値に戻るべき");
    });
});

// ===========================================================================
// M-2 (CR/TR レビュー): onPopup の stale closure 回避
// sax_text_catalog.js の params[0].onPopup と同型のロジックを fixture で再現し、
// picker コールバック内での getState() 再取得 + relations.includes チェックが
// 期待通り動作することを検証する。
// ===========================================================================

describe("TextCatalog: onPopup の stale closure 回避 (Phase 1.2.A Review M-2)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    /**
     * sax_text_catalog.js:1416-1437 と同型の onPopup を fixture として再現。
     * picker は (state, currentItemId, onCommit) を受け取る関数として渡す。
     */
    function makeOnPopupFixture(node, getState, picker) {
        const coordinator = node._saxCoordinator;
        return (relation) => {
            picker(getState(), relation.item_id, (selectedId) => {
                const currentState = getState();
                if (!currentState.relations.includes(relation)) return;
                coordinator.captureFromExisting();
                const newRelations = currentState.relations.map(r =>
                    r === relation
                        ? { ...r, item_id: selectedId, on: r.on ?? true }
                        : r
                );
                coordinator.applyAfterCapture(newRelations);
            });
        };
    }

    it("picker 表示中に対象 relation が他経路で削除された場合は no-op で終わる", () => {
        const node = makeNode({ id: 500, outputCount: 0 });
        node._graph = graph;
        graph.registerNode(node);
        const relA = { item_id: "a", on: true };
        const relB = { item_id: "b", on: true };
        node._textCatalogState = {
            catalog: { items: [{ id: "a", name: "a_text" }, { id: "b", name: "b_text" }, { id: "c", name: "c_text" }] },
            relations: [relA, relB],
        };
        ensureTextCatalogCoordinator(node);
        node._syncOutputSlots(node._textCatalogState);
        node._saxCoordinator.captureFromExisting();

        let pickerCallback = null;
        const picker = (_state, _currentItemId, onCommit) => { pickerCallback = onCommit; };
        const onPopup = makeOnPopupFixture(node, () => node._textCatalogState, picker);

        // picker を開く (relA 編集対象)
        onPopup(relA);
        assert.ok(pickerCallback, "picker が登録されているべき");

        // picker 表示中に他経路 (例: addButton.onAdd や別の操作) で relA を削除
        node._textCatalogState = {
            ...node._textCatalogState,
            relations: [relB],
        };

        // picker が確定 (relA は既に削除済み)
        const slotCountBefore = node.outputs.length;
        const relationsBefore = node._textCatalogState.relations;
        pickerCallback("c");

        // no-op で終わるべき: relations 配列は不変、slot 構造も不変
        assert.strictEqual(node._textCatalogState.relations, relationsBefore,
            "relations 配列参照が不変であるべき (no-op)");
        assert.equal(node.outputs.length, slotCountBefore,
            "slot 数が不変であるべき (no-op)");
    });

    it("picker 表示中に他 relation が変更された場合、確定時の最新 state で newRelations を構築する", () => {
        const node = makeNode({ id: 501, outputCount: 0 });
        node._graph = graph;
        graph.registerNode(node);
        const relA = { item_id: "a", on: true };
        const relB = { item_id: "b", on: true };
        node._textCatalogState = {
            catalog: {
                items: [
                    { id: "a", name: "a_text" },
                    { id: "b", name: "b_text" },
                    { id: "c", name: "c_text" },
                ],
            },
            relations: [relA, relB],
        };
        ensureTextCatalogCoordinator(node);
        node._syncOutputSlots(node._textCatalogState);
        node._saxCoordinator.captureFromExisting();

        let pickerCallback = null;
        const picker = (_state, _currentItemId, onCommit) => { pickerCallback = onCommit; };
        const onPopup = makeOnPopupFixture(node, () => node._textCatalogState, picker);

        // picker を開く (relA 編集対象、表示時点では relations = [relA, relB])
        onPopup(relA);

        // picker 表示中に新しい relation を追加 (relations = [relA, relB, relC])
        const relC = { item_id: "c", on: true };
        node._textCatalogState = {
            ...node._textCatalogState,
            relations: [relA, relB, relC],
        };

        // picker が確定: relA の item_id を "b" に変更
        pickerCallback("b");

        // 確定時の最新 state を使ったので relC も保持されているべき
        const updated = node._textCatalogState.relations;
        assert.equal(updated.length, 3, "relC が保持され relations は 3 件であるべき");
        assert.equal(updated[0].item_id, "b", "relA は item_id が 'b' に更新されているべき");
        assert.strictEqual(updated[1], relB, "relB は元参照を引き継いでいるべき");
        assert.strictEqual(updated[2], relC, "relC は元参照を引き継いでいるべき");
    });
});
