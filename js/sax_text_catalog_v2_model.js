// V2 の編集境界。壊れたデータを補正して保存しないため、検証と編集を分離する。
export const LIMITS = Object.freeze({ items: 10000, recipes: 32, groups: 32, tags: 8, id: 128, name: 256, text: 65536, bytes: 32 * 1024 * 1024 });

export function emptyConfig() {
    return { version: 2, catalog: { items: [] }, recipes: [{ id: "default", name: "組み合わせ 1", groups: [] }], active_recipe_id: "default" };
}

export function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `v2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function fail(message) { throw new Error(message); }
function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path}: オブジェクトが必要です`);
}
function string(value, max, path, nonempty = false) {
    if (typeof value !== "string" || [...value].length > max || (nonempty && !value.length)) fail(`${path}: ${max}文字以内の文字列が必要です`);
}
function array(value, max, path) {
    if (!Array.isArray(value) || value.length > max) fail(`${path}: 最大${max}件の配列が必要です`);
}
function uniqueIds(values, path) {
    const ids = new Set();
    for (const value of values) {
        object(value, path);
        string(value.id, LIMITS.id, `${path}.id`, true);
        if (ids.has(value.id)) fail(`${path}: IDが重複しています`);
        ids.add(value.id);
    }
    return ids;
}

export function validateConfig(config) {
    object(config, "config");
    if (config.version !== 2) fail("対応していないカタログ形式です（version: 2 が必要）");
    object(config.catalog, "catalog");
    array(config.catalog.items, LIMITS.items, "items");
    const itemIds = uniqueIds(config.catalog.items, "items");
    for (const item of config.catalog.items) {
        string(item.name, LIMITS.name, "item.name");
        string(item.text, LIMITS.text, "item.text");
        array(item.tags, LIMITS.tags, "item.tags");
        for (const tag of item.tags) string(tag, LIMITS.name, "tag", true);
        if (new Set(item.tags).size !== item.tags.length) fail("タグが重複しています");
    }
    array(config.recipes, LIMITS.recipes, "recipes");
    if (!config.recipes.length) fail("組み合わせが1件以上必要です");
    const recipeIds = uniqueIds(config.recipes, "recipes");
    string(config.active_recipe_id, LIMITS.id, "active_recipe_id", true);
    if (!recipeIds.has(config.active_recipe_id)) fail("選択中の組み合わせが見つかりません");
    for (const recipe of config.recipes) {
        string(recipe.name, LIMITS.name, "recipe.name");
        array(recipe.groups, LIMITS.groups, "groups");
        uniqueIds(recipe.groups, "groups");
        for (const group of recipe.groups) {
            string(group.name, LIMITS.name, "group.name");
            if (!["all", "random"].includes(group.mode)) fail("選択方式が不正です");
            if (typeof group.on !== "boolean") fail("有効状態が不正です");
            if (!Number.isSafeInteger(group.count) || group.count < 0 || group.count > LIMITS.items) fail("抽選数は0〜10000の整数で指定してください");
            array(group.item_ids, LIMITS.items, "item_ids");
            if (new Set(group.item_ids).size !== group.item_ids.length) fail("同じグループに同じ候補を重複登録できません");
            for (const id of group.item_ids) if (!itemIds.has(id)) fail("参照先の素材が見つかりません");
        }
    }
    if (new TextEncoder().encode(JSON.stringify(config)).length > LIMITS.bytes) fail("カタログは32 MiB以内にしてください");
    return config;
}

export function parseConfig(raw) {
    if (typeof raw !== "string") fail("config_json が文字列ではありません");
    if (new TextEncoder().encode(raw).length > LIMITS.bytes) fail("カタログは32 MiB以内にしてください");
    let config;
    try { config = JSON.parse(raw); } catch { fail("config_json のJSONが壊れています。元のデータを確認してください"); }
    return validateConfig(config);
}

export function parseTags(text) {
    return [...new Set(text.split(/[,、\n]/u).map(tag => tag.trim()).filter(Boolean))];
}

export function filteredItems(config, query = "", tag = "") {
    const needle = query.trim().toLocaleLowerCase();
    return config.catalog.items.filter(item => (!tag || item.tags.includes(tag)) &&
        (!needle || `${item.name}\n${item.text}\n${item.tags.join(" ")}`.toLocaleLowerCase().includes(needle)));
}

export function references(config, itemId) {
    return config.recipes.reduce((count, recipe) => count + recipe.groups.filter(group => group.item_ids.includes(itemId)).length, 0);
}

export function recipeWarnings(config) {
    const recipe = config.recipes.find(value => value.id === config.active_recipe_id);
    return recipe.groups.filter(group => group.on && group.mode === "random" && group.count > group.item_ids.length)
        .map(group => `${group.name || "無題のグループ"}: 候補${group.item_ids.length}件に対して${group.count}件の抽選は実行できません`);
}

export function removeItems(config, ids) {
    const removed = new Set(ids);
    config.catalog.items = config.catalog.items.filter(item => !removed.has(item.id));
    for (const recipe of config.recipes) for (const group of recipe.groups) group.item_ids = group.item_ids.filter(id => !removed.has(id));
}

// 入力フィールドへの連続入力は1操作としてまとめ、別フィールド/構造変更は独立して戻す。
export class EditHistory {
    constructor(raw) { this.current = raw; this.undoStack = []; this.redoStack = []; this.key = null; }
    record(raw, key = null) {
        if (raw === this.current) return false;
        if (!key || key !== this.key) {
            this.undoStack.push(this.current);
            if (this.undoStack.length > 20) this.undoStack.shift();
        }
        this.current = raw;
        this.key = key;
        this.redoStack = [];
        this.trim();
        return true;
    }
    boundary() { this.key = null; }
    trim() {
        const bytes = () => [...this.undoStack, ...this.redoStack].reduce((sum, raw) => sum + raw.length * 2, 0);
        while (bytes() > 64 * 1024 * 1024) {
            if (this.undoStack.length) this.undoStack.shift();
            else this.redoStack.shift();
        }
    }
    undo() {
        if (!this.undoStack.length) return null;
        this.redoStack.push(this.current);
        this.current = this.undoStack.pop(); this.boundary(); this.trim();
        return this.current;
    }
    redo() {
        if (!this.redoStack.length) return null;
        this.undoStack.push(this.current);
        this.current = this.redoStack.pop(); this.boundary(); this.trim();
        return this.current;
    }
}

export function visibleWindow(total, scrollTop, viewport = 260, stride = 40, overscan = 4) {
    const start = Math.max(0, Math.min(total, Math.floor(scrollTop / stride) - overscan));
    const end = Math.min(total, Math.ceil((scrollTop + viewport) / stride) + overscan);
    return { start, end, top: start * stride, bottom: Math.max(0, total - end) * stride };
}

// serializeValue / onSerialize / close は全てこのflushを呼び、debounce中も最新値を返す。
export class BufferedJson {
    constructor(widget, read, onFlush = () => {}) {
        this.widget = widget; this.read = read; this.onFlush = onFlush; this.timer = null; this.dirty = false;
    }
    changed() {
        this.dirty = true; clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 250);
    }
    cancel() { clearTimeout(this.timer); this.timer = null; this.dirty = false; }
    flush() {
        clearTimeout(this.timer); this.timer = null;
        if (this.dirty) {
            this.widget.value = JSON.stringify(this.read()); this.dirty = false;
            this.onFlush(this.widget.value);
        }
        return this.widget.value;
    }
}
