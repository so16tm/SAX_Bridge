/**
 * sax_lora_loader.js — SAX Lora Loader ノードの Canvas カスタム UI
 *
 * loras_json ウィジェットを非表示にして makeItemListWidget ベースの UI に置き換える。
 * 各行: [pill] [LoRA name (click→picker)] [strength] [▲▼] [✕]
 */

import { app } from "../../scripts/app.js";
import {
    PAD, ROW_H,
    txt,
    h,
    showDialog,
    makeItemListWidget,
    getComfyTheme,
    SAX_COLORS,
} from "./sax_ui_base.js";

const EXT_NAME   = "SAX.LoraLoader";
const NODE_TYPE  = "SAX_Bridge_Loader_Lora";
const WIDGET_JSON = "loras_json";
const MAX_LORAS  = 10;

// ---------------------------------------------------------------------------
// LoRA リスト取得（キャッシュ）
// ---------------------------------------------------------------------------

let _loraCache    = null;
let _loraCacheTsm = 0;
const CACHE_TTL   = 30_000; // 30秒

async function getLoraList() {
    const now = Date.now();
    if (_loraCache && now - _loraCacheTsm < CACHE_TTL) return _loraCache;
    try {
        const res  = await fetch("/object_info/LoraLoader");
        const data = await res.json();
        const list = data?.LoraLoader?.input?.required?.lora_name?.[0] ?? [];
        _loraCache    = list;
        _loraCacheTsm = now;
        return list;
    } catch {
        return _loraCache ?? [];
    }
}

// ---------------------------------------------------------------------------
// LoRA ピッカーオーバーレイ
// ---------------------------------------------------------------------------

function showLoraPicker(currentName, onSelect) {
    document.querySelectorAll(".__sax_lora_picker").forEach(e => e.remove());

    // 折りたたみ状態（セクションキー → collapsed boolean）
    const collapsed = new Map();

    // ---- LoRA 表示名（パス・拡張子なし） ----
    const displayName = (full) =>
        full.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

    // ---- LoRA 行（ノードピッカーの makeSelectRow と同じ構造） ----
    function makeLoraRow(fullName, isCurrent, close) {
        const label = displayName(fullName);
        const row = h("div",
            `display:flex;align-items:center;gap:6px;padding:3px 2px;border-radius:3px;` +
            `${isCurrent ? "background:var(--comfy-menu-secondary-bg,#303030);" : ""}`);
        row.title = fullName;

        const lbl = h("label",
            `cursor:default;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;` +
            `white-space:nowrap;font-size:11px;` +
            `color:${isCurrent ? "#7d7" : "var(--input-text,#ddd)"};`);
        lbl.textContent = label;
        row.appendChild(lbl);

        const selBtn = h("button",
            `padding:2px 10px;border-radius:3px;font-size:11px;cursor:pointer;flex-shrink:0;` +
            `background:${isCurrent ? "var(--comfy-menu-secondary-bg,#303030)" : "var(--comfy-input-bg,#222)"};` +
            `border:1px solid var(--content-bg,#4e4e4e);` +
            `color:${isCurrent ? "#9f9" : "var(--input-text,#ddd)"};`,
            isCurrent ? "✓" : "Select");
        selBtn.addEventListener("mouseenter", () => {
            selBtn.style.background = "var(--comfy-menu-secondary-bg,#303030)";
        });
        selBtn.addEventListener("mouseleave", () => {
            selBtn.style.background = isCurrent
                ? "var(--comfy-menu-secondary-bg,#303030)"
                : "var(--comfy-input-bg,#222)";
        });
        selBtn.addEventListener("click", () => { close(); onSelect(fullName); });

        row.appendChild(selBtn);
        if (isCurrent) row.dataset.current = "true";
        return row;
    }

    // ---- 折りたたみセクション（ノードピッカーの makeSection と同じ構造） ----
    // alwaysOpen=true のとき折りたたみ状態を無視して常に展開（検索中に使用）
    function makeSection(key, label, childEls, defaultCollapsed, alwaysOpen = false) {
        const isCollapsed = alwaysOpen ? false : (collapsed.has(key) ? collapsed.get(key) : defaultCollapsed);
        const sec    = h("div", "margin-bottom:4px;");
        const header = h("div",
            `display:flex;align-items:center;gap:6px;cursor:pointer;padding:5px 4px;` +
            `background:var(--comfy-input-bg,#222);border-radius:4px;` +
            `color:${SAX_COLORS.node};font-weight:bold;font-size:12px;`);
        const arrow  = h("span", "font-size:10px;flex-shrink:0;", isCollapsed ? "▶" : "▼");
        header.appendChild(arrow);
        header.appendChild(h("span", "flex:1;", label));
        const body = h("div", `padding-left:8px;${isCollapsed ? "display:none;" : ""}`);
        for (const c of childEls) body.appendChild(c);
        header.addEventListener("click", () => {
            const now = !(collapsed.has(key) ? collapsed.get(key) : defaultCollapsed);
            collapsed.set(key, now);
            arrow.textContent  = now ? "▶" : "▼";
            body.style.display = now ? "none" : "";
        });
        sec.appendChild(header);
        sec.appendChild(body);
        return sec;
    }

    // ---- フォルダツリー構築 ----
    function buildTree(names) {
        // node = { children: Map<string, node>, items: string[] }
        const root = { children: new Map(), items: [] };
        for (const name of names) {
            const parts = name.split(/[\\/]/);
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                const p = parts[i];
                if (!node.children.has(p))
                    node.children.set(p, { children: new Map(), items: [] });
                node = node.children.get(p);
            }
            node.items.push(name);
        }
        return root;
    }

    function countAll(node) {
        return node.items.length +
            [...node.children.values()].reduce((s, c) => s + countAll(c), 0);
    }

    // filterFn を適用したときのマッチ数
    function countFiltered(node, filterFn) {
        const own = node.items.filter(filterFn).length;
        return own + [...node.children.values()].reduce((s, c) => s + countFiltered(c, filterFn), 0);
    }

    // current が node のサブツリー内にあるか（pathPrefix はセクションキー）
    function containsCurrent(node, pathPrefix) {
        if (!currentName) return false;
        const norm = currentName.replace(/\\/g, "/");
        if (pathPrefix && !norm.startsWith(pathPrefix + "/")) return false;
        return node.items.includes(currentName) ||
            [...node.children.entries()].some(([name, child]) =>
                containsCurrent(child, (pathPrefix ? pathPrefix + "/" : "") + name));
    }

    // ---- ツリーを再帰的に DOM 化 ----
    // filterFn: null のとき全件表示、関数のとき条件一致のみ表示（空フォルダは非表示）
    // alwaysOpen: true のとき折りたたみ状態を無視して全セクションを展開
    function renderTree(node, pathPrefix, close, filterFn = null, alwaysOpen = false) {
        const els = [];
        // このレベルのアイテム（サブフォルダなし）
        for (const name of [...node.items].sort()) {
            if (filterFn && !filterFn(name)) continue;
            els.push(makeLoraRow(name, name === currentName, close));
        }
        // サブフォルダ
        for (const [folderName, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const key      = (pathPrefix ? pathPrefix + "/" : "") + folderName;
            const childEls = renderTree(child, key, close, filterFn, alwaysOpen);
            if (childEls.length === 0) continue;  // マッチなし → フォルダごと非表示
            const total    = countAll(child);
            const matched  = filterFn ? countFiltered(child, filterFn) : total;
            const countStr = filterFn && matched < total ? `${matched}/${total}` : String(total);
            const hasCur   = containsCurrent(child, key);
            els.push(makeSection(key, `${folderName}  (${countStr})`, childEls, !hasCur, alwaysOpen));
        }
        return els;
    }

    showDialog({
        title:     "Select LoRA",
        width:     480,
        className: "__sax_lora_picker",
        build(dlg, close) {
            // ---- 検索バー ----
            const searchWrap = h("div",
                "display:flex;align-items:center;gap:6px;" +
                "background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#4e4e4e);" +
                "border-radius:4px;padding:5px 10px;flex-shrink:0;");
            const searchInput = h("input");
            searchInput.placeholder = "Search LoRA name…";
            searchInput.style.cssText =
                "flex:1;background:none;border:none;outline:none;" +
                "color:var(--input-text,#ddd);font-size:12px;";
            searchWrap.appendChild(h("span", "color:var(--content-bg,#4e4e4e);", "🔍"));
            searchWrap.appendChild(searchInput);

            const scroll = h("div", "overflow-y:auto;flex:1;");

            const cancelBtn = h("button",
                "padding:6px 14px;background:var(--comfy-input-bg,#222);" +
                "border:1px solid var(--border-color,#4e4e4e);" +
                "border-radius:4px;color:var(--input-text,#ddd);cursor:pointer;font-size:12px;",
                "Cancel");
            cancelBtn.addEventListener("click", close);
            const btnRow = h("div", "display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;");
            btnRow.appendChild(cancelBtn);

            dlg.appendChild(searchWrap);
            dlg.appendChild(scroll);
            dlg.appendChild(btnRow);

            // ---- リスト描画 ----
            const render = (q) => {
                scroll.innerHTML = "";
                const lower    = q.toLowerCase().trim();
                // 検索時はフルパス（拡張子なし）を対象にフィルタ
                const filterFn = lower
                    ? (name) => name.replace(/\.safetensors$/i, "").toLowerCase().includes(lower)
                    : null;

                getLoraList().then(list => {
                    if (list.length === 0) {
                        scroll.appendChild(h("div",
                            "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;",
                            "No LoRAs found"));
                        return;
                    }

                    // 検索の有無に関わらず常に階層ツリーで表示
                    // 検索時: マッチしないフォルダを非表示、全セクションを強制展開
                    const tree = buildTree(list);
                    const els  = renderTree(tree, "", close, filterFn, !!filterFn);
                    if (els.length === 0) {
                        scroll.appendChild(h("div",
                            "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;",
                            "No results"));
                        return;
                    }
                    for (const el of els) scroll.appendChild(el);
                    // 非検索時: 現在選択中アイテムへスクロール
                    if (!filterFn) {
                        requestAnimationFrame(() => {
                            const cur = scroll.querySelector("[data-current='true']");
                            if (cur) cur.scrollIntoView({ block: "center" });
                        });
                    }
                });
            };

            render("");
            searchInput.addEventListener("input", () => render(searchInput.value));
            requestAnimationFrame(() => searchInput.focus());
        },
    });
}

// ---------------------------------------------------------------------------
// JSON ヘルパー
// ---------------------------------------------------------------------------

function getEntries(node) {
    const w = node.widgets?.find(w => w.name === WIDGET_JSON);
    try { return JSON.parse(w?.value ?? "[]"); } catch { return []; }
}

function saveEntries(node, entries) {
    const w = node.widgets?.find(w => w.name === WIDGET_JSON);
    if (w) w.value = JSON.stringify(entries);
}

// ---------------------------------------------------------------------------
// UI 構築
// ---------------------------------------------------------------------------

function buildUI(node) {
    // loras_json / enabled ウィジェットを非表示化
    for (const name of [WIDGET_JSON, "enabled"]) {
        const w = node.widgets?.find(w => w.name === name);
        if (w && !w._saxHidden) {
            w._saxHidden  = true;
            w.computeSize = () => [0, -4];
            w.draw        = () => {};
            w.mouse       = () => false;
            if (w.element) w.element.style.display = "none";
        }
    }

    // 既存のカスタム UI ウィジェットを除去して再構築
    node.widgets = (node.widgets ?? []).filter(w =>
        w.name === WIDGET_JSON || w.name === "enabled"
    );

    // makeItemListWidget を使って LoRA リスト UI を追加
    const widget = makeItemListWidget(node, {
        widgetName:    "__sax_lora_list",

        getItems:      ()        => getEntries(node),
        saveItems:     (entries) => saveEntries(node, entries),

        maxItems:      MAX_LORAS,
        hasToggle:     true,
        hasMoveUpDown: true,
        hasDelete:     true,
        hasParam:      true,
        enabledWidget: { name: "enabled" },

        param: {
            key:       "strength",
            label:     "Strength",
            get:       (item)    => item.strength ?? 1.0,
            set:       (item, v) => { item.strength = Math.round(v * 100) / 100; },
            min:       -2.0,
            max:        2.0,
            step:       0.01,
            dragScale:  0.01,
            format:     (v)      => v.toFixed(2),
        },

        content: {
            // LoRA 名を描画。未設定時はプレースホルダー
            draw(ctx, item, x, y, w, h, on) {
                const t       = getComfyTheme();
                const name    = item.lora || "";
                const display = name
                    ? name.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "")
                    : "— click to select —";
                const color   = !name
                    ? t.contentBg    // プレースホルダー（暗い行の中で薄く）
                    : t.inputText;   // 選択済み（ON/OFF を問わずライトグレー、明暗は pill で表現）
                ctx.save();
                ctx.beginPath();
                ctx.rect(x + 2, y, w - 4, h);
                ctx.clip();
                txt(ctx, display, x + 4, y + h / 2, color, "left", 11);
                ctx.restore();
            },
            // クリックで LoRA ピッカーを表示
            onClick(item, index, node) {
                showLoraPicker(item.lora ?? "", (name) => {
                    item.lora = name;
                    const entries = getEntries(node);
                    entries[index] = item;
                    saveEntries(node, entries);
                    app.graph.setDirtyCanvas(true, false);
                });
            },
        },

        addButton: {
            label:    "+ Add LoRA",
            onCreate: () => ({ on: true, lora: "", strength: 1.0 }),
        },
    });

    node.addCustomWidget(widget);

    const [, newH] = node.computeSize();
    node.size[0] = Math.max(node.size[0], 280);
    node.size[1] = Math.max(newH, 80);
    app.graph.setDirtyCanvas(true, false);
}

// ---------------------------------------------------------------------------
// Extension 登録
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        await new Promise(r => requestAnimationFrame(r));
        buildUI(node);

        // LoRA リストをバックグラウンドで事前取得
        getLoraList();
    },
});
