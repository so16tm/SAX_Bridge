/**
 * DynamicSlotCoordinator 単体テスト (Phase 1.0)
 *
 * 純粋ロジック (capture/restore データ変換 / 内部 ID 採番 / skipCapture 経路) を
 * 検証する。LiteGraph 依存部分は globalThis.app に最小モックを差し込む形でカバーする。
 *
 * 実行: node --test tests/unit/dynamic_slot_coordinator.test.mjs
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { DynamicSlotCoordinator } from "../../js/sax_dynamic_slot_coordinator.js";

// ---------------------------------------------------------------------------
// LiteGraph / app モック
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
            name: `out_${i}`, type: "*", links: [],
        })),
        inputs: [],
        connectCalls: [],
        connect(slotIndex, targetNode, targetSlot) {
            // テストでは graph.addLink で実 link を作成し、出力 slot.links に追加する
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
    return { id, outputs: [], inputs: [{ name: "in", type: "*" }] };
}

// グローバル app の差し替え (afterEach で復元)
let savedApp;

function installAppMock(graph) {
    savedApp = globalThis.app;
    globalThis.app = { graph, canvas: { setDirty() {} } };
}

function uninstallAppMock() {
    globalThis.app = savedApp;
}

// ---------------------------------------------------------------------------
// テストヘルパ: PrimitiveStore 風の spec を作る
// ---------------------------------------------------------------------------

function makePrimitiveLikeSpec(node, items) {
    const syncSlotStructure = mock.fn(() => {
        // entity 数に合わせて outputs を増減 (PrimitiveStore.syncOutputSlots と同等動作)
        while (node.outputs.length > items.length) node.removeOutput(node.outputs.length - 1);
        while (node.outputs.length < items.length) node.addOutput("", "*");
        for (let i = 0; i < items.length; i++) {
            node.outputs[i].name = items[i].name;
            node.outputs[i].type = items[i].type;
        }
    });
    return {
        spec: {
            direction: "output",
            getEntities: () => items,
            entityToSlots: (item) => [{ name: item.name, type: item.type }],
            syncSlotStructure,
            setEntities: (newEntities) => {
                items.length = 0;
                items.push(...newEntities);
            },
        },
        syncSlotStructure,
    };
}

// ===========================================================================
// テストケース
// ===========================================================================

describe("DynamicSlotCoordinator: WeakMap-based 内部 ID 採番 (entity identity)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("entity identity が維持されれば mutate 後も snapshot が正しく解決される", () => {
        // entity 値を変更しても (SEED 値変更等)、参照は同じため WeakMap キーが一致する
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(40);
        graph.registerNode(target);
        const items = [{ name: "seed", type: "INT", value: 1 }];
        node.outputs[0].name = "seed";
        node.connect(0, target, 0);
        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // skipCapture mutate を 100 回繰り返しても、value 変更は ID マッピングを破壊しない
        for (let i = 0; i < 100; i++) {
            coord.mutate((entities) => { entities[0].value = i; }, { skipCapture: true });
        }
        // 既存 link は 1 つ (skipCapture が capture/restore を skip しているため触らない)
        assert.equal(node.outputs[0].links.length, 1);
        assert.equal(items[0].value, 99);
    });
});

describe("DynamicSlotCoordinator.captureFromExisting", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("現状の outputs[].links を内部スナップショットに記録する (1:1 出力)", () => {
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(99);
        graph.registerNode(target);
        // node.outputs[0] → target node (target_slot=0) の link を実構築
        node.connect(0, target, 0);
        node.connect(1, target, 0);

        const items = [{ name: "a", type: "INT" }, { name: "b", type: "INT" }];
        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);
        coord.captureFromExisting();

        // restore 経路で同じ接続が再現できることで capture が機能していることを確認
        node.connectCalls = [];
        // applyAfterCapture には items のコピーを渡す (setEntities が `items.length=0; push(...newEntities)` を行うため、
        // newEntities が items と同一参照だと意図しない empty 化が起こる)
        const sameItems = [...items];
        coord.applyAfterCapture(sameItems);
        // 内蔵 restore (restoreLinksRaw 未指定) は: 既存 link 全消去 → setEntities → sync → 再接続
        // slot 数不変なので同期 restore。再接続 2 回が期待される。
        assert.equal(node.connectCalls.length, 2,
            "capture したスナップショットから 2 link が再接続されるべき");
    });
});

describe("DynamicSlotCoordinator.mutate (1:1 capture/restore)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("slot 数不変の mutation: 同期 restore で接続が維持される (move 相当)", () => {
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(50);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }, { name: "b", type: "INT" }];
        node.outputs[0].name = "a"; node.outputs[1].name = "b";
        node.connect(0, target, 0); // items[0]=a → target.in
        // 接続を含む形で capture → 入れ替え → restore
        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        node.connectCalls = []; // capture 後の connect 呼出のみ計測する

        coord.mutate((entities) => {
            // 入れ替え (in-place、entity identity は維持)
            const tmp = entities[0]; entities[0] = entities[1]; entities[1] = tmp;
        });

        // syncSlotStructure が呼ばれること
        assert.equal(syncSlotStructure.mock.calls.length, 1);
        // slot 数不変なので同期 restore: 入れ替え後 entity[1] (元 a) が outputs[1] にいるが、
        // a の snapshot は元の outputs[0] にあった link → 新しい outputs[1] に再接続される
        assert.equal(node.connectCalls.length, 1,
            "1 link が再接続されるべき");
        assert.equal(node.connectCalls[0].slotIndex, 1,
            "入れ替え後の新しい slot index に接続されるべき");
    });

    it("slot 数変動の mutation: setTimeout(0) で非同期 restore される (add 相当)", async () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(60);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);
        node.connectCalls = [];

        coord.mutate((entities) => {
            entities.push({ name: "b", type: "INT" });
        });

        // syncSlotStructure は同期で呼ばれる
        assert.equal(syncSlotStructure.mock.calls.length, 1);
        // setTimeout(0) restore のため、まだ再接続は発生していない
        assert.equal(node.connectCalls.length, 0,
            "setTimeout(0) 内 restore 前は connect 未発生");

        await new Promise(resolve => setTimeout(resolve, 1));
        assert.equal(node.connectCalls.length, 1,
            "setTimeout コールバック後に再接続されるべき");
        assert.equal(node.connectCalls[0].slotIndex, 0,
            "items[0]=a は依然 slot 0 にあり、その link が復元される");
    });
});

describe("DynamicSlotCoordinator.mutate ({ skipCapture: true })", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("SEED 値変更ケース: capture/restore をスキップし action + sync のみ実行", () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(70);
        graph.registerNode(target);
        const items = [{ name: "seed", type: "INT", value: 42 }];
        node.outputs[0].name = "seed";
        node.connect(0, target, 0);

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);
        node.connectCalls = [];

        coord.mutate((entities) => {
            entities[0].value = 9999;
        }, { skipCapture: true });

        // syncSlotStructure は呼ばれる
        assert.equal(syncSlotStructure.mock.calls.length, 1);
        // skipCapture のため capture / restore は走らず、既存接続は触らない
        assert.equal(node.connectCalls.length, 0,
            "skipCapture は capture/restore をスキップする");
        // 元の link は維持されている
        assert.equal(node.outputs[0].links.length, 1,
            "既存 link は触られない");
        assert.equal(items[0].value, 9999, "値変更は反映されている");
    });
});

describe("DynamicSlotCoordinator.commitState", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("entity 配列を newEntities で完全置換する", () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const items = [{ name: "old", type: "INT" }];
        node.outputs[0].name = "old";

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        const newItems = [
            { name: "new1", type: "INT" },
            { name: "new2", type: "STRING" },
        ];
        coord.commitState(newItems);

        // setEntities 経由で items が置換されたか
        assert.equal(items.length, 2);
        assert.equal(items[0].name, "new1");
        assert.equal(items[1].name, "new2");
        // syncSlotStructure 経由で outputs も更新される
        assert.equal(node.outputs.length, 2);
    });

    it("setEntities が spec に無い場合はエラーを投げる", () => {
        const node = makeNode({ outputCount: 0 });
        node._graph = graph;
        graph.registerNode(node);
        const items = [];
        const spec = {
            direction: "output",
            getEntities: () => items,
            entityToSlots: () => [],
            syncSlotStructure: () => {},
            // setEntities なし
        };
        const coord = new DynamicSlotCoordinator(node, spec);
        assert.throws(() => coord.commitState([]),
            /setEntities/);
    });
});

describe("DynamicSlotCoordinator.applyAfterCapture (Phase 1.0 wrapper)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("captureFromExisting 後に entity 配列を差し替えて sync + restore を実行", async () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(80);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // beforeModify 相当 (capture)
        coord.captureFromExisting();

        // makeItemListWidget の in-place mutation 相当 (Coordinator の外で起こる)
        // ここでは仮想的に「a を残しつつ b を追加」
        const newItems = [items[0], { name: "b", type: "INT" }];

        node.connectCalls = [];
        coord.applyAfterCapture(newItems);

        // setEntities で items が反映される
        assert.equal(items.length, 2);
        assert.equal(items[0].name, "a");
        assert.equal(items[1].name, "b");

        // 内蔵 restore 経路 (restoreLinksRaw 未指定): slot 数変動あり (1→2) のため
        // setTimeout(0) で非同期 restore される。コールバック完了後に link が復元されること。
        await new Promise(resolve => setTimeout(resolve, 1));
        assert.ok(node.connectCalls.length >= 1,
            "applyAfterCapture が capture したスナップショットから link を復元すべき");
        assert.equal(node.connectCalls[0].slotIndex, 0,
            "items[0]=a は slot 0 に残るため、link も slot 0 に再接続される");
    });

    it("captureFromExisting なしで applyAfterCapture を呼ぶと wrapper モードでは links に触れずに sync のみ実行される (CR-H1 guard)", () => {
        // captureFromExisting を呼ばずに applyAfterCapture を呼ぶ経路 (onPopup / param drag /
        // leftElements onClick) で、wrapper モードの restoreLinksRaw が誤って既存 link を
        // 削除しないこと。#captureCalled が false のため早期 return パスを通るはず。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(81);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT", value: 1 }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0); // 既存 link を構築

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        // wrapper モード: captureLinksRaw / restoreLinksRaw を mock でセット
        const captureLinksRaw = mock.fn(() => {});
        const restoreLinksRaw = mock.fn(() => {});
        spec.captureLinksRaw = captureLinksRaw;
        spec.restoreLinksRaw = restoreLinksRaw;

        const coord = new DynamicSlotCoordinator(node, spec);

        // captureFromExisting を意図的に呼ばずに applyAfterCapture (= 値のみ変更ケース)
        const newItems = [{ ...items[0], value: 999 }];
        const linksBefore = node.outputs[0].links.length;

        coord.applyAfterCapture(newItems);

        // CR-H1 guard: restoreLinksRaw は呼ばれない (空 capture 状態の誤動作防止)
        assert.equal(restoreLinksRaw.mock.calls.length, 0,
            "captureFromExisting なしの場合 restoreLinksRaw は呼ばれない");
        // syncSlotStructure は呼ばれる (slot 名変更等の反映のため)
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "syncSlotStructure は呼ばれる");
        // 既存 link は維持される (誤削除されない)
        assert.equal(node.outputs[0].links.length, linksBefore,
            "既存 link は誤削除されない");
        // setEntities で items は更新される
        assert.equal(items[0].value, 999, "値変更は反映される");
    });

    it("wrapper モード (captureLinksRaw + restoreLinksRaw) で captureFromExisting → applyAfterCapture が両方呼ばれる", () => {
        // 通常の add/del/move 経路 (beforeModify ありで capture → mutation → save)。
        // captureLinksRaw が capture フェーズで呼ばれ、restoreLinksRaw が apply フェーズで呼ばれる。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(82);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const captureLinksRaw = mock.fn((entities) => {
            // 実 captureOutputLinks と同様に entity に _links を埋める動作を模倣
            for (let i = 0; i < entities.length; i++) {
                entities[i]._links = (node.outputs[i]?.links ?? []).slice();
            }
        });
        const restoreLinksRaw = mock.fn((entities, syncFn) => {
            // 実 restoreOutputLinks 相当: syncFn 呼出後に link 復元 (簡略化のため再接続のみ)
            syncFn?.();
        });
        spec.captureLinksRaw = captureLinksRaw;
        spec.restoreLinksRaw = restoreLinksRaw;

        const coord = new DynamicSlotCoordinator(node, spec);

        // beforeModify 相当
        coord.captureFromExisting();
        assert.equal(captureLinksRaw.mock.calls.length, 1,
            "wrapper モードでは captureLinksRaw が呼ばれる");

        // saveItems 相当
        const newItems = [items[0], { name: "b", type: "INT" }];
        coord.applyAfterCapture(newItems);

        assert.equal(restoreLinksRaw.mock.calls.length, 1,
            "wrapper モードでは restoreLinksRaw が呼ばれる");
    });
});
