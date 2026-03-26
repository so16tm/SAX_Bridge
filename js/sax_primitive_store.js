import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    PAD, ROW_H, BOTTOM_PAD, ADD_H,
    txt, rrect,
    makeItemListWidget, showItemEditDialog, getComfyTheme,
    captureOutputLinks, restoreOutputLinks,
    PRIMITIVE_TYPE_META, PRIMITIVE_BADGE_FALLBACK, PRIMITIVE_BADGE_TEXT_COLOR,
} from "./sax_ui_base.js";

const EXT_NAME  = "SAX.PrimitiveStore";
const NODE_TYPE = "SAX_Bridge_Primitive_Store";
const MAX_ITEMS = 32;

function stepDecimals(step) {
    const s = step.toFixed(10).replace(/0+$/, "");
    const d = s.indexOf(".");
    return d === -1 ? 0 : s.length - d - 1;
}

/** type を変更すると ComfyUI がプロンプト収集でスキップするため、描画のみ無効化する */
function hideWidget(widget) {
    widget.computeSize = () => [0, -4];
    widget.draw        = () => {};
}

const TYPE_META = PRIMITIVE_TYPE_META;
/** SEED → INT 変換（下流ノードとの接続互換） */
const OUTPUT_TYPE_MAP = { SEED: "INT" };

// ---------------------------------------------------------------------------
// アイテムファクトリ・ストア
// ---------------------------------------------------------------------------

function makeDefaultItem(type, name) {
    const base = { type, name };
    switch (type) {
        case "INT":     return { ...base, value: 0,     min: -(2 ** 31),    max: 2 ** 31 - 1,  step: 1   };
        case "FLOAT":   return { ...base, value: 0.0,   min: -1_000_000,    max: 1_000_000,    step: 0.1 };
        case "STRING":  return { ...base, value: ""  };
        case "BOOLEAN": return { ...base, value: false };
        case "SEED":    return { ...base, value: 0,     min: 0,             max: 2 ** 53 - 1,  step: 1, mode: "fixed", timing: "before" };
        default:        return { ...base, value: 0   };
    }
}

function randomSeed(max) {
    return Math.floor(Math.random() * ((max ?? 2 ** 53 - 1) + 1));
}

function getNodeItems(node) {
    return node._primitiveItems ?? [];
}

// ---------------------------------------------------------------------------
// 出力スロット同期
// ---------------------------------------------------------------------------

function syncOutputSlots(node, items) {
    while ((node.outputs?.length ?? 0) > items.length)
        node.removeOutput(node.outputs.length - 1);
    while ((node.outputs?.length ?? 0) < items.length)
        node.addOutput("", "*");

    for (let i = 0; i < items.length; i++) {
        node.outputs[i].name = items[i].name;
        node.outputs[i].type = OUTPUT_TYPE_MAP[items[i].type] ?? items[i].type;
    }

    // _links は接続維持用の内部プロパティのため JSON から除外
    const w = node.widgets?.find(w => w.name === "items_json");
    if (w) {
        const serializable = items.map(({ _links, ...rest }) => rest);
        w.value = JSON.stringify(serializable);
    }

    node.size[1] = node.computeSize()[1];
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// ダイアログ
// ---------------------------------------------------------------------------

function showAddDialog(node, saveItems) {
    showItemEditDialog({
        title:     "Add Parameter",
        width:     380,
        className: "__sax_pstore_add",
        fields: [
            {
                key:     "type",
                label:   "Type",
                type:    "select",
                options: Object.entries(TYPE_META).map(([k, v]) => ({
                    value:   k,
                    label:   v.badge,
                    color:   v.color,
                    tooltip: v.tooltip ?? k,
                })),
            },
            { key: "name", label: "Name", type: "text" },
        ],
        data:     { type: "INT", name: "" },
        onCommit: (ed) => {
            const name = ed.name?.trim();
            if (!name) return;
            const items = [...getNodeItems(node), makeDefaultItem(ed.type, name)];
            saveItems(items);
        },
    });
}

function showNumericEditPopup(item, saveItemsFn) {
    const isInt = item.type === "INT";
    const dec   = isInt ? 0 : 4;
    showItemEditDialog({
        title:     item.name,
        width:     300,
        className: "__sax_pstore_edit",
        fields: (() => {
            const curMin  = item.min  ?? (isInt ? -(2 ** 31)  : -1_000_000);
            const curMax  = item.max  ?? (isInt ? 2 ** 31 - 1 :  1_000_000);
            const curStep = item.step ?? (isInt ? 1 : 0.1);
            return [
                { key: "value", label: "Value", type: "number", decimals: dec, step: curStep, min: curMin, max: curMax },
                { key: "min",   label: "Min",   type: "number", decimals: dec, step: curStep },
                { key: "max",   label: "Max",   type: "number", decimals: dec, step: curStep },
                { key: "step",  label: "Step",  type: "number", decimals: dec, step: isInt ? 1 : 0.001, min: isInt ? 1 : 1e-9 },
            ];
        })(),
        data: {
            value: item.value,
            min:   item.min  ?? (isInt ? -(2 ** 31)   : -1_000_000),
            max:   item.max  ?? (isInt ? 2 ** 31 - 1  :  1_000_000),
            step:  item.step ?? (isInt ? 1             : 0.1),
        },
        onCommit: (ed) => {
            if (isInt) {
                item.min   = Math.round(ed.min);
                item.max   = Math.round(ed.max);
                item.step  = Math.max(1, Math.round(ed.step));
                item.value = Math.max(item.min, Math.min(item.max, Math.round(ed.value)));
            } else {
                item.min   = ed.min;
                item.max   = ed.max;
                item.step  = Math.max(1e-9, ed.step);
                item.value = Math.max(item.min, Math.min(item.max, ed.value));
            }
            saveItemsFn();
        },
    });
}

function showStringEditDialog(item, saveItemsFn) {
    showItemEditDialog({
        title:     item.name,
        width:     380,
        className: "__sax_pstore_str",
        fields: [
            { key: "value", label: "Value", type: "text" },
        ],
        data:     { value: item.value ?? "" },
        onCommit: (ed) => {
            item.value = ed.value;
            saveItemsFn();
        },
    });
}

const SEED_MODES = [
    { value: "fixed",  label: "Fixed"  },
    { value: "random", label: "Random" },
];
const SEED_TIMINGS = [
    { value: "before", label: "Before", tooltip: "実行前にシードを生成" },
    { value: "after",  label: "After",  tooltip: "実行後にシードを生成（次回用）" },
];

function showSeedEditPopup(item, saveItemsFn) {
    const curMax = item.max ?? 2 ** 53 - 1;
    showItemEditDialog({
        title:     item.name,
        width:     380,
        className: "__sax_pstore_seed",
        fields: [
            { key: "value", label: "Value", type: "number", decimals: 0, step: 1, min: 0, max: curMax },
            {
                key: "_randomize", type: "custom",
                build(row, ed, _close) {
                    const btn = document.createElement("button");
                    btn.textContent = "New Random";
                    btn.style.cssText = (
                        "flex:1;padding:7px;border-radius:4px;border:none;cursor:pointer;font-weight:bold;" +
                        "background:var(--primary-background,#0b8ce9);color:var(--button-surface-contrast,#fff);"
                    );
                    btn.addEventListener("click", () => {
                        ed.value = randomSeed(curMax);
                        const inp = row.parentElement?.querySelector("input");
                        if (inp) inp.value = String(ed.value);
                    });
                    row.appendChild(btn);
                },
            },
            {
                key:     "mode",
                label:   "Mode",
                type:    "select",
                options: SEED_MODES,
            },
            {
                key:     "timing",
                label:   "Timing",
                type:    "select",
                options: SEED_TIMINGS.map(t => ({ ...t })),
            },
        ],
        data: {
            value:  item.value ?? 0,
            mode:   item.mode ?? "fixed",
            timing: item.timing ?? "before",
        },
        onCommit: (ed) => {
            item.value  = Math.max(0, Math.min(curMax, Math.round(ed.value)));
            item.mode   = ed.mode;
            item.timing = ed.timing;
            saveItemsFn();
        },
    });
}

// ---------------------------------------------------------------------------
// 型バッジ描画
// ---------------------------------------------------------------------------

function drawTypeBadge(ctx, item, x, midY, w, h) {
    const meta  = TYPE_META[item.type] ?? PRIMITIVE_BADGE_FALLBACK;
    const bh    = h - 8;
    const bw    = w - 8;
    const bx    = x + 4;
    const by    = midY - bh / 2;
    const isRandom = item.type === "SEED" && item.mode === "random";

    rrect(ctx, bx, by, bw, bh, 3,
        isRandom ? null : meta.color,
        isRandom ? meta.color : null);

    ctx.save();
    ctx.fillStyle    = isRandom ? meta.color : PRIMITIVE_BADGE_TEXT_COLOR;
    ctx.font         = `bold 8px sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(meta.badge, x + w / 2, midY);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// ウィジェット生成
// ---------------------------------------------------------------------------

function makeStoreWidget(node) {
    // node._primitiveItems を直接参照（クロージャの stale 回避）
    const getItems  = () => node._primitiveItems ?? [];
    const saveItems = (newItems) => {
        node._primitiveItems = newItems;
        restoreOutputLinks(node, newItems, () => syncOutputSlots(node, newItems));
    };

    return makeItemListWidget({
        widgetName:   "__sax_pstore_widget",
        maxItems:     MAX_ITEMS,
        getItems,
        saveItems,
        beforeModify: (items) => captureOutputLinks(node, items),

        leftElements: [
            {
                key:  "typeBadge",
                w:    36,
                draw: (ctx, item, x, midY, w, h) => drawTypeBadge(ctx, item, x, midY, w, h),
                onClick: (item) => {
                    if (item.type !== "SEED") return false;
                    item.mode = item.mode === "random" ? "fixed" : "random";
                    return true;
                },
            },
        ],

        params: [
            {
                key:  "value",
                w:    56,
                get:  item => item.value,
                set:  (item, v) => {
                    if (item.type === "BOOLEAN" || item.type === "STRING") return;
                    const isInt = item.type === "INT" || item.type === "SEED";
                    const min  = item.min  ?? (isInt ? 0 : -1e9);
                    const max  = item.max  ?? (isInt ? 2 ** 53 - 1 : 1e9);
                    const step = item.step ?? (isInt ? 1 : 0.1);
                    const snapped  = Math.round((v - min) / step) * step + min;
                    const clamped  = Math.max(min, Math.min(max, snapped));
                    if (isInt) {
                        item.value = Math.round(clamped);
                    } else {
                        const dec  = stepDecimals(step);
                        item.value = parseFloat(clamped.toFixed(dec));
                    }
                },
                format: v => {
                    if (typeof v === "boolean") return v ? "ON" : "OFF";
                    if (typeof v === "string")  return v.length > 9 ? v.slice(0, 8) + "…" : (v || "―");
                    if (typeof v === "number") {
                        const s = Number.isInteger(v) ? String(v) : v.toFixed(3);
                        return s.length > 7 ? s.slice(0, 6) + "…" : s;
                    }
                    return String(v);
                },
                dragScale: item => {
                    if (item.type === "INT" || item.type === "SEED") return (item.step ?? 1) * 0.5;
                    if (item.type === "FLOAT") return (item.step ?? 0.1) * 0.1;
                    return 1e9;
                },
                onPopup: (item, _idx, _node) => {
                    if (item.type === "BOOLEAN") {
                        item.value = !item.value;
                        saveItems(getItems());
                        return;
                    }
                    if (item.type === "STRING") {
                        showStringEditDialog(item, () => saveItems(getItems()));
                        return;
                    }
                    if (item.type === "SEED") {
                        showSeedEditPopup(item, () => saveItems(getItems()));
                        return;
                    }
                    showNumericEditPopup(item, () => saveItems(getItems()));
                },
            },
        ],

        content: {
            draw(ctx, item, x, y, w, h) {
                const t = getComfyTheme();
                const midY = y + h / 2;
                txt(ctx, item.name, x + 4, midY, t.inputText ?? t.contentBg, "left", 11);
                if (item.type === "SEED" && item.mode === "random") {
                    const label = item.timing === "after" ? "rnd:aft" : "rnd:bef";
                    const labelX = x + w - 4;
                    ctx.save();
                    ctx.font         = "9px sans-serif";
                    ctx.fillStyle    = t.border;
                    ctx.textAlign    = "right";
                    ctx.textBaseline = "middle";
                    ctx.fillText(label, labelX, midY);
                    ctx.restore();
                }
            },
        },

        hasMoveUpDown: true,
        hasDelete:     true,

        addButton: {
            onAdd: (n, _items2, _save) => showAddDialog(node, saveItems),
        },
    });
}

// ---------------------------------------------------------------------------
// SEED 自動ランダム化
// ---------------------------------------------------------------------------

function randomizeSeedsOnNodes(timing) {
    for (const node of app.graph._nodes ?? []) {
        if (node.comfyClass !== NODE_TYPE) continue;
        const items = node._primitiveItems;
        if (!items?.length) continue;

        let changed = false;
        for (const item of items) {
            if (item.type === "SEED" && item.mode === "random" && item.timing === timing) {
                item.value = randomSeed(item.max ?? 2 ** 53 - 1);
                changed = true;
            }
        }
        if (changed) syncOutputSlots(node, items);
    }
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// 拡張登録
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    setup() {
        // キュー登録時: 初回実行用に seed を生成
        const origQueuePrompt = app.queuePrompt?.bind(app);
        if (origQueuePrompt) {
            app.queuePrompt = async function (...args) {
                randomizeSeedsOnNodes("before");
                return origQueuePrompt(...args);
            };
        }

        // 実行完了時: 両タイミングを生成（複数キュー時に次の実行で異なる seed を保証）
        api.addEventListener("executing", (e) => {
            if (e.detail === null) {
                randomizeSeedsOnNodes("after");
                randomizeSeedsOnNodes("before");
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._primitiveItems = [];

            const hw = this.widgets?.find(w => w.name === "items_json");
            if (hw) hideWidget(hw);

            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--)
                this.removeOutput(i);

            this.addCustomWidget(makeStoreWidget(this));
            this.size[0] = Math.max(this.size[0], 260);
            this.size[1] = 1;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);

            const hw = this.widgets?.find(w => w.name === "items_json");
            if (hw) hideWidget(hw);

            let items = [];
            try {
                const raw = hw?.value ?? "[]";
                items = JSON.parse(raw);
            } catch { items = []; }

            this._primitiveItems = items;

            // ウィジェット再生成（クロージャが新しい _primitiveItems を参照するようにする）
            if (this.widgets) {
                const idx = this.widgets.findIndex(w => w.name === "__sax_pstore_widget");
                if (idx !== -1) this.widgets.splice(idx, 1);
            }
            this.addCustomWidget(makeStoreWidget(this));
            this.size[0] = Math.max(this.size[0], 260);

            // LiteGraph のリンク復元完了後にスロット同期・リンク記録
            setTimeout(() => {
                syncOutputSlots(this, items);
                captureOutputLinks(this, items);
            }, 0);
        };
    },
});
