import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const extensions = [];
globalThis.__dictionaryApp = { registerExtension: extension => extensions.push(extension) };
globalThis.__dictionaryApi = { fetchApi() { throw new Error("予期しないAPI呼び出し"); } };
const source = (await readFile(new URL("../../js/sax_tag_dictionary.js", import.meta.url), "utf8"))
    .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.__dictionaryApp;")
    .replace('import { api } from "../../scripts/api.js";', "const api = globalThis.__dictionaryApi;");
const { installDictionaryControls } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const result = overrides => ({ available: true, date: "2026-10-11", tags: 123, installed: true, changed: true, ...overrides });
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(request, download) {
    const node = { widgets: [], setDirtyCanvas() {}, addWidget(type, name, value, callback, options) {
        const widget = { type, name, value, callback, options }; this.widgets.push(widget); return widget;
    } };
    const controller = installDictionaryControls(node, request, download);
    return { node, controller, status: node.widgets[0], message: node.widgets[1], update: node.widgets[2], download: node.widgets[3] };
}

test("作成時は状態だけを取得し、UI値を実行入力へ保存しない", async () => {
    const calls = [];
    const f = fixture(async (...args) => { calls.push(args); return response(result()); });
    await f.controller.ready;
    assert.deepEqual(calls, [["/sax/tag-dictionary/status"]]);
    assert.match(f.status.value, /保存済み.*123タグ/);
    assert.match(f.message.value, /ブラウザ再読込後/);
    assert.ok(f.node.widgets.every(w => w.options.serialize === false && w.serialize === false));
    f.status.value = "手動変更"; f.status.callback();
    assert.match(f.status.value, /保存済み/);
});

test("更新は単独POSTを一回だけ送信し、遅い初期応答が更新結果を上書きしない", async () => {
    const initial = deferred(); const update = deferred(); const calls = [];
    const f = fixture(async (...args) => { calls.push(args); return args[0].endsWith("status") ? initial.promise : update.promise; });
    const pending = f.update.callback();
    await f.update.callback();
    assert.deepEqual(calls, [["/sax/tag-dictionary/status"], ["/sax/tag-dictionary/update", { method: "POST" }]]);
    update.resolve(response(result())); await pending;
    initial.resolve(response({ available: false })); await f.controller.ready;
    assert.match(f.status.value, /更新完了/);
    assert.equal(f.update.name, "最新CSVを取得");
});

test("更新失敗の理由を保持し、再操作で復帰できる", async () => {
    const initial = deferred(); let attempts = 0;
    const f = fixture(async path => path.endsWith("status") ? initial.promise : ++attempts === 1
        ? response({ error: "配布元に接続できません" }, false) : response(result({ changed: false })));
    await f.update.callback();
    initial.resolve(response(result())); await f.controller.ready;
    assert.equal(f.status.value, "更新失敗");
    assert.equal(f.message.value, "配布元に接続できません");
    await f.update.callback();
    assert.match(f.status.value, /変更なし/);
});

test("Autocomplete++未導入でも保存結果とCSVダウンロードを利用できる", async () => {
    let downloads = 0;
    const f = fixture(async () => response(result({ installed: false })), async () => { downloads++; });
    await f.controller.ready;
    assert.match(f.message.value, /未導入.*ダウンロード/);
    await f.download.callback();
    assert.equal(downloads, 1);
    extensions[0].nodeCreated({ comfyClass: "CLIPTextEncode" });
});

test("配置待ちの辞書とAutocomplete++未導入を区別する", async () => {
    const f = fixture(async () => response(result({ installed: false, autocomplete_available: true })));
    await f.controller.ready;
    assert.match(f.message.value, /配置は未完了/);
    assert.doesNotMatch(f.message.value, /未導入/);
});

test("ダウンロード中は更新を開始せず、操作結果が競合しない", async () => {
    let updates = 0;
    const pending = deferred();
    const f = fixture(async path => { if (path.endsWith("update")) updates++; return response(result()); }, () => pending.promise);
    await f.controller.ready;
    const download = f.download.callback();
    await f.update.callback();
    assert.equal(updates, 0);
    pending.resolve();
    await download;
    await f.update.callback();
    assert.equal(updates, 1);
});

test("壊れた応答もエラーとして表示し、ダウンロード失敗を初期応答が消さない", async () => {
    const initial = deferred();
    const f = fixture(async () => initial.promise, async () => { throw new Error("CSV未取得"); });
    await f.download.callback();
    initial.resolve(response(result())); await f.controller.ready;
    assert.equal(f.status.value, "ダウンロード失敗");
    assert.equal(f.message.value, "CSV未取得");
    const broken = fixture(async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid"); } }));
    await broken.controller.ready;
    assert.equal(broken.status.value, "状態取得失敗");
});
