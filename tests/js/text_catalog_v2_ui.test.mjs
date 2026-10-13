import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub, makeNode, makeGraph } from "../bench/env.mjs";
import { emptyConfig } from "../../js/sax_text_catalog_v2_model.js";

register("../bench/hooks.mjs", import.meta.url);
installDomStub();
const baseCreate = document.createElement;
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
function enhanced(tag) {
    const e = baseCreate(tag);
    Object.assign(e, { dataset: {}, scrollTop: 0, clientHeight: 220, parentElement: null, attributes: {} });
    e.appendChild = child => { child.parentElement = e; e.children.push(child); return child; };
    e.append = (...children) => children.forEach(child => e.appendChild(child));
    e.replaceChildren = (...children) => { for (const child of e.children) child.parentElement = null; e.children = []; e.append(...children); };
    e.remove = () => { if (e.parentElement) e.parentElement.children = e.parentElement.children.filter(child => child !== e); e.parentElement = null; };
    e.setAttribute = (name, value) => { e.attributes[name] = value; };
    e.classList = { add() {}, toggle() {} };
    e.querySelectorAll = selector => descendants(e).filter(child => {
        const match = selector.match(/^\[data-([a-z]+)(?:="(.*)")?\]$/);
        return match && child.dataset[match[1]] !== undefined && (match[2] === undefined || child.dataset[match[1]] === match[2]);
    });
    e.querySelector = selector => e.querySelectorAll(selector)[0];
    e.dispatchEvent = event => e.fire(event.type);
    e.focus = () => { document.activeElement = e; };
    Object.defineProperty(e, "isConnected", { get: () => Boolean(e.parentElement) });
    return e;
}
document.createElement = enhanced;
document.body = enhanced("body");
globalThis.Option = function (text, value) { const option = enhanced("option"); option.textContent = text; option.value = value; return option; };
globalThis.requestAnimationFrame = callback => callback();
const { app } = await import("../bench/stubs/comfy_app.js");
await import("../../js/sax_text_catalog_v2.js");
const Type = function () {};
app.extensions.find(e => e.name === "SAX.TextCatalogV2").beforeRegisterNodeDef(Type, { name: "SAX_Bridge_Text_Catalog_V2" });

function nodeWith(count = 10000, random = false) {
    const config = emptyConfig();
    config.catalog.items = Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, name: `素材${i}`, text: `本文${i}`, tags: [`tag${i % 30}`] }));
    if (random) config.recipes[0].groups = [{ id: "g", name: "抽選", mode: "random", on: true, count: 4, item_ids: config.catalog.items.map(i => i.id) }];
    const node = makeNode({ graph: makeGraph() });
    node.widgets = [{ name: "config_json", value: JSON.stringify(config) }, { name: "seed", value: 1 }];
    Type.prototype.onNodeCreated.call(node);
    return node;
}
const all = () => descendants(document.body);
const findButton = text => all().find(e => e.tagName === "button" && e.textContent === text);
const open = node => node.widgets.find(w => w.name === "管理・編集").callback();
const configWidget = node => node.widgets.find(w => w.name === "config_json");

test("10000件のDOMは仮想行だけ、末尾スクロール・大量候補も有界", () => {
    const node = nodeWith(10000, true); open(node);
    assert.ok(all().filter(e => e.className === "cv2-item").length <= 15);
    assert.ok(all().length < 180, `DOM ${all().length}`);
    assert.equal(all().filter(e => e.tagName === "textarea").length, 0);
    const list = all().find(e => e.dataset.scroll === "library-items");
    list.scrollTop = 399780; list.fire("scroll");
    assert.ok(all().some(e => e.textContent === "素材9999"));
    assert.ok(all().filter(e => e.className === "cv2-item").length <= 15);
    findButton("組み合わせ").fire("click");
    const candidates = all().find(e => e.dataset.group === "g");
    candidates.open = true; candidates.fire("toggle");
    assert.equal(all().filter(e => e.className === "cv2-candidate").length, 20);
    assert.equal(all().filter(e => e.tagName === "textarea").length, 0);
    assert.ok(all().length < 350, `DOM ${all().length}`);
    findButton("次の20件").fire("click");
    assert.ok(all().some(e => e.dataset.candidate === "id-20"));
    Type.prototype.onRemoved.call(node); assert.equal(document.body.children.length, 0);
});

test("入力時はエディタDOMを維持し、即時キュー/保存/closeは最新データを反映", () => {
    const node = nodeWith(1000); open(node);
    findButton("アイテム編集").fire("click");
    assert.equal(all().filter(e => e.tagName === "textarea").length, 1);
    const editor = all().find(e => e.dataset.focus === "library:id-0:text");
    editor.focus(); editor.value = "編集中の日本語"; editor.fire("input", { isComposing: true });
    assert.equal(all().find(e => e.dataset.focus === "library:id-0:text"), editor);
    assert.equal(JSON.parse(configWidget(node).serializeValue()).catalog.items[0].text, "編集中の日本語");
    editor.value = "保存前の最終入力"; editor.fire("input");
    const saved = { widgets_values: node.widgets.map(w => w.value) };
    Type.prototype.onSerialize.call(node, saved);
    assert.equal(JSON.parse(saved.widgets_values[0]).catalog.items[0].text, "保存前の最終入力");
    editor.value = "閉じる前"; editor.fire("input"); findButton("閉じる").fire("click");
    assert.equal(JSON.parse(configWidget(node).value).catalog.items[0].text, "閉じる前");
});

test("同一ノードのconfigureは保留中編集で読み込みデータを上書きしない", () => {
    const node = nodeWith(3); open(node);
    findButton("アイテム編集").fire("click");
    const editor = all().find(e => e.dataset.focus === "library:id-0:text");
    editor.value = "読み込みで破棄される編集"; editor.fire("input");
    const loaded = emptyConfig(); loaded.catalog.items = [{ id: "loaded", name: "読込", text: "ロード済み", tags: [] }];
    configWidget(node).value = JSON.stringify(loaded);
    Type.prototype.onConfigure.call(node, {});
    assert.deepEqual(JSON.parse(configWidget(node).value), loaded);
    assert.equal(node.widgets.filter(w => w.name === "管理・編集").length, 1);
    open(node); findButton("アイテム編集").fire("click"); assert.ok(all().some(e => e.value === "ロード済み"));
    Type.prototype.onRemoved.call(node);
});

test("未知schemaは元JSONを保持し、編集UIを開かない", () => {
    const node = nodeWith(0); configWidget(node).value = '{"version":999}'; open(node);
    assert.ok(all().some(e => e.textContent.includes("編集を停止")));
    assert.equal(all().filter(e => e.tagName === "textarea").length, 0);
    assert.equal(configWidget(node).value, '{"version":999}');
    Type.prototype.onRemoved.call(node);
});

test("ライブラリの範囲選択と一括タグ操作は選択アイテムだけに反映", () => {
    const node = nodeWith(1000); open(node);
    const select = (name, shiftKey = false) => {
        const check = all().find(e => e.attributes["aria-label"] === `${name}を選択`);
        check.checked = true; check.fire("click", { shiftKey });
    };
    select("素材1"); select("素材4", true);
    assert.ok(all().some(e => e.textContent === "4件選択 / 検索結果1000件"));
    const tags = all().find(e => e.dataset.focus === "bulk-tags"); tags.value = "一括";
    findButton("タグ追加").fire("click");
    const items = JSON.parse(configWidget(node).value).catalog.items;
    assert.deepEqual(items.filter(i => i.tags.includes("一括")).map(i => i.id), ["id-1", "id-2", "id-3", "id-4"]);
    all().find(e => e.dataset.focus === "bulk-tags").value = "一括";
    findButton("タグ除去").fire("click");
    assert.equal(JSON.parse(configWidget(node).value).catalog.items.filter(i => i.tags.includes("一括")).length, 0);
    Type.prototype.onRemoved.call(node);
});

test("活動を切り替えても入力・選択・ライブラリの位置を保持し、組み合わせには本文編集を表示しない", () => {
    const node = nodeWith(1000); open(node);
    const check = all().find(e => e.attributes["aria-label"] === "素材0を選択"); check.checked = true; check.fire("click");
    const list = all().find(e => e.dataset.scroll === "library-items"); list.scrollTop = 800; list.fire("scroll");
    findButton("アイテム編集").fire("click");
    const editor = all().find(e => e.dataset.focus === "library:id-0:text"); editor.value = "活動切り替え前の入力"; editor.fire("input");
    findButton("組み合わせ").fire("click");
    assert.equal(JSON.parse(configWidget(node).value).catalog.items[0].text, "活動切り替え前の入力");
    assert.equal(all().filter(e => e.tagName === "textarea").length, 0);
    assert.ok(all().some(e => e.textContent === "1件選択 / 検索結果1000件"));
    assert.equal(findButton("タグ追加"), undefined);
    assert.equal(findButton("アイテムを複製"), undefined);
    findButton("固定で追加").fire("click");
    assert.deepEqual(JSON.parse(configWidget(node).value).recipes[0].groups[0].item_ids, ["id-0"]);
    findButton("ライブラリ").fire("click");
    assert.equal(all().find(e => e.dataset.scroll === "library-items").scrollTop, 800);
    findButton("アイテム編集").fire("click");
    assert.equal(all().find(e => e.dataset.focus === "library:id-0:text").value, "活動切り替え前の入力");
    Type.prototype.onRemoved.call(node);
});

test("新規アイテムは編集画面で名前へフォーカスし、閉じて開いても活動と選択を保持", () => {
    const node = nodeWith(5); open(node);
    findButton("＋ 新規").fire("click");
    assert.equal(document.activeElement.attributes["aria-label"], "素材名");
    assert.equal(all().filter(e => e.tagName === "textarea").length, 1);
    const id = JSON.parse(configWidget(node).value).catalog.items.at(-1).id;
    findButton("閉じる").fire("click"); open(node);
    assert.ok(all().some(e => e.dataset.focus === `library:${id}:text`));
    Type.prototype.onRemoved.call(node);
});

test("ノードの組み合わせ切替は管理画面の保留中本文を失わず、自動保存とUndoに参加", () => {
    const node = nodeWith(3);
    const config = JSON.parse(configWidget(node).value);
    config.recipes.push({ id: "second", name: "別の組み合わせ", groups: [] });
    configWidget(node).value = JSON.stringify(config);
    open(node); findButton("アイテム編集").fire("click");
    const editor = all().find(e => e.dataset.focus === "library:id-0:text");
    editor.value = "保留中の本文"; editor.fire("input");
    const picker = node.widgets.find(w => w.name === "組み合わせ");
    // comboの選択肢更新はノード描画時に行われる。
    node.widgets.find(w => w.name === "__sax_text_catalog_v2_quick").computeSize(310);
    picker.callback("別の組み合わせ");
    const after = JSON.parse(configWidget(node).value);
    assert.equal(after.active_recipe_id, "second");
    assert.equal(after.catalog.items[0].text, "保留中の本文");
    findButton("元に戻す").fire("click");
    assert.equal(JSON.parse(configWidget(node).value).active_recipe_id, "default");
    assert.equal(JSON.parse(configWidget(node).value).catalog.items[0].text, "保留中の本文");
    Type.prototype.onRemoved.call(node);
});
