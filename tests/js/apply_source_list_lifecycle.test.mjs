/**
 * applySourceListLifecycle テスト
 *
 * sax_ui_base.js は app.js を import するため直接 import 不可。
 * 同等ロジックを再実装してモック nodeType に対する prototype 設定挙動を検証する。
 *
 * 実行: node --test tests/js/apply_source_list_lifecycle.test.mjs
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// applySourceListLifecycle と同等のテンプレート (sax_ui_base.js の実装と
// 形を揃える。本テストは prototype フックの設定と呼出順を検証する)。
function applySourceListLifecycle(nodeType, spec) {
    const {
        sourceSpec,
        buildCoordinatorSpec,
        ensureCoordinator,
        initialSize = [280, 1],
        clearOutputsOnCreate = false,
        clearAllSlots: clearAllSlotsFn,
        makeSourceListWidget,  // テスト注入用 (実装では import 経由)
    } = spec;

    const [minW, initH] = initialSize;

    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        origOnNodeCreated?.apply(this, arguments);
        clearAllSlotsFn(this, { outputs: clearOutputsOnCreate });

        const coordinator = ensureCoordinator(this, buildCoordinatorSpec);
        this._saxSourceWidget = makeSourceListWidget(sourceSpec, coordinator);
        this._saxSourceWidget.onNodeCreated.call(this);

        this.size[0] = Math.max(this.size[0], minW);
        this.size[1] = initH;
    };

    const origOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (data) {
        origOnSerialize?.apply(this, arguments);
        this._saxSourceWidget?.onSerialize.call(this, data);
    };

    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
        origOnConfigure?.apply(this, arguments);
        this._saxSourceWidget?.onConfigure.call(this, data);
    };
}

function makeMockNodeType() {
    return { prototype: {} };
}

function makeMockSourceWidget() {
    const calls = { onNodeCreated: 0, onSerialize: [], onConfigure: [] };
    return {
        calls,
        widget: {
            onNodeCreated: function () { calls.onNodeCreated++; },
            onSerialize:   function (data) { calls.onSerialize.push({ self: this, data }); },
            onConfigure:   function (data) { calls.onConfigure.push({ self: this, data }); },
        },
    };
}

describe("applySourceListLifecycle", () => {
    it("nodeType.prototype に 3 つのフックを設定する", () => {
        const nodeType = makeMockNodeType();
        applySourceListLifecycle(nodeType, {
            sourceSpec:           {},
            buildCoordinatorSpec: () => ({}),
            ensureCoordinator:    () => ({ mutate: () => {} }),
            clearAllSlots:        () => {},
            makeSourceListWidget: () => makeMockSourceWidget().widget,
        });
        assert.equal(typeof nodeType.prototype.onNodeCreated, "function");
        assert.equal(typeof nodeType.prototype.onSerialize,   "function");
        assert.equal(typeof nodeType.prototype.onConfigure,   "function");
    });

    it("onNodeCreated: ensureCoordinator → makeSourceListWidget → widget.onNodeCreated を順に呼ぶ", () => {
        const nodeType = makeMockNodeType();
        const order = [];
        const sw = makeMockSourceWidget();

        applySourceListLifecycle(nodeType, {
            sourceSpec:           { tag: "spec" },
            buildCoordinatorSpec: function buildSpec(node) { return { node }; },
            ensureCoordinator:    (node, fac) => { order.push("ensureCoordinator"); return { factory: fac, node }; },
            clearAllSlots:        (node, opts) => { order.push(`clearAllSlots:${opts.outputs}`); },
            makeSourceListWidget: (spec, coord) => {
                order.push(`makeSourceListWidget:${spec.tag}:${!!coord.factory}`);
                sw.widget.onNodeCreated = function () { order.push("widget.onNodeCreated"); };
                return sw.widget;
            },
            initialSize:          [320, 1],
            clearOutputsOnCreate: true,
        });

        const node = {
            size: [100, 99],
            inputs: [],
            outputs: [],
        };
        nodeType.prototype.onNodeCreated.call(node);

        assert.deepEqual(order, [
            "clearAllSlots:true",
            "ensureCoordinator",
            "makeSourceListWidget:spec:true",
            "widget.onNodeCreated",
        ]);
        assert.equal(node.size[0], 320);  // max(100, 320)
        assert.equal(node.size[1], 1);
        assert.equal(node._saxSourceWidget, sw.widget);
    });

    it("onSerialize: 既存の prototype.onSerialize を呼んだ後に widget.onSerialize を呼ぶ", () => {
        const nodeType = makeMockNodeType();
        const order = [];
        nodeType.prototype.onSerialize = function (data) { order.push(`orig:${data.tag}`); };

        const sw = makeMockSourceWidget();
        sw.widget.onSerialize = function (data) { order.push(`widget:${data.tag}`); };

        applySourceListLifecycle(nodeType, {
            sourceSpec:           {},
            buildCoordinatorSpec: () => ({}),
            ensureCoordinator:    () => ({ mutate: () => {} }),
            clearAllSlots:        () => {},
            makeSourceListWidget: () => sw.widget,
        });

        const node = { size: [0, 0], _saxSourceWidget: sw.widget };
        const data = { tag: "T" };
        nodeType.prototype.onSerialize.call(node, data);
        assert.deepEqual(order, ["orig:T", "widget:T"]);
    });

    it("onConfigure: 既存 prototype.onConfigure → widget.onConfigure の順で呼ぶ", () => {
        const nodeType = makeMockNodeType();
        const order = [];
        nodeType.prototype.onConfigure = function (data) { order.push(`orig:${data.tag}`); };

        const sw = makeMockSourceWidget();
        sw.widget.onConfigure = function (data) { order.push(`widget:${data.tag}`); };

        applySourceListLifecycle(nodeType, {
            sourceSpec:           {},
            buildCoordinatorSpec: () => ({}),
            ensureCoordinator:    () => ({ mutate: () => {} }),
            clearAllSlots:        () => {},
            makeSourceListWidget: () => sw.widget,
        });

        const node = { size: [0, 0], _saxSourceWidget: sw.widget };
        const data = { tag: "C" };
        nodeType.prototype.onConfigure.call(node, data);
        assert.deepEqual(order, ["orig:C", "widget:C"]);
    });

    it("onSerialize/onConfigure: _saxSourceWidget が null の場合は安全に no-op", () => {
        const nodeType = makeMockNodeType();
        applySourceListLifecycle(nodeType, {
            sourceSpec:           {},
            buildCoordinatorSpec: () => ({}),
            ensureCoordinator:    () => ({ mutate: () => {} }),
            clearAllSlots:        () => {},
            makeSourceListWidget: () => null,
        });

        const node = { size: [0, 0] };
        // throw しないこと
        nodeType.prototype.onSerialize.call(node, {});
        nodeType.prototype.onConfigure.call(node, {});
    });
});
