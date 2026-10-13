// 公式エンジンとの任意の統合検証。外部コードはリポジトリへ取り込まない。
// SAX_AUTOCOMPLETE_SOURCE に公式 web/js/prompt-expander.js のパスを指定して実行する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareAutocompletePrompt, TRANSFER } from "../../js/sax_autocomplete_bridge.js";

test("公式Autocomplete++で本文を展開し、canvas原文参照でもJSONが保護される", { skip: !process.env.SAX_AUTOCOMPLETE_SOURCE }, async () => {
    const source = await readFile(process.env.SAX_AUTOCOMPLETE_SOURCE, "utf8");
    const stripped = source.replace(/^import .*;\r?\n/gm, "");
    const preamble = `const app={graph:null}; const api={};
        const settingValues={enablePromptExpansion:true,wildcardMode:"Random",dynamicPromptMode:"Random"};
        const logDebug=()=>{}; const getActiveControllerNode=()=>null;`;
    const engine = await import("data:text/javascript," + encodeURIComponent(preamble + stripped));
    engine.wildcardContentMap.set("colors", ["blue_eyes"]);
    const data = { version: 1, catalog: { items: [{ id: "i", name: "{metadata|keep}", text: "{red|blue}, __colors__", tags: ["http://metadata/"] }] }, relations: [{ item_id: "i", on: true }] };
    const raw = JSON.stringify(data);
    const output = {
        1: { class_type: "SAX_Bridge_Text_Catalog", inputs: { items_json: raw } },
        2: { class_type: "SAX_Bridge_Prompt", inputs: { wildcard_text: "{red|blue}, __colors__" } },
    };
    const truth = new Map([["1:items_json", raw], ["2:wildcard_text", output[2].inputs.wildcard_text]]);
    // 退避なしでは公式エンジンがJSONを壊す失敗条件を再現。
    const broken = engine.processPromptPayload({ prompt: structuredClone(output) }, truth);
    assert.throws(() => JSON.parse(broken.prompt[1].inputs.items_json));
    const protectedOutput = await prepareAutocompletePrompt(output);
    const sent = engine.processPromptPayload({ prompt: protectedOutput }, truth).prompt;
    assert.match(sent[1].inputs._sax_ac_text_0, /^(red|blue), blue_eyes$/);
    assert.equal(sent[1].inputs._sax_ac_text_0, sent[2].inputs.wildcard_text);
    assert.equal(sent[1].inputs[TRANSFER].inputs.items_json.raw, raw);
    assert.deepEqual(sent[1].inputs[TRANSFER].inputs.items_json.data, data);
    assert.equal(output[1].inputs.items_json, raw);
});
