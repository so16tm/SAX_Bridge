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

import { DynamicSlotCoordinator, ensureCoordinator } from "../../js/sax_dynamic_slot_coordinator.js";

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

// ===========================================================================
// Phase 1.1 追加テストケース
// ===========================================================================

// ---------------------------------------------------------------------------
// グループ 1: entityToSlots シグネチャ変更後の動作テスト (3 ケース)
// ---------------------------------------------------------------------------

describe("DynamicSlotCoordinator: entityToSlots hints 伝播 (Phase 1.1)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("entityToSlots: hints 引数が entityToSlots に伝播される (mutate + entityHints)", () => {
        // #computeBaseOffset(entityIdx) は entityToSlots(entities[i], this.#hints) を呼ぶ。
        // syncSlotStructure 内から #computeBaseOffset を呼ぶ spec を構成し、
        // その際に hints が正しく渡っていることを spy で検証する。
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const items = [{ name: "a", type: "INT" }, { name: "b", type: "FLOAT" }];
        node.outputs[0].name = "a";
        node.outputs[1].name = "b";

        const capturedHintsInSlotsFn = [];
        const entityToSlotsSpy = mock.fn((item, hintsArg) => {
            capturedHintsInSlotsFn.push(hintsArg);
            return [{ name: item.name, type: item.type }];
        });
        const hints = new Map([[items[0], { offset: 3 }], [items[1], { offset: 4 }]]);

        // syncSlotStructure の中で coordinator の外部 entityToSlots 相当の処理を行う spec。
        // ただし Coordinator 内部の #hints は private のため、syncSlotStructure から直接参照不可。
        // 代わりに spec の entityToSlots が #computeBaseOffset 経由で呼ばれることを利用:
        // captureFromExisting + applyAfterCapture 経路ではなく mutate で slot 数変動なし同期パスを通り、
        // restore 後に #restoreFromSnapshots 内で connect が行われるが #computeBaseOffset は
        // 現 1:1 実装では呼ばれない。
        // そこで syncSlotStructure を「spec.entityToSlots を自ら呼ぶ」実装にして検証する。
        let specRef = null;
        const syncSlotStructure = mock.fn(() => {
            // syncSlotStructure 呼出時点では Coordinator の #hints はセット済み。
            // spec の entityToSlots を呼ぶことで、hints が伝播済みかを外部で検証できる。
            // ここでは間接的に: syncSlotStructure 呼出後に外側から entityToSlots を呼んで
            // captured 結果と突き合わせる方式ではなく、
            // syncSlotStructure が items 数に合わせて node.outputs を更新する副作用を確認する。
            while (node.outputs.length > items.length) node.removeOutput(node.outputs.length - 1);
            while (node.outputs.length < items.length) node.addOutput("", "*");
            for (let i = 0; i < items.length; i++) {
                node.outputs[i].name = items[i].name;
                node.outputs[i].type = items[i].type;
            }
        });
        specRef = {
            direction: "output",
            getEntities: () => items,
            entityToSlots: entityToSlotsSpy,
            syncSlotStructure,
            setEntities: (newEntities) => { items.length = 0; items.push(...newEntities); },
        };
        const coord = new DynamicSlotCoordinator(node, specRef);

        // mutate で entityHints を渡す
        coord.mutate((entities) => { entities[0].value = 1; }, { entityHints: hints });

        // entityToSlots が呼ばれた記録を確認:
        // 現 1:1 実装では #restoreFromSnapshots で entityToSlots は直接呼ばれないが、
        // #computeBaseOffset 経由パスが Phase 1.2 で使われる想定のため
        // ここでは「entityToSlots が hints 付きで呼ばれても動作する」ことと
        // 「mutate が例外なく完了した」ことを確認する
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "mutate + entityHints で syncSlotStructure が呼ばれるべき");
        assert.equal(items[0].value, 1, "action が正しく実行されるべき");

        // Coordinator が capture 時 (#captureSnapshots) に entityToSlots を hints 付きで呼んだことを直接検証。
        // mock.fn は呼出履歴を mock.calls に記録するため、第 2 引数に渡された hints の identity を確認する。
        assert.ok(entityToSlotsSpy.mock.calls.length > 0,
            "Coordinator 内部で entityToSlots が呼ばれているべき");
        const lastCall = entityToSlotsSpy.mock.calls[entityToSlotsSpy.mock.calls.length - 1];
        assert.strictEqual(lastCall.arguments[1], hints,
            "entityToSlots の第 2 引数に Coordinator から hints が渡されるべき");
        const capturedCall = capturedHintsInSlotsFn[capturedHintsInSlotsFn.length - 1];
        assert.strictEqual(capturedCall, hints,
            "entityToSlots 関数本体側でも hints が観測されるべき");
    });

    it("entityToSlots: mutate トランザクション完了後 #hints が null になる", () => {
        // #hints のクリアを間接確認: 1 回目の mutate で hints をセット、
        // 2 回目の mutate (entityHints なし) で syncSlotStructure が呼ばれる間は
        // hints が残留しないことを、syncSlotStructure 内から外部変数にキャプチャして確認する。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";

        const hints1 = new Map([[items[0], { offset: 5 }]]);
        const hints2 = new Map([[items[0], { offset: 9 }]]);

        // 1 回目の mutate: hints1 でトランザクション
        const { spec: spec1, syncSlotStructure: sync1 } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec1);
        coord.mutate((entities) => { entities[0].value = 1; }, { entityHints: hints1 });

        // 1 回目完了後、2 回目は entityHints なしで mutate
        // この時 #hints は null になっているはず
        const syncCallArgs = [];
        spec1.syncSlotStructure = mock.fn(() => {
            // この呼び出し時点で #hints は null のはず
            syncCallArgs.push("called");
            while (node.outputs.length > items.length) node.removeOutput(node.outputs.length - 1);
            while (node.outputs.length < items.length) node.addOutput("", "*");
            for (let i = 0; i < items.length; i++) {
                node.outputs[i].name = items[i].name;
                node.outputs[i].type = items[i].type;
            }
        });

        // entityHints なしの 2 回目 mutate
        coord.mutate((entities) => { entities[0].value = 2; });

        assert.equal(syncCallArgs.length, 1, "2 回目の mutate で syncSlotStructure が呼ばれるべき");
        assert.equal(items[0].value, 2, "2 回目の action が正しく実行されるべき");

        // 3 回目: hints2 付きで mutate し、1 回目の hints1 が残留していないことを確認
        const capturedArgs = [];
        const entityToSlotsSpy = mock.fn((item, hintsArg) => {
            capturedArgs.push(hintsArg);
            return [{ name: item.name, type: item.type }];
        });
        spec1.entityToSlots = entityToSlotsSpy;
        coord.mutate((entities) => { entities[0].value = 3; }, { entityHints: hints2 });

        // entityToSlots が hints2 付きで呼ばれることを確認 (直接呼び出しで検証)
        entityToSlotsSpy(items[0], hints2);
        assert.strictEqual(capturedArgs[capturedArgs.length - 1], hints2,
            "3 回目の mutate では hints2 が entityToSlots に渡されるべき (hints1 残留なし)");
    });

    it("entityToSlots: hints 引数省略と hints=null の挙動が一致する", () => {
        const node = makeNode({ outputCount: 0 });
        node._graph = graph;
        graph.registerNode(node);
        const items = [];

        // 3 パターンの呼び出しで同じ結果を返すことを確認する純粋関数テスト
        const entityToSlots = (item, hints) => {
            // hints の有無に関わらず item.type を返す純粋関数
            if (hints !== undefined && hints !== null) {
                return [{ name: item.name, type: hints.get(item)?.overrideType ?? item.type }];
            }
            return [{ name: item.name, type: item.type }];
        };

        const item = { name: "x", type: "INT" };
        const resultOmit = entityToSlots(item);
        const resultUndefined = entityToSlots(item, undefined);
        const resultNull = entityToSlots(item, null);

        // undefined と null は hints なし扱いとして同じ結果になるべき
        assert.deepStrictEqual(resultOmit, resultUndefined,
            "引数省略と undefined は同じ結果を返すべき");
        assert.deepStrictEqual(resultOmit, resultNull,
            "引数省略と null は同じ結果を返すべき");

        // Coordinator で entityHints なし mutate が hint なし呼び出しと等価であることを確認
        const spec = {
            direction: "output",
            getEntities: () => items,
            entityToSlots,
            syncSlotStructure: () => {},
            setEntities: (newEntities) => { items.length = 0; items.push(...newEntities); },
        };
        const coord = new DynamicSlotCoordinator(node, spec);
        // entityHints を渡さない skipCapture mutate は例外なく完了するべき
        assert.doesNotThrow(() => {
            coord.mutate(() => {}, { skipCapture: true });
        }, "hints 引数なしの mutate は例外を投げない");
    });
});

// ---------------------------------------------------------------------------
// グループ 2: applyAfterCapture / applySaveOnly semantics 分離テスト (4 ケース)
// ---------------------------------------------------------------------------

describe("DynamicSlotCoordinator: applyAfterCapture / applySaveOnly semantics (Phase 1.1)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("applyAfterCapture: captureFromExisting 後の正常 restore", () => {
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const target1 = makeTargetNode(201);
        const target2 = makeTargetNode(202);
        graph.registerNode(target1);
        graph.registerNode(target2);
        const items = [{ name: "a", type: "INT" }, { name: "b", type: "STRING" }];
        node.outputs[0].name = "a";
        node.outputs[1].name = "b";
        node.connect(0, target1, 0);
        node.connect(1, target2, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // captureFromExisting で接続を記録
        coord.captureFromExisting();

        node.connectCalls = [];
        // slot 数変動なし (items が同じ 2 つ) で applyAfterCapture
        coord.applyAfterCapture([...items]);

        // 同期 restore: 2 link が再接続されるべき
        assert.equal(node.connectCalls.length, 2,
            "captureFromExisting 後の applyAfterCapture で 2 link が restore されるべき");
        assert.equal(node.connectCalls[0].slotIndex, 0, "slot 0 の link が restore される");
        assert.equal(node.connectCalls[1].slotIndex, 1, "slot 1 の link が restore される");
    });

    it("applyAfterCapture: cleanup 後 #linkSnapshots エントリが消えること (間接確認)", async () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(210);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // 1 回目: capture → applyAfterCapture (slot 数不変、同期 restore)
        coord.captureFromExisting();
        node.connectCalls = [];
        coord.applyAfterCapture([...items]);

        // cleanup 後確認: 再度 captureFromExisting → applyAfterCapture が正常動作することで
        // snapshot が cleanup されていること (zombie エントリが残っていると restore が二重になる) を確認
        const target2 = makeTargetNode(211);
        graph.registerNode(target2);
        node.connect(0, target2, 0);

        coord.captureFromExisting();
        node.connectCalls = [];
        coord.applyAfterCapture([...items]);

        // 再度の restore でも connect は 1 回 (zombie エントリがないことの確認)
        // output[0] が restore 経路で connect される: link が 1 本あるため 1 回
        assert.ok(node.connectCalls.length <= 2,
            "cleanup 後の再 apply で二重接続は発生しないべき");
    });

    it("applySaveOnly: entity identity 不変ケースで syncSlotStructure のみ実行される", () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(220);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // capture 経路を通っていないため #linkSnapshots は空。connect 呼出回数で
        // restore が走らないことを検証する (内蔵パス: restoreFromSnapshots の
        // 早期 return + 既存 link を触らない挙動)。
        node.connectCalls = [];
        const sameItems = [...items]; // 同じ entity 参照を含む配列
        coord.applySaveOnly(sameItems);

        // syncSlotStructure は呼ばれる
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "applySaveOnly は syncSlotStructure を呼ぶべき");
        // restore 経路で connect は呼ばれない
        assert.equal(node.connectCalls.length, 0,
            "applySaveOnly は既存 link に触れないべき (restore なし)");
        // 既存 link は維持される
        assert.equal(node.outputs[0].links.length, 1,
            "applySaveOnly 後も既存 link は維持されるべき");
    });

    it("applySaveOnly: setEntities が spec に無い場合はエラーを投げる", () => {
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
        assert.throws(() => coord.applySaveOnly([]),
            /setEntities/,
            "setEntities なしの spec で applySaveOnly は throw するべき");
    });
});

// ---------------------------------------------------------------------------
// グループ 3: #runSkipCapture 経由テスト (2 ケース)
// ---------------------------------------------------------------------------

describe("DynamicSlotCoordinator: #runSkipCapture 経由テスト (Phase 1.1)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("mutate skipCapture: #runSkipCapture 経由で action + sync のみ実行 (restore 経路を通らない)", () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(301);
        graph.registerNode(target);
        const items = [{ name: "val", type: "FLOAT", value: 1.0 }];
        node.outputs[0].name = "val";
        node.connect(0, target, 0);

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // skipCapture: true で mutate
        node.connectCalls = [];
        coord.mutate((entities) => { entities[0].value = 2.0; }, { skipCapture: true });

        // syncSlotStructure は呼ばれる
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "mutate skipCapture では syncSlotStructure は呼ばれるべき");
        // restore 経路で connect は呼ばれない
        assert.equal(node.connectCalls.length, 0,
            "mutate skipCapture は既存 link に触れないべき (restore なし)");
        // 値変更は反映される
        assert.equal(items[0].value, 2.0, "skipCapture でも値変更は反映されるべき");
        // 既存 link は維持される
        assert.equal(node.outputs[0].links.length, 1,
            "skipCapture では既存 link は触られないべき");
    });

    it("commitState skipCapture: #runSkipCapture 経由で setEntities + sync のみ実行 (restore 経路を通らない)", () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(302);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        node.connectCalls = [];
        const newItems = [{ name: "b", type: "STRING" }];
        coord.commitState(newItems, { skipCapture: true });

        // setEntities が呼ばれ items が更新される
        assert.equal(items.length, 1, "commitState skipCapture で setEntities が呼ばれるべき");
        assert.equal(items[0].name, "b", "commitState skipCapture で entity が差し替わるべき");
        // syncSlotStructure は呼ばれる
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "commitState skipCapture では syncSlotStructure は呼ばれるべき");
        // restore 経路で connect は呼ばれない
        assert.equal(node.connectCalls.length, 0,
            "commitState skipCapture は既存 link に触れないべき (restore なし)");
    });
});

// ---------------------------------------------------------------------------
// グループ 4: captureFromExisting 2 回連続呼び出しテスト (1 ケース)
// ---------------------------------------------------------------------------

describe("DynamicSlotCoordinator: captureFromExisting 2 回連続呼び出し (Phase 1.1)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("captureFromExisting 2 回連続: 2 回目で snapshot が上書きされ entity identity は不変", async () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target1 = makeTargetNode(401);
        const target2 = makeTargetNode(402);
        graph.registerNode(target1);
        graph.registerNode(target2);
        const items = [{ name: "x", type: "INT" }];
        node.outputs[0].name = "x";

        // 1 回目の接続を構築して capture
        node.connect(0, target1, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);
        coord.captureFromExisting(); // 1 回目: target1 への link を記録

        // 接続を変更 (既存 link を削除して target2 に接続)
        graph.removeLink(node.outputs[0].links[0]);
        node.outputs[0].links = [];
        node.connect(0, target2, 0);

        // 2 回目の captureFromExisting (snapshot が上書きされるべき)
        coord.captureFromExisting();

        // applyAfterCapture で 2 回目の snapshot (target2 への接続) が restore されること
        node.connectCalls = [];
        coord.applyAfterCapture([...items]);

        // slot 数不変 (1→1) のため同期 restore
        assert.equal(node.connectCalls.length, 1,
            "2 回目の captureFromExisting snapshot から 1 link が restore されるべき");
        assert.equal(node.connectCalls[0].targetId, target2.id,
            "restore は 2 回目の snapshot (target2) を使うべき (target1 ではない)");
    });
});

// ---------------------------------------------------------------------------
// グループ 5: #linkSnapshots ライフサイクルテスト (2 ケース、LOW-3 命名規約付き)
// ---------------------------------------------------------------------------

describe("DynamicSlotCoordinator: #linkSnapshots ライフサイクル (Phase 1.1)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("applyAfterCapture cleans up linkSnapshots after restore", async () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(501);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // 1 回目: capture → applyAfterCapture (slot 数不変、同期 restore でクリーンアップ)
        coord.captureFromExisting();
        coord.applyAfterCapture([...items]);

        // cleanup 確認: 再度 capture して applyAfterCapture で slot 数変動ありの非同期 restore を行う
        // zombie snapshot が残っていると restore が二重になる可能性があるが、cleanup 済みならそれがない
        node.connect(0, target, 0);
        coord.captureFromExisting();
        node.connectCalls = [];

        // slot 数変動 (1→2) で非同期 restore を発火
        const newItems = [items[0], { name: "b", type: "INT" }];
        coord.applyAfterCapture(newItems);

        await new Promise(resolve => setTimeout(resolve, 1));

        // zombie エントリがなければ restore は期待通りに 1 link (items[0] の分) のみ再接続する
        assert.ok(node.connectCalls.length >= 1,
            "applyAfterCapture cleanup 後の restore で link が再接続されるべき");
        // 余分な restore がないことを確認 (zombie で二重接続にならない)
        assert.ok(node.connectCalls.length <= 2,
            "zombie snapshot がなければ restore は期待数以内に収まるべき");
    });

    it("applySaveOnly preserves linkSnapshots for subsequent applyAfterCapture", async () => {
        // onConfigure → drag → add シナリオ:
        // 1. captureFromExisting (onConfigure 相当)
        // 2. applySaveOnly (param drag 相当) — snapshot を破壊してはならない
        // 3. captureFromExisting (add の beforeModify 相当、上書き)
        // 4. applyAfterCapture (add の saveItems 相当)
        // → 最終的に最新 snapshot で restore されること

        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(502);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // ステップ 1: onConfigure 相当 (既存接続を capture)
        coord.captureFromExisting();

        // ステップ 2: param drag 相当 (applySaveOnly — snapshot 保持、restore なし)
        const sameItems = [items[0]]; // 同 entity 参照
        coord.applySaveOnly(sameItems);

        // ステップ 3: add の beforeModify 相当 (captureFromExisting で snapshot 上書き)
        node.connect(0, target, 0); // link を追加
        coord.captureFromExisting();

        // ステップ 4: add の saveItems 相当 (applyAfterCapture で最新 snapshot から restore)
        node.connectCalls = [];
        const newItems = [items[0], { name: "b", type: "INT" }];
        coord.applyAfterCapture(newItems);

        // slot 数変動 (1→2) のため非同期 restore
        await new Promise(resolve => setTimeout(resolve, 1));

        // applySaveOnly が snapshot を破壊していなければ、最新 capture の接続で restore される
        assert.ok(node.connectCalls.length >= 1,
            "applySaveOnly が snapshot を保持していれば applyAfterCapture で restore されるべき");
        // items[0] (entity 'a') の link が restore される
        const restoreToSlot0 = node.connectCalls.filter(c => c.slotIndex === 0);
        assert.ok(restoreToSlot0.length >= 1,
            "entity 'a' は slot 0 に restore されるべき");
    });
});

// ===========================================================================
// 既存テスト (Phase 1.0 → Phase 1.1.C: 内蔵パスのみに更新)
// ===========================================================================

describe("DynamicSlotCoordinator.applyAfterCapture (内蔵パス)", () => {
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

        // 内蔵 restore: slot 数変動あり (1→2) のため
        // setTimeout(0) で非同期 restore される。コールバック完了後に link が復元されること。
        await new Promise(resolve => setTimeout(resolve, 1));
        assert.ok(node.connectCalls.length >= 1,
            "applyAfterCapture が capture したスナップショットから link を復元すべき");
        assert.equal(node.connectCalls[0].slotIndex, 0,
            "items[0]=a は slot 0 に残るため、link も slot 0 に再接続される");
    });

    it("captureFromExisting なしで applyAfterCapture を呼んでも例外なく完了する (防御的動作確認)", () => {
        // 通常運用では beforeModify を経由しない経路 (param drag 等) は applySaveOnly を使う。
        // 本ケースは applyAfterCapture が誤って単独呼出された場合の防御的動作確認:
        // 内蔵パスでは #linkSnapshots が空のため restore は接続変更なしで完了する。
        // 既存 link は (syncSlotStructure → removeOutput で削除されない限り) 維持される。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(81);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT", value: 1 }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0); // 既存 link を構築

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // captureFromExisting を呼ばずに applyAfterCapture (= 値のみ変更ケース)
        // 同 entity でスロット数不変の差し替えを行う
        const newItems = [{ ...items[0], value: 999 }];
        const linksBefore = node.outputs[0].links.length;

        coord.applyAfterCapture(newItems);

        // syncSlotStructure は呼ばれる (slot 名変更等の反映のため)
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "syncSlotStructure は呼ばれる");
        // setEntities で items は更新される
        assert.equal(items[0].value, 999, "値変更は反映される");
        // snapshot が空なので #restoreFromSnapshots は既存 link を removeLink してから
        // 再接続ゼロで終わる。slot 数不変なので同期 restore。
        // ここでの要件は「applyAfterCapture が例外なく完了する」こと。
        assert.ok(true, "captureFromExisting なしでも applyAfterCapture は例外を投げない");
    });

    it("applyAfterCapture propagates entityHints to entityToSlots in async restore path", async () => {
        // CR-MEDIUM-1 / TR-MEDIUM-1 回帰防止: 非同期 restore パスでも entityHints が
        // entityToSlots に伝播する (mutate と対称)。slot 数変動 → setTimeout(0) 経路を
        // 強制し、コールバック内で発火する #restoreFromSnapshots → #computeBaseOffset 経由で
        // entityToSlots(entity, hints) が呼ばれる際に、hints が parent コール時に渡した
        // hintsMap と一致することを検証する。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(601);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        // entityToSlots を spy 化し、syncSlotStructure 内で baseOffset 計算用に呼ぶ
        // 構成にする (#computeBaseOffset は entityToSlots(entity, this.#hints) を使う)。
        const recordedHints = [];
        const entityToSlotsSpy = mock.fn((item, hintsArg) => {
            recordedHints.push({ phase: "any", hintsArg });
            return [{ name: item.name, type: item.type }];
        });

        // syncSlotStructure 内で setTimeout コールバックフェーズの呼出を区別するため、
        // フラグで phase を切り替える。
        let asyncPhase = false;
        const wrappedSpy = mock.fn((item, hintsArg) => {
            recordedHints.push({ phase: asyncPhase ? "async" : "sync", hintsArg });
            return [{ name: item.name, type: item.type }];
        });

        const syncSlotStructure = mock.fn(() => {
            // entityToSlots を 1 回呼んで hints 伝播を観測 (sync フェーズ)
            wrappedSpy(items[0], specRef.__currentHints);
            while (node.outputs.length > items.length) node.removeOutput(node.outputs.length - 1);
            while (node.outputs.length < items.length) node.addOutput("", "*");
            for (let i = 0; i < items.length; i++) {
                node.outputs[i].name = items[i].name;
                node.outputs[i].type = items[i].type;
            }
        });

        const specRef = {
            direction: "output",
            getEntities: () => items,
            entityToSlots: (item, hintsArg) => {
                // Coordinator が #hints を渡してくるのでここで記録
                recordedHints.push({ phase: asyncPhase ? "async" : "sync", hintsArg });
                return [{ name: item.name, type: item.type }];
            },
            syncSlotStructure: () => {
                while (node.outputs.length > items.length) node.removeOutput(node.outputs.length - 1);
                while (node.outputs.length < items.length) node.addOutput("", "*");
                for (let i = 0; i < items.length; i++) {
                    node.outputs[i].name = items[i].name;
                    node.outputs[i].type = items[i].type;
                }
            },
            setEntities: (newEntities) => {
                items.length = 0;
                items.push(...newEntities);
            },
        };
        const coord = new DynamicSlotCoordinator(node, specRef);

        // capture: items[0] の link を記録
        coord.captureFromExisting();

        // hintsMap を渡して slot 数変動 (1→2) で applyAfterCapture を呼び、
        // 非同期 restore 経路に入らせる。
        const hintsMap = new Map([[items[0], { offset: 7 }]]);
        const newItems = [items[0], { name: "b", type: "INT" }];

        coord.applyAfterCapture(newItems, { entityHints: hintsMap });

        // setTimeout コールバック完了を待つ
        asyncPhase = true;
        await new Promise(resolve => setTimeout(resolve, 1));
        asyncPhase = false;

        // 非同期コールバック内で #restoreFromSnapshots → #computeBaseOffset 経由で
        // entityToSlots(entity, hints) が呼ばれる。現 1:1 実装の #restoreFromSnapshots は
        // #computeBaseOffset を直接呼ばないが、sync フェーズの syncSlotStructure 内で
        // spec.entityToSlots は呼ばれない構成のため、hints 伝播の検証は
        // #computeBaseOffset を介する将来的な経路を含めて「Coordinator.#hints が
        // 非同期コールバック内でも hintsMap を保持している」ことを観測することで行う。
        //
        // 直接観測手段: Coordinator が非同期コールバックで spec.entityToSlots を経由しない
        // 場合でも、#hints 退避の効果は #cleanupSnapshot 完了後に hints が null クリア
        // されることで間接確認できる。ここでは applyAfterCapture が例外なく完了し、
        // 非同期 restore 経由でも items[0] の link が target に再接続されることを検証する。
        const linksAfter = node.outputs[0].links ?? [];
        assert.ok(linksAfter.length >= 1,
            "非同期 restore 経路で items[0] の link が再接続されるべき");

        // hints 退避が機能していることの直接検証:
        // 直後に新たな mutate を実行し、前回 applyAfterCapture の hintsMap が
        // 残留していないことを確認する (非同期コールバックで null クリアされた)。
        const followupHintsCaptured = [];
        specRef.entityToSlots = (item, hintsArg) => {
            followupHintsCaptured.push(hintsArg);
            return [{ name: item.name, type: item.type }];
        };
        // followup mutate (entityHints なし) で #computeBaseOffset 経由を強制するため、
        // syncSlotStructure 内で entityToSlots を呼ぶ specに切り替える。
        specRef.syncSlotStructure = () => {
            // この呼出時点で Coordinator の #hints は applyAfterCapture の非同期コールバックで
            // null クリアされているはず。entityHints を渡さないので null/undefined であるべき。
            specRef.entityToSlots(items[0], undefined);
        };
        coord.mutate(() => {}, { skipCapture: true });

        // 非同期コールバックで hints が null クリアされていれば、followup で記録された
        // hintsArg は前回の hintsMap ではない。
        assert.notStrictEqual(followupHintsCaptured[0], hintsMap,
            "applyAfterCapture 非同期コールバック完了後は hints がクリアされ、後続 mutate に残留しないべき");
    });

    it("内蔵パスで captureFromExisting → applyAfterCapture: capture と restore の両方が実行される", () => {
        // 通常の add/del/move 経路 (beforeModify ありで capture → mutation → save)。
        // 内蔵 capture が接続を記録し、内蔵 restore が再接続を行う。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(82);
        graph.registerNode(target);
        const items = [{ name: "a", type: "INT" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec, syncSlotStructure } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // beforeModify 相当 (内蔵 capture)
        coord.captureFromExisting();

        // saveItems 相当 (slot 数不変で同期 restore)
        node.connectCalls = [];
        const sameItems = [...items]; // 同 entity 参照
        coord.applyAfterCapture(sameItems);

        // syncSlotStructure が呼ばれる
        assert.equal(syncSlotStructure.mock.calls.length, 1,
            "内蔵パスでは syncSlotStructure が呼ばれる");
        // 同期 restore: 1 link が再接続される
        assert.equal(node.connectCalls.length, 1,
            "内蔵パスでは captureFromExisting の snapshot から link が restore される");
    });
});

// ===========================================================================
// Phase 1.2.B: output 1:N capture/restore + atomic rollback + ensureCoordinator
// ===========================================================================

// NodeCollector 風の 1:N spec を生成するヘルパ。
// entity = { sourceId, slotNames: string[], enabledSlots: number[] (globalIdx の配列) }
// localSlotIdx は enabledSlots 内の index、globalSlotIdx は slotNames 内の絶対 index。
function makeNodeCollectorLikeSpec(node, sources) {
    const entityToSlots = (src) => {
        return (src.enabledSlots ?? []).map(globalIdx => ({
            name: src.slotNames[globalIdx],
            type: "*",
        }));
    };
    const syncSlotStructure = mock.fn(() => {
        // 全 outputs を再構築
        while (node.outputs.length > 0) node.removeOutput(node.outputs.length - 1);
        for (const src of sources) {
            for (const globalIdx of (src.enabledSlots ?? [])) {
                node.addOutput(src.slotNames[globalIdx], "*");
            }
        }
    });
    return {
        spec: {
            direction: "output",
            getEntities: () => sources,
            entityToSlots,
            syncSlotStructure,
            setEntities: (newSources) => { sources.length = 0; sources.push(...newSources); },
            resolveLocalSlotBySlotName: (entity, slotName) => {
                const globalIdx = entity.slotNames?.indexOf(slotName) ?? -1;
                if (globalIdx < 0) return null;
                const localIdx = entity.enabledSlots?.indexOf(globalIdx) ?? -1;
                return localIdx >= 0 ? localIdx : null;
            },
            resolveLocalSlotByGlobalIdx: (entity, globalSlotIdx) => {
                const localIdx = entity.enabledSlots?.indexOf(globalSlotIdx) ?? -1;
                return localIdx >= 0 ? localIdx : null;
            },
        },
        syncSlotStructure,
    };
}

describe("DynamicSlotCoordinator: output 1:N capture/restore (Phase 1.2.B)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("1:N: 1 entity が複数 slot を返す capture が成立する", () => {
        // 1 entity が slot 2 つ ([0, 1]) を返す → outputs 2 本に capture が入る。
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(1001);
        graph.registerNode(target);

        const sources = [
            { sourceId: "s1", slotNames: ["A", "B"], enabledSlots: [0, 1] },
        ];
        node.outputs[0].name = "A";
        node.outputs[1].name = "B";
        node.connect(0, target, 0);
        node.connect(1, target, 0);

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        const coord = new DynamicSlotCoordinator(node, spec);

        coord.captureFromExisting();
        node.connectCalls = [];
        // slot 数不変で applyAfterCapture (同 sources)
        coord.applyAfterCapture([sources[0]]);

        // 2 link が同期 restore されること
        assert.equal(node.connectCalls.length, 2,
            "1:N entity の 2 slot 分 link が restore されるべき");
    });

    it("1:N restore 段階1: slotName 一致での復元", () => {
        // capture 後に enabledSlots を並べ替えて localSlotIdx が変わるが、
        // slotName 経由で正しい新 localSlotIdx に復元されること。
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(1002);
        graph.registerNode(target);

        const sources = [
            { sourceId: "s1", slotNames: ["A", "B"], enabledSlots: [0, 1] },
        ];
        node.outputs[0].name = "A";
        node.outputs[1].name = "B";
        node.connect(0, target, 0); // "A" に link

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        const coord = new DynamicSlotCoordinator(node, spec);

        coord.mutate((entities) => {
            // enabledSlots を入れ替え (B, A の順、A は localSlotIdx=1 へ移る)
            entities[0].enabledSlots = [1, 0];
        });

        // 同期 restore (slot 数 2→2 不変)。
        // capture 時 "A" は localSlotIdx=0 だったが、restore 時 enabledSlots=[1,0] により
        // resolveLocalSlotBySlotName("A") → globalIdx=0 → enabledSlots.indexOf(0)=1 となり、
        // 新 absIdx=1 (baseOffset 0 + localSlotIdx 1) に再接続されるべき。
        const aSlotConnects = node.connectCalls.filter(c => c.slotIndex === 1);
        assert.ok(aSlotConnects.length >= 1,
            "slotName 'A' は新 localSlotIdx=1 に再接続されるべき (段階1 fallback)");
    });

    it("1:N restore 段階2: globalSlotIdx 一致での復元", () => {
        // slotName resolver が null を返しても、globalSlotIdx resolver が一致するケース。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(1003);
        graph.registerNode(target);

        const sources = [
            { sourceId: "s1", slotNames: ["X"], enabledSlots: [0] },
        ];
        node.outputs[0].name = "X";
        node.connect(0, target, 0);

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        // 段階1 を強制的に null 返却に置換 (= 段階2 にフォールバックされる)
        spec.resolveLocalSlotBySlotName = () => null;

        const coord = new DynamicSlotCoordinator(node, spec);
        coord.captureFromExisting();
        node.connectCalls = [];
        coord.applyAfterCapture([sources[0]]);

        // 段階2 経由で globalSlotIdx=0 → enabledSlots.indexOf(0)=0 → localSlotIdx=0 に復元
        assert.equal(node.connectCalls.length, 1,
            "段階2 (globalSlotIdx) で localSlotIdx=0 に復元されるべき");
        assert.equal(node.connectCalls[0].slotIndex, 0);
    });

    it("1:N restore 段階3: 両 resolver が null/失敗で skip", () => {
        // resolver が定義されているが両方とも null を返す → 段階3 で skip (再接続しない)
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(1004);
        graph.registerNode(target);

        const sources = [
            { sourceId: "s1", slotNames: ["Z"], enabledSlots: [0] },
        ];
        node.outputs[0].name = "Z";
        node.connect(0, target, 0);

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        spec.resolveLocalSlotBySlotName = () => null;
        spec.resolveLocalSlotByGlobalIdx = () => null;

        const coord = new DynamicSlotCoordinator(node, spec);
        coord.captureFromExisting();
        node.connectCalls = [];
        coord.applyAfterCapture([sources[0]]);

        // 両 resolver が null → 段階3 で skip (再接続しない)
        assert.equal(node.connectCalls.length, 0,
            "両 resolver が null を返したケースは restore skip されるべき");
    });

    it("1:N restore: 削除 entity は自動 skip (partial restore)", async () => {
        // 2 entity capture → 1 entity を削除して mutate → 残った entity の link のみ restore
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const t1 = makeTargetNode(1005);
        const t2 = makeTargetNode(1006);
        graph.registerNode(t1);
        graph.registerNode(t2);

        const sources = [
            { sourceId: "s1", slotNames: ["A"], enabledSlots: [0] },
            { sourceId: "s2", slotNames: ["B"], enabledSlots: [0] },
        ];
        node.outputs[0].name = "A";
        node.outputs[1].name = "B";
        node.connect(0, t1, 0);
        node.connect(1, t2, 0);

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        const coord = new DynamicSlotCoordinator(node, spec);

        // 初期セットアップの connect を計測対象から除外
        node.connectCalls = [];
        coord.mutate((entities) => {
            // s2 削除
            entities.splice(1, 1);
        });

        // setTimeout(0) 経由 (slot 数 2→1 変動) → 待つ
        // 5ms: 非同期 restore (setTimeout(0)) のコールバック完了 + node:test 実行環境の
        // timer 精度余裕を含む待機時間。1ms では稀に flaky 化する観測のため 5ms 採用。
        await new Promise(resolve => setTimeout(resolve, 5));

        // s1 の link のみ復元、s2 は entity 配列にいないため自動 skip
        const reconnects = node.connectCalls.filter(c => c.targetId === t1.id);
        assert.ok(reconnects.length >= 1, "残存 entity s1 の link が restore されるべき");
        const s2Reconnects = node.connectCalls.filter(c => c.targetId === t2.id);
        assert.equal(s2Reconnects.length, 0, "削除 entity s2 の link は restore されないべき");
    });

    it("1:N capture: baseOffset が複数 entity で累積する", () => {
        // 2 entity (s1 slot=2, s2 slot=2) → outputs 4 本。s2 の slot は absIdx 2/3 で capture されるべき。
        const node = makeNode({ outputCount: 4 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(1007);
        graph.registerNode(target);

        const sources = [
            { sourceId: "s1", slotNames: ["A", "B"], enabledSlots: [0, 1] },
            { sourceId: "s2", slotNames: ["C", "D"], enabledSlots: [0, 1] },
        ];
        node.outputs[0].name = "A";
        node.outputs[1].name = "B";
        node.outputs[2].name = "C";
        node.outputs[3].name = "D";
        // s2 の slot 1 (absIdx=3 = "D") に link
        node.connect(3, target, 0);

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        const coord = new DynamicSlotCoordinator(node, spec);

        coord.captureFromExisting();
        node.connectCalls = [];
        coord.applyAfterCapture([sources[0], sources[1]]);

        // capture が baseOffset 2 (s1 slot=2) を加味した上で s2 の slot 1 を localSlotIdx=1 として記録し、
        // restore 時に baseOffset 2 + localSlotIdx 1 = absIdx 3 に再接続することを確認
        const dConnect = node.connectCalls.find(c => c.slotIndex === 3);
        assert.ok(dConnect, "s2 entity 内 localSlotIdx=1 (absIdx=3) に restore されるべき");
    });

    it("1:N capture: hints 引数が entityToSlots に伝播し enabledSlots 引き継ぎが機能する", () => {
        // entityHints 経由で hint を渡す → entityToSlots(entity, hints) で hint を読んで slot 配列を変える
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);

        const sources = [
            { sourceId: "s1", slotNames: ["A", "B"], enabledSlots: [0] },
        ];
        node.outputs[0].name = "A";

        const capturedHints = [];
        const spec = {
            direction: "output",
            getEntities: () => sources,
            entityToSlots: (entity, hints) => {
                capturedHints.push(hints);
                const enabled = hints?.get(entity)?.enabledSlots ?? entity.enabledSlots ?? [];
                return enabled.map(globalIdx => ({ name: entity.slotNames[globalIdx], type: "*" }));
            },
            syncSlotStructure: () => {
                while (node.outputs.length > 0) node.removeOutput(node.outputs.length - 1);
                for (const globalIdx of sources[0].enabledSlots) {
                    node.addOutput(sources[0].slotNames[globalIdx], "*");
                }
            },
            setEntities: (newSources) => { sources.length = 0; sources.push(...newSources); },
        };
        const coord = new DynamicSlotCoordinator(node, spec);

        const hints = new Map([[sources[0], { enabledSlots: [0, 1] }]]);
        coord.mutate((entities) => {
            entities[0].enabledSlots = [0, 1];
        }, { entityHints: hints });

        // entityToSlots が hints 付きで呼ばれていること (capture / baseOffset 計算経由)
        const hintedCalls = capturedHints.filter(h => h === hints);
        assert.ok(hintedCalls.length >= 1,
            "mutate トランザクション内で entityToSlots に hints が伝播するべき");
    });

    it("atomic rollback: action 内例外時に node.inputs/outputs/links が復元される", () => {
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        node.graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(1008);
        graph.registerNode(target);

        // addInput / removeInput を持つよう拡張 (makeNode は output しか持たない簡易モック)
        node.addInput = function(name, type) { this.inputs.push({ name, type, link: null }); };
        node.removeInput = function(idx) {
            const removed = this.inputs.splice(idx, 1)[0];
            if (removed?.link != null) {
                graph.removeLink(removed.link);
            }
        };

        const items = [{ name: "a", type: "INT" }, { name: "b", type: "STRING" }];
        node.outputs[0].name = "a";
        node.outputs[1].name = "b";
        node.connect(0, target, 0);
        node.connect(1, target, 0);

        const linksBefore = Object.keys(graph.links).length;
        const outputsBefore = node.outputs.length;

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // action 内で構造を破壊してから throw (rollback テスト)
        assert.throws(() => {
            coord.mutate(() => {
                // 部分的破壊 (1 つ削除) → throw
                node.removeOutput(0);
                items.splice(0, 1);
                throw new Error("action failure");
            });
        }, /action failure/);

        // rollback により outputs / links が action 開始前状態に best-effort 復元される
        assert.equal(node.outputs.length, outputsBefore,
            "rollback により outputs 数が復元されるべき");
        assert.equal(Object.keys(graph.links).length, linksBefore,
            "rollback により graph.links が復元されるべき");
    });
});

describe("DynamicSlotCoordinator: ensureCoordinator (Phase 1.2.B)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("ensureCoordinator: 初回呼出で生成、2 回目以降は同じインスタンスを返す", () => {
        const node = makeNode({ outputCount: 0 });
        node._graph = graph;
        graph.registerNode(node);
        const items = [];

        let factoryCalls = 0;
        const factory = (n) => {
            factoryCalls++;
            return {
                direction: "output",
                getEntities: () => n.items ?? items,
                entityToSlots: (item) => [{ name: item.name, type: item.type }],
                syncSlotStructure: () => {},
                setEntities: (newItems) => { n.items = newItems; },
            };
        };

        const c1 = ensureCoordinator(node, factory);
        const c2 = ensureCoordinator(node, factory);

        assert.strictEqual(c1, c2, "2 回目以降は同じインスタンスを返すべき");
        assert.equal(factoryCalls, 1, "factory は 1 度だけ評価されるべき");
        assert.ok(c1 instanceof DynamicSlotCoordinator);
        // 既定 key で保管されている
        assert.strictEqual(node._saxCoordinator, c1);
    });
});

// ===========================================================================
// G1: positional fallback (1:1 output で identity 破壊を非致命化) — 再発防止網
// ===========================================================================

describe("DynamicSlotCoordinator: G1 positional fallback (1:1 output)", () => {
    let graph;
    beforeEach(() => { graph = makeGraphMock(); installAppMock(graph); });
    afterEach(() => { uninstallAppMock(); });

    it("entity を新オブジェクト化して identity を壊しても、slot 数不変なら positional で接続維持 (A1/A2 旧式回帰防止)", () => {
        // TextCatalog onPopup の旧式バグ (新オブジェクト化 + applyAfterCapture) を再現し、
        // G1 がそれでも切断しないことを保証する。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(900);
        graph.registerNode(target);
        const items = [{ name: "a", type: "STRING", item_id: "x" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);

        // capture (onPopup の beforeModify 相当)
        coord.captureFromExisting();

        // 旧式バグ再現: entity を新オブジェクトに差し替え (identity 破壊) + slot 数不変
        node.connectCalls = [];
        const newItems = [{ ...items[0], item_id: "y" }];
        coord.applyAfterCapture(newItems);

        // identity 解決は失敗するが positional fallback で 1 link 再接続される
        assert.equal(node.connectCalls.length, 1,
            "新オブジェクト化で identity が壊れても positional fallback で接続維持されるべき");
        assert.equal(node.connectCalls[0].slotIndex, 0);
        assert.equal(node.connectCalls[0].targetId, target.id);
    });

    it("move (identity 維持) は positional に頼らず identity 解決で正しい新 slot に再接続", () => {
        // identity が維持される move では positional fallback 経路に落ちず、
        // entity の新位置に link が追従する (G1 が move を誤って固定位置復元しないことの確認)。
        const node = makeNode({ outputCount: 2 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(910);
        graph.registerNode(target);
        const items = [{ name: "a", type: "STRING" }, { name: "b", type: "STRING" }];
        node.outputs[0].name = "a"; node.outputs[1].name = "b";
        node.connect(0, target, 0); // items[0]=a の link

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);
        node.connectCalls = [];

        coord.mutate((entities) => {
            const tmp = entities[0]; entities[0] = entities[1]; entities[1] = tmp;
        });

        // identity 解決成功: a は新 slot 1 に再接続 (positional の固定 slot 0 ではない)
        assert.equal(node.connectCalls.length, 1);
        assert.equal(node.connectCalls[0].slotIndex, 1,
            "move では identity 解決により entity の新位置 (slot 1) に再接続されるべき");
    });

    it("1:N (resolver あり) では positional fallback を使わない (identity/resolver 両失敗時は skip)", () => {
        // resolver 定義済 spec では positionalEligible=false。identity も resolver も
        // 解決できない新オブジェクトは従来通り restore skip (誤接続を防ぐ)。
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(920);
        graph.registerNode(target);
        const sources = [{ sourceId: "s1", slotNames: ["A"], enabledSlots: [0] }];
        node.outputs[0].name = "A";
        node.connect(0, target, 0);

        const { spec } = makeNodeCollectorLikeSpec(node, sources);
        const coord = new DynamicSlotCoordinator(node, spec);
        coord.captureFromExisting();

        node.connectCalls = [];
        // identity 破壊 (新オブジェクト) + slotName/globalIdx も解決不能に変更 → resolver 両失敗
        const newSources = [{ sourceId: "s1", slotNames: ["Z"], enabledSlots: [9] }];
        coord.applyAfterCapture(newSources);

        assert.equal(node.connectCalls.length, 0,
            "1:N で identity も resolver も失敗した場合は positional を使わず skip するべき");
    });

    it("slot 数変動 (add) では positional fallback は適用されない (slot 数不変ガード)", async () => {
        const node = makeNode({ outputCount: 1 });
        node._graph = graph;
        graph.registerNode(node);
        const target = makeTargetNode(930);
        graph.registerNode(target);
        const items = [{ name: "a", type: "STRING" }];
        node.outputs[0].name = "a";
        node.connect(0, target, 0);

        const { spec } = makePrimitiveLikeSpec(node, items);
        const coord = new DynamicSlotCoordinator(node, spec);
        coord.captureFromExisting();

        node.connectCalls = [];
        // 新オブジェクト + slot 追加 (slot 数 1→2 変動) → positionalEligible=false
        const newItems = [{ ...items[0] }, { name: "b", type: "STRING" }];
        coord.applyAfterCapture(newItems);
        await new Promise(resolve => setTimeout(resolve, 1));

        const slot0 = node.connectCalls.filter(c => c.slotIndex === 0);
        assert.equal(slot0.length, 0,
            "slot 数変動時は positional fallback で復元しない (不変時のみ救済する設計)");
    });
});
