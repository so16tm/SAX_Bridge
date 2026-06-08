/**
 * makeJsonWidgetAccessor テスト
 *
 * sax_ui_base.js の `makeJsonWidgetAccessor` は app.js を import する経路に含まれるため
 * テスト環境から直接 import できない。同等ロジックをここで再実装して検証する。
 *
 * 実行: node --test tests/js/json_widget_accessor.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// テスト用 makeJsonWidgetAccessor 再実装（sax_ui_base.js の実装と同一ロジック）
function makeJsonWidgetAccessor(widgetName, fallback = [], { fireCallback = false } = {}) {
    return {
        getEntries(node) {
            const w = node.widgets?.find(w => w.name === widgetName);
            try { return JSON.parse(w?.value ?? "null") ?? fallback; }
            catch { return fallback; }
        },
        saveEntries(node, value) {
            const w = node.widgets?.find(w => w.name === widgetName);
            if (!w) return;
            w.value = JSON.stringify(value);
            if (fireCallback) w.callback?.(w.value);
        },
    };
}

function makeNode(widgets) {
    return { widgets };
}

describe("makeJsonWidgetAccessor.getEntries", () => {
    it("有効な JSON 配列をパースして返す", () => {
        const node = makeNode([{ name: "data", value: '[1,2,3]' }]);
        const acc = makeJsonWidgetAccessor("data", []);
        assert.deepEqual(acc.getEntries(node), [1, 2, 3]);
    });

    it("有効な JSON オブジェクトをパースして返す", () => {
        const node = makeNode([{ name: "cfg", value: '{"a":1}' }]);
        const acc = makeJsonWidgetAccessor("cfg", {});
        assert.deepEqual(acc.getEntries(node), { a: 1 });
    });

    it("パース失敗時に fallback を返す", () => {
        const node = makeNode([{ name: "data", value: 'not json' }]);
        const acc = makeJsonWidgetAccessor("data", ["fb"]);
        assert.deepEqual(acc.getEntries(node), ["fb"]);
    });

    it("widget 値が undefined のとき fallback を返す (null パース)", () => {
        const node = makeNode([{ name: "data" }]);
        const acc = makeJsonWidgetAccessor("data", [42]);
        assert.deepEqual(acc.getEntries(node), [42]);
    });

    it("widget が存在しないとき fallback を返す", () => {
        const node = makeNode([]);
        const acc = makeJsonWidgetAccessor("missing", ["fb"]);
        assert.deepEqual(acc.getEntries(node), ["fb"]);
    });

    it("widgets が undefined のときも fallback を返す", () => {
        const node = {};
        const acc = makeJsonWidgetAccessor("data", []);
        assert.deepEqual(acc.getEntries(node), []);
    });

    it("JSON 値が null のとき fallback を返す", () => {
        const node = makeNode([{ name: "data", value: "null" }]);
        const acc = makeJsonWidgetAccessor("data", ["fb"]);
        assert.deepEqual(acc.getEntries(node), ["fb"]);
    });
});

describe("makeJsonWidgetAccessor.saveEntries", () => {
    it("値を JSON.stringify して widget.value に書き込む", () => {
        const w = { name: "data", value: "[]" };
        const node = makeNode([w]);
        const acc = makeJsonWidgetAccessor("data", []);
        acc.saveEntries(node, [{ on: true, name: "x" }]);
        assert.equal(w.value, '[{"on":true,"name":"x"}]');
    });

    it("widget が存在しないとき何もしない", () => {
        const node = makeNode([]);
        const acc = makeJsonWidgetAccessor("missing", []);
        assert.doesNotThrow(() => acc.saveEntries(node, [1, 2]));
    });

    it("fireCallback: true のとき widget.callback を呼ぶ", () => {
        let calledWith = null;
        const w = {
            name: "data",
            value: "[]",
            callback(v) { calledWith = v; },
        };
        const node = makeNode([w]);
        const acc = makeJsonWidgetAccessor("data", [], { fireCallback: true });
        acc.saveEntries(node, [9]);
        assert.equal(calledWith, "[9]");
    });

    it("fireCallback: false (デフォルト) のとき callback を呼ばない", () => {
        let called = false;
        const w = {
            name: "data",
            value: "[]",
            callback() { called = true; },
        };
        const node = makeNode([w]);
        const acc = makeJsonWidgetAccessor("data", []);
        acc.saveEntries(node, [1]);
        assert.equal(called, false);
    });

    it("fireCallback: true でも widget.callback が無ければエラーにならない", () => {
        const w = { name: "data", value: "[]" };
        const node = makeNode([w]);
        const acc = makeJsonWidgetAccessor("data", [], { fireCallback: true });
        assert.doesNotThrow(() => acc.saveEntries(node, [1]));
        assert.equal(w.value, "[1]");
    });
});

describe("makeJsonWidgetAccessor round-trip", () => {
    it("save → get で同等の値が取り出せる (配列)", () => {
        const w = { name: "items", value: "[]" };
        const node = makeNode([w]);
        const acc = makeJsonWidgetAccessor("items", []);
        const input = [{ on: true, strength: 0.5 }, { on: false, strength: 1.2 }];
        acc.saveEntries(node, input);
        assert.deepEqual(acc.getEntries(node), input);
    });

    it("save → get で同等の値が取り出せる (オブジェクト)", () => {
        const w = { name: "cfg", value: "{}" };
        const node = makeNode([w]);
        const acc = makeJsonWidgetAccessor("cfg", {});
        const input = { managed: [], scenes: { Default: {} }, currentScene: "Default" };
        acc.saveEntries(node, input);
        assert.deepEqual(acc.getEntries(node), input);
    });
});
