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
    showDialog,
    showItemEditDialog,
    makeItemListWidget,
    getComfyTheme,
    SAX_COLORS,
    buildPickerContent,
    makePickerSection,
    AUTO_EXPAND_THRESHOLD,
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
    document.querySelectorAll(".__sax_lora_picker").forEach(e => e.remove());

    const collapsed = new Map();
    const selection = new Set(initSelection);

    function makeLoraRow(fullName, isCurrent, close) {
        const label = displayName(fullName);

        if (mode === "multi") {
            const row = h("div",
                "display:flex;align-items:center;gap:8px;padding:3px 0 3px 2px;");
            row.classList.add("sax-picker-item");
            row.title = fullName;
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selection.has(fullName);
            cb.style.cssText = "cursor:pointer;flex-shrink:0;accent-color:#4a9;";
            cb.addEventListener("change", () => {
                if (cb.checked) selection.add(fullName); else selection.delete(fullName);
            });
            const lbl = h("span",
                "cursor:pointer;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;" +
                "white-space:nowrap;font-size:11px;color:var(--input-text,#ddd);");
            lbl.textContent = label;
            lbl.addEventListener("click", () => { cb.click(); });
            row.appendChild(cb);
            row.appendChild(lbl);
            return row;
        }

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

    function buildTree(names) {
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

    function countFiltered(node, filterFn) {
        const own = node.items.filter(filterFn).length;
        return own + [...node.children.values()].reduce((s, c) => s + countFiltered(c, filterFn), 0);
    }

    // 直接アイテムを含むフォルダセクション数を再帰的に集計（中間フォルダは除く）
    function countSections(node, filterFn) {
        let count = 0;
        for (const child of node.children.values()) {
            const directItems = filterFn
                ? child.items.filter(filterFn).length
                : child.items.length;
            if (directItems > 0) count += 1;
            count += countSections(child, filterFn);
        }
        return count;
    }

    function containsCurrent(node, pathPrefix) {
        if (!currentName) return false;
        const norm = currentName.replace(/\\/g, "/");
        if (pathPrefix && !norm.startsWith(pathPrefix + "/")) return false;
        return node.items.includes(currentName) ||
            [...node.children.entries()].some(([name, child]) =>
                containsCurrent(child, (pathPrefix ? pathPrefix + "/" : "") + name));
    }

    // filterFn: null のとき全件、関数のとき条件一致のみ（空フォルダは非表示）
    // alwaysOpen: true のとき折りたたみを無視して全セクションを展開
    function renderTree(node, pathPrefix, close, filterFn = null, alwaysOpen = false) {
        const els = [];
        for (const name of [...node.items].sort()) {
            if (filterFn && !filterFn(name)) continue;
            els.push(makeLoraRow(name, name === currentName, close));
        }
        for (const [folderName, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const key      = (pathPrefix ? pathPrefix + "/" : "") + folderName;
            const childEls = renderTree(child, key, close, filterFn, alwaysOpen);
            if (childEls.length === 0) continue;  // マッチなし → フォルダごと非表示
            const total    = countAll(child);
            const matched  = filterFn ? countFiltered(child, filterFn) : total;
            const countStr = filterFn && matched < total ? `${matched}/${total}` : String(total);
            const hasCur   = containsCurrent(child, key);
            els.push(makePickerSection(collapsed, key, `${folderName}  (${countStr})`, SAX_COLORS.node, childEls, !hasCur, alwaysOpen, mode));
        }
        return els;
    }

    let pickerCleanup = null;
    showDialog({
        title:     mode === "multi" ? "Add / Remove Items" : "Select LoRA",
        width:     480,
        className: "__sax_lora_picker",
        onClose:   () => { pickerCleanup?.(); },
        build(dlg, close) {
            const closeFn = () => { pickerCleanup?.(); close(); };

            const renderContentFn = (q, scroll) => {
                scroll.innerHTML = "";
                const lower    = q.toLowerCase().trim();
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

                    // セクション数が閾値以下なら強制展開
                    const tree         = buildTree(list);
                    const sectionCount = countSections(tree, filterFn);
                    const forceOpen    = sectionCount <= AUTO_EXPAND_THRESHOLD;
                    const els          = renderTree(tree, "", closeFn, filterFn, forceOpen);
                    if (els.length === 0) {
                        scroll.appendChild(h("div",
                            "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;",
                            "No results"));
                        return;
                    }
                    for (const el of els) scroll.appendChild(el);
                    if (!filterFn) {
                        requestAnimationFrame(() => {
                            const cur = scroll.querySelector("[data-current='true']");
                            if (cur) cur.scrollIntoView({ block: "center" });
                        });
                    }
                });
            };

            const { element, focusSearch, cleanup } = buildPickerContent({
                mode,
                placeholder: "Search LoRA name…",
                renderContent: renderContentFn,
                onApply: mode === "multi" ? () => { closeFn(); onConfirm?.([...selection]); } : null,
                onCancel: closeFn,
            });
            pickerCleanup = cleanup;

            dlg.appendChild(element);
            focusSearch();
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
