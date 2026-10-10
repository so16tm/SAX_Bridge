import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyConfig, validateConfig, parseConfig, parseTags, filteredItems, references, removeItems, recipeWarnings, EditHistory, BufferedJson, visibleWindow } from "../../js/sax_text_catalog_v2_model.js";

const fixture = count => {
    const config = emptyConfig();
    config.catalog.items = Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, name: `素材 ${i}`, text: `本文 ${i}`, tags: [i % 2 ? "style" : "camera"] }));
    return config;
};

test("10000件を保持し、検索/タグ絞り込みと未知形式の保全を検証", () => {
    const config = fixture(10000);
    assert.equal(parseConfig(JSON.stringify(config)).catalog.items.length, 10000);
    assert.equal(filteredItems(config, "本文 9999", "style")[0].id, "item-9999");
    assert.equal(filteredItems(config, "", "camera").length, 5000);
    assert.throws(() => validateConfig(fixture(10001)), /最大10000/);
    assert.throws(() => parseConfig("{broken"), /壊れています/);
    assert.throws(() => parseConfig('{"version":3}'), /対応していない/);
});

test("候補不足は警告、重複/参照切れは拒否、無効グループは警告しない", () => {
    const config = fixture(3);
    const group = { id: "g", name: "抽選", mode: "random", item_ids: ["item-0"], count: 2, on: true };
    config.recipes[0].groups.push(group);
    validateConfig(config); assert.equal(recipeWarnings(config).length, 1);
    group.on = false; assert.equal(recipeWarnings(config).length, 0);
    group.item_ids.push("item-0"); assert.throws(() => validateConfig(config), /重複/);
    group.item_ids = ["missing"]; assert.throws(() => validateConfig(config), /参照先/);
    group.item_ids = []; group.count = 10001; assert.throws(() => validateConfig(config), /整数/);
});

test("素材削除は全組み合わせの参照を除去し、別グループの重複使用を許容", () => {
    const config = fixture(3);
    const group = { id: "g", name: "固定", mode: "all", item_ids: ["item-0", "item-1"], count: 0, on: true };
    config.recipes[0].groups = [group];
    config.recipes.push({ id: "r2", name: "別案", groups: [structuredClone(group)] });
    assert.equal(references(config, "item-0"), 2);
    removeItems(config, ["item-0"]); validateConfig(config);
    assert.deepEqual(config.recipes.map(r => r.groups[0].item_ids), [["item-1"], ["item-1"]]);
    assert.deepEqual(parseTags("style, style、camera\n"), ["style", "camera"]);
});

test("10000件をスクロールしてもウィンドウは一定件数で端まで到達する", () => {
    const seen = new Set();
    for (let scroll = 0; scroll < 400000; scroll += 260) {
        const window = visibleWindow(10000, scroll);
        assert.ok(window.end - window.start <= 16);
        for (let i = window.start; i < window.end; i++) seen.add(i);
        assert.equal(window.top + (window.end - window.start) * 40 + window.bottom, 400000);
    }
    assert.equal(seen.size, 10000);
});

test("連続入力のUndo統合・Redo・新規編集によるRedo破棄", () => {
    const history = new EditHistory("a");
    history.record("b", "field"); history.record("c", "field");
    assert.equal(history.undo(), "a"); assert.equal(history.redo(), "c");
    history.boundary(); history.record("d", "field");
    assert.equal(history.undo(), "c"); history.record("e"); assert.equal(history.redo(), null);
    for (let i = 0; i < 30; i++) history.record(String(i));
    assert.ok(history.undoStack.length <= 20);
    const large = new EditHistory("a".repeat(9 * 1024 * 1024));
    for (let i = 0; i < 6; i++) large.record(String(i).repeat(9 * 1024 * 1024));
    assert.ok(large.undoStack.reduce((sum, raw) => sum + raw.length * 2, 0) <= 64 * 1024 * 1024);
});

test("debounceの待機前でもserialize相当のflushは最新入力を返す", () => {
    const widget = { value: '{"text":"before"}' }, config = { text: "before" };
    let writes = 0;
    const buffer = new BufferedJson(widget, () => config, () => writes++);
    config.text = "日本語変換中"; buffer.changed();
    assert.equal(JSON.parse(widget.value).text, "before");
    assert.equal(JSON.parse(buffer.flush()).text, "日本語変換中");
    assert.equal(writes, 1); assert.equal(buffer.dirty, false);
    buffer.flush(); assert.equal(writes, 1);
    config.text = "破棄"; buffer.changed(); buffer.cancel();
    assert.equal(JSON.parse(buffer.flush()).text, "日本語変換中");
});
