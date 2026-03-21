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
    makeItemListWidget,
    getComfyTheme,
} from "./sax_ui_base.js";

const EXT_NAME   = "SAX.LoraLoader";
const NODE_TYPE  = "SAX_Bridge_Pipe_Lora_Loader";
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
    // 既存ピッカーを除去
    document.querySelectorAll(".__sax_lora_picker").forEach(e => e.remove());

    const overlay = document.createElement("div");
    overlay.className = "__sax_lora_picker";
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:10000;" +
        "display:flex;align-items:center;justify-content:center;";

    const dlg = document.createElement("div");
    dlg.style.cssText =
        "background:var(--comfy-menu-bg,#353535);border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:6px;padding:16px;width:480px;max-height:76vh;" +
        "display:flex;flex-direction:column;" +
        "color:var(--fg-color,#fff);font:13px/1.5 sans-serif;gap:8px;";

    const title = document.createElement("div");
    title.style.cssText = "font:bold 14px sans-serif;color:var(--fg-color,#fff);";
    title.textContent = "Select LoRA";

    const searchWrap = document.createElement("div");
    searchWrap.style.cssText =
        "display:flex;align-items:center;gap:6px;" +
        "background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:4px;padding:5px 10px;flex-shrink:0;";
    const searchIcon = document.createElement("span");
    searchIcon.style.cssText = "color:var(--content-bg,#4e4e4e);";
    searchIcon.textContent = "🔍";
    const searchInput = document.createElement("input");
    searchInput.placeholder = "Search LoRA name…";
    searchInput.style.cssText =
        "flex:1;background:none;border:none;outline:none;" +
        "color:var(--input-text,#ddd);font-size:12px;";
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);

    const scroll = document.createElement("div");
    scroll.style.cssText = "overflow-y:auto;flex:1;";

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
        "padding:6px 14px;background:var(--comfy-menu-secondary-bg,#303030);" +
        "border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:4px;color:var(--fg-color,#fff);cursor:pointer;font-size:12px;";
    cancelBtn.addEventListener("click", () => overlay.remove());

    btnRow.appendChild(cancelBtn);
    dlg.appendChild(title);
    dlg.appendChild(searchWrap);
    dlg.appendChild(scroll);
    dlg.appendChild(btnRow);
    overlay.appendChild(dlg);
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    // リスト描画
    const render = (q) => {
        scroll.innerHTML = "";
        const lower = q.toLowerCase().trim();
        getLoraList().then(list => {
            const filtered = lower
                ? list.filter(n => n.toLowerCase().includes(lower))
                : list;
            if (filtered.length === 0) {
                const empty = document.createElement("div");
                empty.style.cssText =
                    "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;";
                empty.textContent   = "No results";
                scroll.appendChild(empty);
                return;
            }
            for (const name of filtered) {
                const row = document.createElement("div");
                const isCurrent = name === currentName;
                const selectedBg = "var(--tr-odd-bg-color,#353535)";
                const hoverBg    = "var(--content-hover-bg,#222)";
                row.style.cssText =
                    `display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px;` +
                    `cursor:pointer;${isCurrent ? `background:${selectedBg};` : ""}`;
                row.addEventListener("mouseenter", () => {
                    if (!isCurrent) row.style.background = hoverBg;
                });
                row.addEventListener("mouseleave", () => {
                    row.style.background = isCurrent ? selectedBg : "";
                });

                const lbl = document.createElement("span");
                lbl.style.cssText =
                    `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
                    `font-size:11px;color:${isCurrent
                        ? "var(--fg-color,#fff)"
                        : "var(--input-text,#ddd)"};`;
                lbl.textContent = name;

                if (isCurrent) {
                    const mark = document.createElement("span");
                    mark.style.cssText =
                        "color:var(--input-text,#ddd);font-size:11px;flex-shrink:0;";
                    mark.textContent   = "✓";
                    row.appendChild(mark);
                }
                row.appendChild(lbl);
                row.addEventListener("click", () => {
                    overlay.remove();
                    onSelect(name);
                });
                scroll.appendChild(row);
            }
        });
    };

    render("");
    searchInput.addEventListener("input", () => render(searchInput.value));
    requestAnimationFrame(() => searchInput.focus());
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
