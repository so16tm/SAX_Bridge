import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAutocompletePrompt, TRANSFER } from "../../js/sax_autocomplete_bridge.js";

const v1 = text => ({ version: 1, catalog: { items: [{ id: "i", name: "{name|keep}", text, tags: [] }] }, relations: [{ item_id: "i", on: true }] });

test("V1本文だけを展開入力にし、保存JSON・メタデータ・接続を変更しない", async () => {
    const raw = JSON.stringify(v1("{red|blue}, __colors__"));
    const output = {
        1: { class_type: "SAX_Bridge_Text_Catalog", inputs: { items_json: raw, merge_outputs: true } },
        2: { class_type: "SAX_Bridge_Primitive_Store", inputs: { items_json: '[{"type":"SEED","mode":"random"}]' } },
        3: { class_type: "SAX_Bridge_Prompt", inputs: { wildcard_text: ["1", 0], pipe: ["5", 0] } },
        4: { class_type: "CLIPTextEncode", inputs: { text: "{x|y}" } },
    };
    const prepared = await prepareAutocompletePrompt(output);
    assert.equal(output[1].inputs.items_json, raw);
    assert.equal(prepared[1].inputs.items_json, undefined);
    assert.equal(prepared[1].inputs._sax_ac_text_0, "{red|blue}, __colors__");
    assert.equal(prepared[1].inputs[TRANSFER].inputs.items_json.data.catalog.items[0].name, "{name|keep}");
    assert.deepEqual(prepared[3], output[3]);
    assert.deepEqual(prepared[4], output[4]);
    assert.equal(prepared[2].inputs[TRANSFER].inputs.items_json.raw, output[2].inputs.items_json);
    // Autocomplete++ は入力直下の文字列を走査し、canvas の同名widgetを参照する。
    assert.deepEqual(Object.keys(prepared[1].inputs).filter(k => typeof prepared[1].inputs[k] === "string"), ["_sax_ac_text_0"]);
});

test("共有V2の参照と実行時seed接続を維持し、送信ごとに独立したsnapshotを取得", async () => {
    let loads = 0;
    const document = { version: 3, id: "cat", name: "共有", revision: 1, catalog: { items: [{ id: "i", text: "__colors__" }] }, recipes: [] };
    const output = { 1: { class_type: "SAX_Bridge_Text_Catalog_V2", inputs: { config_json: JSON.stringify({ version: 3, catalog_id: "cat", rows: [] }), seed: ["9", 0] } } };
    output[2] = structuredClone(output[1]);
    const load = async id => { loads++; assert.equal(id, "cat"); return document; };
    const first = await prepareAutocompletePrompt(output, load);
    assert.equal(loads, 1);
    assert.deepEqual(first[1].inputs.seed, ["9", 0]);
    assert.equal(first[1].inputs._sax_ac_text_0, "__colors__");
    first[1].inputs[TRANSFER].inputs.config_json.data._sax_queued_catalog.name = "changed";
    assert.equal(first[2].inputs[TRANSFER].inputs.config_json.data._sax_queued_catalog.name, "共有");
    document.revision = 2;
    document.catalog.items[0].text = "new";
    const second = await prepareAutocompletePrompt(output, load);
    assert.equal(loads, 2);
    assert.equal(second[1].inputs._sax_ac_text_0, "new");
    assert.equal(JSON.parse(output[1].inputs.config_json)._sax_queued_catalog, undefined);
});

test("取得失敗はQueueを中止し、元データを保持する", async () => {
    const output = { 1: { class_type: "SAX_Bridge_Text_Catalog_V2", inputs: { config_json: '{"version":3,"catalog_id":"cat","rows":[]}' } } };
    const copy = structuredClone(output);
    await assert.rejects(prepareAutocompletePrompt(output, async () => { throw new Error("offline"); }), /offline/);
    assert.deepEqual(output, copy);
});

test("旧V2は本文を分離、無効JSONは元のValidatorへ、空カタログは外部取得不要", async () => {
    const output = {
        1: { class_type: "SAX_Bridge_Text_Catalog_V2", inputs: { config_json: JSON.stringify({ version: 2, catalog: { items: [{ text: "{a|b}" }] } }) } },
        2: { class_type: "SAX_Bridge_Text_Catalog", inputs: { items_json: "invalid" } },
        3: { class_type: "SAX_Bridge_Text_Catalog_V2", inputs: { config_json: '{"version":3,"catalog_id":"","rows":[]}' } },
        4: { class_type: "SAX_Bridge_Prompt", inputs: { wildcard_text: '{"text":"{a|b}"}' } },
    };
    const result = await prepareAutocompletePrompt(output, () => { throw new Error("unexpected"); });
    assert.equal(result[1].inputs._sax_ac_text_0, "{a|b}");
    assert.equal(result[2].inputs.items_json, "invalid");
    assert.equal(result[3].inputs._sax_ac_text_0, undefined);
    assert.equal(result[4].inputs.wildcard_text, output[4].inputs.wildcard_text);
});

test("structuredClone できない値（Proxy・関数）を含む output でも複製できる", async () => {
    const inputs = new Proxy({ text: "a", fn() {} }, {});
    assert.throws(() => structuredClone(inputs), { name: "DataCloneError" });
    const output = { 1: { class_type: "SAX_Bridge_Prompt_Qwen_Image", inputs } };
    const prepared = await prepareAutocompletePrompt(output);
    assert.deepEqual(prepared[1], { class_type: "SAX_Bridge_Prompt_Qwen_Image", inputs: { text: "a" } });
});
