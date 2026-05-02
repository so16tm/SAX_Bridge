import { app } from "../../scripts/app.js";
import {
    h, txt, getComfyTheme,
    makeItemListWidget,
    captureOutputLinks, restoreOutputLinks,
    showDialog,
    showFilePicker,
} from "./sax_ui_base.js";

const EXT_NAME      = "SAX.TextCatalog";
const NODE_TYPE     = "SAX_Bridge_Text_Catalog";
const SCHEMA_VERSION = 1;
const MAX_RELATIONS = 32;
const MAX_ITEMS     = 32;
const MAX_TAGS      = 8;

const UNSET_LABEL  = "(unset)";
const ORPHAN_LABEL = "<orphan>";

/** タグフィルタ 1 行に並べる最大件数。残りは [Show all] で展開する */
const TAG_FILTER_INLINE_LIMIT = 12;

// ---------------------------------------------------------------------------
// 共通スタイル
// ---------------------------------------------------------------------------

const STYLE = {
    pane: "background:var(--comfy-input-bg,#222);border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;padding:8px;",
    btn: "padding:5px 10px;border-radius:4px;border:1px solid var(--border-color,#4e4e4e);background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);cursor:pointer;font-size:12px;",
    primaryBtn: "padding:7px 16px;border-radius:4px;border:none;background:var(--primary-background,#0b8ce9);color:#fff;cursor:pointer;font-weight:bold;",
    input: "background:var(--comfy-input-bg,#222);border:1px solid var(--content-bg,#4e4e4e);border-radius:3px;color:var(--input-text,#ddd);padding:5px 6px;font-size:12px;outline:none;",
    tagActive: "display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:10px;background:#3a4a6a;color:#cde;cursor:pointer;user-select:none;flex-shrink:0;",
    tagInactive: "display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:10px;background:#2a2a30;color:#888;cursor:pointer;user-select:none;border:1px solid #444;flex-shrink:0;",
    label: "font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.05em;",
};

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** id 生成（randomUUID 優先、フォールバックあり） */
function newId() {
    if (typeof crypto !== "undefined" && crypto?.randomUUID) {
        return crypto.randomUUID();
    }
    return `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** タグ正規化: trim + 小文字化 */
function normalizeTag(s) {
    return String(s ?? "").trim().toLowerCase();
}

/**
 * confirm() 等のダイアログ表示用に文字列を安全化する。
 * 制御文字・ゼロ幅文字・双方向制御文字を除去し最大長で打ち切る。
 * 用途: ログインジェクション防止と、ゼロ幅文字による UI 偽装（誤承認）の防止。
 *
 * 範囲:
 *   \x00-\x1f, \x7f : ASCII 制御文字
 *   U+200B-U+200F      : ゼロ幅文字（ZWSP, ZWNJ, ZWJ, LRM, RLM）
 *   U+202A-U+202E      : 双方向制御文字（LRE, RLE, PDF, LRO, RLO）
 *   U+2060-U+206F      : ワードジョイナー / 不可視操作
 */
function sanitizeForDialog(s, maxLen = 80) {
    // ソースに不可視文字を直接書くことを避けるため、コードポイントから動的に RegExp を構築する。
    if (!sanitizeForDialog._re) {
        const ranges = [
            [0x00, 0x1f], [0x7f, 0x7f],
            [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f],
        ];
        const cls = ranges.map(([a, b]) => 
            String.fromCodePoint(a) + (a === b ? "" : "-" + String.fromCodePoint(b))).join("");
        sanitizeForDialog._re = new RegExp("[" + cls + "]", "g");
    }
    return String(s ?? "").replace(sanitizeForDialog._re, " ").slice(0, maxLen);
}

/** 隠しウィジェットを描画から除外する（Primitive Store と同パターン） */
function hideWidget(widget) {
    widget.computeSize = () => [0, -4];
    widget.draw        = () => {};
}

// ---------------------------------------------------------------------------
// danbooru タグオートコンプリート（pyssss ComfyUI-Custom-Scripts 連携）
// ---------------------------------------------------------------------------

/**
 * pyssss `TextAreaAutoComplete` の動的ロード。
 * pyssss が未導入 or 配信パスが異なる場合は null を返してフォールバック（手動入力）。
 *
 * 結果はモジュールスコープでメモ化し、Dialog 開閉ごとの再 import を避ける。
 */
let _pysssssAutoCompletePromise = null;

function loadPysssssAutoComplete() {
    if (_pysssssAutoCompletePromise) return _pysssssAutoCompletePromise;
    const candidatePaths = [
        "/extensions/pysssss/js/common/autocomplete.js",
        "/extensions/ComfyUI-Custom-Scripts/js/common/autocomplete.js",
    ];
    _pysssssAutoCompletePromise = (async () => {
        for (const path of candidatePaths) {
            try {
                const mod = await import(path);
                if (mod?.TextAreaAutoComplete) {
                    // globalSeparator はインスタンス間で共有される static プロパティ。
                    // pyssss 既定（""）を ", " に上書きして区切りを補完時に自動挿入する
                    if (mod.TextAreaAutoComplete.globalSeparator === "") {
                        mod.TextAreaAutoComplete.globalSeparator = ", ";
                    }
                    return mod.TextAreaAutoComplete;
                }
            } catch {
                // 次の候補パスへ
            }
        }
        return null;
    })();
    return _pysssssAutoCompletePromise;
}

/**
 * textarea に danbooru タグオートコンプリートをアタッチする。
 * pyssss 未導入時は何もしない（手動入力にフォールバック）。
 *
 * Manager Dialog のオーバーレイ (z-index 10000) より前に出すため、
 * dropdown の z-index を個別に引き上げる。pyssss 既定は 9999。
 */
async function attachAutoComplete(textarea) {
    const TextAreaAutoComplete = await loadPysssssAutoComplete();
    if (!TextAreaAutoComplete) return;
    // textarea が既に DOM から外されていた場合はアタッチしない
    if (!textarea.isConnected) return;
    try {
        const instance = new TextAreaAutoComplete(textarea);
        if (instance?.dropdown) {
            instance.dropdown.style.zIndex = "10001";
        }
    } catch {
        // pyssss 側の API 変更等で例外発生 → 黙ってフォールバック
    }
}

// ---------------------------------------------------------------------------
// LoRA / Wildcard ピッカー（Editor の挿入補助）
// ---------------------------------------------------------------------------

const LORA_COMBO_NAME       = "select_to_add_lora";
const WILDCARD_COMBO_NAME   = "select_to_add_wildcard";
const LORA_PLACEHOLDER      = "Select the LoRA to add to the text";
const WILDCARD_PLACEHOLDER  = "Select the Wildcard to add to the text";

/** 表示用に LoRA フルパスから .safetensors とディレクトリを除去 */
const loraDisplayName = (full) =>
    String(full).replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

/** combo widget の選択肢からプレースホルダを除外して取得 */
function getComboOptions(node, comboName, placeholder) {
    const combo = node.widgets?.find(w => w.name === comboName);
    return (combo?.options?.values ?? []).filter(v => v !== placeholder);
}

/**
 * textarea のカーソル位置に文字列を挿入し、input イベントを発火する。
 *
 * 注意: pyssss TextAreaAutoComplete が attach されている場合、`textarea.value`
 * への直接代入は autocomplete 内部状態と競合する可能性がある。`input` イベント
 * 発火で再同期させるが、pyssss 側の API 変更時は再検証が必要。
 */
function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end   = textarea.selectionEnd   ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after  = textarea.value.slice(end);
    textarea.value = before + text + after;
    const newPos = start + text.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// API レスポンスの安全制限（信頼境界外データに対する型・サイズガード）
const WILDCARD_NAME_MAX_LENGTH = 200;
const WILDCARD_LIST_MAX_ITEMS  = 1000;

/**
 * Wildcard 一覧を Impact-Pack の REST API から遅延ロードし、
 * combo の options.values にマージする。Impact-Pack 未導入時は無視。
 *
 * 成功時のみメモ化フラグを立てるため、ネットワーク一時失敗からの再試行が可能。
 * 「成功」の定義は API レスポンスの取得成功（list が空でもフラグを立てる）。
 * 例外発生時のみフラグを立てず再試行できる状態に留める。
 * `await` 完了後にフラグ判定するため複数 Dialog 起動時の race も保護される。
 */
async function ensureWildcardList(node) {
    if (node._textCatalogWildcardLoaded) return;
    const combo = node.widgets?.find(w => w.name === WILDCARD_COMBO_NAME);
    if (!combo) return;
    // 既に Wildcard が取得済み（define_schema 経由でプレースホルダ以外が含まれる）ならスキップ
    const values = combo.options?.values ?? [];
    if (values.length >= 2 || (values.length === 1 && values[0] !== WILDCARD_PLACEHOLDER)) {
        node._textCatalogWildcardLoaded = true;
        return;
    }
    try {
        const { api } = await import("../../scripts/api.js");
        const res = await api.fetchApi("/impact/wildcards/list");
        if (!res.ok) return;
        const data = await res.json();
        // 信頼境界外: 文字列要素のみ採用、長さ・件数の上限で DoS / プロトタイプ汚染を防ぐ
        const raw = Array.isArray(data?.data) ? data.data : [];
        const list = raw
            .filter(v => typeof v === "string" && v.length > 0 && v.length <= WILDCARD_NAME_MAX_LENGTH)
            .slice(0, WILDCARD_LIST_MAX_ITEMS);
        if (list.length > 0) {
            combo.options.values = [WILDCARD_PLACEHOLDER, ...list];
        }
        node._textCatalogWildcardLoaded = true;
    } catch {
        // Impact-Pack 未導入時はピッカーが空リストになる（ボタン無効化で対応）。
        // フラグは立てないため、Impact-Pack を後からロードした場合に再試行できる。
    }
}

// `showFilePicker` も内部で showDialog を使うため、Manager Dialog と同じ z-index:10000
// になる。後から body.appendChild される DOM 順により前面表示される（実害なし）。
// 各ピッカーは独自 className を持つため Manager のクラス名重複削除と競合しない。
/** LoRA ピッカーを開き、選択肢を textarea のカーソル位置に挿入 */
function showLoraPicker(node, textarea) {
    const items = getComboOptions(node, LORA_COMBO_NAME, LORA_PLACEHOLDER);
    if (items.length === 0) return;
    showFilePicker({
        items,
        title: "Select LoRA to Insert",
        placeholder: "Search LoRA name…",
        mode: "single",
        className: "__sax_text_catalog_lora_picker",
        displayName: loraDisplayName,
        onSelect(name) {
            // 拡張子のみ除去しサブディレクトリパスを保持する。
            // prompt.py の _resolve_lora_name は末尾一致で LoRA を解決するため、
            // 同名 LoRA が複数フォルダに存在すると意図しないファイルが解決される。
            // パスを残すことでこの衝突を防ぐ。表示名は loraDisplayName で短縮するが
            // 挿入名はパス付きのまま使う（ComfyUI コンボボックス一般のパターン）。
            const cleanName = String(name).replace(/\.safetensors$/i, "");
            insertAtCursor(textarea, `<lora:${cleanName}>`);
        },
    });
}

/** Wildcard ピッカーを開き、選択肢を textarea のカーソル位置に挿入 */
function showWildcardPicker(node, textarea) {
    const items = getComboOptions(node, WILDCARD_COMBO_NAME, WILDCARD_PLACEHOLDER);
    if (items.length === 0) return;
    showFilePicker({
        items,
        title: "Select Wildcard to Insert",
        placeholder: "Search wildcard…",
        mode: "single",
        className: "__sax_text_catalog_wc_picker",
        onSelect(name) {
            // 信頼境界外（Impact-Pack API 由来）の値を items_json にシリアライズする経路があるため、
            // 制御文字を除去し最大長で打ち切る。
            const safeName = String(name).replace(/[\x00-\x1f\x7f]/g, "").slice(0, WILDCARD_NAME_MAX_LENGTH);
            if (!safeName) return;
            // 区切り判定はカーソル前のテキスト末尾に対して行う（textarea 全体ではない）。
            // カーソルが中間にある場合に直前文字が ", " かどうかで判定する。
            const cursor = textarea.selectionStart ?? textarea.value.length;
            const before = textarea.value.slice(0, cursor);
            const prefix = before && !before.endsWith(", ") ? ", " : "";
            insertAtCursor(textarea, prefix + safeName);
        },
    });
}

// ---------------------------------------------------------------------------
// 状態モデル
// ---------------------------------------------------------------------------

/** ノード初期状態を生成 */
function emptyState() {
    return {
        catalog: {
            items: [],
            tag_definitions: [],
            favorite_tags: [],
        },
        relations: [],
    };
}

/** items_json (string) → state object */
function parseState(raw) {
    if (!raw || typeof raw !== "string") return emptyState();
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object") return emptyState();
        if (obj.version !== SCHEMA_VERSION) return emptyState();
        const catalog = obj.catalog || {};
        const items = Array.isArray(catalog.items) ? catalog.items : [];
        const tagDefs = Array.isArray(catalog.tag_definitions) ? catalog.tag_definitions : [];
        const favTags = Array.isArray(catalog.favorite_tags) ? catalog.favorite_tags : [];
        const relations = Array.isArray(obj.relations) ? obj.relations : [];

        const normalizedTagDefs = tagDefs.map(normalizeTag).filter(Boolean);
        const tagDefSet = new Set(normalizedTagDefs);
        // favorite_tags は tag_definitions に存在するもののみ採用（壊れた参照を排除）
        const normalizedFavTags = favTags
            .map(normalizeTag)
            .filter(t => t && tagDefSet.has(t));

        return {
            catalog: {
                items: items.map(it => ({
                    id: typeof it.id === "string" ? it.id : newId(),
                    name: typeof it.name === "string" ? it.name : "",
                    text: typeof it.text === "string" ? it.text : "",
                    tags: Array.isArray(it.tags)
                        ? it.tags.map(normalizeTag).filter(Boolean).slice(0, MAX_TAGS)
                        : [],
                })),
                tag_definitions: normalizedTagDefs,
                favorite_tags: normalizedFavTags,
            },
            relations: relations.map(rel => ({
                item_id: rel && typeof rel.item_id === "string" ? rel.item_id : null,
                // `on` 欠損は ON 扱い（旧ワークフローとの後方互換）。
                // boolean 以外は明示的に Boolean() で正規化する。
                on: rel && rel.on !== undefined ? Boolean(rel.on) : true,
            })),
        };
    } catch {
        return emptyState();
    }
}

/** state → items_json (string)。内部プロパティ（_links 等）は明示的に除外する */
function serializeState(state) {
    const payload = {
        version: SCHEMA_VERSION,
        catalog: {
            items: state.catalog.items.map(({ id, name, text, tags }) => ({
                id, name, text, tags: [...(tags ?? [])],
            })),
            tag_definitions: [...state.catalog.tag_definitions],
            favorite_tags: [...(state.catalog.favorite_tags ?? [])],
        },
        // `on` の正規化は parseState と対称に書く（欠損 → true、それ以外は Boolean()）
        relations: state.relations.map(({ item_id, on }) => ({
            item_id,
            on: on !== undefined ? Boolean(on) : true,
        })),
    };
    return JSON.stringify(payload);
}

/** Catalog 内で id から Item を引く（O(n) 線形検索でも n<=32 なので問題なし） */
function findItemById(state, itemId) {
    if (!itemId) return null;
    return state.catalog.items.find(it => it.id === itemId) ?? null;
}

/** Relation の表示名を解決 */
function resolveRelationLabel(state, relation) {
    if (!relation || !relation.item_id) return UNSET_LABEL;
    const item = findItemById(state, relation.item_id);
    if (!item) return ORPHAN_LABEL;
    return item.name || "(no name)";
}

/** 起こり得るエラー状態（unset / orphan）の判定 */
function relationStatus(state, relation) {
    if (!relation || !relation.item_id) return "unset";
    if (!findItemById(state, relation.item_id)) return "orphan";
    return "ok";
}

// ---------------------------------------------------------------------------
// 共通：フィルタ・タグ集計
// ---------------------------------------------------------------------------

/** 全 items から (tag → 使用数) Map を集計 */
function countTagUsage(items) {
    const usage = new Map();
    for (const it of items) {
        for (const tag of it.tags ?? []) {
            usage.set(tag, (usage.get(tag) ?? 0) + 1);
        }
    }
    return usage;
}

/**
 * Item リストを「テキスト検索クエリ + 選択中タグ集合」で AND 絞り込む。
 * Manager と Item ピッカーで共通利用する。
 */
function filterItemsByQueryAndTags(items, query, activeTags) {
    const q = (query ?? "").trim().toLowerCase();
    return items.filter(it => {
        if (q) {
            const inName = it.name?.toLowerCase().includes(q);
            const inTag  = (it.tags ?? []).some(t => t.toLowerCase().includes(q));
            if (!inName && !inTag) return false;
        }
        if (activeTags && activeTags.size > 0) {
            const tagsOfItem = new Set(it.tags ?? []);
            for (const t of activeTags) {
                if (!tagsOfItem.has(t)) return false;
            }
        }
        return true;
    });
}

/**
 * タグを以下の優先度でソートする:
 *   1. お気に入りタグのうち「コンテキスト内に登場するもの」（favoriteTags 配列の登録順）
 *   2. 残り：絞り込み後 items 内の使用数（降順）→ アルファベット順
 *
 * コンテキスト外タグは表示しない（タグ行の圧迫を避けるため）。
 * ただし選択中の activeTags はコンテキスト外でも残す（解除のため必須）。
 */
function sortTagsByContext(filteredItems, activeTags, favoriteTags = []) {
    const usage = countTagUsage(filteredItems);
    // コンテキスト内タグ + 選択中タグ
    // （お気に入りはコンテキスト連動で絞り込む。コンテキスト外お気に入りは表示しない）
    const inContext = new Set([
        ...usage.keys(),
        ...(activeTags ?? []),
    ]);

    const favSet = new Set(favoriteTags);
    // お気に入りはコンテキスト内に登場するもののみ、登録順で先頭へ
    const favs = favoriteTags.filter(t => inContext.has(t));
    const rest = [...inContext].filter(t => !favSet.has(t)).sort((a, b) => {
        const ua = usage.get(a) ?? 0;
        const ub = usage.get(b) ?? 0;
        if (ua !== ub) return ub - ua;
        return a.localeCompare(b);
    });

    return [...favs, ...rest];
}

/**
 * Item のタグ配列を sortedTags の順序に並び替える。
 * sortedTags に含まれないタグ（コンテキスト外タグ）は末尾にアルファベット順で付加する。
 * Editor / リスト内のタグ表示でタグトグルと並びを揃えるために使う。
 *
 * @param {string[]} itemTags    - Item の tags 配列
 * @param {string[]} sortedTags  - sortTagsByContext で得たタグ全体順序
 * @returns {string[]} 並び替え後の新配列（元配列は変更しない）
 */
function sortItemTagsByContext(itemTags, sortedTags) {
    if (!Array.isArray(itemTags) || itemTags.length === 0) return [];
    const order = new Map(sortedTags.map((t, i) => [t, i]));
    const inOrder = [];
    const outOfContext = [];
    for (const tag of itemTags) {
        if (order.has(tag)) inOrder.push(tag);
        else outOfContext.push(tag);
    }
    inOrder.sort((a, b) => order.get(a) - order.get(b));
    outOfContext.sort((a, b) => a.localeCompare(b));
    return [...inOrder, ...outOfContext];
}

/**
 * Item を「タグ順序リスト内のインデックスを昇順ソートしたタプル」で辞書順比較する。
 * タグなし items は最後尾にまとめる。同位はアイテム名昇順。
 *
 * @param {object[]} items     - 並び替え対象（filter 済み）
 * @param {string[]} sortedTags - sortTagsByContext で得たタグ全体順序
 * @returns {object[]} 新しい配列（元配列は変更しない）
 */
function sortItemsByTagOrder(items, sortedTags) {
    const tagIndex = new Map(sortedTags.map((t, i) => [t, i]));
    const FALLBACK_INDEX = Number.POSITIVE_INFINITY;

    const keyed = items.map(it => {
        const tagPositions = (it.tags ?? [])
            .map(t => tagIndex.has(t) ? tagIndex.get(t) : FALLBACK_INDEX)
            .filter(i => i !== FALLBACK_INDEX)
            .sort((a, b) => a - b);
        const hasNoTags = tagPositions.length === 0;
        return { item: it, hasNoTags, tagPositions };
    });

    keyed.sort((a, b) => {
        // タグなしは最後尾にまとめる
        if (a.hasNoTags !== b.hasNoTags) return a.hasNoTags ? 1 : -1;
        // タプル辞書順比較
        const len = Math.min(a.tagPositions.length, b.tagPositions.length);
        for (let i = 0; i < len; i++) {
            if (a.tagPositions[i] !== b.tagPositions[i]) {
                return a.tagPositions[i] - b.tagPositions[i];
            }
        }
        if (a.tagPositions.length !== b.tagPositions.length) {
            return a.tagPositions.length - b.tagPositions.length;
        }
        // 同位はアイテム名昇順
        return (a.item.name ?? "").localeCompare(b.item.name ?? "");
    });

    return keyed.map(k => k.item);
}

/** Item を参照している Relation 数を返す */
function countRelationsReferencing(state, itemId) {
    return state.relations.filter(r => r.item_id === itemId).length;
}

// ---------------------------------------------------------------------------
// 共通：タグフィルタ UI（1 行固定 + Show all モーダル）
// ---------------------------------------------------------------------------

/**
 * タグフィルタ行を生成・更新する。
 *
 * @param {HTMLElement} containerEl - タグバッジを描画するコンテナ（1 行固定）
 * @param {() => {sortedTags:string[], usage:Map<string,number>}} computeContext
 * @param {Set<string>} activeTags  - 現在選択中のタグ（クリックで切替）
 * @param {() => Set<string>} favSetGetter - お気に入りタグ集合を遅延取得する getter（stale 回避）
 * @param {() => void} onChange     - タグ選択が変わった時のコールバック
 */
function renderTagFilter(containerEl, computeContext, activeTags, favSetGetter, onChange) {
    const { sortedTags, usage } = computeContext();
    const favSet = favSetGetter();
    containerEl.innerHTML = "";
    if (sortedTags.length === 0) {
        containerEl.appendChild(h("span", "color:#666;font-size:11px;", "(no tags in current context)"));
        return;
    }

    const visible = sortedTags.slice(0, TAG_FILTER_INLINE_LIMIT);
    const hidden  = sortedTags.slice(TAG_FILTER_INLINE_LIMIT);

    for (const tag of visible) {
        containerEl.appendChild(makeTagBadge(tag, activeTags, usage, favSet, onChange));
    }

    if (hidden.length > 0) {
        const moreBtn = h("button", STYLE.btn + "padding:2px 8px;font-size:10px;flex-shrink:0;",
            `Show all (${hidden.length} more)`);
        moreBtn.addEventListener("click", () => {
            showAllTagsDialog(computeContext, activeTags, favSetGetter, onChange);
        });
        containerEl.appendChild(moreBtn);
    }
}

/** タグバッジを生成（クリックで activeTags を切替）。お気に入りなら★マーク付き。 */
function makeTagBadge(tag, activeTags, usage, favSet, onChange) {
    const isActive = activeTags.has(tag);
    const isFav = favSet?.has(tag);
    const count = usage.get(tag) ?? 0;
    const baseStyle = isActive ? STYLE.tagActive : STYLE.tagInactive;
    const favStyle  = isFav ? "border:1px solid #d4a017;" : "";
    const label = (isFav ? "★ " : "") + (count > 0 ? `${tag} (${count})` : tag);
    const badge = h("span", baseStyle + favStyle, label);
    badge.addEventListener("click", () => {
        if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
        onChange();
    });
    return badge;
}

/** タグ件数が上限を超えた時の「全件表示」ダイアログ。 */
function showAllTagsDialog(computeContext, activeTags, favSetGetter, onChange) {
    showDialog({
        title: "All Tags",
        width: 480,
        className: "__sax_text_catalog_all_tags",
        build(dlg, close) {
            const wrap = h("div", "display:flex;flex-wrap:wrap;gap:4px;max-height:60vh;overflow-y:auto;padding:4px;");

            const rerender = () => {
                // クリック・親の変更でタグ順序・★状態が変わるため、毎回最新値を取り直す
                const { sortedTags, usage } = computeContext();
                const favSet = favSetGetter();
                wrap.innerHTML = "";
                for (const tag of sortedTags) {
                    wrap.appendChild(makeTagBadge(tag, activeTags, usage, favSet, () => {
                        onChange();
                        rerender();
                    }));
                }
            };
            rerender();
            dlg.appendChild(wrap);

            const foot = h("div", "display:flex;justify-content:flex-end;margin-top:8px;");
            const okBtn = h("button", STYLE.primaryBtn, "Done");
            okBtn.addEventListener("click", close);
            foot.appendChild(okBtn);
            dlg.appendChild(foot);
        },
    });
}

function showManagerDialog(node, getState, applyDraft) {
    // draft は Dialog ローカルの「書き換え可能な作業コピー」として扱う。
    // 設計方針:
    //   - 親 state（node._textCatalogState）はイミュータブル更新を厳守する
    //   - draft 内の Item オブジェクトに対する name/text/tags の代入は意図的な
    //     in-place 編集を許容する（Save 時に node 側へ deep copy で渡される）
    //   - draft 自体への配列再代入（draft.items = [...]）はイミュータブル更新する
    // Save 押下まで親 state には反映されない（draft / commit パターン）
    const original = getState();
    let draft = {
        items: original.catalog.items.map(it => ({ ...it, tags: [...(it.tags ?? [])] })),
        tag_definitions: [...original.catalog.tag_definitions],
        favorite_tags: [...(original.catalog.favorite_tags ?? [])],
    };
    let selectedId = null;  // 初期化はリスト表示順が確定する getVisibleItems 定義後に行う
    const activeTagFilter = new Set();
    let searchQuery = "";
    let dirty = false;  // Save 後の追加変更を検知

    // -- レンダリング再構築用ハンドル --
    let leftListEl = null;
    let editorEl   = null;
    let tagFilterRowEl = null;
    let leftTitleEl = null;

    /** 検索クエリ + 選択タグで絞り込んだ items（コンテキスト計算の基準） */
    function getFilteredItems() {
        return filterItemsByQueryAndTags(draft.items, searchQuery, activeTagFilter);
    }

    /** コンテキストに応じた sortedTags / usage を計算（タグフィルタとアイテムソートで共用） */
    function computeContext() {
        const filtered = getFilteredItems();
        return {
            filtered,
            sortedTags: sortTagsByContext(filtered, activeTagFilter, draft.favorite_tags ?? []),
            usage: countTagUsage(filtered),
        };
    }

    /** リストに実際に表示される並び順（フィルタ + タグソート適用済み） */
    function getVisibleItems() {
        const { filtered, sortedTags } = computeContext();
        return sortItemsByTagOrder(filtered, sortedTags);
    }

    // 初期選択はリスト表示順の先頭
    selectedId = getVisibleItems()[0]?.id ?? null;

    function renderTagFilterRow() {
        if (!tagFilterRowEl) return;
        // 最新のフィルタ状態から sortedTags/usage を計算する関数を渡す
        // （Show all ダイアログ内でクリックされた際にも最新値で再描画できるようにするため）
        const ctxFn = () => {
            const { sortedTags, usage } = computeContext();
            return { sortedTags, usage };
        };
        // favSet は draft.favorite_tags の更新（Manage Tags で変更）に追随するため getter で渡す
        const favSetGetter = () => new Set(draft.favorite_tags ?? []);
        renderTagFilter(tagFilterRowEl, ctxFn, activeTagFilter, favSetGetter, () => renderAll());
    }

    function renderItemList() {
        if (!leftListEl) return;
        leftListEl.innerHTML = "";
        if (leftTitleEl) {
            leftTitleEl.textContent = `Items (${draft.items.length}/${MAX_ITEMS})`;
        }

        const { filtered, sortedTags } = computeContext();
        if (filtered.length === 0) {
            leftListEl.appendChild(h("div", "color:#666;font-size:11px;padding:8px;text-align:center;",
                draft.items.length === 0 ? "No items. Click [+ New] to create one." : "No items match the filter."));
            return;
        }
        const sorted = sortItemsByTagOrder(filtered, sortedTags);

        for (const it of sorted) {
            const row = h("div", "padding:5px 6px;border-radius:3px;cursor:pointer;display:flex;align-items:center;gap:6px;");
            if (it.id === selectedId) {
                row.style.background = "var(--comfy-menu-secondary-bg,#303030)";
            }
            row.addEventListener("click", () => {
                selectedId = it.id;
                renderAll();
            });
            row.addEventListener("mouseenter", () => {
                if (it.id !== selectedId) row.style.background = "var(--comfy-menu-secondary-bg,#2a2a2a)";
            });
            row.addEventListener("mouseleave", () => {
                if (it.id !== selectedId) row.style.background = "";
            });

            const nameEl = h("div", "flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", it.name || "(unnamed)");
            row.appendChild(nameEl);

            const refs = countRelationsReferencing({ ...original, catalog: draft }, it.id);
            if (refs > 0) {
                row.appendChild(h("span", "font-size:9px;color:#7a9;background:#234;padding:1px 5px;border-radius:8px;flex-shrink:0;", `×${refs}`));
            }
            const tagsForDisplay = sortItemTagsByContext(it.tags, sortedTags).slice(0, 3);
            for (const tag of tagsForDisplay) {
                row.appendChild(h("span", "font-size:9px;color:#aab;background:#334;padding:1px 4px;border-radius:6px;flex-shrink:0;", tag));
            }
            leftListEl.appendChild(row);
        }
    }

    function renderEditor() {
        if (!editorEl) return;
        editorEl.innerHTML = "";

        const item = draft.items.find(it => it.id === selectedId);
        if (!item) {
            editorEl.appendChild(h("div", "color:#666;text-align:center;padding:24px;", "Select an item to edit."));
            return;
        }

        // -- Name --
        editorEl.appendChild(h("div", STYLE.label, "Name"));
        const nameInput = h("input", STYLE.input);
        nameInput.type = "text";
        nameInput.value = item.name;
        nameInput.addEventListener("input", () => {
            item.name = nameInput.value;
            dirty = true;
            renderItemList();
        });
        editorEl.appendChild(nameInput);

        // -- Tags（タグトグルと同じ並び順で表示） --
        editorEl.appendChild(h("div", STYLE.label + "margin-top:8px;", "Tags"));
        const tagsRow = h("div", "display:flex;flex-wrap:wrap;gap:4px;align-items:center;");
        const { sortedTags } = computeContext();
        const sortedItemTags = sortItemTagsByContext(item.tags, sortedTags);
        for (const tag of sortedItemTags) {
            const badge = h("span", STYLE.tagActive);
            badge.appendChild(h("span", "", tag));
            const x = h("span", "color:#fcc;font-weight:bold;", "×");
            badge.appendChild(x);
            badge.addEventListener("click", () => {
                item.tags = item.tags.filter(t => t !== tag);
                dirty = true;
                renderEditor();
                renderItemList();
                renderTagFilterRow();
            });
            tagsRow.appendChild(badge);
        }
        if ((item.tags ?? []).length < MAX_TAGS) {
            const tagInput = h("input", STYLE.input + "width:100px;");
            tagInput.type = "text";
            tagInput.placeholder = "+ tag";
            tagInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    const t = normalizeTag(tagInput.value);
                    if (t && !item.tags.includes(t)) {
                        item.tags = [...(item.tags ?? []), t].slice(0, MAX_TAGS);
                        if (!draft.tag_definitions.includes(t)) {
                            draft.tag_definitions = [...draft.tag_definitions, t];
                        }
                        dirty = true;
                        tagInput.value = "";
                        renderEditor();
                        renderItemList();
                        renderTagFilterRow();
                    }
                }
            });
            tagsRow.appendChild(tagInput);
        }
        editorEl.appendChild(tagsRow);

        // -- Text （広い入力エリア）--
        editorEl.appendChild(h("div", STYLE.label + "margin-top:8px;", "Text"));
        const textArea = h("textarea", STYLE.input + "resize:vertical;flex:1;min-height:280px;font-family:monospace;font-size:12px;line-height:1.5;");
        textArea.value = item.text;
        textArea.addEventListener("input", () => {
            item.text = textArea.value;
            dirty = true;
        });
        editorEl.appendChild(textArea);
        // pyssss ComfyUI-Custom-Scripts が導入されていれば danbooru タグ補完を有効化。
        // 未導入時は黙って手動入力にフォールバックする
        attachAutoComplete(textArea);

        // -- LoRA / Wildcard 挿入ボタン（カーソル位置に構文を挿入） --
        // LoRA combo は define_schema 時点で folder_paths から確定するため遅延ロード不要。
        // Wildcard は Impact-Pack の API 経由で遅延取得され、ensureWildcardList の完了後に
        // renderEditor が再走することでボタンの enabled 状態が更新される。
        const insertRow = h("div", "display:flex;gap:6px;margin-top:6px;flex-shrink:0;");
        const loraCount = getComboOptions(node, LORA_COMBO_NAME, LORA_PLACEHOLDER).length;
        const wcCount   = getComboOptions(node, WILDCARD_COMBO_NAME, WILDCARD_PLACEHOLDER).length;

        const loraBtn = h("button", STYLE.btn, "+ LoRA");
        loraBtn.disabled = loraCount === 0;
        loraBtn.title = loraCount === 0 ? "No LoRA found" : "Insert <lora:name> at cursor";
        if (loraCount === 0) loraBtn.style.opacity = "0.5";
        loraBtn.addEventListener("click", () => showLoraPicker(node, textArea));
        insertRow.appendChild(loraBtn);

        const wcBtn = h("button", STYLE.btn, "+ Wildcard");
        wcBtn.disabled = wcCount === 0;
        wcBtn.title = wcCount === 0 ? "No wildcards found (Impact-Pack required)" : "Insert wildcard name at cursor";
        if (wcCount === 0) wcBtn.style.opacity = "0.5";
        wcBtn.addEventListener("click", () => showWildcardPicker(node, textArea));
        insertRow.appendChild(wcBtn);

        editorEl.appendChild(insertRow);

        // -- Action buttons --
        const refs = countRelationsReferencing({ ...original, catalog: draft }, item.id);
        const actionsRow = h("div", "display:flex;gap:6px;margin-top:8px;flex-shrink:0;");
        const dupBtn = h("button", STYLE.btn, "Duplicate");
        dupBtn.addEventListener("click", () => {
            if (draft.items.length >= MAX_ITEMS) return;
            const copy = {
                id: newId(),
                name: `${item.name} (copy)`,
                text: item.text,
                tags: [...(item.tags ?? [])],
            };
            draft.items = [...draft.items, copy];
            selectedId = copy.id;
            dirty = true;
            renderAll();
        });
        const delBtn = h("button", STYLE.btn + "color:#fcc;border-color:#622;", `Delete${refs > 0 ? ` (${refs} refs)` : ""}`);
        delBtn.addEventListener("click", () => {
            if (refs > 0) {
                const safeName = sanitizeForDialog(item.name, 80);
                if (!confirm(`"${safeName}" is referenced by ${refs} relation(s).\n\nDelete it? Affected relations will become unset.`)) {
                    return;
                }
            }
            draft.items = draft.items.filter(it => it.id !== item.id);
            // 削除後のフォールバックもリスト表示順の先頭にする（draft.items[0] ではない）
            selectedId = getVisibleItems()[0]?.id ?? null;
            dirty = true;
            renderAll();
        });
        actionsRow.appendChild(dupBtn);
        actionsRow.appendChild(delBtn);
        editorEl.appendChild(actionsRow);
    }

    function renderAll() {
        renderTagFilterRow();
        renderItemList();
        renderEditor();
    }

    // -- ダイアログ構築 --
    showDialog({
        title: "Manage Texts",
        width: 900,        // テキスト入力エリアを広く確保
        maxHeight: "85vh",
        className: "__sax_text_catalog_manager",
        build(dlg, close) {
            // Wildcard リストを Impact-Pack の API から遅延ロード（define_schema 取得失敗時の補完）。
            // 取得後にボタン無効化を再評価するため、完了時 renderEditor を再実行する。
            ensureWildcardList(node).then(() => {
                if (selectedId) renderEditor();
            });

            // 検索 + タグフィルタ行
            const filterContainer = h("div", "display:flex;flex-direction:column;gap:6px;flex-shrink:0;");
            const searchRow = h("div", "display:flex;gap:6px;align-items:center;");
            const searchInput = h("input", STYLE.input + "flex:1;");
            searchInput.type = "text";
            searchInput.placeholder = "Search by name or tag…";
            searchInput.addEventListener("input", () => {
                searchQuery = searchInput.value;
                renderAll();
            });
            searchRow.appendChild(searchInput);
            filterContainer.appendChild(searchRow);

            filterContainer.appendChild(h("div", STYLE.label, "Filter by tags"));
            // 1 行固定（折り返さず、はみ出すと横スクロールではなく [Show all] で展開）
            tagFilterRowEl = h("div",
                "display:flex;gap:4px;align-items:center;overflow:hidden;white-space:nowrap;height:22px;");
            filterContainer.appendChild(tagFilterRowEl);
            dlg.appendChild(filterContainer);

            // 2 ペイン（左：Item リスト、右：Editor）
            const cols = h("div", "display:flex;gap:10px;flex:1;min-height:440px;overflow:hidden;");

            // -- Left pane: Item list（幅を抑える） --
            const leftPane = h("div", STYLE.pane + "width:240px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;min-width:0;");
            const leftHeader = h("div", "display:flex;justify-content:space-between;align-items:center;flex-shrink:0;");
            leftTitleEl = h("div", "font-size:11px;color:#888;", `Items (${draft.items.length}/${MAX_ITEMS})`);
            const newBtn = h("button", STYLE.btn, "+ New");
            newBtn.addEventListener("click", () => {
                if (draft.items.length >= MAX_ITEMS) return;
                const item = {
                    id: newId(),
                    name: "untitled",
                    text: "",
                    tags: [],
                };
                draft.items = [...draft.items, item];
                selectedId = item.id;
                dirty = true;
                renderAll();
            });
            leftHeader.appendChild(leftTitleEl);
            leftHeader.appendChild(newBtn);
            leftPane.appendChild(leftHeader);

            leftListEl = h("div", "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px;");
            leftPane.appendChild(leftListEl);

            const manageTagsBtn = h("button", STYLE.btn, "Manage Tags…");
            manageTagsBtn.addEventListener("click", () => showTagManagerSubDialog());
            leftPane.appendChild(manageTagsBtn);

            cols.appendChild(leftPane);

            // -- Right pane: Editor（テキストエリアに広く割り当てる） --
            const rightPane = h("div", STYLE.pane + "flex:1;display:flex;flex-direction:column;gap:4px;overflow-y:auto;min-width:0;");
            editorEl = rightPane;
            cols.appendChild(rightPane);

            dlg.appendChild(cols);

            // -- Footer (Save / Close) --
            const foot = h("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:4px;flex-shrink:0;");
            const closeBtn = h("button", STYLE.btn + "padding:7px 16px;", "Close");
            const saveBtn  = h("button", STYLE.primaryBtn, "Save");
            closeBtn.addEventListener("click", () => {
                if (dirty) {
                    if (!confirm("You have unsaved changes. Discard and close?")) return;
                }
                close();
            });
            saveBtn.addEventListener("click", () => {
                // draft 内の各 Item は in-place 編集される設計のため、親 state に渡す前に
                // deep copy して両者を完全に切り離す
                const snapshot = {
                    items: draft.items.map(it => ({ ...it, tags: [...(it.tags ?? [])] })),
                    tag_definitions: [...draft.tag_definitions],
                    favorite_tags: [...(draft.favorite_tags ?? [])],
                };
                applyDraft(snapshot);
                dirty = false;
            });
            foot.appendChild(closeBtn);
            foot.appendChild(saveBtn);
            dlg.appendChild(foot);

            renderAll();
        },
    });

    // タグ定義の管理サブダイアログ（お気に入り + 並び替え + 削除）
    function showTagManagerSubDialog() {
        showDialog({
            title: "Manage Tags",
            width: 460,
            className: "__sax_text_catalog_tag_manager",
            build(dlg, close) {
                const favSection = h("div", "display:flex;flex-direction:column;gap:4px;");
                const allSection = h("div", "display:flex;flex-direction:column;gap:4px;max-height:36vh;overflow-y:auto;");

                const rerender = () => {
                    favSection.innerHTML = "";
                    allSection.innerHTML = "";
                    const usage = countTagUsage(draft.items);
                    const favs = [...(draft.favorite_tags ?? [])];
                    const favSet = new Set(favs);
                    const nonFavs = draft.tag_definitions.filter(t => !favSet.has(t)).sort((a, b) => {
                        const ua = usage.get(a) ?? 0;
                        const ub = usage.get(b) ?? 0;
                        if (ua !== ub) return ub - ua;
                        return a.localeCompare(b);
                    });

                    // -- Favorites セクション --
                    favSection.appendChild(h("div", STYLE.label, "Favorites (drag-free reorder)"));
                    if (favs.length === 0) {
                        favSection.appendChild(h("div", "color:#666;font-size:11px;padding:6px;",
                            "No favorite tags. Click ☆ in the list below to add."));
                    } else {
                        favs.forEach((tag, idx) => {
                            favSection.appendChild(makeTagRow(tag, idx, favs.length, true, usage.get(tag) ?? 0));
                        });
                    }

                    // -- All tags セクション --
                    allSection.appendChild(h("div", STYLE.label + "margin-top:8px;", "All tags"));
                    if (draft.tag_definitions.length === 0) {
                        allSection.appendChild(h("div", "color:#666;font-size:11px;padding:8px;text-align:center;",
                            "No tags defined. Add tags via the Item editor."));
                    } else if (nonFavs.length === 0) {
                        allSection.appendChild(h("div", "color:#666;font-size:11px;padding:6px;",
                            "(all tags are favorites)"));
                    } else {
                        for (const tag of nonFavs) {
                            allSection.appendChild(makeTagRow(tag, -1, 0, false, usage.get(tag) ?? 0));
                        }
                    }
                };

                /** タグ 1 行を生成（fav 行は ↑↓ 表示、all 行は無し）。 */
                const makeTagRow = (tag, favIdx, favLen, isFav, refs) => {
                    const row = h("div", "display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:3px;background:var(--comfy-input-bg,#222);");

                    // ★/☆ トグル
                    const star = h("button",
                        STYLE.btn + "padding:2px 6px;font-size:13px;flex-shrink:0;" +
                        (isFav ? "color:#f5c83c;border-color:#a07d10;" : "color:#888;"),
                        isFav ? "★" : "☆");
                    star.title = isFav ? "Remove from favorites" : "Add to favorites";
                    star.addEventListener("click", () => {
                        if (isFav) {
                            draft.favorite_tags = draft.favorite_tags.filter(t => t !== tag);
                        } else {
                            draft.favorite_tags = [...(draft.favorite_tags ?? []), tag];
                        }
                        dirty = true;
                        rerender();
                    });
                    row.appendChild(star);

                    // ↑↓（fav 行のみ）
                    if (isFav) {
                        const upBtn = h("button",
                            STYLE.btn + "padding:2px 6px;font-size:11px;flex-shrink:0;" +
                            (favIdx === 0 ? "opacity:0.3;pointer-events:none;" : ""),
                            "↑");
                        upBtn.addEventListener("click", () => {
                            if (favIdx === 0) return;
                            const arr = [...draft.favorite_tags];
                            [arr[favIdx - 1], arr[favIdx]] = [arr[favIdx], arr[favIdx - 1]];
                            draft.favorite_tags = arr;
                            dirty = true;
                            rerender();
                        });
                        const dnBtn = h("button",
                            STYLE.btn + "padding:2px 6px;font-size:11px;flex-shrink:0;" +
                            (favIdx === favLen - 1 ? "opacity:0.3;pointer-events:none;" : ""),
                            "↓");
                        dnBtn.addEventListener("click", () => {
                            if (favIdx === favLen - 1) return;
                            const arr = [...draft.favorite_tags];
                            [arr[favIdx + 1], arr[favIdx]] = [arr[favIdx], arr[favIdx + 1]];
                            draft.favorite_tags = arr;
                            dirty = true;
                            rerender();
                        });
                        row.appendChild(upBtn);
                        row.appendChild(dnBtn);
                    }

                    row.appendChild(h("span", "flex:1;font-size:12px;", tag));
                    row.appendChild(h("span", "font-size:10px;color:#888;flex-shrink:0;", `${refs} item(s)`));

                    const delBtn = h("button", STYLE.btn + "padding:3px 8px;font-size:11px;color:#fcc;flex-shrink:0;", "Remove");
                    delBtn.addEventListener("click", () => {
                        if (refs > 0) {
                            const safeTag = sanitizeForDialog(tag, 60);
                            if (!confirm(`Tag "${safeTag}" is used by ${refs} item(s).\n\nRemove it? Affected items will lose this tag.`)) {
                                return;
                            }
                            draft.items = draft.items.map(it => ({
                                ...it,
                                tags: (it.tags ?? []).filter(t => t !== tag),
                            }));
                        }
                        draft.tag_definitions = draft.tag_definitions.filter(t => t !== tag);
                        draft.favorite_tags = (draft.favorite_tags ?? []).filter(t => t !== tag);
                        activeTagFilter.delete(tag);
                        dirty = true;
                        renderAll();
                        rerender();
                    });
                    row.appendChild(delBtn);

                    return row;
                };

                dlg.appendChild(favSection);
                dlg.appendChild(allSection);

                const footRow = h("div", "display:flex;justify-content:flex-end;margin-top:8px;");
                const okBtn = h("button", STYLE.primaryBtn, "Close");
                okBtn.addEventListener("click", () => {
                    renderAll();  // 親 Manager の表示も最新化
                    close();
                });
                footRow.appendChild(okBtn);
                dlg.appendChild(footRow);

                rerender();
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Item ピッカー（Manager Dialog と同じ検索 + タグフィルタ UI を共有）
// ---------------------------------------------------------------------------

/**
 * Relation に紐づける Item を選択させる。
 * `onSelect(itemIdOrNull)` で選択結果を返す（null は「未割当に戻す」）。
 */
function pickItemForRelation(state, currentItemId, onSelect) {
    const items = state.catalog.items;
    if (items.length === 0) {
        // Item が空ならカタログ未整備。未割当だけ選択肢として返す
        onSelect(null);
        return;
    }

    const activeTagFilter = new Set();
    let searchQuery = "";
    // ピッカーは閲覧専用のため state は呼び出し時のスナップショット。favoriteTags も固定
    const favoriteTags = state.catalog.favorite_tags ?? [];

    showDialog({
        title: "Select Item for Relation",
        width: 560,
        maxHeight: "78vh",
        className: "__sax_text_catalog_item_picker",
        build(dlg, close) {
            // close を build スコープのクロージャ変数として保持し、
            // 各ヘルパーは引数で受け取らずクロージャ経由で参照する
            let listEl = null;
            let tagFilterRowEl = null;

            const getFiltered = () =>
                filterItemsByQueryAndTags(items, searchQuery, activeTagFilter);

            const computeCtx = () => {
                const filtered = getFiltered();
                return {
                    filtered,
                    sortedTags: sortTagsByContext(filtered, activeTagFilter, favoriteTags),
                    usage: countTagUsage(filtered),
                };
            };

            const renderTagRow = () => {
                if (!tagFilterRowEl) return;
                const ctxFn = () => {
                    const { sortedTags, usage } = computeCtx();
                    return { sortedTags, usage };
                };
                const favSetGetter = () => new Set(favoriteTags);
                renderTagFilter(tagFilterRowEl, ctxFn, activeTagFilter, favSetGetter, () => renderAll());
            };

            const makeUnsetRow = (isCurrent) => {
                const row = h("div", "padding:5px 6px;border-radius:3px;display:flex;align-items:center;gap:6px;" +
                    (isCurrent ? "background:var(--comfy-menu-secondary-bg,#303030);" : ""));
                row.appendChild(h("div", "flex:1;font-size:12px;color:#888;", UNSET_LABEL));
                const btn = h("button", STYLE.btn + "padding:2px 10px;font-size:11px;",
                    isCurrent ? "✓" : "Select");
                btn.addEventListener("click", () => { close(); onSelect(null); });
                row.appendChild(btn);
                return row;
            };

            const makeItemRow = (item, isCurrent, sortedTags) => {
                const row = h("div", "padding:5px 6px;border-radius:3px;display:flex;align-items:center;gap:6px;" +
                    (isCurrent ? "background:var(--comfy-menu-secondary-bg,#303030);" : ""));
                const nameEl = h("div", "flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
                    (isCurrent ? "color:#7d7;" : ""), item.name || "(unnamed)");
                row.appendChild(nameEl);
                const tagsForDisplay = sortItemTagsByContext(item.tags, sortedTags).slice(0, 4);
                for (const tag of tagsForDisplay) {
                    row.appendChild(h("span", "font-size:9px;color:#aab;background:#334;padding:1px 4px;border-radius:6px;flex-shrink:0;", tag));
                }
                const btn = h("button", STYLE.btn + "padding:2px 10px;font-size:11px;",
                    isCurrent ? "✓" : "Select");
                btn.addEventListener("click", () => { close(); onSelect(item.id); });
                row.appendChild(btn);
                return row;
            };

            const renderList = () => {
                if (!listEl) return;
                listEl.innerHTML = "";
                listEl.appendChild(makeUnsetRow(currentItemId == null));

                const { filtered, sortedTags } = computeCtx();
                if (filtered.length === 0) {
                    listEl.appendChild(h("div", "color:#666;font-size:11px;padding:12px;text-align:center;",
                        "No items match the filter."));
                    return;
                }
                const sorted = sortItemsByTagOrder(filtered, sortedTags);
                for (const it of sorted) {
                    listEl.appendChild(makeItemRow(it, it.id === currentItemId, sortedTags));
                }
            };

            const renderAll = () => {
                renderTagRow();
                renderList();
            };

            // 検索
            const searchInput = h("input", STYLE.input + "width:100%;");
            searchInput.type = "text";
            searchInput.placeholder = "Search by name or tag…";
            searchInput.addEventListener("input", () => {
                searchQuery = searchInput.value;
                renderAll();
            });
            dlg.appendChild(searchInput);

            // タグフィルタ
            dlg.appendChild(h("div", STYLE.label, "Filter by tags"));
            tagFilterRowEl = h("div",
                "display:flex;gap:4px;align-items:center;overflow:hidden;white-space:nowrap;height:22px;");
            dlg.appendChild(tagFilterRowEl);

            // リスト
            listEl = h("div", STYLE.pane + "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px;min-height:300px;");
            dlg.appendChild(listEl);

            // フッター
            const foot = h("div", "display:flex;justify-content:flex-end;margin-top:4px;");
            const cancelBtn = h("button", STYLE.btn + "padding:6px 14px;", "Cancel");
            cancelBtn.addEventListener("click", close);
            foot.appendChild(cancelBtn);
            dlg.appendChild(foot);

            renderAll();
            requestAnimationFrame(() => searchInput.focus());
        },
    });
}

// ---------------------------------------------------------------------------
// 出力スロット同期
// ---------------------------------------------------------------------------

function syncOutputSlots(node, state) {
    const relations = state.relations;
    while ((node.outputs?.length ?? 0) > relations.length) {
        node.removeOutput(node.outputs.length - 1);
    }
    while ((node.outputs?.length ?? 0) < relations.length) {
        node.addOutput("", "STRING");
    }

    for (let i = 0; i < relations.length; i++) {
        const status = relationStatus(state, relations[i]);
        const label  = resolveRelationLabel(state, relations[i]);
        node.outputs[i].name = label;
        node.outputs[i].type = "STRING";
        node.outputs[i]._textCatalogStatus = status;
    }

    const w = node.widgets?.find(w => w.name === "items_json");
    if (w) {
        w.value = serializeState(state);
    }

    node.size[1] = node.computeSize()[1];
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// Relation 行のカスタム描画（status に応じて警告色）
// ---------------------------------------------------------------------------

function drawRelationContent(ctx, state, relation, x, y, w, rowH, on = true) {
    const t = getComfyTheme();
    const midY = y + rowH / 2;

    const status = relationStatus(state, relation);
    const label  = resolveRelationLabel(state, relation);

    // 警告色
    let bgColor = null;
    let textColor = t.inputText ?? t.contentBg;
    if (status === "orphan") {
        bgColor = "rgba(180, 80, 0, 0.25)";
        textColor = "#ffb060";
    } else if (status === "unset") {
        textColor = "#888";
    }

    // orphan 警告背景はフル不透明のまま描画する（OFF 状態でも参照切れを目立たせるため）。
    // OFF 表現は文字側の globalAlpha のみで担当し、背景と役割を分離する。
    if (bgColor) {
        ctx.save();
        ctx.fillStyle = bgColor;
        ctx.fillRect(x, y, w, rowH);
        ctx.restore();
    }

    const prefix = status === "orphan" ? "⚠ " : status === "unset" ? "" : "";
    // OFF 状態は文字を半透明にして無効化を視覚的に伝える（既存トグル付きノードと同じ手法）。
    ctx.save();
    if (!on) ctx.globalAlpha = 0.4;
    txt(ctx, prefix + label, x + 4, midY, textColor, "left", 11);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// メインウィジェット
// ---------------------------------------------------------------------------

function makeCatalogWidget(node) {
    const getState = () => node._textCatalogState ?? emptyState();

    const saveStateAndSync = (newState) => {
        node._textCatalogState = newState;
        restoreOutputLinks(node, newState.relations, () => syncOutputSlots(node, newState));
    };

    const openManager = () => {
        showManagerDialog(node, getState, (draftCatalog) => {
            const state = getState();
            // Save 直前に Canvas 上の最新リンク状態を state.relations[i]._links に取り込む。
            // restoreOutputLinks は items[i]._links を再接続のソースとするため、
            // ここで capture しないと「前回キャプチャ時点」の古い接続情報で上書き復元されてしまう
            captureOutputLinks(node, state.relations);

            // 削除された Item を参照する Relation の item_id を null に遷移させる
            // （仕様: Item 削除時に該当 Relation は未割当状態に自動遷移）
            const validIds = new Set(draftCatalog.items.map(it => it.id));
            const newRelations = state.relations.map(rel => {
                // `on` は parseState で必ず補完されるが、外部経路から `on` 欠損の
                // Relation が混入した場合のランタイム誤描画（OFF 扱い）を防ぐため、
                // ここでも明示的に既定値を保証する。
                const base = { ...rel, on: rel.on ?? true };
                const updated = rel.item_id && !validIds.has(rel.item_id)
                    ? { ...base, item_id: null }
                    : base;
                // _links は restoreOutputLinks のキーなので、新オブジェクトにも引き継ぐ
                updated._links = rel._links;
                return updated;
            });
            const newState = {
                catalog: draftCatalog,
                relations: newRelations,
            };
            saveStateAndSync(newState);
        });
    };
    node._openTextCatalogManager = openManager;

    return makeItemListWidget({
        widgetName: "__sax_text_catalog_widget",
        maxItems: MAX_RELATIONS,
        getItems: () => getState().relations,
        saveItems: (newRelations) => {
            const state = getState();
            const newState = { ...state, relations: newRelations };
            saveStateAndSync(newState);
        },
        beforeModify: (relations) => captureOutputLinks(node, relations),

        // `hasToggle: true` により行頭 pill が描画され、クリックで `relation.on` がトグルされる。
        // makeItemListWidget が saveItems を呼ぶため、syncOutputSlots / serializeState が連鎖実行される。
        hasToggle: true,

        params: [
            {
                key: "edit",
                w: 24,
                get: () => "",
                format: () => "✎",
                onPopup: (relation, _idx, _node) => {
                    const state = getState();
                    pickItemForRelation(state, relation.item_id, (selectedId) => {
                        // 最新の Canvas 接続を _links に取り込む
                        captureOutputLinks(node, state.relations);
                        // 編集対象 relation を新しい配列で置換（イミュータブル）
                        // 編集対象以外は元参照のため _links がそのまま引き継がれる。
                        // 編集対象も _links を引き継ぐ（item_id だけ変更）
                        const newRelations = state.relations.map(r => {
                            if (r !== relation) return r;
                            // `on` 欠損混入時の誤描画を防ぐため明示的に既定値を保証する。
                            const updated = { ...r, item_id: selectedId, on: r.on ?? true };
                            updated._links = r._links;
                            return updated;
                        });
                        saveStateAndSync({ ...state, relations: newRelations });
                    });
                },
            },
        ],

        content: {
            draw(ctx, relation, x, y, w, rowH, on) {
                drawRelationContent(ctx, getState(), relation, x, y, w, rowH, on);
            },
        },

        hasMoveUpDown: true,
        hasDelete:     true,

        addButton: {
            // フレームワークから渡される items / saveItems は使用しない。
            // captureOutputLinks → saveStateAndSync の順序保証と
            // restoreOutputLinks 経由のリンク復元を、本ノード側で完結させるため。
            label: "+ Add Relation",
            onAdd: (_n, _items, _save) => {
                const state = getState();
                if (state.relations.length >= MAX_RELATIONS) return;
                // 既存 relations の最新 Canvas 接続を保存（追加スロットには影響しない）
                captureOutputLinks(node, state.relations);
                const newRelations = [...state.relations, { item_id: null, on: true }];
                saveStateAndSync({ ...state, relations: newRelations });
            },
        },
    });
}

// ---------------------------------------------------------------------------
// 拡張登録
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const addManagerButton = (node) => {
            // serialize しない LiteGraph 標準ボタンウィジェット
            const btn = node.addWidget("button", "📖 Manage Texts...", null, () => {
                node._openTextCatalogManager?.();
            });
            btn.serialize = false;
        };

        // LoRA / Wildcard combo は JS 側ピッカーが options.values を引くために必要だが、
        // ノード本体には表示しないため hideWidget で描画から除外する。
        const hideHiddenWidgets = (node) => {
            for (const name of ["items_json", LORA_COMBO_NAME, WILDCARD_COMBO_NAME]) {
                const w = node.widgets?.find(w => w.name === name);
                if (w) hideWidget(w);
            }
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._textCatalogState = emptyState();

            hideHiddenWidgets(this);

            // 静的に定義された 32 個の出力スロットをいったん全削除し、
            // Relation 配列に応じて動的に再構築する
            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--) {
                this.removeOutput(i);
            }

            addManagerButton(this);
            this.addCustomWidget(makeCatalogWidget(this));
            this.size[0] = Math.max(this.size[0] ?? 0, 280);
            this.size[1] = 1;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);

            hideHiddenWidgets(this);
            const hw = this.widgets?.find(w => w.name === "items_json");

            const raw = hw?.value ?? "{}";
            const state = parseState(raw);
            this._textCatalogState = state;

            // ウィジェット再生成（クロージャの stale 回避）
            // 同名 widget が万が一複数残った場合に備え filter で全件除去する
            if (this.widgets) {
                this.widgets = this.widgets.filter(w => {
                    if (w.name === "__sax_text_catalog_widget") return false;
                    if (w.type === "button" && typeof w.name === "string" && w.name.startsWith("📖")) return false;
                    return true;
                });
            }
            addManagerButton(this);
            this.addCustomWidget(makeCatalogWidget(this));
            this.size[0] = Math.max(this.size[0] ?? 0, 280);

            // 出力スロット同期は同期フェーズで実行（Node Collector 等の競合回避）
            syncOutputSlots(this, state);

            // LiteGraph のリンク復元完了後に _links を記録
            setTimeout(() => {
                captureOutputLinks(this, state.relations);
            }, 0);
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);
            options.unshift({
                content: "📖 Manage Texts...",
                callback: () => this._openTextCatalogManager?.(),
            });
        };
    },
});
