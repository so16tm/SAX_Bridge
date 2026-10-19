import { test } from "node:test";
import assert from "node:assert/strict";
import { sortedNamedOptions, emptyConfig, validateConfig, parseConfig, parseTags, filteredItems, references, removeItems, recipeWarnings, EditHistory, BufferedJson, visibleWindow, itemTagSortKeys, compareItemTagKeys, walkGroups, groupItemIds, parseRandomCount, formatRandomCount, parseSelectionWeight, candidateWeight } from "../../js/sax_text_catalog_v2_model.js";

test("ランダム抽選数は固定数と3種の範囲表記を解析し、保存形式を整える", () => {
    assert.deepEqual(parseRandomCount("2"), { count: 2 });
    for (const value of ["0-2", "0～2", "0〜2", " 0 ～ 2 "]) assert.deepEqual(parseRandomCount(value), { count: 2, count_min: 0 });
    assert.equal(formatRandomCount({ count: 2 }), "2");
    assert.equal(formatRandomCount({ count: 2, count_min: 0 }), "0～2");
    for (const value of ["2-1", "-1", "1.5", "10001", "0-10001", "2--3"]) assert.throws(() => parseRandomCount(value));
});

test("選択重みは有限な10進数を解析し、候補重みと範囲を検証する", () => {
    for (const value of ["0", "0.5", ".5", "1.", "1000000", 0, 0.25, 1_000_000]) assert.equal(parseSelectionWeight(value), Number(value));
    for (const value of ["", "  ", "1e2", "-1", "1000001", "NaN", "Infinity", true, NaN, Infinity]) assert.throws(() => parseSelectionWeight(value));
    assert.equal(candidateWeight({ item_weights: { a: 0.25 } }, "a"), 0.25);
    assert.equal(candidateWeight({}, "a"), 1);
    assert.equal(candidateWeight({item_weights:{}}, "constructor"), 1);
});

test("ネストの抽選警告は重み0の子を候補数から除外する", () => {
    const config = emptyConfig();
    const child = {id:"child",name:"子",mode:"all",on:true,count:0,item_ids:[],weight:0};
    config.recipes[0].groups = [{id:"parent",name:"親",kind:"nested",mode:"random",on:true,count:1,groups:[child]}];
    assert.match(recipeWarnings(config)[0], /候補0件/);
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

test("ネスト抽選の候補数はOFFの直下の子を除いて判定し、無効な親の配下は警告しない", () => {
    const config = fixture(1), child = { ...leaf("child"), mode: "random", count: 2 };
    const root = { ...nested("root", [child, { ...leaf("off"), on: false }]), mode: "random", count: 2 };
    config.recipes[0].groups = [root]; validateConfig(config);
    assert.equal(recipeWarnings(config).length, 2);
    root.count = 3;
    assert.equal(recipeWarnings(config).length, 2);
    assert.match(recipeWarnings(config)[0], /候補1件/);
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

test("重みはmodeを問わず検証し、候補重み0を抽選候補数から除外する", () => {
    const config = fixture(2), group = { ...leaf("g", ["item-0", "item-1"]), mode: "random", count: 2, item_weights: { "item-0": 0 } };
    config.recipes[0].groups = [group];
    validateConfig(config); assert.equal(recipeWarnings(config).length, 1);
    assert.match(recipeWarnings(config)[0], /候補1件/);
    group.mode = "all"; group.weight = 1; validateConfig(config);
    for (const value of [false, NaN, Infinity, -0.1, 1_000_001]) {
        group.weight = value; assert.throws(() => validateConfig(config), /重み/);
    }
    group.weight = 1; group.item_weights = { missing: 0.5 }; assert.throws(() => validateConfig(config), /候補アイテム/);
    for (const value of [false, NaN, Infinity]) {
        group.item_weights = { "item-0": value }; assert.throws(() => validateConfig(config), /有限数/);
    }
    group.item_weights = { "item-0": 0.5 }; config.recipes[0].groups = [nested("parent", [group])];
    config.recipes[0].groups[0].item_weights = {}; assert.throws(() => validateConfig(config), /ネスト.*重み/);
});

test("構成要素のprefix/suffixは全mode・全階層で省略または空文字を許し、文字列4096文字まで", () => {
    const config = fixture(1);
    const root = nested("parent", [leaf("child")]);
    root.prefix = "";
    root.groups[0].suffix = "後".repeat(4096);
    config.recipes[0].groups = [root];
    assert.equal(validateConfig(config), config);
    assert.deepEqual(parseConfig(JSON.stringify(config)).recipes[0].groups, [root]);
    root.mode = "random"; root.prefix = "前";
    root.groups[0].mode = "random";
    validateConfig(config);
    for (const value of [null, 1, false, {}, "前".repeat(4097)]) {
        root.prefix = value;
        assert.throws(() => validateConfig(config), /group\.prefix/);
    }
    delete root.prefix;
    root.groups[0].suffix = null;
    assert.throws(() => validateConfig(config), /group\.suffix/);
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

test("素材削除時にitem_weightsの参照キーも除去する", () => {
    const config = fixture(2), group = { ...leaf("g", ["item-0", "item-1"]), item_weights: { "item-0": 0.2, "item-1": 0.7 } };
    config.recipes[0].groups = [group]; removeItems(config, ["item-0"]);
    validateConfig(config); assert.deepEqual(group.item_weights, { "item-1": 0.7 });
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

import { itemUsage, deletionImpact, normalizeSearch, searchTokens, matchesSearch, tagsError } from "../../js/sax_text_catalog_v2_model.js";

test("検索は空白区切りのAND・全角半角と大文字小文字を区別しない", () => {
    const item = { name: "Masterpiece 傑作", text: "高品質なポートレート", tags: ["ＡＢＣ", "背景"] };
    const hit = query => matchesSearch(item, searchTokens(query));
    assert.equal(hit(""), true);
    assert.equal(hit("masterpiece  高品質"), true);
    assert.equal(hit("MASTERPIECE　ﾎﾟｰﾄﾚｰﾄ"), true, "全角空白区切り・半角カナ・大文字");
    assert.equal(hit("abc 背景"), true, "タグの全角英字");
    assert.equal(hit("masterpiece 存在しない"), false, "一語でも欠けたら不一致");
    assert.equal(matchesSearch(undefined, searchTokens("a")), false);
    assert.equal(normalizeSearch("Ｆｕｌｌ ＷＩＤＴＨ１２"), "full width12");
    item.name = "別名"; assert.equal(hit("masterpiece"), true, "同一オブジェクトの検索文字列はキャッシュされる");
    assert.equal(matchesSearch({ ...item }, searchTokens("masterpiece")), false, "複製した別オブジェクトは再計算される");
});

test("使用集計は構成要素数とセット数を数え、削除の影響と一致する", () => {
    const group = (id, ids, extra = {}) => ({ id, name: id, mode: "all", on: true, count: 1, item_ids: ids, ...extra });
    const recipes = [
        { id: "r1", name: "A", groups: [group("g1", ["a", "b"]), { id: "n", name: "入れ子", kind: "nested", mode: "all", on: true, count: 1, groups: [group("g2", ["a"])] }] },
        { id: "r2", name: "B", groups: [group("g3", ["a", "c"])] },
    ];
    const usage = itemUsage(recipes);
    assert.deepEqual([usage.get("a").groups, usage.get("a").recipeIds.size], [3, 2]);
    assert.deepEqual([usage.get("b").groups, usage.get("b").recipeIds.size], [1, 1]);
    assert.equal(usage.has("unused"), false);
    assert.deepEqual(deletionImpact(usage, ["a", "c"]), { groups: 4, recipes: 2 });
    assert.deepEqual(deletionImpact(usage, ["unused"]), { groups: 0, recipes: 0 });
});

test("タグの上限エラーは件数と文字数を具体的に示す", () => {
    assert.equal(tagsError(Array.from({ length: 8 }, (_, i) => `t${i}`)), "");
    assert.match(tagsError(Array.from({ length: 9 }, (_, i) => `t${i}`)), /最大8件.*9件/);
    assert.match(tagsError(["あ".repeat(257)]), /256文字/);
    assert.equal(tagsError(["あ".repeat(256)]), "");
});
