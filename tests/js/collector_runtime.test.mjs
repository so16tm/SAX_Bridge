import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DynamicSlotCoordinator } from "../../js/sax_dynamic_slot_coordinator.js";
import * as collectorLink from "../../js/sax_collector_link.js";

// ブラウザーの app 境界だけを差し替え、実際のファクトリと各 Collector spec を実行する。
function loadRuntime(file, deps, exports) {
    const source = readFileSync(new URL(`../../js/${file}`, import.meta.url), "utf8")
        .replace(/^import[\s\S]*?;\s*$/gm, "")
        .replace(/\bexport (?=(?:async )?function|const|class)/g, "");
    return new Function(...Object.keys(deps), `${source}\nreturn {${exports}};`)(...Object.values(deps));
}

function setup(kind, outputs = [{ name: "image", type: "IMAGE" }]) {
    let nextLink = 1;
    const graph = {
        _nodes: [], links: {},
        getNodeById(id) { return this._nodes.find(n => n.id === id); },
        removeLink(id) {
            const link = this.links[id];
            if (!link) return;
            const from = this.getNodeById(link.origin_id), to = this.getNodeById(link.target_id);
            from.outputs[link.origin_slot].links = from.outputs[link.origin_slot].links.filter(x => x !== id);
            if (to.inputs[link.target_slot]?.link === id) to.inputs[link.target_slot].link = null;
            delete this.links[id];
        },
        setDirtyCanvas() {},
    };
    const app = { graph, canvas: { setDirty() {} }, registerExtension() {} };
    const base = loadRuntime("sax_ui_base.js", {
        app, _sourceSignatureImpl: collectorLink.sourceSignature, ...collectorLink,
        MutationObserver: class { observe() {} }, document: { documentElement: {}, head: {} },
    }, "makeSourceListWidget,initSourceBase,applySourceListLifecycle,ensureRenderLinkPatch,rowLayout");
    const builder = { node: "buildNodeCollectorSpec", image: "buildImageCollectorSpec", pipe: "buildPipeCollectorSpec" }[kind];
    const runtime = loadRuntime(`sax_${kind}_collector.js`, {
        app, ...base, ...collectorLink, showPicker() {}, ensureCoordinator() {}, showDialog() {}, h() {},
    }, `SOURCE_SPEC,${builder}`);
    function node(id, slots = []) {
        const n = {
            id, graph, pos: [0, 0], size: [320, 80], widgets: [], inputs: [], outputs: [],
            computeSize() { return this.size; }, addCustomWidget(w) { this.widgets.push(w); },
            addInput(name, type) { this.inputs.push({ name, type, link: null }); },
            addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
            removeInput(i) {
                if (this.inputs[i].link != null) graph.removeLink(this.inputs[i].link);
                this.inputs.splice(i, 1);
                for (const l of Object.values(graph.links)) if (l.target_id === id && l.target_slot > i) l.target_slot--;
            },
            removeOutput(i) {
                for (const link of [...this.outputs[i].links]) graph.removeLink(link);
                this.outputs.splice(i, 1);
                for (const l of Object.values(graph.links)) if (l.origin_id === id && l.origin_slot > i) l.origin_slot--;
            },
            connect(slot, target, input) {
                if (target.inputs[input].link != null) graph.removeLink(target.inputs[input].link);
                const linkId = nextLink++;
                graph.links[linkId] = { origin_id: id, origin_slot: slot, target_id: target.id, target_slot: input };
                this.outputs[slot].links.push(linkId);
                target.inputs[input].link = linkId;
            },
        };
        for (const o of slots) n.addOutput(o.name, o.type);
        graph._nodes.push(n);
        return n;
    }
    const upstream = node(1, outputs);
    const collector = node(2, kind === "node" ? [] : [{ name: "result", type: outputs[0].type }]);
    const target = node(3); target.addInput("input", "*"); target.addInput("input2", "*");
    const coordinator = new DynamicSlotCoordinator(collector, runtime[builder](collector));
    const widget = base.makeSourceListWidget(runtime.SOURCE_SPEC, coordinator);
    widget.onNodeCreated.call(collector);
    return { graph, upstream, collector, target, widget, node, base };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

it("Node Collector: source rebuild 後も下流接続を維持する", async () => {
    const { upstream, collector, target, widget, graph } = setup("node");
    widget.addSource(collector, upstream); await settle();
    collector.connect(0, target, 0);
    widget.modifySource(collector, 0, src => { src.sourceTitle = "renamed"; });
    await settle();
    assert.equal(graph.links[target.inputs[0].link]?.origin_id, collector.id);
});

it("Node Collector: 有効スロット変更の capture は変更前の対応を保持する", async () => {
    const { upstream, collector, target, widget, graph } = setup("node", [
        { name: "a", type: "IMAGE" }, { name: "b", type: "IMAGE" },
    ]);
    widget.addSource(collector, upstream); await settle();
    collector.connect(0, target, 0); collector.connect(1, target, 1);
    widget.modifySource(collector, 0, src => { src.enabledSlots = [1]; });
    await settle();
    assert.equal(target.inputs[0].link, null);
    assert.equal(graph.links[target.inputs[1].link]?.origin_slot, 0);
});

it("Node Collector: 同名出力の下流接続を先頭へ集約しない", async () => {
    const { upstream, collector, target, widget, graph } = setup("node", [
        { name: "image", type: "IMAGE" }, { name: "image", type: "IMAGE" },
    ]);
    widget.addSource(collector, upstream); await settle();
    collector.connect(0, target, 0); collector.connect(1, target, 1);
    widget.modifySource(collector, 0, src => { src.sourceTitle = "changed"; });
    await settle();
    assert.equal(graph.links[target.inputs[0].link]?.origin_slot, 0);
    assert.equal(graph.links[target.inputs[1].link]?.origin_slot, 1);
});

it("Node Collector: 同一タスクで複数 source を追加しても既存接続を維持する", async () => {
    const { upstream, collector, target, widget, graph, node } = setup("node");
    widget.addSource(collector, upstream); await settle();
    collector.connect(0, target, 0);
    widget.addSource(collector, node(4, [{ name: "b", type: "IMAGE" }]));
    widget.addSource(collector, node(5, [{ name: "c", type: "IMAGE" }]));
    await settle();
    assert.equal(graph.links[target.inputs[0].link]?.origin_slot, 0);
});

it("Node Collector: 残り1ピンでも上流末尾の出力を選択できる", async () => {
    const slots = Array.from({ length: 31 }, (_, i) => ({ name: `a${i}`, type: "IMAGE" }));
    const { upstream, collector, widget, node } = setup("node", slots);
    widget.addSource(collector, upstream); await settle();
    const second = node(4, Array.from({ length: 32 }, (_, i) => ({ name: `b${i}`, type: "IMAGE" })));
    widget.addSource(collector, second); await settle();
    assert.equal(collector._remoteSources[1].slotCount, 32);
    widget.modifySource(collector, 1, src => { src.enabledSlots = [31]; });
    await settle();
    assert.equal(collector.outputs.length, 32);
    assert.equal(collector.outputs[31].name, "b31");
});

it("Node Collector: 上流の型と名前が変わったら出力メタデータも更新する", async () => {
    const { upstream, collector, widget } = setup("node");
    widget.addSource(collector, upstream); await settle();
    upstream.outputs[0].name = "mask";
    upstream.outputs[0].type = "MASK";
    widget.modifySource(collector, 0, () => {});
    await settle();
    assert.equal(collector.outputs[0].name, "mask");
    assert.equal(collector.outputs[0].type, "MASK");
});

for (const kind of ["image", "pipe"]) {
    it(`${kind} Collector: 最後の source 削除でも固定出力リンクを維持する`, async () => {
        const type = kind === "image" ? "IMAGE" : "PIPE_LINE";
        const { upstream, collector, target, widget, graph, base } = setup(kind, [{ name: "result", type }]);
        widget.addSource(collector, upstream); await settle();
        collector.connect(0, target, 0);
        const linkId = target.inputs[0].link;
        const custom = collector.widgets[0];
        const layout = base.rowLayout(320, { hasJump: true, hasMoveUpDown: true, hasDelete: true });
        custom.mouse({ type: "pointerdown" }, [layout.del.x + 1, 21], collector);
        await settle();
        assert.equal(collector._remoteSources.length, 0);
        assert.equal(target.inputs[0].link, linkId);
        assert.equal(graph.links[linkId]?.origin_id, collector.id);
    });
}

it("Toggle Manager: 他経路で変更された実状態をクリックで反転する", () => {
    const { graph, node, base } = setup("node");
    const managed = node(4); managed.mode = 4;
    const manager = node(5);
    const item = { type: "node", id: 4 };
    const configWidget = { name: "config_json", value: JSON.stringify({
        managed: [item], scenes: { Default: { "n:4": true } }, currentScene: "Default",
    }) };
    manager.widgets.push(configWidget);
    const runtime = loadRuntime("sax_toggle_manager.js", {
        app: { graph, registerExtension() {} }, ...base,
        makeJsonWidgetAccessor: (name) => ({
            getEntries: n => JSON.parse(n.widgets.find(w => w.name === name).value),
            saveEntries: (n, value) => { n.widgets.find(w => w.name === name).value = JSON.stringify(value); },
        }),
        itemKey: i => `n:${i.id}`, inX: (pos, x, width) => pos[0] >= x && pos[0] < x + width,
        ROW_H: 24,
        document: { addEventListener() {} },
    }, "makeToggleWidget");
    const widget = runtime.makeToggleWidget(manager, item, 0);
    const layout = base.rowLayout(320, { hasToggle: true, hasMoveUpDown: true, hasDelete: true });
    widget.mouse({ type: "pointerdown" }, [layout.pill.x + 1, 10], manager);
    assert.equal(managed.mode, 0);
    assert.equal(JSON.parse(configWidget.value).scenes.Default["n:4"], true);
});

it("Assert UI: label / actual の PASS により FAIL / ERROR を成功表示しない", () => {
    const { detectStatus } = loadRuntime("sax_debug.js", { app: { registerExtension() {} } }, "detectStatus");
    assert.equal(detectStatus('[PASS expected] FAIL: mode=equals actual=\'PASS\''), "fail");
    assert.equal(detectStatus('[SAX Assert] "PASS" ERROR: invalid expected'), "error");
    assert.equal(detectStatus('[FAIL label] PASS'), "pass");
    assert.equal(detectStatus('arbitrary text with PASS'), "neutral");
});
