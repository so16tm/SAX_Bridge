import { app } from "../../scripts/app.js";
import {
    h, txt, getComfyTheme,
    makeItemListWidget,
    showDialog,
    showFilePicker,
    fileBasenameWithoutExt,
    hideWidget as _hideWidgetCommon,
    clearAllSlots,
    loadWildcardList,
    showConfirmDialog,
    autoResize,
} from "./sax_ui_base.js";
import { ensureCoordinator } from "./sax_dynamic_slot_coordinator.js";

const EXT_NAME      = "SAX.TextCatalog";
const NODE_TYPE     = "SAX_Bridge_Text_Catalog";
const SCHEMA_VERSION = 1;
const MAX_RELATIONS = 32;
const MAX_ITEMS     = 256;
const MAX_TAGS      = 8;

// -- Manager Dialog のアイテムリスト仮想化パラメータ --
// 行は絶対配置し、スクロール量から可視インデックスを算出する。そのため
// 行の高さは CSS 側で固定し、ここの数値と一致させる必要がある。
/** アイテム行の高さ (px)。row の height と一致させること。 */
const ITEM_ROW_HEIGHT = 26;
/** アイテム行どうしの間隔 (px)。 */
const ITEM_ROW_GAP    = 2;
/** 1 行あたりの占有高 (px)。i 番目の行の top = i * ITEM_ROW_STRIDE。 */
const ITEM_ROW_STRIDE = ITEM_ROW_HEIGHT + ITEM_ROW_GAP;
/** 可視範囲の上下に余分に描画しておく行数（高速スクロール時の白抜け防止）。 */
const ITEM_ROW_OVERSCAN = 6;
/**
 * リストの可視高が測れないとき (clientHeight が 0／未定義。DOM 未アタッチ時や
 * テスト用 DOM スタブ) のフォールバック。左ペインの min-height 相当。
 */
const ITEM_LIST_FALLBACK_VIEWPORT = 440;

const UNSET_LABEL  = "(unset)";
const ORPHAN_LABEL = "<orphan>";

/** 個別出力 / マージ出力を切り替える Boolean widget 名 (Python schema と一致) */
const MERGE_WIDGET_NAME = "merge_outputs";

/** マージ出力モードか判定する。 */
function isMerged(node) {
    return Boolean(node.widgets?.find(w => w.name === MERGE_WIDGET_NAME)?.value);
}

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

/** 隠しウィジェットを描画から除外する（Primitive Store と同パターン、type は変更しない） */
function hideWidget(widget) {
    _hideWidgetCommon(widget, { mode: "minimal" });
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
const loraDisplayName = fileBasenameWithoutExt;

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
    // sax_ui_base.js の loadWildcardList を利用 (モジュールスコープでキャッシュ済み)。
    // 失敗時は空配列が返るので例外は発生しない。ノードフラグはネットワーク取得が
    // 成功 (空応答含む) した場合にのみ立てるため、ここでは list.length > 0 のみで判定する。
    const list = await loadWildcardList({
        maxNameLength: WILDCARD_NAME_MAX_LENGTH,
        maxItems:      WILDCARD_LIST_MAX_ITEMS,
    });
    if (list.length > 0) {
        combo.options.values = [WILDCARD_PLACEHOLDER, ...list];
        node._textCatalogWildcardLoaded = true;
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

/**
 * catalog オブジェクト → その JSON 断片のキャッシュ。
 *
 * items 索引 (`_itemIndexCache`) と同じ不変条件に乗る: catalog は内容が変わるとき必ず
 * 新しいオブジェクトに差し替わる (parseState / Manager Save の snapshot) ため、
 * オブジェクト identity をキーにすれば stale なキャッシュは発生しない。
 */
const _catalogJsonCache = new WeakMap();

/** catalog 部分の JSON 断片を返す（catalog オブジェクトごとに初回のみ生成）。 */
function serializeCatalog(catalog) {
    const cached = _catalogJsonCache.get(catalog);
    if (cached !== undefined) return cached;
    const json = JSON.stringify({
        items: catalog.items.map(({ id, name, text, tags }) => ({
            id, name, text, tags: [...(tags ?? [])],
        })),
        tag_definitions: [...catalog.tag_definitions],
        favorite_tags: [...(catalog.favorite_tags ?? [])],
    });
    _catalogJsonCache.set(catalog, json);
    return json;
}

/**
 * state → items_json (string)。内部プロパティ（_links 等）は明示的に除外する。
 *
 * relation の追加・削除・並べ替え・トグルは `syncOutputSlots` 経由で毎回ここを通るが、
 * catalog (最大 MAX_ITEMS=256 件) は relation 操作では変化しない。catalog 断片を
 * キャッシュし、毎回作り直すのは relations 部分だけにする。
 * 出力は従来実装とバイト単位で同一 (キー順・正規化規則とも不変)。
 */
function serializeState(state) {
    // `on` の正規化は parseState と対称に書く（欠損 → true、それ以外は Boolean()）
    const relationsJson = JSON.stringify(state.relations.map(({ item_id, on }) => ({
        item_id,
        on: on !== undefined ? Boolean(on) : true,
    })));
    return `{"version":${JSON.stringify(SCHEMA_VERSION)}`
        + `,"catalog":${serializeCatalog(state.catalog)}`
        + `,"relations":${relationsJson}}`;
}

/**
 * `catalog.items` 配列 → `id → item` の索引キャッシュ。
 *
 * 配列そのものを WeakMap のキーにする。items 配列は内容が変わるとき必ず
 * 新しい配列に差し替わる (parseState / Manager Save の deep copy) ため、
 * 「同じ配列 identity なら中身も同じ」が成立し stale 索引は発生しない。
 * 配列が GC されれば索引も一緒に消える。
 */
const _itemIndexCache = new WeakMap();

/** `catalog.items` の id 索引を取得する（配列ごとに初回のみ構築）。 */
function itemIndexOf(items) {
    if (!Array.isArray(items)) return null;
    let index = _itemIndexCache.get(items);
    if (index) return index;
    index = new Map();
    for (const it of items) {
        if (it?.id != null) index.set(it.id, it);
    }
    _itemIndexCache.set(items, index);
    return index;
}

/**
 * Catalog 内で id から Item を引く。
 *
 * MAX_ITEMS を 32 → 256 に引き上げたことで、線形検索のままでは
 * relation ごとに呼ぶ `syncOutputSlots` と毎フレーム走る `drawRelationContent` が
 * O(relations × items) になる。id 索引で O(1) にする。
 */
function findItemById(state, itemId) {
    if (!itemId) return null;
    return itemIndexOf(state.catalog?.items)?.get(itemId) ?? null;
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
 * タグ順序配列を `tag → index` の Map に変換する。
 * items ループの外で 1 回だけ作り、`sortItemTagsByContext` に使い回す。
 *
 * @param {string[]} sortedTags
 * @returns {Map<string, number>}
 */
function tagOrderMap(sortedTags) {
    return new Map((sortedTags ?? []).map((t, i) => [t, i]));
}

/**
 * Item のタグ配列を sortedTags の順序に並び替える。
 * sortedTags に含まれないタグ（コンテキスト外タグ）は末尾にアルファベット順で付加する。
 * Editor / リスト内のタグ表示でタグトグルと並びを揃えるために使う。
 *
 * items を列挙するループから呼ぶ場合は `tagOrderMap(sortedTags)` で作った Map を渡すこと。
 * 配列を渡すと呼び出しごとに Map を組み直すため、items 件数 × タグ語彙数のコストになる
 * (MAX_ITEMS=256 では無視できない)。
 *
 * @param {string[]} itemTags    - Item の tags 配列
 * @param {string[] | Map<string, number>} sortedTags
 *        sortTagsByContext で得たタグ全体順序、または `tagOrderMap` で Map 化したもの
 * @returns {string[]} 並び替え後の新配列（元配列は変更しない）
 */
function sortItemTagsByContext(itemTags, sortedTags) {
    if (!Array.isArray(itemTags) || itemTags.length === 0) return [];
    const order = sortedTags instanceof Map ? sortedTags : tagOrderMap(sortedTags);
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

/** Item を参照している Relation 数を返す（単発呼び出し用） */
function countRelationsReferencing(state, itemId) {
    return state.relations.filter(r => r.item_id === itemId).length;
}

/**
 * 全 Item の被参照数を 1 パスで集計する。
 *
 * items を列挙しながら `countRelationsReferencing` を呼ぶと O(items × relations) に
 * なるうえ、呼び出しごとの state スプレッドで毎回オブジェクトを作ってしまう。
 * リスト描画ではこちらを 1 回だけ呼ぶ。
 *
 * @param {object[]} relations
 * @returns {Map<string, number>} item_id → 参照している relation 数
 */
function countRelationsByItem(relations) {
    const counts = new Map();
    for (const rel of relations ?? []) {
        const id = rel?.item_id;
        if (!id) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
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

    /** 選択中のアイテム行の背景色。初回描画と選択変更 fast path で共有する。 */
    const ROW_SELECTED_BG = "var(--comfy-menu-secondary-bg,#303030)";

    // -- レンダリング再構築用ハンドル --
    /** アイテムリストのスクロールコンテナ。 */
    let leftListEl = null;
    /** leftListEl の内側で全行分の高さを確保する絶対配置の土台。 */
    let listCanvasEl = null;
    /** 該当 0 件のときだけ leftListEl に差し込むメッセージ行。 */
    let emptyRowEl = null;
    /**
     * item_id → 現在マウント済みのリスト行 DOM。選択変更 fast path のハイライト
     * 付け替えと、再描画時のキー付き再利用の両方がこのマップを参照する。
     */
    let rowElsById = new Map();
    /** アンマウントした行 DOM の再利用プール（行の生成そのものを避ける）。 */
    const rowPool = [];
    /** 直近の renderItemList が確定させた表示順。スクロール時の窓計算に使う。 */
    let visibleItems = [];
    /** visibleItems と同時に確定する、タグ表示順の索引。 */
    let rowTagOrder = new Map();
    /** 現在マウントしている行の範囲 [start, end)。窓が動いたときだけ差分更新する。 */
    let mountedStart = 0;
    let mountedEnd   = 0;
    /** 最後にスクロール位置を合わせた選択 id。選択が外から変わった時だけ追従する。 */
    let scrolledSelectionId = null;
    /** リストの可視高の変化（初回レイアウト・ウィンドウリサイズ）を拾う observer。 */
    let listResizeObserver = null;
    let editorEl   = null;
    let tagFilterRowEl = null;
    let leftTitleEl = null;

    /**
     * relation の参照数は original.relations から決まり、ダイアログを開いている間は
     * 変化しない。renderItemList / スクロールのたびに数え直さないよう 1 回だけ作る。
     */
    const relationRefCounts = countRelationsByItem(original.relations);

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

    // -----------------------------------------------------------------
    // アイテムリストの描画（行の再利用 + 仮想化）
    //
    // 以前は renderItemList が毎回 leftListEl を空にして全行を作り直していた。
    // MAX_ITEMS=256 では 256 行 × 約 5 要素 ≈ 1300 ノードの再生成になり、
    // ダイアログのオープンと検索 1 打鍵がそのままこのコストを負っていた。
    // 対策は 2 段構え:
    //   1. 仮想化  — 可視範囲 + overscan の行だけを DOM に載せる
    //   2. 行再利用 — 行 DOM を item_id でキャッシュし、変化した部分だけ書き換える
    // これでリスト長に比例する DOM 生成が消え、コストは可視行数に比例する。
    // -----------------------------------------------------------------

    const REF_BADGE_CSS = "font-size:9px;color:#7a9;background:#234;padding:1px 5px;border-radius:8px;flex-shrink:0;";
    const TAG_BADGE_CSS = "font-size:9px;color:#aab;background:#334;padding:1px 4px;border-radius:6px;flex-shrink:0;";

    /** 空の行 DOM を 1 つ作る。中身は updateRow が後から流し込む。 */
    function createRow() {
        const row = h("div",
            `position:absolute;left:0;right:0;height:${ITEM_ROW_HEIGHT}px;box-sizing:border-box;`
            + "padding:0 6px;border-radius:3px;cursor:pointer;display:flex;align-items:center;gap:6px;");
        // 行は使い回されるので、リスナは生成時の item ではなく row._itemId を見る。
        row._itemId = null;
        row._sig    = null;
        row._badges = [];
        row._nameEl = h("div", "flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
        row.appendChild(row._nameEl);

        row.addEventListener("click", () => {
            // 選択が変わるだけならリストの中身 (並び順・参照数・タグ) は不変。
            // ハイライトの付け替えと Editor 再描画だけで済ませる。
            if (row._itemId === null || row._itemId === selectedId) return;
            const prevRow = rowElsById.get(selectedId);
            if (prevRow) prevRow.style.background = "";
            selectedId = row._itemId;
            // 可視行のクリックなので、次の再描画でスクロールを動かす必要はない。
            scrolledSelectionId = selectedId;
            row.style.background = ROW_SELECTED_BG;
            renderEditor();
        });
        row.addEventListener("mouseenter", () => {
            if (row._itemId !== selectedId) row.style.background = "var(--comfy-menu-secondary-bg,#2a2a2a)";
        });
        row.addEventListener("mouseleave", () => {
            if (row._itemId !== selectedId) row.style.background = "";
        });
        return row;
    }

    /** row の badge スロット i を指定の見た目に合わせる（無ければ生成して追加）。 */
    function setBadge(row, i, css, text) {
        let badge = row._badges[i];
        if (!badge) {
            badge = h("span", css, text);
            badge._css = css;
            row._badges[i] = badge;
            row.appendChild(badge);
            return;
        }
        if (badge._css !== css) {
            badge.style.cssText = css;
            badge._css = css;
        }
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.style.display === "none") badge.style.display = "";
    }

    /** used 個目以降の badge スロットを隠す（DOM からは外さず再利用に残す）。 */
    function hideBadgesFrom(row, used) {
        for (let i = used; i < row._badges.length; i++) row._badges[i].style.display = "none";
    }

    /** 行 DOM を index 番目の item の内容・位置に合わせる。 */
    function updateRow(row, item, index) {
        row.style.top = `${index * ITEM_ROW_STRIDE}px`;

        const refs = relationRefCounts.get(item.id) ?? 0;
        const tags = sortItemTagsByContext(item.tags, rowTagOrder).slice(0, 3);
        // 名前・参照数・表示タグが全部同じなら子要素の書き換えは丸ごと不要。
        const sig  = `${item.name ?? ""}\u0000${refs}\u0000${tags.join("\u0001")}`;
        if (row._itemId !== item.id || row._sig !== sig) {
            row._itemId = item.id;
            row._sig    = sig;
            row._nameEl.textContent = item.name || "(unnamed)";
            let used = 0;
            if (refs > 0) setBadge(row, used++, REF_BADGE_CSS, `×${refs}`);
            for (const tag of tags) setBadge(row, used++, TAG_BADGE_CSS, tag);
            hideBadgesFrom(row, used);
        }
        row.style.background = item.id === selectedId ? ROW_SELECTED_BG : "";
    }

    /** 現在のスクロール位置から、描画すべき行のインデックス範囲 [start, end) を求める。 */
    function computeRowWindow() {
        const total = visibleItems.length;
        if (total === 0) return { start: 0, end: 0 };
        // DOM 未アタッチ時 / テスト用スタブでは clientHeight が取れないので既定値に落とす。
        const viewport  = leftListEl.clientHeight || ITEM_LIST_FALLBACK_VIEWPORT;
        const scrollTop = leftListEl.scrollTop || 0;
        const first = Math.floor(scrollTop / ITEM_ROW_STRIDE) - ITEM_ROW_OVERSCAN;
        const last  = Math.ceil((scrollTop + viewport) / ITEM_ROW_STRIDE) + ITEM_ROW_OVERSCAN;
        return {
            start: Math.min(Math.max(0, first), total),
            end:   Math.min(total, Math.max(0, last)),
        };
    }

    /** マウント済みの行をすべて外してプールへ戻す。 */
    function unmountAllRows() {
        for (const row of rowElsById.values()) {
            listCanvasEl.removeChild(row);
            rowPool.push(row);
        }
        rowElsById.clear();
        mountedStart = 0;
        mountedEnd   = 0;
    }

    /**
     * 可視範囲の行だけを DOM に載せ替える。
     *
     * @param {boolean} contentChanged リスト内容（並び順・件数・表示文字列）が変わったか。
     *   false（純粋なスクロール）で窓が動いていなければ何もしない。
     */
    function renderRowWindow(contentChanged) {
        const { start, end } = computeRowWindow();
        if (!contentChanged && start === mountedStart && end === mountedEnd) return;

        // 新しい窓に入る item_id。ここに無い行は外してプールへ戻す。
        const keep = new Set();
        for (let i = start; i < end; i++) keep.add(visibleItems[i].id);
        for (const [id, row] of rowElsById) {
            if (keep.has(id)) continue;
            listCanvasEl.removeChild(row);
            rowElsById.delete(id);
            rowPool.push(row);
        }
        for (let i = start; i < end; i++) {
            const item = visibleItems[i];
            let row = rowElsById.get(item.id);
            if (!row) {
                row = rowPool.pop() ?? createRow();
                rowElsById.set(item.id, row);
                listCanvasEl.appendChild(row);
            }
            updateRow(row, item, i);
        }
        mountedStart = start;
        mountedEnd   = end;
    }

    /**
     * 行クリック以外（+ New / Duplicate / Delete など）で選択が動いたとき、
     * 選択行が可視範囲に入るようスクロールする。仮想化により選択行が DOM 上に
     * 存在しないことがあるため、ブラウザ任せにはできない。
     */
    function ensureSelectionVisible() {
        if (selectedId === scrolledSelectionId) return;
        scrolledSelectionId = selectedId;
        const index = visibleItems.findIndex(it => it.id === selectedId);
        if (index < 0) return;
        const viewport  = leftListEl.clientHeight || ITEM_LIST_FALLBACK_VIEWPORT;
        const scrollTop = leftListEl.scrollTop || 0;
        const top    = index * ITEM_ROW_STRIDE;
        const bottom = top + ITEM_ROW_HEIGHT;
        if (top < scrollTop) leftListEl.scrollTop = top;
        else if (bottom > scrollTop + viewport) leftListEl.scrollTop = bottom - viewport;
    }

    /** 該当 0 件メッセージの表示 / 非表示。 */
    function setEmptyMessage(text) {
        if (text === null) {
            if (emptyRowEl) emptyRowEl.style.display = "none";
            return;
        }
        if (!emptyRowEl) {
            emptyRowEl = h("div", "color:#666;font-size:11px;padding:8px;text-align:center;");
            leftListEl.appendChild(emptyRowEl);
        }
        if (emptyRowEl.textContent !== text) emptyRowEl.textContent = text;
        emptyRowEl.style.display = "";
    }

    function renderItemList() {
        if (!leftListEl) return;
        if (leftTitleEl) {
            leftTitleEl.textContent = `Items (${draft.items.length}/${MAX_ITEMS})`;
        }

        const { filtered, sortedTags } = computeContext();
        rowTagOrder  = tagOrderMap(sortedTags);
        visibleItems = filtered.length === 0 ? [] : sortItemsByTagOrder(filtered, sortedTags);

        if (visibleItems.length === 0) {
            unmountAllRows();
            listCanvasEl.style.height = "0px";
            setEmptyMessage(draft.items.length === 0
                ? "No items. Click [+ New] to create one."
                : "No items match the filter.");
            return;
        }
        setEmptyMessage(null);
        // 全行分の高さを土台に持たせ、スクロールバーの長さを実件数どおりにする。
        listCanvasEl.style.height = `${visibleItems.length * ITEM_ROW_STRIDE}px`;
        ensureSelectionVisible();
        renderRowWindow(true);
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
        delBtn.addEventListener("click", async () => {
            if (refs > 0) {
                const safeName = sanitizeForDialog(item.name, 80);
                const ok = await showConfirmDialog({
                    title:   "Delete item",
                    message: `"${safeName}" is referenced by ${refs} relation(s).\n\nDelete it? Affected relations will become unset.`,
                    danger:  true,
                    okLabel: "Delete",
                });
                if (!ok) return;
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
        onClose() {
            listResizeObserver?.disconnect();
            listResizeObserver = null;
        },
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

            // 仮想化のため、スクロールコンテナ (leftListEl) と全行分の高さを確保する
            // 土台 (listCanvasEl) を分ける。行は listCanvasEl に絶対配置され、
            // 行間は ITEM_ROW_STRIDE で表現するので flex の gap は使わない。
            leftListEl   = h("div", "flex:1;overflow-y:auto;position:relative;");
            listCanvasEl = h("div", "position:relative;width:100%;");
            leftListEl.appendChild(listCanvasEl);
            leftListEl.addEventListener("scroll", () => renderRowWindow(false));
            // showDialog は build() の後に overlay を document へ追加するため、初回の
            // renderItemList 時点では clientHeight が 0 で可視高が測れない。レイアウト確定後
            // (とウィンドウリサイズ後) に窓を測り直す。
            if (typeof ResizeObserver !== "undefined") {
                listResizeObserver = new ResizeObserver(() => renderRowWindow(false));
                listResizeObserver.observe(leftListEl);
            }
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
            closeBtn.addEventListener("click", async () => {
                if (dirty) {
                    const ok = await showConfirmDialog({
                        title:   "Discard changes?",
                        message: "You have unsaved changes. Discard and close?",
                        danger:  true,
                        okLabel: "Discard",
                    });
                    if (!ok) return;
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
                    delBtn.addEventListener("click", async () => {
                        if (refs > 0) {
                            const safeTag = sanitizeForDialog(tag, 60);
                            const ok = await showConfirmDialog({
                                title:   "Remove tag",
                                message: `Tag "${safeTag}" is used by ${refs} item(s).\n\nRemove it? Affected items will lose this tag.`,
                                danger:  true,
                                okLabel: "Remove",
                            });
                            if (!ok) return;
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

            // `sortedTags` は配列でも Map でも受け付ける。items ループから呼ぶ側は
            // tagOrderMap で Map 化したものを渡し、行ごとの Map 再構築を避ける。
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
                const tagOrder = tagOrderMap(sortedTags);
                for (const it of sorted) {
                    listEl.appendChild(makeItemRow(it, it.id === currentItemId, tagOrder));
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
    if (isMerged(node)) {
        // merged は常に単一 STRING ピン。1 本状態での再同期では add/remove しないため、
        // relation の値変更だけでは下流リンクを切断しない。
        while ((node.outputs?.length ?? 0) > 1) {
            node.removeOutput(node.outputs.length - 1);
        }
        if ((node.outputs?.length ?? 0) === 0) {
            node.addOutput("merged", "STRING");
        }
        node.outputs[0].name = "merged";
        node.outputs[0].type = "STRING";
        delete node.outputs[0]._textCatalogStatus;
    } else {
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
    }

    const w = node.widgets?.find(w => w.name === "items_json");
    if (w) {
        w.value = serializeState(state);
    }

    node.size[1] = node.computeSize()[1];
    app.canvas?.setDirty(true, true);
}

/**
 * merge_outputs 切替時は出力の意味自体が変わるため、既存リンクを明示切断して
 * individual / merged のスロット構造を作り直す。
 *
 * @param {object} node
 * @param {boolean} previousMerged callback 発火前に記録していた状態
 */
function onMergeToggle(node, previousMerged) {
    const mergeWidget = node.widgets?.find(w => w.name === MERGE_WIDGET_NAME);
    const nextMerged = Boolean(mergeWidget?.value);
    if (nextMerged === Boolean(previousMerged)) return;

    const state = node._textCatalogState ?? emptyState();
    try {
        clearAllSlots(node, { inputs: false });
        syncOutputSlots(node, state);
        if (!nextMerged) {
            const coordinator = ensureCoordinator(node, buildTextCatalogSpec);
            setTimeout(() => coordinator.captureFromExisting(), 0);
        }
        autoResize(node);
    } catch (e) {
        // widget とスロット構造を切替前へ戻す。リンクはモード切替時に意図的に切断済み。
        if (mergeWidget) mergeWidget.value = Boolean(previousMerged);
        try {
            clearAllSlots(node, { inputs: false });
            syncOutputSlots(node, state);
            autoResize(node);
        } catch (rollbackError) {
            console.error("[TextCatalog] merge_outputs rollback failed:", rollbackError);
        }
        throw e;
    }
}

/** merge_outputs widget の callback に切替処理を一度だけチェーンする。 */
function chainMergeToggle(node) {
    const w = node.widgets?.find(w => w.name === MERGE_WIDGET_NAME);
    if (!w) return;

    // onConfigure が同じ instance に再度走った場合は、復元された現在値を基準値へ同期する。
    if (w._saxMergeChained) {
        w._saxMergeLastValue = Boolean(w.value);
        return;
    }

    const orig = w.callback;
    w._saxMergeLastValue = Boolean(w.value);
    w.callback = function () {
        const previousMerged = Boolean(w._saxMergeLastValue);
        try {
            orig?.apply(this, arguments);
            onMergeToggle(node, previousMerged);
        } finally {
            w._saxMergeLastValue = Boolean(w.value);
        }
    };
    w._saxMergeChained = true;
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

/**
 * TextCatalog 用 DynamicSlotCoordinator spec factory。
 * relation 1 件 → output slot 1 件 (1:1) の output direction Coordinator。
 */
function buildTextCatalogSpec(node) {
    return {
        direction: "output",
        // link-preserving 再構築の明示 opt-in。relation 1 件 → 出力ピン 1 件 (1:1) かつ
        // 出力ピンが Coordinator 管理対象 (syncOutputSlots が add/remove する) のため、
        // 下流端を切らずに上流ピンだけ付け替える経路を有効化する。
        // Image/Pipe Collector は固定出力でこのフラグを持たないため従来 reconnect 経路に入る。
        linkPreserving: true,
        getEntities: () => (node._textCatalogState ?? emptyState()).relations,
        // placeholder のみ。実 name/type は syncSlotStructure (syncOutputSlots) が書き込む。_hints は TextCatalog では不使用。
        entityToSlots: (_entity, _hints) => [{ name: "", type: "STRING" }],
        syncSlotStructure: () => syncOutputSlots(node, node._textCatalogState ?? emptyState()),
        setEntities: (newRelations) => {
            const prev = node._textCatalogState ?? emptyState();
            node._textCatalogState = { ...prev, relations: newRelations };
        },
    };
}

function makeCatalogWidget(node) {
    const getState = () => node._textCatalogState ?? emptyState();
    const coordinator = ensureCoordinator(node, buildTextCatalogSpec);

    const openManager = () => {
        showManagerDialog(node, getState, (draftCatalog) => {
            const state = getState();
            const validIds = new Set(draftCatalog.items.map(it => it.id));

            // Manager Save は items/tags のみ編集し relations 件数は不変 (slot 数不変)。
            // 孤立 relation (削除済み item を参照) の item_id を in-place で null 化して
            // entity identity を維持する。新オブジェクト化すると Coordinator の snapshot 解決が
            // 壊れ、(unset)/<orphan> となるスロットの下流リンクが落ちる。on 欠損補正も in-place で対称に行う。
            // (relations 件数が不変のため、capture/restore を伴う commitState ではなく applySaveOnly を使う。
            //  将来 Manager が relation 追加/削除を持つ場合は add/del 経路 = applyAfterCapture が必要。)
            // ロールバック退避: in-place mutation 前に各 relation の item_id/on を記録する (A2-1)。
            const relSnapshot = state.relations.map(r => ({ rel: r, item_id: r.item_id, on: r.on }));
            const oldCatalog = state.catalog;

            for (const rel of state.relations) {
                if (rel.item_id && !validIds.has(rel.item_id)) rel.item_id = null;
                if (rel.on === undefined || rel.on === null) rel.on = true;
            }

            // catalog 先行更新: slot 名導出 (resolveRelationLabel) は catalog.items を参照するため、
            // applySaveOnly の syncSlotStructure 呼出時点で新しい catalog が反映されている必要がある。
            node._textCatalogState = { ...state, catalog: draftCatalog };

            try {
                // relations 件数不変 + identity 維持 → applySaveOnly (capture/restore なし、下流リンク保持)。
                coordinator.applySaveOnly(state.relations);
            } catch (e) {
                // best-effort ロールバック: relations の item_id/on を in-place 復元し catalog を戻して
                // syncOutputSlots を再実行する (A2-1)。再例外時は abort せずログのみ
                // (次回 onConfigure の validIds fallback で救済)。
                for (const s of relSnapshot) { s.rel.item_id = s.item_id; s.rel.on = s.on; }
                node._textCatalogState = { ...node._textCatalogState, catalog: oldCatalog };
                try {
                    syncOutputSlots(node, node._textCatalogState);
                } catch (rollbackError) {
                    console.error("[TextCatalog] Rollback syncOutputSlots failed after applySaveOnly error:", rollbackError);
                }
                throw e;
            }
        });
    };
    node._openTextCatalogManager = openManager;

    return makeItemListWidget({
        widgetName: "__sax_text_catalog_widget",
        maxItems: MAX_RELATIONS,
        getItems: () => getState().relations,
        // saveItems は makeItemListWidget が saveItemsCapturing / saveItemsValueOnly 未指定時に
        // フォールバックとして呼ぶ可能性があるため残す。TextCatalog 自身の mutation 経路は
        // beforeModify / saveItemsCapturing / saveItemsValueOnly のみ使用するため通常呼ばれない。
        saveItems: (newRelations) => coordinator.applySaveOnly(newRelations),
        // individual はリンク保持 restore、merged は単一ピンを維持するため値/構造同期のみ。
        saveItemsCapturing: (newRelations) =>
            isMerged(node)
                ? coordinator.applySaveOnly(newRelations)
                : coordinator.applyAfterCapture(newRelations),
        // beforeModify 非経由 (toggle/onPopup 内など): slot 構造不変、値のみ保存。
        saveItemsValueOnly: (newRelations) => coordinator.applySaveOnly(newRelations),
        beforeModify: () => { if (!isMerged(node)) coordinator.captureFromExisting(); },

        // `hasToggle: true` により行頭 pill が描画され、クリックで `relation.on` がトグルされる。
        // pill toggle 経路 (sax_ui_base.js:1089) は saveItemsValueOnly 経由 (slot 構造不変)。
        hasToggle: true,

        params: [
            {
                key: "edit",
                w: 24,
                get: () => "",
                format: () => "✎",
                onPopup: (relation, _idx, _node) => {
                    // picker 表示時の item_id を渡すが、確定時の relations は picker コールバック内で
                    // 再取得する (picker 表示中に他経路で relations が変わった場合の stale closure 回避)。
                    pickItemForRelation(getState(), relation.item_id, (selectedId) => {
                        // 確定時点の最新 state を再取得 (stale closure 回避、CR/TR レビュー M-2 対応)。
                        const currentState = getState();
                        // picker 表示中に対象 relation が他経路で削除されていた場合は no-op で終わる。
                        if (!currentState.relations.includes(relation)) return;
                        // item_id 変更は slot 数不変・type STRING 固定の「値のみ変更」。
                        // relation を in-place 更新して entity identity を維持し、applySaveOnly で保存する
                        // (PrimitiveStore 同型。capture/restore を通さないため下流リンクは保持される。
                        // 新オブジェクト化すると Coordinator の WeakMap snapshot 解決が壊れ切断する)。
                        relation.item_id = selectedId;
                        if (relation.on === undefined || relation.on === null) relation.on = true;
                        coordinator.applySaveOnly(currentState.relations);
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
            // makeItemListWidget の add 経路に統一: フレームワーク側 beforeModify (capture)
            // + saveItemsCapturing (applyAfterCapture) で動作。独自 capture / saveStateAndSync 直呼びは廃止。
            label: "+ Add Relation",
            onAdd: (_n, _items, save) => {
                const state = getState();
                if (state.relations.length >= MAX_RELATIONS) return;
                const newRelations = [...state.relations, { item_id: null, on: true }];
                save(newRelations);
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
            clearAllSlots(this, { inputs: false });

            addManagerButton(this);
            this.addCustomWidget(makeCatalogWidget(this));
            // merge_outputs は表示したまま、出力構造切替 callback のみ追加する。
            chainMergeToggle(this);
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
            // merge_outputs は表示したまま、出力構造切替 callback のみ追加する。
            chainMergeToggle(this);
            this.size[0] = Math.max(this.size[0] ?? 0, 280);

            // 削除済 Item を参照する relation の自動修復 (commitState 例外時 / 外部編集時の
            // serialize 不整合 fallback、Plan 論点 4 v3 根拠 2)。
            //
            // in-place mutation は意図的: parseState の戻り値はこの onConfigure 内でのみ参照され、
            // この時点では Coordinator の captureFromExisting (下の setTimeout(0)) が未実行のため
            // WeakMap (#entityIds) には未登録。新オブジェクト置換で identity を切り替えるよりも
            // 同一参照を維持するほうが、後続の captureFromExisting で採番される ID が
            // 以降の mutate / applyAfterCapture 経路と一致して snapshot 解決が安定する。
            const validItemIds = new Set(state.catalog.items.map(it => it.id));
            for (const rel of state.relations) {
                if (rel.item_id && !validItemIds.has(rel.item_id)) {
                    rel.item_id = null;
                }
            }

            // 出力スロット同期は同期フェーズで実行（Node Collector 等の競合回避）
            syncOutputSlots(this, state);

            // LiteGraph のリンク復元完了後に Coordinator が現状接続を snapshot に取り込む。
            // setTimeout(0) は LiteGraph link 復元完了待ち (PrimitiveStore L497-499 と同パターン)。
            const coordinator = ensureCoordinator(this, buildTextCatalogSpec);
            // merged は relation N件 → 出力1本で Coordinator の 1:1 前提と一致しないため、
            // individual のときだけリンク snapshot を取り込む。
            if (!isMerged(this)) {
                setTimeout(() => {
                    coordinator.captureFromExisting();
                }, 0);
            }
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
