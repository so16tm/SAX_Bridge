import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub, makeNode, makeGraph } from "../bench/env.mjs";
register("../bench/shared_catalog_hooks.mjs", import.meta.url);
installDomStub();
const { app } = await import("../bench/stubs/comfy_app.js");
const { getSession, applyOperations } = await import("../../js/sax_text_catalog_v2_client.js");
const { flushCatalogPrompt, readReference, installSharedControls, sharedController } = await import("../../js/sax_text_catalog_v2_shared.js");
const documents = new Map(); let writes = 0;
window._saxTestSent = [];
window._saxTestRequest = async (url, options = {}) => {
    const id = url.split("/").at(-1), document = documents.get(id);
    if (id === "catalogs") return { ok: true, json: async () => ({ catalogs: [...documents.values()].map(({id,name,revision}) => ({id,name,revision})) }) };
    if (options.method === "PATCH") {
        writes++; const body = JSON.parse(options.body); assert.equal(body.base_revision, document.revision);
        applyOperations(document, body.operations); document.revision++;
        return { ok: true, json: async () => ({ id, revision: document.revision }) };
    }
    return { ok: true, json: async () => structuredClone(document) };
};
const fixture = id => ({ version: 3, id, name: "共通", revision: 1, catalog: { items: [{ id: "a", name: "背景", text: "本文", tags: [] }] }, recipes: [{ id: "r", name: "セット", groups: [] }] });
const nodeFor = (id, count = 1) => {
    const node = makeNode({ graph: makeGraph() }); node.type = "SAX_Bridge_Text_Catalog_V2";
    node.widgets = [{ name: "config_json", value: JSON.stringify({ version: 3, catalog_id: id, rows: Array.from({length:count}, (_,i) => ({ id:`row${i}`,recipe_id:"r",on:true })) }) }, { name: "seed", value: 123 }];
    return node;
};

test("共有参照は本文を保存せず、不正な行と重複IDを拒否する", () => {
    const node = nodeFor("reference"); assert.equal(readReference(node).rows.length, 1);
    assert.ok(node.widgets[0].value.length < 150);
    const ref = readReference(node); ref.rows.push(ref.rows[0]); node.widgets[0].value = JSON.stringify(ref);
    assert.throws(() => readReference(node), /参照が不正/);
});

test("シリアライズ済みpromptは重複参照をまとめて保存してから送信する", async () => {
    const id = "prompt-test"; documents.set(id, fixture(id));
    const session = await getSession(id); session.mutate([{type:"item.put",item:{...session.document.catalog.items[0],text:"直前の編集"}}]);
    const entry = { class_type: "SAX_Bridge_Text_Catalog_V2", inputs: { config_json: nodeFor(id).widgets[0].value } };
    const before = writes; await flushCatalogPrompt({one:entry,two:entry}); assert.equal(writes, before+1); assert.equal(documents.get(id).catalog.items[0].text,"直前の編集");
});

test("セット行は全件表示し、ONとドラッグ順はワークフローだけに保存する", async () => {
    const id = "widget-test"; documents.set(id, fixture(id)); const node = nodeFor(id, 20);
    installSharedControls(node); await new Promise(resolve => setTimeout(resolve, 20));
    const widget = node.widgets.find(w => w.name === "__sax_shared_sets"); assert.equal(widget.computeSize(400)[1],1040);
    widget.y=0; widget.mouse({type:"pointerdown"},[20,15]); assert.equal(readReference(node).rows[0].on,false);
    const handlers = new Map(); window.addEventListener=(type,fn)=>handlers.set(type,fn);window.removeEventListener=type=>handlers.delete(type);
    widget.mouse({type:"pointerdown",clientY:100},[45,15]);handlers.get("pointerup")({clientY:204});
    assert.equal(readReference(node).rows[2].id,"row0");assert.equal(documents.get(id).recipes.length,1);
    assert.deepEqual(node.widgets.filter(w=>w.options?.serialize!==false).map(w=>w.name),["config_json","seed"]);
    sharedController(node).dispose();
});

test("バッチ送信直前のAPIフックでも共有編集を保存する", async () => {
    await import("../../js/sax_text_catalog_v2.js");
    app.queuePrompt = async () => "app-sent";
    await app.extensions.find(e=>e.name==="SAX.TextCatalogV2").setup();
    const {api}=await import("../../scripts/api.js");const id="api-send-test";documents.set(id,fixture(id));const session=await getSession(id);
    session.mutate([{type:"item.put",item:{...session.document.catalog.items[0],text:"バッチ途中の編集"}}]);
    await api.queuePrompt(0,{output:{node:{class_type:"SAX_Bridge_Text_Catalog_V2",inputs:{config_json:nodeFor(id).widgets[0].value}}}});
    assert.equal(documents.get(id).catalog.items[0].text,"バッチ途中の編集");assert.equal(window._saxTestSent.length,1);
});
