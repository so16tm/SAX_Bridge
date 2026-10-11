import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogSession, applyOperations, getSession } from "../../js/sax_text_catalog_v2_client.js";

const fixture = () => ({ version: 3, id: "shared", name: "共通", revision: 1, catalog: { items: [{ id: "a", name: "森", text: "原文", tags: [] }] }, recipes: [{ id: "r", name: "背景", groups: [{ id: "g", name: "固定", mode: "all", count: 1, on: true, item_ids: ["a"] }] }] });
function server(initial = fixture()) {
    let document = structuredClone(initial);
    const calls = [];
    const request = async (path, options) => {
        calls.push({ path, options });
        if (options.method === "GET") return { ok: true, json: async () => structuredClone(document) };
        const body = JSON.parse(options.body);
        if (body.base_revision !== document.revision) return { ok: false, status: 409, json: async () => ({ error: "競合", current: structuredClone(document) }) };
        applyOperations(document, body.operations); document.revision++;
        return { ok: true, json: async () => structuredClone(document) };
    };
    return { request, calls, update(operations) { applyOperations(document, operations); document.revision++; }, document: () => document };
}
const edit = (text, extra = {}) => ({ type: "item.put", item: { id: "a", name: "森", text, tags: [], ...extra } });

test("差分保存の改訂情報だけの応答でも、保存中の追加本文を保持する", async () => {
    const backend = server(); let release; let first = true;
    const request = async (path, options) => {
        if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
        const response = await backend.request(path, options); const document = await response.json();
        return { ok: response.ok, json: async () => ({ id: document.id, revision: document.revision }) };
    };
    const session = new CatalogSession(fixture(), { request, debounceMs: 10000 });
    session.mutate([edit("一回目")]); const saving = session.flush(); session.mutate([edit("追加編集")]); release(); await saving;
    assert.equal(session.document.catalog.items[0].text, "追加編集"); assert.equal(session.document.revision, 3);
});

test("最新データ取得中に別の画面で入力された本文を失わない", async () => {
    let release; const backend = server();
    const session = new CatalogSession(fixture(), { request: async (...args) => { await new Promise(resolve => { release = resolve; }); return backend.request(...args); }, debounceMs: 10000 });
    const loading = session.reload(); session.mutate([edit("取得中の編集")]); release(); await loading;
    assert.equal(session.document.catalog.items[0].text, "取得中の編集"); assert.equal(session.pending.length, 1);
    session.request = backend.request; await session.flush();
});

test("差分保存・自動保存状態と複数購読を通知する", async () => {
    const backend = server(); const session = new CatalogSession(fixture(), { request: backend.request, debounceMs: 10000 });
    const states = []; const unsubscribe = session.subscribe(s => states.push(s.status));
    session.mutate([edit("新しい本文")]); assert.equal(session.document.catalog.items[0].text, "新しい本文");
    await session.flush(); unsubscribe();
    assert.deepEqual(states, ["pending", "saving", "saved"]);
    const body = JSON.parse(backend.calls[0].options.body);
    assert.deepEqual(Object.keys(body), ["base_revision", "operations"]);
    assert.equal(session.document.revision, 2); assert.equal(session.status, "saved");
});

test("保存中の追加編集を失わず次の改訂へ直列保存する", async () => {
    const backend = server(); let release; let first = true;
    const request = async (...args) => { if (first) { first = false; await new Promise(resolve => { release = resolve; }); } return backend.request(...args); };
    const session = new CatalogSession(fixture(), { request, debounceMs: 10000 });
    session.mutate([edit("一回目")]); const saving = session.flush();
    session.mutate([edit("二回目")]); release(); await saving;
    assert.equal(session.document.catalog.items[0].text, "二回目");
    assert.deepEqual(backend.calls.map(call => JSON.parse(call.options.body).base_revision), [1, 2]);
});

test("競合時は未保存編集を保ち、明示再適用まで上書きしない", async () => {
    const backend = server(); const session = new CatalogSession(fixture(), { request: backend.request, debounceMs: 10000 });
    session.mutate([edit("ローカル")]); backend.update([{ type: "catalog.rename", name: "外部変更" }]);
    await assert.rejects(session.flush(), /競合/);
    assert.equal(session.conflict, true); assert.equal(session.document.catalog.items[0].text, "ローカル");
    await assert.rejects(session.flush(), /競合/); assert.equal(backend.calls.length, 1);
    await session.reapply(); assert.equal(session.document.name, "外部変更");
    assert.equal(session.document.catalog.items[0].text, "ローカル"); assert.equal(session.conflict, false);
});

test("競合再読み込みと通信再試行を明示的に実行する", async () => {
    const backend = server(); let fail = true;
    const session = new CatalogSession(fixture(), { request: async (...args) => { if (fail) throw new Error("通信失敗"); return backend.request(...args); }, debounceMs: 10000 });
    session.mutate([edit("ローカル")]); await assert.rejects(session.flush(), /通信失敗/);
    assert.equal(session.status, "error"); assert.equal(session.pending.length, 1);
    fail = false; await session.retry(); assert.equal(session.status, "saved");
    session.mutate([edit("破棄予定")]); await session.reload();
    assert.equal(session.document.catalog.items[0].text, "ローカル"); assert.equal(session.pending.length, 0);
});

test("削除のundoはアイテムと全セット参照を復元しredoで除去する", async () => {
    const backend = server(); const session = new CatalogSession(fixture(), { request: backend.request, debounceMs: 10000 });
    session.mutate([{ type: "item.delete", id: "a" }]); assert.equal(session.document.catalog.items.length, 0);
    assert.deepEqual(session.document.recipes[0].groups[0].item_ids, []);
    assert.equal(session.undo(), true); assert.equal(session.document.catalog.items[0].text, "原文");
    assert.deepEqual(session.document.recipes[0].groups[0].item_ids, ["a"]);
    session.redo(); await session.flush(); assert.equal(backend.document().catalog.items.length, 0);
});

test("無効な複数操作は部分変更を残さず、連続本文入力をひとつの履歴にする", async () => {
    const backend = server(); const session = new CatalogSession(fixture(), { request: backend.request, debounceMs: 10000 });
    assert.throws(() => session.mutate([edit("先行"), { type: "unknown" }]));
    assert.equal(session.document.catalog.items[0].text, "原文");
    session.mutate([edit("一")], { historyKey: "a:text" }); session.mutate([edit("二")], { historyKey: "a:text" });
    assert.equal(session.undoStack.length, 1); session.undo(); assert.equal(session.document.catalog.items[0].text, "原文");
    session.redo(); assert.equal(session.document.catalog.items[0].text, "二"); await session.flush();
});

test("10000件の編集でも本文全件を送信せず、同じカタログのセッションを共有する", async () => {
    const document = fixture(); document.id = "large-shared";
    document.catalog.items = Array.from({ length: 10000 }, (_, i) => ({ id: `i${i}`, name: `${i}`, text: "本文".repeat(100), tags: [] }));
    document.recipes = [];
    const backend = server(document);
    const [first, second] = await Promise.all([getSession(document.id, { request: backend.request, debounceMs: 10000 }), getSession(document.id, { request: backend.request })]);
    assert.equal(first, second); assert.equal(backend.calls.length, 1);
    first.mutate([{ type: "item.put", item: { ...first.document.catalog.items[9999], text: "変更" } }]);
    await second.flush(); assert.equal(second.document.catalog.items[9999].text, "変更");
    assert.ok(backend.calls[1].options.body.length < 300);
});
