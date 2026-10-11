// V2 の編集境界。壊れたデータを補正して保存しないため、検証と編集を分離する。
export const LIMITS = Object.freeze({ items: 10000, recipes: 32, groups: 32, groupDepth: 8, totalGroups: 256, tags: 8, id: 128, name: 256, text: 65536, bytes: 32 * 1024 * 1024 });

export function emptyConfig() {
    return { version: 2, catalog: { items: [] }, recipes: [{ id: "default", name: "組み合わせ 1", groups: [] }], active_recipe_id: "default" };
}

export function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `v2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// 選択肢だけを並べ替え、保存された実行順は変更しない。
export function sortedNamedOptions(values) {
    return [...values].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja") || a.id.localeCompare(b.id));
}

export function itemTagSortKeys(items) {
    return new Map(items.map(item => [item.id, [...(item.tags ?? [])].sort((a, b) => a.localeCompare(b, "ja"))]));
}

export function compareItemTagKeys(left, right) {
    if (!left.length || !right.length) return Number(!left.length) - Number(!right.length);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const difference = left[i].localeCompare(right[i], "ja");
        if (difference) return difference;
    }
    return left.length - right.length;
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

export function* walkGroups(groups) {
    for (const group of groups) {
        yield group;
        if (group.kind === "nested") yield* walkGroups(group.groups);
    }
}

export function groupItemIds(groups) {
    return [...walkGroups(groups)].flatMap(group => group.kind === "nested" ? [] : group.item_ids);
}

export function validateGroups(groups, itemIds) {
    const ids = new Set();
    let total = 0;
    function visit(values, depth) {
        array(values, LIMITS.groups, "groups");
        if (values.length && depth > LIMITS.groupDepth) fail("構成要素の階層は8段以内にしてください");
        for (const group of values) {
            object(group, "group");
            string(group.id, LIMITS.id, "group.id", true);
            if (ids.has(group.id)) fail("構成要素IDが重複しています");
            ids.add(group.id);
            if (++total > LIMITS.totalGroups) fail("セット内の構成要素は256件以内にしてください");
            string(group.name, LIMITS.name, "group.name");
            if (!["all", "random"].includes(group.mode)) fail("選択方式が不正です");
            if (typeof group.on !== "boolean") fail("有効状態が不正です");
            if (!Number.isSafeInteger(group.count) || group.count < 0 || group.count > LIMITS.items) fail("抽選数は0〜10000の整数で指定してください");
            if (group.kind === "nested") {
                if (Object.hasOwn(group, "item_ids")) fail("ネスト構成要素にはアイテム候補を指定できません");
                visit(group.groups, depth + 1);
            } else {
                if (group.kind !== undefined && group.kind !== "items") fail("構成要素の種類が不正です");
                if (Object.hasOwn(group, "groups")) fail("アイテム構成要素には子の構成要素を指定できません");
                array(group.item_ids, LIMITS.items, "item_ids");
                if (new Set(group.item_ids).size !== group.item_ids.length) fail("同じグループに同じ候補を重複登録できません");
                for (const id of group.item_ids) if (!itemIds.has(id)) fail("参照先の素材が見つかりません");
            }
        }
    }
    visit(groups, 1);
    return groups;
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
        validateGroups(recipe.groups, itemIds);
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
    const tags = Array.isArray(tag) ? tag : tag ? [tag] : [];
    return config.catalog.items.filter(item => tags.every(value => item.tags.includes(value)) &&
        (!needle || `${item.name}\n${item.text}\n${item.tags.join(" ")}`.toLocaleLowerCase().includes(needle)));
}

export function references(config, itemId) {
    return config.recipes.reduce((count, recipe) => count + [...walkGroups(recipe.groups)].filter(group => group.kind !== "nested" && group.item_ids.includes(itemId)).length, 0);
}

export function recipeWarnings(config) {
    const recipe = config.recipes.find(value => value.id === config.active_recipe_id);
    const warnings = [];
    function visit(groups) {
        for (const group of groups) {
            if (!group.on) continue;
            const candidates = group.kind === "nested" ? group.groups.length : group.item_ids.length;
            if (group.mode === "random" && group.count > candidates) warnings.push(`${group.name || "無題のグループ"}: 候補${candidates}件に対して${group.count}件の抽選は実行できません`);
            if (group.kind === "nested" && (group.mode === "all" || group.count > 0)) visit(group.groups);
        }
    }
    visit(recipe.groups);
    return warnings;
}

export function removeItems(config, ids) {
    const removed = new Set(ids);
    config.catalog.items = config.catalog.items.filter(item => !removed.has(item.id));
    for (const recipe of config.recipes) for (const group of walkGroups(recipe.groups)) if (group.kind !== "nested") group.item_ids = group.item_ids.filter(id => !removed.has(id));
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
