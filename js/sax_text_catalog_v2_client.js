import { LIMITS, validateConfig, validateGroups, groupItemIds, walkGroups, tagsError } from "./sax_text_catalog_v2_model.js";

const BASE = "/sax/text-catalog/v2/catalogs";
const sessions = new Map();
const copy = value => structuredClone(value);
async function defaultRequest(path, options) {
    const { api } = await import("../../scripts/api.js");
    return api.fetchApi(path, options);
}
async function requestJson(request, path, method = "GET", body) {
    const response = await request(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) {
        const error = new Error(data.error || `カタログの保存に失敗しました (${response.status})`);
        error.status = response.status; error.current = data.current;
        throw error;
    }
    return data;
}
export function validateDocument(document) {
    if (document?.version !== 3 || typeof document.id !== "string" || !document.id || typeof document.name !== "string" || document.name.length > LIMITS.name || !Number.isSafeInteger(document.revision) || document.revision < 0) throw new Error("共有カタログの形式が不正です");
    const recipes = document.recipes?.length ? document.recipes : [{ id: "validation-default", name: "", groups: [] }];
    if (!Array.isArray(document.recipes)) throw new Error("テキストセットの形式が不正です");
    if (document.recipes.length > 1024) throw new Error("テキストセットは1024件以内にしてください");
    const ids = new Set();
    for (const recipe of recipes) {
        if (ids.has(recipe.id)) throw new Error("テキストセットIDが重複しています");
        ids.add(recipe.id);
    }
    // 共有カタログは従来のノード内セット数上限に依存しない。
    for (let start = 0; start < recipes.length; start += LIMITS.recipes) {
        const batch = recipes.slice(start, start + LIMITS.recipes);
        validateConfig({ version: 2, catalog: document.catalog, recipes: batch, active_recipe_id: batch[0].id });
    }
    if (new TextEncoder().encode(JSON.stringify(document)).length > LIMITS.bytes) throw new Error("カタログは32 MiB以内にしてください");
    return document;
}
function string(value, max, nonempty = false) {
    if (typeof value !== "string" || [...value].length > max || (nonempty && !value)) throw new Error("カタログ入力の文字数または型が不正です");
}
function validateOperation(document, operation) {
    const { type } = operation;
    if (type === "item.put") {
        const item = operation.item;
        if (!item) throw new Error("アイテムが必要です");
        string(item.id, LIMITS.id, true); string(item.name, LIMITS.name); string(item.text, LIMITS.text);
        if (!Array.isArray(item.tags) || new Set(item.tags).size !== item.tags.length) throw new Error("タグが不正です");
        const tagProblem = tagsError(item.tags); if (tagProblem) throw new Error(tagProblem);
        item.tags.forEach(tag => string(tag, LIMITS.name, true));
        if (!document.catalog.items.some(value => value.id === item.id) && document.catalog.items.length >= LIMITS.items) throw new Error("アイテムは10000件以内にしてください");
    } else if (type === "recipe.put") {
        const recipe = operation.recipe;
        if (!recipe) throw new Error("テキストセットが必要です");
        string(recipe.id, LIMITS.id, true); string(recipe.name, LIMITS.name);
        if (!document.recipes.some(value => value.id === recipe.id) && document.recipes.length >= 1024) throw new Error("テキストセットの上限を超えています");
        // セット編集だけを検証し、全本文の再シリアライズを避ける。
        const ids = new Set(document.catalog.items.map(item => item.id));
        validateGroups(recipe.groups, ids);
        const referenced = new Set(groupItemIds(recipe.groups));
        if ([...referenced].some(id => !ids.has(id))) throw new Error("参照先のアイテムがありません");
        validateConfig({ version: 2, catalog: { items: [...referenced].map(id => ({ id, name: "", text: "", tags: [] })) }, recipes: [recipe], active_recipe_id: recipe.id });
    } else if (type === "item.delete" || type === "recipe.delete") string(operation.id, LIMITS.id, true);
    else if (type === "catalog.rename") string(operation.name, LIMITS.name);
    else throw new Error("対応していないカタログ操作です");
}
function put(array, value) {
    const index = array.findIndex(existing => existing.id === value.id);
    if (index < 0) array.push(copy(value)); else array[index] = copy(value);
}
function appendOperations(target, operations) {
    for (const operation of operations) {
        const previous = target.at(-1);
        const sameTarget = previous?.type === operation.type && (
            operation.type === "item.put" && previous.item.id === operation.item.id ||
            operation.type === "recipe.put" && previous.recipe.id === operation.recipe.id ||
            operation.type === "catalog.rename");
        if (sameTarget) target[target.length - 1] = copy(operation);
        else target.push(copy(operation));
    }
}
export function applyOperations(document, operations) {
    for (const operation of operations) {
        validateOperation(document, operation);
        if (operation.type === "item.put") put(document.catalog.items, operation.item);
        else if (operation.type === "recipe.put") put(document.recipes, operation.recipe);
        else if (operation.type === "catalog.rename") document.name = operation.name;
        else if (operation.type === "recipe.delete") document.recipes = document.recipes.filter(recipe => recipe.id !== operation.id);
        else {
            document.catalog.items = document.catalog.items.filter(item => item.id !== operation.id);
            for (const recipe of document.recipes) for (const group of walkGroups(recipe.groups)) if (group.kind !== "nested") {
                group.item_ids = group.item_ids.filter(id => id !== operation.id);
                if (group.item_weights) delete group.item_weights[operation.id];
            }
        }
    }
    return document;
}
function inverseOperations(document, operations) {
    const inverse = [];
    for (const operation of operations) {
        if (operation.type === "item.put") {
            const old = document.catalog.items.find(item => item.id === operation.item.id);
            inverse.unshift(old ? { type: "item.put", item: copy(old) } : { type: "item.delete", id: operation.item.id });
        } else if (operation.type === "recipe.put") {
            const old = document.recipes.find(recipe => recipe.id === operation.recipe.id);
            inverse.unshift(old ? { type: "recipe.put", recipe: copy(old) } : { type: "recipe.delete", id: operation.recipe.id });
        } else if (operation.type === "catalog.rename") inverse.unshift({ type: "catalog.rename", name: document.name });
        else if (operation.type === "recipe.delete") {
            const old = document.recipes.find(recipe => recipe.id === operation.id);
            if (old) inverse.unshift({ type: "recipe.put", recipe: copy(old) });
        } else {
            const old = document.catalog.items.find(item => item.id === operation.id);
            const affected = document.recipes.filter(recipe => groupItemIds(recipe.groups).includes(operation.id));
            inverse.unshift(...(old ? [{ type: "item.put", item: copy(old) }] : []), ...affected.map(recipe => ({ type: "recipe.put", recipe: copy(recipe) })));
        }
        applyOperations(document, [operation]);
    }
    return inverse;
}
export class CatalogSession {
    constructor(document, { request = defaultRequest, debounceMs = 250 } = {}) {
        this.document = copy(validateDocument(document)); this.request = request; this.debounceMs = debounceMs;
        this.status = "saved"; this.conflict = false; this.error = null; this.pending = []; this.listeners = new Set();
        this.undoStack = []; this.redoStack = []; this.timer = null; this.inFlight = null; this.generation = 0;
        this.editEpoch = 0;
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    notify() { for (const fn of this.listeners) fn(this); }
    mutate(operations, { historyKey = null } = {}) {
        if (!Array.isArray(operations)) throw new Error("操作は配列で指定してください");
        if (!operations.length) return;
        // 変更する配列は浅く複製、参照除去が必要な削除時だけセットを複製する。
        const draft = { ...this.document, catalog: { items: [...this.document.catalog.items] }, recipes: operations.some(op => op.type === "item.delete") ? copy(this.document.recipes) : [...this.document.recipes] };
        const forward = copy(operations), inverse = inverseOperations(draft, forward);
        this.document = draft;
        const previous = this.undoStack.at(-1);
        if (historyKey && previous?.key === historyKey) {
            appendOperations(previous.forward, forward);
            const merged = []; appendOperations(merged, [...inverse, ...previous.inverse]); previous.inverse = merged;
        }
        else this.undoStack.push({ forward, inverse, key: historyKey });
        this.redoStack = []; this.trimHistory(); this.enqueue(forward);
    }
    trimHistory() {
        while (this.undoStack.length > 20) this.undoStack.shift();
        let bytes = [...this.undoStack, ...this.redoStack].reduce((sum, entry) => sum + JSON.stringify(entry).length * 2, 0);
        while (bytes > 64 * 1024 * 1024 && (this.undoStack.length || this.redoStack.length)) {
            const entry = this.undoStack.length ? this.undoStack.shift() : this.redoStack.shift(); bytes -= JSON.stringify(entry).length * 2;
        }
    }
    enqueue(operations) {
        this.editEpoch++;
        appendOperations(this.pending, operations);
        this.status = this.conflict ? "conflict" : this.error ? "error" : "pending";
        clearTimeout(this.timer);
        if (!this.error) this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.debounceMs);
        this.notify();
    }
    undo() {
        const entry = this.undoStack.pop(); if (!entry) return false;
        applyOperations(this.document, entry.inverse); this.redoStack.push(entry); this.enqueue(entry.inverse); return true;
    }
    redo() {
        const entry = this.redoStack.pop(); if (!entry) return false;
        applyOperations(this.document, entry.forward); this.undoStack.push(entry); this.enqueue(entry.forward); return true;
    }
    async flush() {
        clearTimeout(this.timer); this.timer = null;
        if (this.inFlight) { await this.inFlight; return this.flush(); }
        if (this.error) throw this.error;
        if (!this.pending.length) return this.document;
        const batch = this.pending.splice(0), generation = this.generation;
        this.status = "saving"; this.notify();
        this.inFlight = (async () => {
            try {
                const saved = await requestJson(this.request, `${BASE}/${encodeURIComponent(this.document.id)}`, "PATCH", { base_revision: this.document.revision, operations: batch });
                if (generation !== this.generation) return;
                if (saved.version === 3) {
                    const document = copy(validateDocument(saved));
                    applyOperations(document, this.pending); this.document = document;
                } else {
                    // 差分保存の応答は改訂情報だけ。本文全件の返送・検証を入力ごとに行わない。
                    if (saved.id !== this.document.id || !Number.isSafeInteger(saved.revision) || saved.revision <= this.document.revision) throw new Error("保存応答の改訂情報が不正です");
                    this.document = { ...this.document, revision: saved.revision };
                }
                this.status = this.pending.length ? "pending" : "saved";
            } catch (error) {
                if (generation === this.generation) {
                    this.pending.unshift(...batch); this.error = error; this.conflict = error.status === 409;
                    this.status = this.conflict ? "conflict" : "error";
                }
                throw error;
            } finally { this.inFlight = null; this.notify(); }
        })();
        await this.inFlight;
        return this.flush();
    }
    async reload() {
        clearTimeout(this.timer); this.timer = null;
        if (this.inFlight) await this.inFlight.catch(() => {});
        const epoch = this.editEpoch;
        const document = await requestJson(this.request, `${BASE}/${encodeURIComponent(this.document.id)}`);
        // 最新取得を待つ間に別の編集画面で入力された内容を消さない。
        if (epoch !== this.editEpoch) return this.document;
        this.document = copy(validateDocument(document)); this.pending = []; this.undoStack = []; this.redoStack = [];
        this.error = null; this.conflict = false; this.status = "saved"; this.generation++; this.notify(); return this.document;
    }
    async reapply() {
        clearTimeout(this.timer); this.timer = null;
        if (this.inFlight) await this.inFlight.catch(() => {});
        const latest = copy(validateDocument(await requestJson(this.request, `${BASE}/${encodeURIComponent(this.document.id)}`)));
        const operations = copy(this.pending); applyOperations(latest, operations);
        this.document = latest; this.generation++; this.error = null; this.conflict = false; this.status = "pending";
        // 外部変更後は古い逆操作を適用しない。
        this.undoStack = []; this.redoStack = []; this.notify(); return this.flush();
    }
    async retry() { if (this.conflict) throw this.error; this.error = null; return this.flush(); }
    // 実行と同じ抽選をサーバーで1セット分だけ行う。未保存の編集は先に保存し、カタログ・Queue・キャッシュは変更しない。
    async preview({ recipeId, seed = 0 }) {
        await this.flush();
        return requestJson(this.request, `${BASE}/${encodeURIComponent(this.document.id)}/preview`, "POST", { recipe_id: recipeId, seed });
    }
}
export async function listCatalogs({ request = defaultRequest } = {}) { return (await requestJson(request, BASE)).catalogs; }
export async function createCatalog(value, { request = defaultRequest, catalog, recipes } = {}) {
    const body = typeof value === "string" ? { name: value, ...(catalog ? { catalog } : {}), ...(recipes ? { recipes } : {}) } : value;
    return validateDocument(await requestJson(request, BASE, "POST", body));
}
export async function importCatalog(document, { request = defaultRequest } = {}) { return validateDocument(await requestJson(request, BASE, "POST", { document })); }
export async function getSession(id, options = {}) {
    if (!sessions.has(id)) {
        const promise = requestJson(options.request ?? defaultRequest, `${BASE}/${encodeURIComponent(id)}`).then(document => new CatalogSession(document, options));
        sessions.set(id, promise); promise.catch(() => { if (sessions.get(id) === promise) sessions.delete(id); });
    }
    return sessions.get(id);
}
export async function flushSessions() { await Promise.all([...sessions.values()].map(async session => (await session).flush())); }
