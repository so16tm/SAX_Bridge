/**
 * sax_lora_loader.js — SAX Lora Loader ノードの Canvas カスタム UI
 *
 * loras_json ウィジェットを非表示にして makeItemListWidget ベースの UI に置き換える。
 * 各行: [pill] [LoRA name (click→統合ダイアログ)] [strength drag] [▲▼] [✕]
 */

import { app } from "../../scripts/app.js";
import {
    PAD, ROW_H,
    txt,
    h,
    showItemEditDialog,
    makeItemListWidget,
    getComfyTheme,
    showFilePicker,
} from "./sax_ui_base.js";

// LoRA 表示名（パス・拡張子なし）— モジュールスコープで共有
const displayName = (full) =>
    full.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

const EXT_NAME   = "SAX.LoraLoader";
const NODE_TYPE  = "SAX_Bridge_Loader_Lora";
const WIDGET_JSON = "loras_json";
const MAX_LORAS  = 20;

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

function showLoraPicker(currentName, onSelect, { mode = "single", onConfirm = null, selection: initSelection = new Set() } = {}) {
    getLoraList().then(list => {
        showFilePicker({
            items:        list,
            currentValue: currentName,
            title:        mode === "multi" ? "Add / Remove Items" : "Select LoRA",
            placeholder:  "Search LoRA name…",
            mode,
            className:    "__sax_lora_picker",
            onSelect,
            selection:    initSelection,
            onConfirm,
            displayName,
        });
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
// 統合編集ダイアログ
// ---------------------------------------------------------------------------

function showLoraEditDialog(node, items, rowIndex) {
    const item = items[rowIndex];
    showItemEditDialog({
        title:     "Edit LoRA Entry",
        className: "__sax_lora_edit_dlg",
        fields: [
            {
                type: "custom", label: "LoRA",
                build(row, ed) {
                    const nameEl = h("span",
                        "flex:1;font-size:11px;color:var(--input-text,#ddd);" +
                        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:center;",
                        ed.lora ? displayName(ed.lora) : "— not selected —");
                    const btn = h("button",
                        "padding:4px 14px;border-radius:4px;flex-shrink:0;" +
                        "border:1px solid var(--content-bg,#4e4e4e);" +
                        "background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);" +
                        "cursor:pointer;font-size:11px;white-space:nowrap;",
                        "Select…");
                    btn.addEventListener("click", () => {
                        showLoraPicker(ed.lora ?? "", (name) => {
                            ed.lora = name;
                            nameEl.textContent = displayName(name);
                        });
                    });
                    row.appendChild(nameEl);
                    row.appendChild(btn);
                },
            },
            {
                type: "number", key: "strength", label: "Strength",
                min: -2, max: 2, step: 0.01, decimals: 2,
            },
        ],
        data: { lora: item.lora ?? "", strength: item.strength ?? 1.0 },
        onCommit(ed) {
            Object.assign(item, ed);
            saveEntries(node, items);
            app.graph.setDirtyCanvas(true, false);
        },
    });
}

// ---------------------------------------------------------------------------
// UI 構築
// ---------------------------------------------------------------------------

function buildUI(node) {
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

    const widget = makeItemListWidget({
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
            onPopup(item, index, node) {
                const entries = getEntries(node);
                showLoraEditDialog(node, entries, index);
            },
        },

        content: {
            draw(ctx, item, x, y, w, h, on) {
                const t       = getComfyTheme();
                const name    = item.lora || "";
                const display = name ? displayName(name) : "— click to edit —";
                const color   = !name ? t.contentBg : t.inputText;
                ctx.save();
                ctx.beginPath();
                ctx.rect(x + 2, y, w - 4, h);
                ctx.clip();
                txt(ctx, display, x + 4, y + h / 2, color, "left", 11);
                ctx.restore();
            },
            onClick(item, index, node) {
                const entries = getEntries(node);
                showLoraEditDialog(node, entries, index);
            },
        },

        addButton: {
            onAdd(node, items, saveItems) {
                showLoraPicker("", null, {
                    mode: "multi",
                    selection: new Set(items.map(i => i.lora)),
                    onConfirm(names) {
                        const newSet = new Set(names);
                        // 除去（逆順でインデックスずれを防止）
                        for (let i = items.length - 1; i >= 0; i--) {
                            if (!newSet.has(items[i].lora)) items.splice(i, 1);
                        }
                        // 追加（既存にないもののみ）
                        const existing = new Set(items.map(i => i.lora));
                        for (const name of names) {
                            if (existing.has(name)) continue;
                            if (items.length >= MAX_LORAS) break;
                            items.push({ on: true, lora: name, strength: 1.0 });
                        }
                        saveItems(items);
                        app.graph.setDirtyCanvas(true, false);
                    },
                });
            },
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
