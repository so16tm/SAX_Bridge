import { test } from "node:test";
import assert from "node:assert/strict";
import { sortedNamedOptions, emptyConfig, validateConfig, parseConfig, parseTags, filteredItems, references, removeItems, recipeWarnings, EditHistory, BufferedJson, visibleWindow, itemTagSortKeys, compareItemTagKeys, walkGroups, groupItemIds, parseRandomCount, formatRandomCount } from "../../js/sax_text_catalog_v2_model.js";

test("ランダム抽選数は固定数と3種の範囲表記を解析し、保存形式を整える", () => {
    assert.deepEqual(parseRandomCount("2"), { count: 2 });
    for (const value of ["0-2", "0～2", "0〜2", " 0 ～ 2 "]) assert.deepEqual(parseRandomCount(value), { count: 2, count_min: 0 });
    assert.equal(formatRandomCount({ count: 2 }), "2");
    assert.equal(formatRandomCount({ count: 2, count_min: 0 }), "0～2");
    for (const value of ["2-1", "-1", "1.5", "10001", "0-10001", "2--3"]) assert.throws(() => parseRandomCount(value));
});

test("名前順の選択肢は同名をIDで比較し、元の保存順を変更しない", () => {
    const values = [{id:"z",name:"Z"},{id:"b",name:"A"},{id:"a",name:"A"}];
    assert.deepEqual(sortedNamedOptions(values).map(v=>v.id), ["a","b","z"]);
    assert.deepEqual(values.map(v=>v.id), ["z","b","a"]);
});

test("タグ順は複数タグの入力順に依存せず、同タグは名前順、タグなしは末尾", () => {
    const items = [
        { id: "none", name: "A", tags: [] },
        { id: "b", name: "B", tags: ["b"] },
        { id: "az", name: "Z", tags: ["b", "a"] },
        { id: "aa", name: "A", tags: ["a", "b"] },
        { id: "a", name: "Z", tags: ["a"] },
    ];
    const before = structuredClone(items), keys = itemTagSortKeys(items);
    const sorted = [...items].sort((a, b) => compareItemTagKeys(keys.get(a.id), keys.get(b.id)) || a.name.localeCompare(b.name, "ja"));
    assert.deepEqual(sorted.map(i => i.id), ["a", "aa", "az", "b", "none"]);
    assert.deepEqual(items, before);
    assert.equal(compareItemTagKeys([], []), 0);
    const japanese = ["背景", "人物"].sort((a, b) => a.localeCompare(b, "ja"));
    assert.ok(compareItemTagKeys([japanese[0]], [japanese[1]]) < 0);
});

const fixture = count => {
    const config = emptyConfig();
    config.catalog.items = Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, name: `素材 ${i}`, text: `本文 ${i}`, tags: [i % 2 ? "style" : "camera"] }));
    return config;
};

const leaf = (id, item_ids = ["item-0"]) => ({ id, name: id, mode: "all", count: 0, on: true, item_ids });
const nested = (id, groups) => ({ id, name: id, kind: "nested", mode: "all", count: 0, on: true, groups });

test("ネスト参照を出力定義順で走査し、削除は全階層の候補だけを除去する", () => {
    const config = fixture(2);
    config.recipes[0].groups = [nested("root", [leaf("a"), nested("inner", [leaf("b", ["item-1", "item-0"])])])];
    validateConfig(config);
    assert.deepEqual([...walkGroups(config.recipes[0].groups)].map(group => group.id), ["root", "a", "inner", "b"]);
    assert.deepEqual(groupItemIds(config.recipes[0].groups), ["item-0", "item-1", "item-0"]);
    assert.equal(references(config, "item-0"), 2);
    removeItems(config, ["item-0"]); validateConfig(config);
    assert.deepEqual(groupItemIds(config.recipes[0].groups), ["item-1"]);
    assert.equal(Object.hasOwn(config.recipes[0].groups[0], "item_ids"), false);
});

test("全階層IDの重複、混在形式、深さ・総数・兄弟数の超過を拒否する", () => {
    const config = fixture(1), check = groups => { config.recipes[0].groups = groups; return () => validateConfig(config); };
    assert.throws(check([nested("same", [leaf("same")])]), /ID.*重複/);
    assert.throws(check([{ ...nested("root", []), item_ids: [] }]), /ネスト/);
    assert.throws(check([{ ...leaf("a"), groups: [] }]), /アイテム構成/);
    assert.throws(check([{ ...leaf("a"), kind: "unknown" }]), /種類/);
    assert.throws(check([nested("root", [leaf("a", ["missing"])])]), /参照先/);
    let deep = leaf("d8");
    for (let i = 7; i >= 1; i--) deep = nested(`d${i}`, [deep]);
    assert.doesNotThrow(check([deep]));
    assert.throws(check([nested("too-deep", [deep])]), /階層/);
    assert.throws(check([nested("root", Array.from({ length: 33 }, (_, i) => leaf(`s${i}`)))]), /最大32/);
    const many = Array.from({ length: 8 }, (_, i) => nested(`p${i}`, Array.from({ length: 31 }, (_, j) => leaf(`c${i}_${j}`))));
    assert.doesNotThrow(check(many)); // 8 + 248 = 256
    many[0].groups.push(leaf("extra")); assert.throws(check(many), /256/);
});

test("ネスト抽選の候補数はOFFを含む直下の子で判定し、無効な親の配下は警告しない", () => {
    const config = fixture(1), child = { ...leaf("child"), mode: "random", count: 2 };
    const root = { ...nested("root", [child, { ...leaf("off"), on: false }]), mode: "random", count: 2 };
    config.recipes[0].groups = [root]; validateConfig(config);
    assert.equal(recipeWarnings(config).length, 1);
    root.count = 3;
    assert.equal(recipeWarnings(config).length, 2);
    assert.match(recipeWarnings(config)[0], /候補2件/);
    root.on = false; assert.deepEqual(recipeWarnings(config), []);
    root.on = true; root.count = 0; assert.deepEqual(recipeWarnings(config), []);
});

test("10000件を保持し、検索/タグ絞り込みと未知形式の保全を検証", () => {
    const config = fixture(10000);
    assert.equal(parseConfig(JSON.stringify(config)).catalog.items.length, 10000);
    assert.equal(filteredItems(config, "本文 9999", "style")[0].id, "item-9999");
    assert.equal(filteredItems(config, "", "camera").length, 5000);
    assert.throws(() => validateConfig(fixture(10001)), /最大10000/);
    assert.throws(() => parseConfig("{broken"), /壊れています/);
    assert.throws(() => parseConfig('{"version":3}'), /対応していない/);
});

test("埋め込みV2も複数タグをAND条件で絞り込み、本文検索と併用できる", () => {
    const config = emptyConfig();
    config.catalog.items = [{id:"a",name:"A",text:"本文",tags:["共通","背景"]},{id:"b",name:"B",text:"別",tags:["共通"]}];
    assert.deepEqual(filteredItems(config,"",["共通","背景"]).map(i=>i.id),["a"]);
    assert.deepEqual(filteredItems(config,"別",["共通","背景"]),[]);
    assert.deepEqual(filteredItems(config,"背景",[]).map(i=>i.id),["a"]);
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

test("count_minは全modeで上限以下の整数に限定し、警告は範囲上限で判定する", () => {
    const config = fixture(2), group = { id: "g", name: "範囲", mode: "random", item_ids: ["item-0"], count: 2, count_min: 0, on: true };
    config.recipes[0].groups = [group];
    validateConfig(config);
    assert.equal(recipeWarnings(config).length, 1);
    group.count = 1; assert.equal(recipeWarnings(config).length, 0);
    group.mode = "all"; group.count_min = 2; assert.throws(() => validateConfig(config), /下限/);
    group.count_min = -1; assert.throws(() => validateConfig(config), /下限/);
    group.count_min = 1.5; assert.throws(() => validateConfig(config), /下限/);
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
