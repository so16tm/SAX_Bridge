// Text Catalog V2 改善 P3 の純関数（カタログ一覧・取り込み・タグ管理・確率・同名・行出力・検索/並べ替え）の契約。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    formatUpdated, catalogLabel, catalogSummary, nameKey, duplicateNames, recipeEntries, parseTextItems, parseItemsJson,
    importCapacityError, countDuplicateTexts, tagStats, planTagChange, drawProbabilities, groupProbabilities, formatPercent,
    rowOutputText, selectItems, sortItems, warmSearchIndex, searchTokens, compareText, sortedNamedOptions, LIMITS,
} from "../../js/sax_text_catalog_v2_model.js";

const item = (id, name, text = "", tags = []) => ({ id, name, text, tags });

test("カタログの表示は件数・更新日時・ID先頭を並べ、同名でも区別でき、壊れたものは読み込めない旨を示す", () => {
    const at = new Date(2026, 9, 19, 7, 5).getTime() / 1000;
    assert.equal(formatUpdated(at), "2026-10-19 07:05");
    assert.equal(formatUpdated(undefined), "");
    assert.equal(formatUpdated(Number.NaN), "");
    const catalog = { id: "0123456789abcdef", name: "共通", items: 12, recipes: 3, updated_at: at };
    assert.equal(catalogSummary(catalog), "アイテム12件・セット3件・更新 2026-10-19 07:05");
    assert.equal(catalogLabel(catalog), "共通 · アイテム12件・セット3件・更新 2026-10-19 07:05 · 01234567");
    // 古いサーバー（件数なし）でも従来どおり「名前 · ID先頭」
    assert.equal(catalogLabel({ id: "0123456789abcdef", name: "共通" }), "共通 · 01234567");
    assert.equal(catalogSummary({ id: "x", name: "x", error: "壊れています" }), "読み込めません");
    const other = { ...catalog, id: "fedcba9876543210", items: 5 };
    assert.notEqual(catalogLabel(catalog), catalogLabel(other));
});

test("同名の検出は全角半角・大文字小文字・前後の空白を同じ名前として数え、2件以上だけを返す", () => {
    const counts = duplicateNames([{ name: "Ａ" }, { name: " a " }, { name: "b" }, { name: "A" }]);
    assert.deepEqual([...counts], [[nameKey("a"), 3]]);
    assert.equal(duplicateNames([{ name: "x" }, { name: "y" }]).size, 0);
});

test("セットの選択肢は同名のセットにだけ構成要素数の補足を付け、並びは名前順", () => {
    const group = id => ({ id, name: id, kind: "items", mode: "all", on: true, count: 1, item_ids: [] });
    const nested = { id: "n", name: "n", kind: "nested", mode: "all", on: true, count: 1, groups: [group("c1"), group("c2")] };
    const entries = recipeEntries([
        { id: "b", name: "旅", groups: [group("g1")] },
        { id: "a", name: "旅", groups: [nested, group("g2")] },
        { id: "c", name: "水彩", groups: [] },
    ]);
    assert.deepEqual(entries.map(entry => entry.id), sortedNamedOptions([{ id: "b", name: "旅" }, { id: "a", name: "旅" }, { id: "c", name: "水彩" }]).map(entry => entry.id));
    assert.equal(entries.find(entry => entry.id === "c").hint, undefined);
    assert.equal(entries.find(entry => entry.id === "a").hint, "構成要素4件"); // ネスト本体と子を含む
    assert.equal(entries.find(entry => entry.id === "b").hint, "構成要素1件");
});

test("テキストの取り込みは空行区切りと1行1アイテムを解析し、名前は先頭行、IDは新規発行", () => {
    const text = "masterpiece, best quality\r\n高品質\n\n   \n　\nsoft light\n\n\n\nbackground, city night";
    const blank = parseTextItems(text, { tags: ["共通"] });
    assert.deepEqual(blank.map(value => [value.name, value.text, value.tags]), [
        ["masterpiece, best quality", "masterpiece, best quality\n高品質", ["共通"]],
        ["soft light", "soft light", ["共通"]],
        ["background, city night", "background, city night", ["共通"]],
    ]);
    assert.equal(new Set(blank.map(value => value.id)).size, 3);
    blank[0].tags.push("x"); assert.deepEqual(blank[1].tags, ["共通"]); // タグ配列はアイテムごとに独立
    const lines = parseTextItems("a\n\n b \nc\n", { split: "line" });
    assert.deepEqual(lines.map(value => value.text), ["a", "b", "c"]);
    assert.deepEqual(parseTextItems("   \n \n"), []);
    const long = parseTextItems("あ".repeat(100))[0];
    assert.equal([...long.name].length, 41); assert.ok(long.name.endsWith("…")); assert.equal([...long.text].length, 100);
    assert.throws(() => parseTextItems("x".repeat(LIMITS.text + 1)), /1件目の本文/);
});

test("部分JSONはアイテム配列・items・カタログ全体を受け付け、idは無視し、セットは数だけ返す", () => {
    const entries = [{ id: "keep-me", name: "A", text: "本文A", tags: ["x", "x", " y "], extra: 1 }, { text: "名前なし" }, "文字列だけ\n2行目"];
    for (const source of [entries, { items: entries }, { version: 3, catalog: { items: entries }, recipes: [{ id: "r" }, { id: "s" }] }]) {
        const parsed = parseItemsJson(source, { tags: ["追加"] });
        assert.deepEqual(parsed.items.map(value => [value.name, value.text, value.tags]), [
            ["A", "本文A", ["x", "y", "追加"]], ["", "名前なし", ["追加"]], ["文字列だけ", "文字列だけ\n2行目", ["追加"]],
        ]);
        assert.ok(parsed.items.every(value => value.id && value.id !== "keep-me"));
    }
    assert.equal(parseItemsJson({ version: 3, catalog: { items: [] }, recipes: [{ id: "r" }] }).recipes, 1);
    assert.equal(parseItemsJson([]).items.length, 0);
});

test("部分JSONの不正は何件目かを示して全体を拒否する", () => {
    assert.throws(() => parseItemsJson({ recipes: [] }), /取り込めるアイテム/);
    assert.throws(() => parseItemsJson("x"), /取り込めるアイテム/);
    assert.throws(() => parseItemsJson([{ text: "a" }, 5]), /2件目/);
    assert.throws(() => parseItemsJson([{ text: 1 }]), /1件目の名前と本文/);
    assert.throws(() => parseItemsJson([{ tags: "a" }]), /1件目のタグ/);
    assert.throws(() => parseItemsJson([{ tags: [""] }]), /1件目のタグ/);
    assert.throws(() => parseItemsJson([{ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }]), /1件目: タグは最大8件/);
    assert.throws(() => parseItemsJson([{ text: "a", tags: Array.from({ length: 8 }, (_, i) => `t${i}`) }], { tags: ["共通"] }), /1件目: タグは最大8件/);
    assert.throws(() => parseItemsJson([{ name: "n".repeat(LIMITS.name + 1) }]), /名前が256文字/);
    assert.throws(() => parseItemsJson([{ text: "a" }, { prompt: "キー違い" }]), /2件目に名前も本文もありません/);
    assert.throws(() => parseItemsJson([{ name: " ", text: "" }]), /1件目に名前も本文もありません/);
    assert.throws(() => parseItemsJson(["ok", "  "]), /2件目に名前も本文もありません/);
    for (const tag of ["a,b", "a、b", "a\nb"]) assert.throws(() => parseItemsJson([{ text: "a", tags: [tag] }]), /1件目のタグにカンマ/);
});

test("取り込みの上限は追加後の件数で判定し、既存と同じ本文の数を数える", () => {
    assert.equal(importCapacityError(LIMITS.items - 2, 2), "");
    assert.match(importCapacityError(LIMITS.items - 2, 3), /10000件以内.*現在9998件＋追加3件/);
    assert.equal(importCapacityError(1, 1, LIMITS.bytes), "");
    assert.match(importCapacityError(1, 1, LIMITS.bytes + 1), /32 MiB以内/);
    assert.equal(countDuplicateTexts([item("a", "A", " 本文 ")], [item("n1", "", "本文"), item("n2", "", "別")]), 1);
    assert.equal(countDuplicateTexts([item("a", "A", "")], [item("n1", "", "")]), 0);
});

test("タグ一覧は件数順で、表記が近いタグを相互に示す", () => {
    const stats = tagStats([item("1", "a", "", ["Style", "光"]), item("2", "b", "", ["style", "光"]), item("3", "c", "", ["光"]), item("4", "d", "", ["ＳＴＹＬＥ"])]);
    assert.deepEqual(stats[0], { tag: "光", count: 3, variants: [] });
    assert.deepEqual(stats.slice(1).map(entry => entry.count), [1, 1, 1]);
    assert.deepEqual(stats.slice(1).map(entry => entry.tag), [...stats.slice(1).map(entry => entry.tag)].sort(compareText));
    assert.deepEqual(stats.find(entry => entry.tag === "style").variants.sort(), ["Style", "ＳＴＹＬＥ"].sort());
    assert.deepEqual(stats.find(entry => entry.tag === "光").variants, []);
});

test("タグの名前変更・統合・削除は、変更のあるアイテムだけを返し、重複させない", () => {
    const items = [item("1", "a", "", ["old", "keep"]), item("2", "b", "", ["new", "old"]), item("3", "c", "", ["keep"]), item("4", "d", "", ["old", "alt", "new"])];
    const before = structuredClone(items);
    let plan = planTagChange(items, ["old"], "new");
    assert.deepEqual(plan.changed.map(value => [value.id, value.tags]), [["1", ["new", "keep"]], ["2", ["new"]], ["4", ["new", "alt"]]]);
    assert.deepEqual(items, before); // 入力は変更しない
    plan = planTagChange(items, ["old", "alt"], " merged ");
    assert.deepEqual(plan.changed.map(value => [value.id, value.tags]), [["1", ["merged", "keep"]], ["2", ["new", "merged"]], ["4", ["merged", "new"]]]);
    plan = planTagChange(items, ["old"], "");
    assert.deepEqual(plan.changed.map(value => [value.id, value.tags]), [["1", ["keep"]], ["2", ["new"]], ["4", ["alt", "new"]]]);
    assert.deepEqual(planTagChange(items, ["old"], "old").changed, []); // 同名への変更は何もしない
    assert.deepEqual(planTagChange(items, ["none"], "x").changed, []);
    for (const bad of ["a, b", "a、b", "a\nb", "x".repeat(LIMITS.name + 1)]) assert.ok(planTagChange(items, ["old"], bad).error, bad);
    assert.ok(planTagChange(items, [], "x").error);
});

test("1件抽選時の確率は重みの合計に対する割合で、重み0とオフの子は対象外", () => {
    assert.deepEqual(drawProbabilities([1, 1, 2]), [25, 25, 50]);
    assert.deepEqual(drawProbabilities([0, 0]), [0, 0]);
    assert.deepEqual(drawProbabilities([0, 3]), [0, 100]);
    const items = groupProbabilities({ id: "g", mode: "random", item_ids: ["a", "b", "c"], item_weights: { b: 3, c: 0 } });
    assert.deepEqual([...items], [["a", 25], ["b", 75], ["c", 0]]);
    const nested = groupProbabilities({ id: "n", kind: "nested", mode: "random", groups: [{ id: "x", on: true }, { id: "y", on: true, weight: 3 }, { id: "z", on: false, weight: 5 }] });
    assert.deepEqual([...nested], [["x", 25], ["y", 75], ["z", 0]]);
    assert.deepEqual([formatPercent(25), formatPercent(100 / 3), formatPercent(0), formatPercent(0.04), formatPercent(99.96)], ["25%", "33.3%", "0%", "<0.1%", "100%"]);
});

test("行の出力テキストは出力順に、前後付与後の本文でネストも含めて組み立てる", () => {
    const row = { groups: [
        { items: [{ id: "b", text: " B ", output_position: 2 }, { id: "a", text: "A", output_position: 1, output_text: "(A:1.2)" }, { id: "e", text: "  ", output_position: null }] },
        { kind: "nested", groups: [{ items: [{ id: "c", text: "C", output_position: 3 }] }] },
    ] };
    assert.equal(rowOutputText(row), "(A:1.2)\nB\nC");
    assert.equal(rowOutputText({ groups: [{ items: [] }] }), "");
    assert.equal(rowOutputText(undefined), "");
});

const bigCatalog = count => Array.from({ length: count }, (_, i) => item(`id-${String(i).padStart(5, "0")}`, `素材${i % 500}`, `本文 Masterpiece ${i} `.repeat(3), [`tag${i % 7}`, i % 2 ? "style" : "camera"]));

test("絞り込みと並べ替えは、絞り込み条件・並び順・タイブレークを従来どおり満たす", () => {
    const items = [item("2", "B", "Soft LIGHT", ["x"]), item("1", "B", "soft light", ["x", "y"]), item("3", "A", "ＳＯＦＴ　ｌｉｇｈｔ", ["y"]), item("4", "C", "other", ["x"])];
    const ids = values => values.map(value => value.id);
    assert.deepEqual(ids(selectItems(items, { tokens: searchTokens("soft  LIGHT") })), ["3", "1", "2"]);
    assert.deepEqual(ids(selectItems(items, { tokens: searchTokens("soft"), tags: ["x"] })), ["1", "2"]);
    assert.deepEqual(ids(selectItems(items, { tags: ["x", "y"] })), ["1"]);
    assert.deepEqual(ids(selectItems(items, { ids: new Set(["4", "3"]) })), ["3", "4"]);
    assert.deepEqual(ids(selectItems(items, { unusedIds: new Set(["1", "2"]) })), ["3", "4"]);
    assert.deepEqual(ids(selectItems(items, { selectedIds: new Set(["1", "4"]) })), ["1", "4"]);
    assert.deepEqual(ids(selectItems(items, { sort: "catalog" })), ["2", "1", "3", "4"]);
    assert.deepEqual(ids(selectItems(items, { sort: "usage", usage: new Map([["4", { groups: 3 }], ["3", { groups: 1 }]]) })), ["4", "3", "1", "2"]);
    assert.deepEqual(ids(selectItems(items, { sort: "tags" })), ["2", "4", "1", "3"]); // [x]（同じなら名前順）→ [x,y] → [y]
    assert.deepEqual(ids(items), ["2", "1", "3", "4"]); // 入力の配列は並べ替えない
});

test("結果画面向けの並べ替えは resolve で本体を取り出し、同名はIDで比較する", () => {
    const entries = [{ source: item("b", "同じ") }, { source: item("a", "同じ") }, { source: item("c", "あ") }];
    sortItems(entries, { resolve: entry => entry.source });
    assert.deepEqual(entries.map(entry => entry.source.id), ["c", "a", "b"]);
});

test("名前順の共通照合は従来の localeCompare('ja') と同じ順序になる", () => {
    const names = ["背景", "人物", "Zebra", "apple", "Ａ", "あ", "ア", "10", "2", ""];
    assert.deepEqual([...names].sort(compareText), [...names].sort((a, b) => a.localeCompare(b, "ja")));
    assert.deepEqual(sortedNamedOptions([{ id: "b", name: "A" }, { id: "a", name: "A" }]).map(value => value.id), ["a", "b"]);
    assert.deepEqual(sortedNamedOptions([{ id: "a_1", name: "A" }, { id: "A1", name: "A" }, { id: "a1", name: "A" }]).map(value => value.id), ["a_1", "a1", "A1"].sort((x, y) => x.localeCompare(y)));
});

test("検索の下準備は少しずつ進め、検索結果を変えず、中止できる", () => {
    const items = bigCatalog(1000), queue = [], cancelled = [];
    const stop = warmSearchIndex(items, { chunk: 400, schedule: fn => (queue.push(fn), queue.length), cancel: handle => cancelled.push(handle) });
    assert.equal(queue.length, 1);
    queue.shift()(); assert.equal(queue.length, 1); // 400件ずつ
    queue.shift()(); queue.shift()(); assert.equal(queue.length, 0);
    const tokens = searchTokens("MASTERPIECE 本文");
    assert.equal(selectItems(items, { tokens }).length, 1000);
    const second = warmSearchIndex(items, { chunk: 10, schedule: fn => (queue.push(fn), 7), cancel: handle => cancelled.push(handle) });
    second(); assert.deepEqual(cancelled, [7]);
    queue.shift()(); assert.equal(queue.length, 0); // 中止後は続きを予約しない
    stop();
});
