import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub } from "../bench/env.mjs";
import { TRANSFER } from "../../js/sax_autocomplete_bridge.js";

register("../bench/shared_catalog_hooks.mjs", import.meta.url);
installDomStub();
const { app } = await import("../bench/stubs/comfy_app.js");
const { api } = await import("../../scripts/api.js");
const { getSession } = await import("../../js/sax_text_catalog_v2_client.js");
await import("../../js/sax_autocomplete.js");

test("共有編集の保存→snapshot取得→送信を保証し、workflowに転送データを保存しない", async () => {
    let document = { version: 3, id: "cat", name: "共有", revision: 1,
        catalog: { items: [{ id: "i", name: "素材", text: "old", tags: [] }] }, recipes: [] };
    const operations = [];
    window._saxTestSent = [];
    window._saxTestRequest = async (route, options) => {
        assert.equal(route, "/sax/text-catalog/v2/catalogs/cat");
        if (options?.method === "PATCH") {
            operations.push("save");
            const body = JSON.parse(options.body);
            document.catalog.items[0] = structuredClone(body.operations[0].item);
            document.revision++;
            return { ok: true, json: async () => ({ id: "cat", revision: document.revision }) };
        }
        operations.push("read");
        return { ok: true, json: async () => structuredClone(document) };
    };
    const session = await getSession("cat");
    session.mutate([{ type: "item.put", item: { id: "i", name: "素材", text: "{red|blue}", tags: [] } }]);
    operations.length = 0;
    const extension = app.extensions.find(e => e.name === "SAX.AutocompletePlusPlus");
    await extension.setup();
    const queue = api.queuePrompt;
    await extension.setup();
    assert.equal(api.queuePrompt, queue);
    const prompt = { workflow: { original: true }, output: { 42: { class_type: "SAX_Bridge_Text_Catalog_V2", inputs: { config_json: '{"version":3,"catalog_id":"cat","rows":[]}', seed: ["99", 0] } } } };
    assert.equal(await api.queuePrompt(0, prompt), "sent");
    assert.deepEqual(operations, ["save", "read"]);
    const sent = window._saxTestSent[0][1];
    assert.equal(sent.workflow, prompt.workflow);
    assert.equal(prompt.output[42].inputs[TRANSFER], undefined);
    assert.equal(sent.output[42].inputs._sax_ac_text_0, "{red|blue}");
    assert.equal(sent.output[42].inputs[TRANSFER].inputs.config_json.data._sax_queued_catalog.revision, 2);
    window._saxTestRequest = async () => ({ ok: false, json: async () => ({ error: "offline" }) });
    await assert.rejects(api.queuePrompt(0, prompt), /取得できない/);
    assert.equal(window._saxTestSent.length, 1);
});
