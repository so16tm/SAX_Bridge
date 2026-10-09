/**
 * makeItemListWidget の param ボタン（`set` を持たない onPopup 専用 param）の回帰テスト。
 *
 * Text Catalog の relation 行にある ✎ は `get` / `onPopup` だけを持ち `set` が無い。
 * ドラッグ経路が `p.set` を無条件に呼ぶと、クリック時にカーソルが数 px 動いただけで
 * 例外が出たうえ `_dragged` が立ち、pointerup の onPopup 経路まで塞がれて
 * 「✎ を押しても何も起きない」状態になる。
 *
 * 実行: node --test （引数なし）
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { installDomStub } from "../bench/env.mjs";

// js/*.js は ComfyUI 本体の ../../scripts/app.js を import するため、
// ベンチと同じ resolve フックでスタブへ差し替える。
register("../bench/hooks.mjs", import.meta.url);
installDomStub();

// window のイベントリスナ（ドラッグ経路が使う）を捕捉できるようにする
const winListeners = new Map();
globalThis.addEventListener = (type, fn) => {
    const arr = winListeners.get(type) ?? [];
    arr.push(fn);
    winListeners.set(type, arr);
};
globalThis.removeEventListener = (type, fn) => {
    winListeners.set(type, (winListeners.get(type) ?? []).filter(f => f !== fn));
};
const fireWindow = (type, evt) => {
    for (const fn of [...(winListeners.get(type) ?? [])]) fn(evt);
};

let makeItemListWidget;
before(async () => {
    const { app } = await import("../bench/stubs/comfy_app.js");
    app.graph = { setDirtyCanvas() {} };
    ({ makeItemListWidget } = await import("../../js/sax_ui_base.js"));
});

const W = 280;

/** param 1 つを持つ widget と、その param の当たり判定 x を返す。 */
function setup(paramOverrides) {
    const items = [{ id: "a" }];
    const popped = [];
    const widget = makeItemListWidget({
        widgetName: "__test_item_list",
        getItems: () => items,
        saveItems: () => {},
        params: [{ key: "edit", w: 24, get: () => "", format: () => "✎",
                   onPopup: (item) => popped.push(item), ...paramOverrides }],
        content: { draw() {} },
    });
    widget._y = 0;
    const node = { size: [W, 200], widgets: [], setDirtyCanvas() {} };
    // param は行の右端から積まれる。右端から w/2 の位置を突く。
    const x = W - 6 - 12;
    return { widget, node, items, popped, pos: [x, 12] };
}

describe("makeItemListWidget: set を持たない param", () => {
    beforeEach(() => winListeners.clear());

    it("ドラッグ相当の pointermove で例外を投げない", () => {
        const { widget, node, pos } = setup();
        widget.mouse({ type: "pointerdown", clientX: 10, clientY: 100 }, pos, node);
        assert.doesNotThrow(() => fireWindow("pointermove", { clientX: 10, clientY: 60 }));
    });

    it("少し動かしてから離しても onPopup が呼ばれる", () => {
        const { widget, node, items, popped, pos } = setup();
        widget.mouse({ type: "pointerdown", clientX: 10, clientY: 100 }, pos, node);
        fireWindow("pointermove", { clientX: 10, clientY: 60 });  // 40px ドラッグ相当
        fireWindow("pointerup", { type: "pointerup", clientX: 10, clientY: 60 });
        assert.deepEqual(popped, [items[0]]);
    });

    it("まったく動かさずに離しても onPopup が呼ばれる", () => {
        const { widget, node, items, popped, pos } = setup();
        widget.mouse({ type: "pointerdown", clientX: 10, clientY: 100 }, pos, node);
        fireWindow("pointerup", { type: "pointerup", clientX: 10, clientY: 100 });
        assert.deepEqual(popped, [items[0]]);
    });
});

describe("makeItemListWidget: set を持つ param はドラッグで値が変わる", () => {
    beforeEach(() => winListeners.clear());

    it("pointermove で set が呼ばれ、onPopup は呼ばれない", () => {
        const values = [];
        const { widget, node, popped, pos } = setup({
            get: () => 1.0,
            set: (_item, v) => values.push(v),
            step: 0.01,
            min: 0,
            max: 10,
        });
        widget.mouse({ type: "pointerdown", clientX: 10, clientY: 100 }, pos, node);
        fireWindow("pointermove", { clientX: 10, clientY: 90 });  // 上へ 10px
        fireWindow("pointerup", { type: "pointerup", clientX: 10, clientY: 90 });
        assert.equal(values.length, 1);
        assert.ok(values[0] > 1.0, `expected value to increase, got ${values[0]}`);
        assert.deepEqual(popped, []);
    });
});
