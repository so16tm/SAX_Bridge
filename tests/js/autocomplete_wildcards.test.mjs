import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub } from "../bench/env.mjs";
register("../bench/shared_catalog_hooks.mjs", import.meta.url);
installDomStub();
const { loadWildcardList } = await import("../../js/sax_ui_base.js");

test("Autocomplete++一覧を挿入構文へ変換し、名前・件数の上限を守る", async () => {
    let calls = 0;
    window._saxTestRequest = async route => {
        calls++;
        assert.equal(route, "/autocomplete-plus-plus/wildcards/all-data");
        return { ok: true, json: async () => ({ success: true, wildcards: { colors: ["red"], "folder/file": ["x"], "": [], ["x".repeat(300)]: [] } }) };
    };
    assert.deepEqual(await loadWildcardList({ forceRefresh: true, maxItems: 1 }), ["__colors__"]);
    assert.deepEqual(await loadWildcardList(), ["__colors__"]);
    assert.equal(calls, 1);
    assert.deepEqual(await loadWildcardList({ forceRefresh: true }), ["__colors__", "__folder/file__"]);
});

test("未導入・不正な応答・取得エラー時に通常入力を妨げない", async () => {
    for (const response of [{ ok: false }, { ok: true, json: async () => ({ success: true, wildcards: ["wrong"] }) }]) {
        window._saxTestRequest = async () => response;
        assert.deepEqual(await loadWildcardList({ forceRefresh: true }), []);
    }
    window._saxTestRequest = async () => { throw new Error("offline"); };
    assert.deepEqual(await loadWildcardList({ forceRefresh: true }), []);
});
