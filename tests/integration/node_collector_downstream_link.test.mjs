/**
 * Node Collector (出力スロット可変ノード) → 下流ノード の接続維持 統合テスト
 *
 * 再現する不具合:
 *   Node Collector は出力スロットが可変し、スロット選択変更 / ソース並べ替え /
 *   上流ノードの変化 (sig 変化) がいずれも `rebuildAllSources` = 「全出力ピンを破棄 →
 *   buildSource で再構築」を通る。この経路には独立した 2 つの切断要因があった。
 *
 *   (1) 上流ノード自体の問題 — entity identity の破壊
 *       rebuild が `buildSource` の戻り値 (新オブジェクト) を `_remoteSources` に戻すため、
 *       DynamicSlotCoordinator の WeakMap ベース entity identity が毎回壊れ、
 *       capture 済み下流リンクを 1 本も解決できなくなっていた。
 *       → adoptSourceIdentity (sax_collector_link.js) で旧オブジェクトへ in-place 取り込み。
 *
 *   (2) 下流ノードとの組み合わせ — 復元経路が下流端を壊す
 *       復元が「全出力リンクを removeLink → capture 時の targetSlot へ connect」だったため、
 *       下流が動的入力 (Autogrow、例: SAX Prompt Concat) だと removeLink で入力スロットが
 *       詰められ、陳腐化した targetSlot への再接続が失敗・誤接続していた。
 *       → spec.linkPreserving + #restoreByRepoint (origin_slot のみ in-place 付け替え)。
 *
 * 本テストは app / LiteGraph 非依存のフィクスチャで
 * 「buildSource → rebuildLiveSources → Coordinator 復元」の統合経路を通す。
 *
 * 実行: node --test tests/integration/node_collector_downstream_link.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { DynamicSlotCoordinator } from "../../js/sax_dynamic_slot_coordinator.js";
import { rebuildLiveSources } from "../../js/sax_collector_link.js";

// ---------------------------------------------------------------------------
// LiteGraph モック
// ---------------------------------------------------------------------------

function makeGraphMock() {
    const links = {};
    const nodes = new Map();
    let nextLinkId = 1;
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
            const originSlot = nodes.get(link.origin_id)?.outputs?.[link.origin_slot];
            if (originSlot?.links) originSlot.links = originSlot.links.filter(id => id !== linkId);
            const target = nodes.get(link.target_id);
            const targetSlot = link.target_slot;
            const targetInput = target?.inputs?.[targetSlot];
            if (targetInput && targetInput.link === linkId) targetInput.link = null;
            delete links[linkId];
            target?.disconnectInput?.(targetSlot);
        },
        setDirtyCanvas() {},
    };
}

function makeCollectorNode(graph, id = 1) {
    return {
        id,
        _graph: graph,
        outputs: [],
        inputs: [],
        connectCalls: [],
        connect(slotIndex, targetNode, targetSlot) {
            // 本物の LiteGraph.connect は対象入力スロットが無ければ link を作らない。
            if (targetNode.inputs && !targetNode.inputs[targetSlot]) {
                this.connectCalls.push({ slotIndex, targetSlot, failed: true });
                return null;
            }
            const existing = targetNode.inputs?.[targetSlot]?.link;
            if (existing != null) this._graph.removeLink(existing);
            const linkId = this._graph.addLink({
                origin_id: this.id, origin_slot: slotIndex,
                target_id: targetNode.id, target_slot: targetSlot,
            });
            this.outputs[slotIndex].links.push(linkId);
            if (targetNode.inputs?.[targetSlot]) targetNode.inputs[targetSlot].link = linkId;
            targetNode.onConnectionsChange?.("input", targetSlot, true, this._graph.links[linkId]);
            this.connectCalls.push({ slotIndex, targetSlot });
            return linkId;
        },
        addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
        removeOutput(idx) {
            const removed = this.outputs.splice(idx, 1)[0];
            if (removed?.links) for (const id of [...removed.links]) this._graph.removeLink(id);
            for (const link of Object.values(this._graph.links)) {
                if (link.origin_id === this.id && link.origin_slot > idx) link.origin_slot -= 1;
            }
        },
    };
}

// 上流ソースノード (Node Collector が参照する側)。
function makeUpstreamNode(id, outputs) {
    return { id, inputs: [], outputs: outputs.map(o => ({ name: o.name, type: o.type, links: [] })) };
}

// ComfyUI の io.Autogrow 入力 (例: SAX Prompt Concat の texts) を模倣する下流ノード。
// 切断を受けると該当入力スロットを削除し、以降を再採番する (スロット数自体が縮小する)。
function makeAutogrowNode(id, graph, { initialInputs = 1 } = {}) {
    return {
        id,
        outputs: [],
        inputs: Array.from({ length: initialInputs }, (_, i) => ({ name: `text${i + 1}`, type: "*", link: null })),
        _graph: graph,
        onConnectionsChange(side, slot, connected, linkInfo) {
            if (side !== "input" || !connected) return;
            if (this.inputs[slot]) this.inputs[slot].link = linkInfo?.id ?? this.inputs[slot].link;
            if (this.inputs.every(inp => inp.link != null)) {
                this.inputs.push({ name: `text${this.inputs.length + 1}`, type: "*", link: null });
            }
        },
        disconnectInput(slot) {
            if (!this.inputs[slot]) return;
            this.inputs.splice(slot, 1);
            for (const link of Object.values(this._graph.links)) {
                if (link.target_id === this.id && link.target_slot > slot) link.target_slot -= 1;
            }
            this.inputs.forEach((inp, i) => { inp.name = `text${i + 1}`; });
        },
    };
}

// ---------------------------------------------------------------------------
// Node Collector のプロダクション実装を再現するフィクスチャ
// ---------------------------------------------------------------------------

// js/sax_node_collector.js buildSource の再現 (_rebuildHints による enabledSlots 引継ぎ込み)。
function collectorBuildSource(srcNode, collectorNode) {
    const srcOutputs = srcNode.outputs ?? [];
    const allCount = srcOutputs.length;
    if (allCount === 0) return null;

    const hint = collectorNode._rebuildHints?.get(srcNode.id);
    let enabledSlots;
    if (hint?.enabledSlots) {
        const oldEnabled = hint.enabledSlots;
        const oldCount = hint.slotCount ?? oldEnabled.length;
        if (allCount > oldCount) {
            enabledSlots = [...oldEnabled, ...Array.from({ length: allCount - oldCount }, (_, i) => oldCount + i)];
        } else if (allCount < oldCount) {
            enabledSlots = oldEnabled.filter(i => i < allCount);
        } else {
            enabledSlots = [...oldEnabled];
        }
    } else {
        enabledSlots = Array.from({ length: allCount }, (_, i) => i);
    }

    return {
        sourceId: srcNode.id,
        slotCount: allCount,
        enabledSlots,
        slotNames: srcOutputs.map((o, i) => o.label || o.name || o.type || `out_${i}`),
        slotTypes: srcOutputs.map(o => o.type || "*"),
    };
}

// js/sax_node_collector.js buildNodeCollectorSpec の再現。
function buildNodeCollectorSpec(node) {
    return {
        direction: "output",
        linkPreserving: true,
        getEntities: () => node._remoteSources ?? [],
        setEntities: (newSources) => { node._remoteSources = newSources; },
        entityToSlots: (src, hints) => {
            const hint = hints?.get?.(src?.sourceId) ?? node._rebuildHints?.get?.(src?.sourceId);
            const enabled = hint?.enabledSlots ?? src?.enabledSlots
                ?? Array.from({ length: src?.slotCount ?? 0 }, (_, i) => i);
            const slotNames = src?.slotNames ?? [];
            const slotTypes = src?.slotTypes ?? [];
            return enabled.map((gi, li) => ({ name: slotNames[gi] || `out_${li}`, type: slotTypes[gi] || "*" }));
        },
        syncSlotStructure: () => {},
        resolveLocalSlotBySlotName: (entity, slotName) => {
            const globalIdx = entity?.slotNames?.indexOf(slotName) ?? -1;
            if (globalIdx < 0) return null;
            const localIdx = entity?.enabledSlots?.indexOf(globalIdx) ?? -1;
            return localIdx >= 0 ? localIdx : null;
        },
        resolveLocalSlotByGlobalIdx: (entity, globalSlotIdx) => {
            const localIdx = entity?.enabledSlots?.indexOf(globalSlotIdx) ?? -1;
            return localIdx >= 0 ? localIdx : null;
        },
    };
}

// js/sax_ui_base.js の rebuildAllSources (_rebuildInner) 相当。
// 全出力ピンを破棄 → buildSource で fresh 再構築 → 旧 source へ in-place 取り込み。
// beforeRebuild はプロダクション同様 **トランザクション内側** で実行する
// (modifySource が source を書き換えてから rebuild する経路の再現)。
function rebuildAllSources(node, graph, coordinator, beforeRebuild = null) {
    coordinator.mutate((entities) => {
        beforeRebuild?.();
        const saved = [...entities];
        node._rebuildHints = new Map(
            saved.map(s => [s.sourceId, { enabledSlots: s.enabledSlots, slotCount: s.slotCount }]),
        );
        for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) node.removeOutput(i);
        node._remoteSources = [];

        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById: (id) => graph.getNodeById(id),
            buildSourceFn: (srcNode) => collectorBuildSource(srcNode, node),
            getSlotCount: (s) => s.enabledSlots?.length ?? s.slotCount ?? 0,
        });
        for (const { source } of rebuilt) {
            for (const gi of (source.enabledSlots ?? [])) {
                node.addOutput(source.slotNames[gi], source.slotTypes[gi]);
            }
            node._remoteSources.push(source);
        }
        node._rebuildHints = null;
    });
}

// ---------------------------------------------------------------------------
// アサーションヘルパ
// ---------------------------------------------------------------------------

// 当ノード → 下流ノードのリンクを { id, pin, pinName, targetSlot } で返す (pin 昇順)。
function downstreamLinks(graph, node, downstreamId) {
    return Object.values(graph.links)
        .filter(l => l.origin_id === node.id && l.target_id === downstreamId)
        .map(l => ({
            id: l.id,
            pin: l.origin_slot,
            pinName: node.outputs[l.origin_slot]?.name,
            targetSlot: l.target_slot,
        }))
        .sort((a, b) => a.pin - b.pin);
}

// 上流 outputs[].links / 下流 inputs[].link の双方が graph.links と整合すること。
function assertGraphIntegrity(graph, node, downstream, label) {
    for (const link of Object.values(graph.links)) {
        if (link.origin_id === node.id) {
            const out = node.outputs[link.origin_slot];
            assert.ok(out, `[${label}] link ${link.id} の origin_slot=${link.origin_slot} に出力ピンが実在するべき`);
            assert.ok(out.links?.includes(link.id),
                `[${label}] outputs[${link.origin_slot}].links は link ${link.id} を含むべき`);
        }
        if (link.target_id === downstream.id) {
            const inp = downstream.inputs[link.target_slot];
            assert.ok(inp, `[${label}] link ${link.id} の target_slot=${link.target_slot} に入力スロットが実在するべき`);
            assert.equal(inp.link, link.id,
                `[${label}] 下流 inputs[${link.target_slot}].link は link ${link.id} を指すべき`);
        }
    }
}

// ===========================================================================

describe("Node Collector → 下流ノード: rebuild を挟んでも接続が切れない", () => {
    let graph;
    let savedApp;

    beforeEach(() => {
        graph = makeGraphMock();
        savedApp = globalThis.app;
        globalThis.app = { graph, canvas: { setDirty() {} } };
    });
    afterEach(() => { globalThis.app = savedApp; });

    // 上流 2 ノード (各 2 出力) を Node Collector に登録し、出力ピン 4 本を下流へ全結線する。
    function setup(downstream) {
        const node = makeCollectorNode(graph);
        graph.registerNode(node);
        graph.registerNode(downstream);

        const up1 = makeUpstreamNode(10, [{ name: "A", type: "STRING" }, { name: "B", type: "STRING" }]);
        const up2 = makeUpstreamNode(20, [{ name: "C", type: "STRING" }, { name: "D", type: "STRING" }]);
        graph.registerNode(up1);
        graph.registerNode(up2);

        node._remoteSources = [];
        for (const up of [up1, up2]) {
            const src = collectorBuildSource(up, node);
            for (const gi of src.enabledSlots) node.addOutput(src.slotNames[gi], src.slotTypes[gi]);
            node._remoteSources.push(src);
        }
        for (let i = 0; i < 4; i++) node.connect(i, downstream, i);

        const coordinator = new DynamicSlotCoordinator(node, buildNodeCollectorSpec(node));
        node.connectCalls = [];
        return { node, up1, up2, coordinator };
    }

    it("動的入力下流 (Autogrow): rebuild しても 4 本すべて維持される", () => {
        const ag = makeAutogrowNode(900, graph, { initialInputs: 1 });
        const { node, coordinator } = setup(ag);

        const before = downstreamLinks(graph, node, ag.id);
        const inputCountBefore = ag.inputs.length;
        assert.equal(before.length, 4, "前提: 4 本結線されている");

        rebuildAllSources(node, graph, coordinator);

        const after = downstreamLinks(graph, node, ag.id);
        assert.deepEqual(after, before,
            "rebuild 後も link id / 物理ピン / 下流端がすべて不変であるべき");
        assert.equal(ag.inputs.length, inputCountBefore,
            "下流 Autogrow の入力スロットは縮小しないべき");
        assert.equal(node.connectCalls.length, 0, "下流端に触れないため connect は使わない");
        assertGraphIntegrity(graph, node, ag, "autogrow-rebuild");
    });

    it("動的入力下流 (Autogrow): 上流の出力名変更を挟んだ rebuild でも接続が維持される", () => {
        const ag = makeAutogrowNode(901, graph, { initialInputs: 1 });
        const { node, up1, coordinator } = setup(ag);
        const before = downstreamLinks(graph, node, ag.id);

        // 上流ノード側の出力名が変わる (sig 変化 → rebuildAllSources が走る実運用ケース)。
        up1.outputs[0].name = "A_renamed";
        rebuildAllSources(node, graph, coordinator);

        const after = downstreamLinks(graph, node, ag.id);
        assert.deepEqual(after.map(l => ({ id: l.id, pin: l.pin, targetSlot: l.targetSlot })),
            before.map(l => ({ id: l.id, pin: l.pin, targetSlot: l.targetSlot })),
            "上流改名を挟んでも link は作り直されず物理位置・下流端が保たれるべき");
        assert.equal(ag.inputs.length, 5, "下流 Autogrow は縮小しないべき");
        assertGraphIntegrity(graph, node, ag, "rename-rebuild");
    });

    it("動的入力下流 (Autogrow): スロット選択解除では解除した 1 本だけが切れる", () => {
        const ag = makeAutogrowNode(902, graph, { initialInputs: 1 });
        const { node, coordinator } = setup(ag);
        const before = downstreamLinks(graph, node, ag.id);
        const removedLinkId = before.find(l => l.pinName === "A").id;

        // showSlotSelectDialog → _applySlotSelection → modifySource → rebuildAllSources 相当。
        // updater はトランザクション内側で走る (capture が古い出力ピン配置とずれないため)。
        rebuildAllSources(node, graph, coordinator, () => {
            node._remoteSources[0].enabledSlots = [1];
        });

        const after = downstreamLinks(graph, node, ag.id);
        assert.equal(after.length, 3, "解除した A の 1 本だけが切れるべき");
        assert.ok(!after.some(l => l.id === removedLinkId), "A の link が除去されている");
        assert.deepEqual(after.map(l => l.pinName), ["B", "C", "D"],
            "残る 3 本は詰めた物理ピンに正しく追従するべき");
        assert.deepEqual(after.map(l => l.targetSlot), [0, 1, 2],
            "下流は切れた 1 本分だけ詰まり、残りの対応は保たれる");
        assert.equal(ag.inputs.length, 4, "下流 Autogrow の縮小は 1 本分だけ (5 → 4)");
        assertGraphIntegrity(graph, node, ag, "deselect-rebuild");
    });

    it("動的入力下流 (Autogrow): ソース並べ替えで各 link が entity に追従する", () => {
        const ag = makeAutogrowNode(903, graph, { initialInputs: 1 });
        const { node, coordinator } = setup(ag);
        const before = downstreamLinks(graph, node, ag.id);

        // swapSources 相当: 入れ替えもトランザクション内側で行う (プロダクション同様)。
        rebuildAllSources(node, graph, coordinator, () => {
            const s = node._remoteSources;
            [s[0], s[1]] = [s[1], s[0]];
        });

        const after = downstreamLinks(graph, node, ag.id);
        assert.equal(after.length, 4, "並べ替えでも 4 本すべて維持されるべき");
        assert.deepEqual(after.map(l => l.pinName), ["C", "D", "A", "B"],
            "出力ピンは新しい順序になる");
        assert.deepEqual(
            after.map(l => [l.pinName, l.targetSlot]),
            [["C", 2], ["D", 3], ["A", 0], ["B", 1]],
            "各 link は元の下流端を保ったまま新しい出力ピンへ付け替わるべき");
        assert.deepEqual(after.map(l => l.id).sort(), before.map(l => l.id).sort(),
            "link は作り直されない");
        assert.equal(ag.inputs.length, 5, "下流 Autogrow は縮小しないべき");
        assertGraphIntegrity(graph, node, ag, "swap-rebuild");
    });

    it("静的入力下流でも rebuild で接続が維持される (下流種別に依存しない)", () => {
        const target = {
            id: 904, outputs: [],
            inputs: Array.from({ length: 4 }, (_, i) => ({ name: `in${i}`, type: "*", link: null })),
        };
        const { node, coordinator } = setup(target);
        const before = downstreamLinks(graph, node, target.id);

        rebuildAllSources(node, graph, coordinator);

        assert.deepEqual(downstreamLinks(graph, node, target.id), before,
            "静的入力下流でも link id / 物理ピン / 下流端が不変であるべき");
        assertGraphIntegrity(graph, node, target, "static-rebuild");
    });
});
