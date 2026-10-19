// V2 の編集境界。壊れたデータを補正して保存しないため、検証と編集を分離する。
export const LIMITS = Object.freeze({ items: 10000, recipes: 32, groups: 32, groupDepth: 8, totalGroups: 256, tags: 8, id: 128, name: 256, text: 65536, affix: 4096, bytes: 32 * 1024 * 1024 });

export function parseRandomCount(value) {
    if (typeof value !== "string") fail("抽選数は整数または範囲で指定してください");
    const match = value.match(/^\s*(\d+)\s*(?:[-～〜]\s*(\d+)\s*)?$/u);
    if (!match) fail("抽選数は整数または範囲で指定してください");
    const first = Number(match[1]), second = match[2] === undefined ? null : Number(match[2]);
    if (!Number.isSafeInteger(first) || first > LIMITS.items || (second !== null && (!Number.isSafeInteger(second) || second > LIMITS.items))) fail("抽選数は0〜10000の整数で指定してください");
    if (second === null) return { count: first };
    if (first > second) fail("抽選数の下限は上限以下にしてください");
    return { count: second, count_min: first };
}

export function parseSelectionWeight(value) {
    if (typeof value === "number") return validateWeight(value);
    if (typeof value !== "string") fail("重みは0〜1000000の数値で指定してください");
    const text = value.trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(text)) fail("重みは0〜1000000の数値で指定してください");
    return validateWeight(Number(text));
}

export function candidateWeight(group, itemId) {
    return group.item_weights && Object.hasOwn(group.item_weights, itemId) ? group.item_weights[itemId] : 1;
}

function validateWeight(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) fail("重みは0〜1000000の有限数で指定してください");
    return value;
}

export function formatRandomCount(group) {
    return Object.hasOwn(group, "count_min") ? `${group.count_min}～${group.count}` : String(group.count);
}

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

// アイテムを参照している構成要素数とセットを集計する。削除確認（1-4）と使用数表示で共通に使う。
export function itemUsage(recipes) {
    const usage = new Map();
    for (const recipe of recipes) for (const group of walkGroups(recipe.groups)) {
        if (group.kind === "nested") continue;
        for (const id of new Set(group.item_ids)) {
            let entry = usage.get(id);
            if (!entry) usage.set(id, entry = { groups: 0, recipeIds: new Set() });
            entry.groups++; entry.recipeIds.add(recipe.id);
        }
    }
    return usage;
}

export function deletionImpact(usage, ids) {
    let groups = 0; const recipeIds = new Set();
    for (const id of ids) { const entry = usage.get(id); if (!entry) continue; groups += entry.groups; for (const recipeId of entry.recipeIds) recipeIds.add(recipeId); }
    return { groups, recipes: recipeIds.size };
}

// 使用数の表示と削除確認で同じ文言を使い、件数が食い違わないようにする。
export function usageSummary(impact) {
    return impact.groups ? `使用中の構成要素 ${impact.groups}件・セット ${impact.recipes}件` : "どのセットでも使用されていません";
}

// セット内で使われているアイテムID。exceptGroupId を指定すると、その構成要素の候補は数えない（候補の編集中に自分自身を重複扱いしないため）。
export function recipeItemIds(recipe, exceptGroupId = null) {
    const ids = new Set();
    for (const group of walkGroups(recipe.groups)) if (group.kind !== "nested" && group.id !== exceptGroupId) for (const id of group.item_ids) ids.add(id);
    return ids;
}

// 選んだアイテムをセットの構成要素として追加する（recipe を直接書き換えて返す）。separate なら1アイテム1構成要素に分ける。
// セット画面の「選んだアイテムを追加」と一覧の「セットへ追加」で共通に使う。
export function appendItemGroups(recipe, itemIds, { separate = false, mode = "all", bounds = { count: 1 }, parentId = "", nameOf = () => "" } = {}) {
    let children = recipe.groups;
    if (parentId) {
        const parent = [...walkGroups(recipe.groups)].find(group => group.id === parentId && group.kind === "nested");
        if (!parent) throw new Error("追加先の構成要素が見つかりません");
        children = parent.groups;
    }
    for (const ids of separate ? itemIds.map(id => [id]) : [itemIds]) {
        children.push({ id: newId(), name: nameOf(ids[0]) || "構成要素", on: true, mode: separate ? "all" : mode, ...bounds, item_ids: ids });
    }
    return recipe;
}

// タグ入力欄の補完候補。value の最後のカンマ区切り部分を絞り込み語とし、入力済みのタグは除く。多く使われているタグを先に並べる。
export function tagCounts(items) {
    const counts = new Map();
    for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return counts;
}

export function suggestTags(counts, value, limit = 8) {
    const parts = String(value).split(/[,、\n]/u), fragment = parts.at(-1).trim();
    const chosen = new Set(parts.slice(0, -1).map(tag => tag.trim()).filter(Boolean));
    const tokens = searchTokens(fragment), head = normalizeSearch(fragment);
    return [...counts].filter(([tag]) => tag !== fragment && !chosen.has(tag) && tokens.every(token => normalizeSearch(tag).includes(token)))
        .map(([tag, count]) => ({ tag, count, prefix: head && normalizeSearch(tag).startsWith(head) ? 0 : 1 }))
        .sort((a, b) => a.prefix - b.prefix || b.count - a.count || a.tag.localeCompare(b.tag, "ja"))
        .slice(0, limit).map(({ tag, count }) => ({ tag, count }));
}

export function applyTagSuggestion(value, tag) {
    const text = String(value), at = Math.max(text.lastIndexOf(","), text.lastIndexOf("、"), text.lastIndexOf("\n"));
    const head = at >= 0 ? text.slice(0, at + 1) : "";
    return `${head}${head && !head.endsWith("\n") ? " " : ""}${tag}, `;
}

// 全角・半角と大文字小文字を区別せず、空白区切りの全語を含むものに一致させる。
export function normalizeSearch(text) {
    return String(text ?? "").normalize("NFKC").toLowerCase();
}

export function searchTokens(query) {
    return normalizeSearch(query).split(/\s+/u).filter(Boolean);
}

const searchTexts = new WeakMap();
export function matchesSearch(item, tokens) {
    if (!tokens.length) return true;
    if (!item) return false;
    let text = searchTexts.get(item);
    if (text === undefined) { text = normalizeSearch(`${item.name ?? ""}\n${item.text ?? ""}\n${item.tags?.join(" ") ?? ""}`); searchTexts.set(item, text); }
    return tokens.every(token => text.includes(token));
}

// タグの上限エラーを欄の近くへ具体的に示すための検査。問題がなければ空文字を返す。
export function tagsError(tags) {
    if (tags.length > LIMITS.tags) return `タグは最大${LIMITS.tags}件までです（現在${tags.length}件）`;
    if (tags.some(tag => typeof tag === "string" && [...tag].length > LIMITS.name)) return `タグは各${LIMITS.name}文字までです`;
    return "";
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
            for (const key of ["prefix", "suffix"]) if (Object.hasOwn(group, key)) string(group[key], LIMITS.affix, `group.${key}`);
            if (!["all", "random"].includes(group.mode)) fail("選択方式が不正です");
            if (typeof group.on !== "boolean") fail("有効状態が不正です");
            if (!Number.isSafeInteger(group.count) || group.count < 0 || group.count > LIMITS.items) fail("抽選数は0〜10000の整数で指定してください");
            if (Object.hasOwn(group, "count_min") && (!Number.isSafeInteger(group.count_min) || group.count_min < 0 || group.count_min > group.count)) fail("抽選数の下限は0〜上限以下の整数で指定してください");
            if (Object.hasOwn(group, "weight")) validateWeight(group.weight);
            if (group.kind === "nested") {
                if (Object.hasOwn(group, "item_weights")) fail("ネスト構成要素にはアイテムの重みを指定できません");
                if (Object.hasOwn(group, "item_ids")) fail("ネスト構成要素にはアイテム候補を指定できません");
                visit(group.groups, depth + 1);
            } else {
                if (group.kind !== undefined && group.kind !== "items") fail("構成要素の種類が不正です");
                if (Object.hasOwn(group, "groups")) fail("アイテム構成要素には子の構成要素を指定できません");
                array(group.item_ids, LIMITS.items, "item_ids");
                if (new Set(group.item_ids).size !== group.item_ids.length) fail("同じグループに同じ候補を重複登録できません");
                for (const id of group.item_ids) if (!itemIds.has(id)) fail("参照先の素材が見つかりません");
                if (Object.hasOwn(group, "item_weights")) {
                    object(group.item_weights, "item_weights");
                    for (const [id, weight] of Object.entries(group.item_weights)) {
                        if (!group.item_ids.includes(id)) fail("重みの参照先は候補アイテムに含めてください");
                        validateWeight(weight);
                    }
                }
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
            const candidates = group.kind === "nested" ? group.groups.filter(child => child.on && (child.weight ?? 1) > 0).length : group.item_ids.filter(id => candidateWeight(group, id) > 0).length;
            if (group.mode === "random" && group.count > candidates) warnings.push(`${group.name || "無題のグループ"}: 候補${candidates}件に対して最大${group.count}件の抽選は実行できません`);
            if (group.kind === "nested" && (group.mode === "all" || group.count > 0)) visit(group.groups);
        }
    }
    visit(recipe.groups);
    return warnings;
}

export function removeItems(config, ids) {
    const removed = new Set(ids);
    config.catalog.items = config.catalog.items.filter(item => !removed.has(item.id));
    for (const recipe of config.recipes) for (const group of walkGroups(recipe.groups)) if (group.kind !== "nested") {
        group.item_ids = group.item_ids.filter(id => !removed.has(id));
        if (group.item_weights) for (const id of removed) delete group.item_weights[id];
    }
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
