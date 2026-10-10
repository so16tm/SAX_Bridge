import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub, makeNode, makeGraph } from "../bench/env.mjs";
import { emptyConfig } from "../../js/sax_text_catalog_v2_model.js";

register("../bench/hooks.mjs", import.meta.url);
installDomStub();
const { app } = await import("../bench/stubs/comfy_app.js");
const { installQuickControls } = await import("../../js/sax_text_catalog_v2_quick.js");
const handlers = new Map();
window.addEventListener = (type, fn) => handlers.set(type, fn);
window.removeEventListener = type => handlers.delete(type);

function fixture(groups = 2) {
    const config = emptyConfig();
    config.catalog.items = [{ id: "a", name: "素材", text: "原文", tags: [] }];
    config.recipes[0].groups = Array.from({ length: groups }, (_, i) => ({ id: `g${i}`, name: `グループ${i}`, item_ids: ["a"], mode: i === 0 ? "all" : "random", count: 1, on: true }));
    config.recipes.push({ id: "r2", name: config.recipes[0].name, groups: [] });
    const node = makeNode({ graph: makeGraph() }); app.graph = node.graph;
    node.widgets = [{ name: "config_json", value: JSON.stringify(config) }, { name: "seed", value: 123 }];
    node.addWidget("button", "カタログを開く", null, () => {});
    const state = { history: null };
    const controller = installQuickControls(node, { state: () => state });
    const picker = node.widgets.find(w => w.name === "組み合わせ");
    const quick = node.widgets.find(w => w.name === "__sax_text_catalog_v2_quick");
    return { node, state, picker, quick, controller, read: () => JSON.parse(node.widgets[0].value) };
}

test("ノード上で組み合わせを切り替え、同名Recipeも区別できる", () => {
    const { node, picker, read } = fixture();
    assert.equal(picker.options.values.length, 2);
    assert.notEqual(picker.options.values[0], picker.options.values[1]);
    picker.callback(picker.options.values[1]);
    assert.equal(read().active_recipe_id, "r2");
    assert.equal(read().catalog.items[0].text, "原文");
    assert.equal(node.widgets.at(-1).name, "管理・編集");
    assert.equal(picker.serialize, false);
    assert.deepEqual(node.widgets.filter(w => w.options?.serialize !== false).map(w => w.name), ["config_json", "seed"]);
    assert.equal(read().recipes[0].groups.some(g => "_recipeId" in g), false);
});

test("グループのON/OFFはノード上のpillで変更し、候補を維持", () => {
    const { node, quick, read, state } = fixture();
    quick.mouse({ type: "pointerdown" }, [20, 28], node);
    assert.equal(read().recipes[0].groups[0].on, false);
    assert.deepEqual(read().recipes[0].groups[0].item_ids, ["a"]);
    assert.equal(JSON.parse(state.history.undo()).recipes[0].groups[0].on, true);
});

test("ランダム選択数はノードのパラメータドラッグで整数として更新", () => {
    const { node, quick, read } = fixture();
    quick.mouse({ type: "pointerdown", clientY: 100 }, [node.size[0] - 25, 52], node);
    handlers.get("pointermove")({ clientY: 96 });
    handlers.get("pointerup")({ type: "pointerup" });
    assert.equal(read().recipes[0].groups[1].count, 5);
    assert.equal(read().recipes[0].groups[0].count, 1);
});

test("大量のグループは8件ずつ表示し、次ページの実グループを操作", () => {
    const { node, quick, read } = fixture(32);
    assert.ok(quick.computeSize(node.size[0])[1] < 250);
    // header16 + 8rows*24 + padding6 がページ切り替え行の先頭。
    quick.mouse({ type: "pointerdown" }, [node.size[0] - 20, 220], node);
    quick.mouse({ type: "pointerdown" }, [20, 28], node);
    assert.equal(read().recipes[0].groups[8].on, false);
    assert.equal(read().recipes[0].groups[0].on, true);
});

test("再initializeで操作ウィジェットを重複追加せず、不明形式も保全", () => {
    const { node } = fixture();
    installQuickControls(node, {});
    assert.equal(node.widgets.filter(w => w.name === "組み合わせ").length, 1);
    assert.equal(node.widgets.filter(w => w.name === "__sax_text_catalog_v2_quick").length, 1);
    node.widgets[0].value = '{"version":999}';
    installQuickControls(node, {});
    assert.equal(node.widgets[0].value, '{"version":999}');
});

test("件数ドラッグ中にRecipeを切り替えても、同じgroup IDの別Recipeを変更しない", () => {
    const { node, picker, quick, controller, read } = fixture();
    const config = read();
    config.recipes[1].groups = [{ id: "g1", name: "同じID", mode: "random", item_ids: ["a"], count: 9, on: false }];
    node.widgets[0].value = JSON.stringify(config); controller.refresh();
    quick.mouse({ type: "pointerdown", clientY: 100 }, [node.size[0] - 25, 52], node);
    picker.callback(picker.options.values[1]);
    handlers.get("pointermove")({ clientY: 96 });
    handlers.get("pointerup")({ type: "pointerup" });
    assert.equal(read().recipes[1].groups[0].count, 9);
    assert.equal(read().recipes[1].groups[0].on, false);
});
