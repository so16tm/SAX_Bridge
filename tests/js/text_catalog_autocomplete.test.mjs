import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { installDomStub, makeNode, makeGraph } from "../bench/env.mjs";
import { emptyConfig } from "../../js/sax_text_catalog_v2_model.js";

const instances = [];
const textarea = (extra = {}) => ({ isConnected: true, addEventListener() {}, removeEventListener() {}, ...extra });
globalThis.__catalogAutocompleteInstances = instances;
const stub = `export class TextAreaAutoComplete {
    static globalSeparator = "";
    constructor(el, words, separator) {
        this.el = el; this.words = words; this.separator = separator;
        this.helper = { getScale: () => 2, getBeforeCursor: () => this.el.value };
        this.dropdown = { style: {}, remove() { this.removed = true; } };
        globalThis.__catalogAutocompleteInstances.push(this);
    }
}`;
const stubUrl = "data:text/javascript," + encodeURIComponent(stub);
const appUrl = new URL("../bench/stubs/comfy_app.js", import.meta.url).href;
const loader = `export async function resolve(specifier, context, next) {
    if (specifier.endsWith("scripts/app.js")) return { url: ${JSON.stringify(appUrl)}, shortCircuit: true };
    if (specifier.startsWith("/extensions/")) {
        if (specifier.includes("/pysssss/")) throw new Error("別の配信パス");
        return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    }
    return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(loader), import.meta.url);
const { attachAutoComplete, detachAutoComplete } = await import("../../js/sax_text_autocomplete.js");

test("代替配信パスを使い、辞書を共有してダイアログ前面に補完を接続", async () => {
    let keyDown;
    const input = textarea({ value: "blu", addEventListener(type, handler) { if (type === "keydown") keyDown = handler; } });
    await attachAutoComplete(input);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].el, input);
    assert.equal(instances[0].words, null);
    assert.equal(instances[0].separator, ", ");
    assert.equal(instances[0].dropdown.style.zIndex, "10001");
    assert.equal(instances[0].helper.getScale(), 1);
    assert.equal(instances[0].helper.getBeforeCursor(), "blu");
    let stopped = false;
    instances[0].dropdown.parentElement = {};
    keyDown({ key: "Escape", stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
    await attachAutoComplete(input);
    assert.equal(instances.length, 1);
    detachAutoComplete(input);
    assert.equal(instances[0].dropdown.removed, true);
    assert.equal(instances[0].helper.getBeforeCursor(), null);
});

test("ユーザーの区切り設定を保持し、他ノードのglobalSeparatorを変更しない", async () => {
    const mod = await import("data:text/javascript," + encodeURIComponent(stub));
    assert.equal(mod.TextAreaAutoComplete.globalSeparator, "");
    mod.TextAreaAutoComplete.globalSeparator = "; ";
    await attachAutoComplete(textarea());
    assert.equal(instances.at(-1).separator, "; ");
    assert.equal(mod.TextAreaAutoComplete.globalSeparator, "; ");
});

test("非同期読込中に閉じたエディタ、切断済みエディタへ補完を付けない", async () => {
    const before = instances.length;
    await attachAutoComplete({ isConnected: false });
    const input = { isConnected: true };
    const pending = attachAutoComplete(input);
    detachAutoComplete(input);
    await pending;
    assert.equal(instances.length, before);
});

test("V2の編集画面に補完を接続し、補完後の本文を保存して閉じる際に候補を除去", async () => {
    installDomStub();
    const baseCreate = document.createElement;
    const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
    document.createElement = tag => {
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
    };
    document.body = document.createElement("body");
    globalThis.Option = function (text, value) { const option = document.createElement("option"); option.textContent = text; option.value = value; return option; };
    globalThis.requestAnimationFrame = callback => callback();
    const { app } = await import("../bench/stubs/comfy_app.js");
    await import("../../js/sax_text_catalog_v2.js");
    const Type = function () {};
    app.extensions.find(e => e.name === "SAX.TextCatalogV2").beforeRegisterNodeDef(Type, { name: "SAX_Bridge_Text_Catalog_V2" });
    const config = emptyConfig();
    config.catalog.items = [{ id: "item", name: "素材", text: "blu", tags: [] }];
    const node = makeNode({ graph: makeGraph() });
    node.widgets = [{ name: "config_json", value: JSON.stringify(config) }, { name: "seed", value: 1 }];
    Type.prototype.onNodeCreated.call(node);
    node.widgets.find(w => w.name === "管理・編集").callback();
    descendants(document.body).find(e => e.tagName === "button" && e.textContent === "アイテム編集").fire("click");
    await new Promise(resolve => setImmediate(resolve));
    const editor = descendants(document.body).find(e => e.tagName === "textarea");
    const attached = instances.find(instance => instance.el === editor);
    assert.ok(attached, "本文の補完が接続される");
    editor.value = "blue_eyes, "; editor.dispatchEvent(new Event("input"));
    assert.equal(JSON.parse(node.widgets[0].serializeValue()).catalog.items[0].text, "blue_eyes, ");
    descendants(document.body).find(e => e.tagName === "button" && e.textContent === "閉じる").fire("click");
    assert.equal(attached.dropdown.removed, true);
    Type.prototype.onRemoved.call(node);
});

test("V1にも共通補完を使い、補完側が消費したEscapeでV2を閉じない", async () => {
    const v1 = await readFile(new URL("../../js/sax_text_catalog.js", import.meta.url), "utf8");
    const v2 = await readFile(new URL("../../js/sax_text_catalog_v2.js", import.meta.url), "utf8");
    assert.match(v1, /attachAutoComplete\(textArea\)/);
    assert.match(v1, /from "\.\/sax_text_autocomplete\.js"/);
    assert.match(v2, /event\.isComposing \|\| event\.defaultPrevented/);
});

test("従来のText Catalogでもズーム外の本文補完とSave保存が成立する", async () => {
    const { app } = await import("../bench/stubs/comfy_app.js");
    await import("../../js/sax_text_catalog.js");
    const Type = function () {};
    await app.extensions.find(e => e.name === "SAX.TextCatalog").beforeRegisterNodeDef(Type, { name: "SAX_Bridge_Text_Catalog" });
    const payload = {
        version: 1,
        catalog: { items: [{ id: "old", name: "従来素材", text: "blu", tags: [] }], tag_definitions: [], favorite_tags: [] },
        relations: [{ item_id: "old", on: true }],
    };
    const node = makeNode({ graph: makeGraph() });
    node.widgets = [{ name: "items_json", value: JSON.stringify(payload) }, { name: "merge_outputs", value: false }];
    Type.prototype.onNodeCreated.call(node);
    Type.prototype.onConfigure.call(node, {});
    node._openTextCatalogManager("old");
    await new Promise(resolve => setImmediate(resolve));
    const all = () => {
        const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
        return descendants(document.body);
    };
    const editor = all().find(e => e.tagName === "textarea");
    const attached = instances.find(instance => instance.el === editor);
    assert.ok(attached, "従来の本文にも補完を接続する");
    assert.equal(attached.helper.getScale(), 1, "キャンバスのズーム2倍をDOMエディタへ適用しない");
    assert.equal(attached.dropdown.style.zIndex, "10001");
    editor.value = "blue_eyes, "; editor.dispatchEvent(new Event("input"));
    all().find(e => e.tagName === "button" && e.textContent === "Save").fire("click");
    assert.equal(JSON.parse(node.widgets.find(w => w.name === "items_json").value).catalog.items[0].text, "blue_eyes, ");
    all().find(e => e.tagName === "button" && e.textContent === "Close").fire("click");
    assert.equal(attached.dropdown.removed, true);
});

test.after(() => { delete globalThis.__catalogAutocompleteInstances; });
