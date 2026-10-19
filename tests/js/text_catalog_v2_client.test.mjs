import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogSession, applyOperations, getSession, duplicateCatalog, archiveCatalog, restoreCatalog, listArchivedCatalogs, releaseSession } from "../../js/sax_text_catalog_v2_client.js";

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

test("ネスト構成要素の差分保存・削除・Undo/Redoは子の参照と構造を維持する", async () => {
    const initial = fixture();
    initial.recipes[0].groups = [{ id: "parent", name: "場面", kind: "nested", mode: "random", count: 1, on: true, groups: initial.recipes[0].groups }];
    const backend = server(initial), session = new CatalogSession(initial, { request: backend.request, debounceMs: 10000 });
    const recipe = structuredClone(initial.recipes[0]); recipe.groups[0].groups[0].name = "子の編集";
    session.mutate([{ type: "recipe.put", recipe }]); await session.flush();
    assert.equal(backend.document().recipes[0].groups[0].groups[0].name, "子の編集");
    session.mutate([{ type: "item.delete", id: "a" }]);
    assert.deepEqual(session.document.recipes[0].groups[0].groups[0].item_ids, []);
    session.undo(); assert.deepEqual(session.document.recipes[0].groups[0].groups[0].item_ids, ["a"]);
    session.redo(); await session.flush();
    assert.deepEqual(backend.document().recipes[0].groups[0].groups[0].item_ids, []);
    assert.equal(Object.hasOwn(session.document.recipes[0].groups[0], "item_ids"), false);
});

test("ネスト構成の不正な差分は既存データと履歴を変更しない", () => {
    const initial = fixture(), session = new CatalogSession(initial);
    const recipe = structuredClone(initial.recipes[0]);
    recipe.groups = [{ id: "parent", name: "場面", kind: "nested", mode: "all", count: 0, on: true, groups: [{ ...recipe.groups[0], item_ids: ["missing"] }] }];
    assert.throws(() => session.mutate([{ type: "recipe.put", recipe }]), /参照先/);
    assert.deepEqual(session.document, initial); assert.equal(session.undoStack.length, 0);
    recipe.groups[0].groups = [null]; assert.throws(() => session.mutate([{ type: "recipe.put", recipe }]), /オブジェクト/);
});

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
    const initial = fixture(); initial.recipes[0].groups[0].item_weights = { a: 0.25 };
    const backend = server(initial); const session = new CatalogSession(initial, { request: backend.request, debounceMs: 10000 });
    session.mutate([{ type: "item.delete", id: "a" }]); assert.equal(session.document.catalog.items.length, 0);
    assert.deepEqual(session.document.recipes[0].groups[0].item_ids, []);
    assert.deepEqual(session.document.recipes[0].groups[0].item_weights, {});
    assert.equal(session.undo(), true); assert.equal(session.document.catalog.items[0].text, "原文");
    assert.deepEqual(session.document.recipes[0].groups[0].item_ids, ["a"]);
    assert.deepEqual(session.document.recipes[0].groups[0].item_weights, { a: 0.25 });
    session.redo(); await session.flush(); assert.equal(backend.document().catalog.items.length, 0);
    assert.deepEqual(backend.document().recipes[0].groups[0].item_weights, {});
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

test("タグの上限超過は具体的な理由で拒否し、文書を変更しない", () => {
    const session = new CatalogSession(fixture(), { request: server().request, debounceMs: 10000 });
    const put = tags => session.mutate([edit("原文", { tags })]);
    put(Array.from({ length: 8 }, (_, i) => `t${i}`));
    assert.throws(() => put(Array.from({ length: 9 }, (_, i) => `t${i}`)), /最大8件/);
    assert.throws(() => put(["あ".repeat(257)]), /256文字/);
    assert.throws(() => put(["重複", "重複"]), /タグが不正/);
    assert.equal(session.document.catalog.items[0].tags.length, 8);
});

test("プレビューは未保存の編集を保存してから、実行と同じ抽選をサーバーへ依頼する", async () => {
    const backend = server(); const order = [];
    const request = async (path, options) => {
        order.push(`${options.method} ${path.replace(/^.*\/shared/, "")}`);
        if (path.endsWith("/preview")) return { ok: true, json: async () => ({ text: `${backend.document().catalog.items[0].text}@${JSON.parse(options.body).seed}`, revision: backend.document().revision, seed: JSON.parse(options.body).seed }) };
        return backend.request(path, options);
    };
    const session = new CatalogSession(fixture(), { request, debounceMs: 10000 });
    session.mutate([edit("プレビュー直前の編集")]);
    const result = await session.preview({ recipeId: "r", seed: 42 });
    assert.deepEqual(order, ["PATCH ", "POST /preview"], "保存が先、プレビューが後");
    assert.equal(result.text, "プレビュー直前の編集@42", "保存済みの本文で抽選される");
    assert.deepEqual(JSON.parse(backend.calls[0].options.body).operations.map(op => op.type), ["item.put"]);
    assert.equal(session.status, "saved"); assert.equal(session.undoStack.length, 1, "プレビューは履歴・カタログを変更しない");
});

test("プレビューが失敗しても編集は止まらず、保存の競合ではプレビューを実行しない", async () => {
    const failing = new CatalogSession(fixture(), { request: async (path) => path.endsWith("/preview") ? { ok: false, status: 400, json: async () => ({ error: "選択数が候補数を超えています" }) } : { ok: true, json: async () => ({}) }, debounceMs: 10000 });
    await assert.rejects(failing.preview({ recipeId: "r", seed: 1 }), /候補数を超えています/);
    assert.equal(failing.error, null, "プレビューの失敗はセッションの保存状態にしない");
    failing.mutate([edit("続けて編集できる")]); assert.equal(failing.document.catalog.items[0].text, "続けて編集できる");
    const backend = server(); let previewed = 0;
    const session = new CatalogSession(fixture(), { request: async (path, options) => { if (path.endsWith("/preview")) { previewed++; return { ok: true, json: async () => ({}) }; } return backend.request(path, options); }, debounceMs: 10000 });
    session.mutate([edit("ローカル")]); backend.update([{ type: "catalog.rename", name: "外部変更" }]);
    await assert.rejects(session.preview({ recipeId: "r", seed: 1 }), /競合/); assert.equal(previewed, 0);
    assert.equal(session.conflict, true);
});

test("カタログの複製・アーカイブ・復元は専用の経路へ送り、失敗は理由つきの例外にする", async () => {
    const calls = [];
    const request = async (path, options) => { calls.push([options.method, path, options.body]); return path.includes("missing") ? { ok: false, status: 400, json: async () => ({ error: "見つかりません" }) } : { ok: true, json: async () => ({ id: "a b", catalogs: [] }) }; };
    await duplicateCatalog("a b", undefined, { request }); await duplicateCatalog("a b", "別名", { request });
    await archiveCatalog("a b", { request }); await restoreCatalog("a b", { request });
    assert.deepEqual(await listArchivedCatalogs({ request }), []);
    assert.deepEqual(calls, [
        ["POST", "/sax/text-catalog/v2/catalogs/a%20b/duplicate", "{}"],
        ["POST", "/sax/text-catalog/v2/catalogs/a%20b/duplicate", JSON.stringify({ name: "別名" })],
        ["POST", "/sax/text-catalog/v2/catalogs/a%20b/archive", "{}"],
        ["POST", "/sax/text-catalog/v2/archive/a%20b/restore", "{}"],
        ["GET", "/sax/text-catalog/v2/archive", undefined],
    ]);
    await assert.rejects(archiveCatalog("missing", { request }), /見つかりません/);
});

test("セッションの解放は未保存の編集を保存してから忘れ、保存できなければ残す", async () => {
    const backend = server(), id = "release-ok";
    const document = { ...fixture(), id };
    const session = await getSession(id, { request: async (path, options) => options.method === "GET" ? { ok: true, json: async () => structuredClone(document) } : backend.request(path, options), debounceMs: 10000 });
    session.mutate([edit("解放前の編集")]);
    await releaseSession(id);
    assert.equal(backend.calls.at(-1).options.method, "PATCH", "解放前に保存される");
    assert.notEqual(await getSession(id, { request: async () => ({ ok: true, json: async () => ({ ...document, id }) }) }), session, "古いセッションは使い回さない");
    const failing = "release-fail";
    const kept = await getSession(failing, { request: async (path, options) => options.method === "GET" ? { ok: true, json: async () => ({ ...fixture(), id: failing }) } : { ok: false, status: 500, json: async () => ({ error: "保存できません" }) }, debounceMs: 10000 });
    kept.mutate([edit("保存できない編集")]);
    await assert.rejects(releaseSession(failing), /保存できません/);
    assert.equal(await getSession(failing), kept, "保存できないときはセッションと未保存の編集を残す");
    await releaseSession("never-loaded");
});
