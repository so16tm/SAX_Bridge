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

// localeCompare(..., "ja") は呼ぶたびに照合器を作るため、1万件の並べ替えで数倍遅い。照合器は1つを共有する。
const collator = new Intl.Collator("ja");
export const compareText = (a, b) => collator.compare(a ?? "", b ?? "");
const compareId = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));

// 選択肢だけを並べ替え、保存された実行順は変更しない。
export function sortedNamedOptions(values) {
    return [...values].sort((a, b) => compareText(a.name, b.name) || compareId(a.id, b.id));
}

export function itemTagSortKeys(items) {
    return new Map(items.map(item => [item.id, [...(item.tags ?? [])].sort(compareText)]));
}

export function compareItemTagKeys(left, right) {
    if (!left.length || !right.length) return Number(!left.length) - Number(!right.length);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const difference = compareText(left[i], right[i]);
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
        .sort((a, b) => a.prefix - b.prefix || b.count - a.count || compareText(a.tag, b.tag))
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

// 正規化した検索用文字列はアイテム（編集のたびに新しい値へ置き換わる）ごとに1回だけ作る。
const searchTexts = new WeakMap();
export function searchText(item) {
    let text = searchTexts.get(item);
    if (text === undefined) { text = normalizeSearch(`${item.name ?? ""}\n${item.text ?? ""}\n${item.tags?.join(" ") ?? ""}`); searchTexts.set(item, text); }
    return text;
}

export function matchesSearch(item, tokens) {
    if (!tokens.length) return true;
    if (!item) return false;
    const text = searchText(item);
    return tokens.every(token => text.includes(token));
}

// 大きなカタログでは最初の検索で全件の正規化が走るため、開いた直後に少しずつ済ませておく。戻り値で中止できる。
export function warmSearchIndex(items, { chunk = 400, schedule = callback => setTimeout(callback, 0), cancel = handle => clearTimeout(handle) } = {}) {
    let at = 0, handle = null, stopped = false;
    const step = () => {
        handle = null; if (stopped) return;
        for (const end = Math.min(items.length, at + chunk); at < end; at++) searchText(items[at]);
        if (at < items.length) handle = schedule(step);
    };
    handle = schedule(step);
    return () => { stopped = true; if (handle !== null) cancel(handle); };
}

// 絞り込み（検索語・タグ・セット）と並べ替えを1か所にまとめる。一覧と候補一覧が同じ処理を使い、計測もこれを対象にする。
export function sortItems(values, { sort = "name", resolve = value => value, order = null, usage = null } = {}) {
    const tagKeys = sort === "tags" ? itemTagSortKeys(values.map(resolve)) : null;
    const ranks = sort === "catalog" ? order : null;
    const counts = sort === "usage" ? usage : null;
    return values.sort((a, b) => {
        const left = resolve(a), right = resolve(b);
        if (tagKeys) { const difference = compareItemTagKeys(tagKeys.get(left.id), tagKeys.get(right.id)); if (difference) return difference; }
        if (ranks) { const difference = (ranks.get(left.id) ?? Infinity) - (ranks.get(right.id) ?? Infinity); if (difference) return difference; }
        if (counts) { const difference = (counts.get(right.id)?.groups ?? 0) - (counts.get(left.id)?.groups ?? 0); if (difference) return difference; }
        return compareText(left.name, right.name) || compareId(left.id, right.id);
    });
}

export function selectItems(items, { tokens = [], tags = [], ids = null, unusedIds = null, selectedIds = null, sort = "name", order = null, usage = null } = {}) {
    const values = items.filter(item => (!ids || ids.has(item.id)) && (!unusedIds || !unusedIds.has(item.id)) && (!selectedIds || selectedIds.has(item.id))
        && tags.every(tag => item.tags?.includes(tag)) && matchesSearch(item, tokens));
    return sortItems(values, { sort, order: order ?? (sort === "catalog" ? new Map(items.map((item, index) => [item.id, index])) : null), usage });
}

// タグの上限エラーを欄の近くへ具体的に示すための検査。問題がなければ空文字を返す。
export function tagsError(tags) {
    if (tags.length > LIMITS.tags) return `タグは最大${LIMITS.tags}件までです（現在${tags.length}件）`;
    if (tags.some(tag => typeof tag === "string" && [...tag].length > LIMITS.name)) return `タグは各${LIMITS.name}文字までです`;
    return "";
}

// ---- カタログ一覧（P3: 3-1）----
const pad2 = value => String(value).padStart(2, "0");
// 更新日時（エポック秒）を「2026-10-19 17:05」の形で返す。値がなければ空文字。
export function formatUpdated(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
    const date = new Date(seconds * 1000);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function catalogSummary(catalog) {
    if (catalog.error) return "読み込めません";
    const parts = [];
    if (Number.isSafeInteger(catalog.items)) parts.push(`アイテム${catalog.items}件`);
    if (Number.isSafeInteger(catalog.recipes)) parts.push(`セット${catalog.recipes}件`);
    const updated = formatUpdated(catalog.updated_at); if (updated) parts.push(`更新 ${updated}`);
    return parts.join("・");
}

// ノード上のカタログ選択肢の表示。同名のカタログも件数・更新日時・ID先頭で区別できる。選択の照合にも同じ関数を使う。
export function catalogLabel(catalog) {
    const detail = catalogSummary(catalog);
    return [catalog.name, ...(detail ? [detail] : []), catalog.id.slice(0, 8)].join(" · ");
}

// ---- 同名の検出（P3: 3-6）----
export function nameKey(name) { return normalizeSearch(name).trim(); }

// 同じ名前を持つものの数。2件以上あるものだけを返す（key は nameKey）。
export function duplicateNames(values) {
    const counts = new Map();
    for (const value of values) { const key = nameKey(value.name); counts.set(key, (counts.get(key) ?? 0) + 1); }
    for (const [key, count] of counts) if (count < 2) counts.delete(key);
    return counts;
}

// 同名のグループ。key（nameKey）→ 値の配列。2件以上のものだけ。
export function duplicateGroups(values) {
    const groups = new Map();
    for (const value of values) { const key = nameKey(value.name); const list = groups.get(key); if (list) list.push(value); else groups.set(key, [value]); }
    for (const [key, list] of groups) if (list.length < 2) groups.delete(key);
    return groups;
}

// セットの選択肢。同名のセットだけ構成要素数を添えて、ピッカーで見分けられるようにする。並び順は sortedNamedOptions と同じ。
export function recipeEntries(recipes) {
    const duplicated = duplicateNames(recipes);
    return sortedNamedOptions(recipes).map(recipe => {
        const entry = { id: recipe.id, name: recipe.name };
        if (duplicated.has(nameKey(recipe.name))) entry.hint = `構成要素${[...walkGroups(recipe.groups)].length}件`;
        return entry;
    });
}

// ---- 取り込み（P3: 3-2）----
const IMPORT_NAME_LENGTH = 40;
function nameFromText(text) {
    const chars = [...text.trim().split("\n", 1)[0].trim()];
    return chars.length > IMPORT_NAME_LENGTH ? `${chars.slice(0, IMPORT_NAME_LENGTH).join("")}…` : chars.join("");
}
function importItem(name, text, tags, index) {
    const chars = [...name];
    if (chars.length > LIMITS.name) fail(`${index}件目の名前が${LIMITS.name}文字を超えています`);
    if ([...text].length > LIMITS.text) fail(`${index}件目の本文が${LIMITS.text}文字を超えています`);
    return { id: newId(), name, text, tags };
}

// 貼り付けたテキストを取り込み用のアイテムにする。blank は空行区切り、line は1行1アイテム。
// 名前は先頭行（長いときは先頭40文字）、本文はそのブロック全体。ID は新しく発行する。
export function parseTextItems(text, { split = "blank", tags = [] } = {}) {
    const normalized = String(text ?? "").replace(/\r\n?/gu, "\n");
    const blocks = (split === "line" ? normalized.split("\n") : normalized.split(/\n[ \t\u3000]*(?:\n[ \t\u3000]*)+/u)).map(block => block.trim()).filter(Boolean);
    return blocks.map((block, index) => importItem(nameFromText(block), block, [...tags], index + 1));
}

function importTags(value, index) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(tag => typeof tag !== "string" || !tag.trim())) fail(`${index}件目のタグは文字列の配列で指定してください`);
    const tags = [...new Set(value.map(tag => tag.trim()))], problem = tagsError(tags);
    if (problem) fail(`${index}件目: ${problem}`);
    if (tags.some(tag => /[,、\n\r]/u.test(tag))) fail(`${index}件目のタグにカンマ・読点・改行は使えません`);
    return tags;
}

// 部分 JSON を取り込み用のアイテムにする。受け付ける形式は、アイテムの配列・{ items: [...] }・カタログ全体（version 2／3）。
// 配列の要素は { name, text, tags } のオブジェクトか文字列。id は無視して新しく発行する。セットは取り込まず、数だけ recipes で返す。
export function parseItemsJson(source, { tags = [] } = {}) {
    const entries = Array.isArray(source) ? source : Array.isArray(source?.catalog?.items) ? source.catalog.items : Array.isArray(source?.items) ? source.items : null;
    if (!entries) fail("取り込めるアイテムが見つかりません。アイテムの配列、{ \"items\": [...] }、またはカタログのJSONを指定してください");
    const items = entries.map((entry, i) => {
        const index = i + 1;
        if (typeof entry === "string") {
            if (!entry.trim()) fail(`${index}件目に名前も本文もありません`);
            return importItem(nameFromText(entry), entry.trim(), [...tags], index);
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${index}件目はオブジェクトまたは文字列で指定してください`);
        if ((entry.name !== undefined && typeof entry.name !== "string") || (entry.text !== undefined && typeof entry.text !== "string")) fail(`${index}件目の名前と本文は文字列で指定してください`);
        const merged = [...new Set([...importTags(entry.tags, index), ...tags])], problem = tagsError(merged);
        if (problem) fail(`${index}件目: ${problem}`);
        if (!(entry.name ?? "").trim() && !(entry.text ?? "").trim()) fail(`${index}件目に名前も本文もありません（"name" または "text" を指定してください）`);
        return importItem(entry.name ?? "", entry.text ?? "", merged, index);
    });
    return { items, recipes: Array.isArray(source?.recipes) ? source.recipes.length : 0 };
}

// 追加後の件数が上限を超えるときの理由。問題がなければ空文字。
// bytes は追加後のカタログ全体のおおよその大きさ（UTF-8 のバイト数）。省略時は件数だけを見る。
export function importCapacityError(existing, adding, bytes = 0) {
    if (existing + adding > LIMITS.items) return `アイテムは${LIMITS.items}件以内にしてください（現在${existing}件＋追加${adding}件）`;
    return bytes > LIMITS.bytes ? "カタログは32 MiB以内にしてください（追加後の大きさが上限を超えます）" : "";
}

// 既存のアイテムと本文が完全に一致する追加分の数。取り込みの重複確認に使う（追加は止めない）。
export function countDuplicateTexts(existing, adding) {
    const texts = new Set(existing.map(item => item.text.trim()).filter(Boolean));
    return adding.filter(item => texts.has(item.text.trim())).length;
}

// ---- タグ管理（P3: 3-3）----
// 件数の多い順（同数は名前順）。表記が正規化後に同じタグ（全角半角・大文字小文字違い）には variants に相手を入れる。
export function tagStats(items) {
    const counts = tagCounts(items), groups = new Map();
    for (const tag of counts.keys()) { const key = normalizeSearch(tag).trim(); groups.set(key, [...(groups.get(key) ?? []), tag]); }
    return [...counts].map(([tag, count]) => ({ tag, count, variants: groups.get(normalizeSearch(tag).trim()).filter(value => value !== tag) }))
        .sort((a, b) => b.count - a.count || compareText(a.tag, b.tag));
}

// froms のタグを to に置き換える（to が空ならタグを外す）。既に to を持つアイテムは重複させない。変更のあるアイテムの複製だけ返す。
export function planTagChange(items, froms, to) {
    const sources = new Set(froms), target = String(to ?? "").trim();
    if (!sources.size) return { changed: [], error: "対象のタグを選んでください" };
    if (target) {
        if (parseTags(target).length !== 1 || /[,、\n]/u.test(target)) return { changed: [], error: "タグ名は1つだけ指定してください（カンマ・改行は使えません）" };
        if ([...target].length > LIMITS.name) return { changed: [], error: `タグは各${LIMITS.name}文字までです` };
    }
    const changed = [];
    for (const item of items) {
        if (!item.tags.some(tag => sources.has(tag))) continue;
        const tags = [];
        for (const tag of item.tags) { const next = sources.has(tag) ? target : tag; if (next && !tags.includes(next)) tags.push(next); }
        if (tags.length !== item.tags.length || tags.some((tag, index) => tag !== item.tags[index])) changed.push({ ...item, tags });
    }
    return { changed, error: "" };
}

// ---- ランダム抽選の確率（P3: 3-5）----
// 1件を抽選するときの確率（%）。重みが正のものだけが対象で、合計に対する割合になる。対象がなければすべて 0。
export function drawProbabilities(weights) {
    const total = weights.reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0);
    return weights.map(weight => total > 0 && weight > 0 ? weight / total * 100 : 0);
}

// 抽選グループの候補ごとの確率。キーは、アイテム候補ならアイテムID、ネストなら子の構成要素ID。ネストは有効な子だけが対象。
export function groupProbabilities(group) {
    const keys = group.kind === "nested" ? group.groups.map(child => child.id) : group.item_ids;
    const weights = group.kind === "nested" ? group.groups.map(child => child.on ? (child.weight ?? 1) : 0) : group.item_ids.map(id => candidateWeight(group, id));
    const percents = drawProbabilities(weights);
    return new Map(keys.map((key, index) => [key, percents[index]]));
}

export function formatPercent(percent) {
    if (!(percent > 0)) return "0%";
    if (percent < 0.1) return "<0.1%";
    return `${Number(percent.toFixed(1))}%`;
}

// ---- 前回の実行結果の行出力（P3: 3-4）----
// selection_json の行から、その行の出力テキストを出力順に組み立てる。出力がなければ空文字。
export function rowOutputText(row) {
    const outputs = [];
    const visit = groups => {
        for (const group of groups ?? []) {
            if (group.kind === "nested") { visit(group.groups); continue; }
            for (const item of group.items ?? []) {
                const text = item.output_text ?? String(item.text ?? "").trim();
                if (Number.isSafeInteger(item.output_position) && text) outputs.push([item.output_position, text]);
            }
        }
    };
    visit(row?.groups);
    return outputs.sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join("\n");
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
