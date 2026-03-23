import { app } from "../../scripts/app.js";
import {
    PAD, ROW_H, BOTTOM_PAD, ADD_H,
    txt, rrect,
    makeItemListWidget, showItemEditDialog, getComfyTheme,
    captureOutputLinks, restoreOutputLinks,
} from "./sax_ui_base.js";

const EXT_NAME  = "SAX.PrimitiveStore";
const NODE_TYPE = "SAX_Bridge_Primitive_Store";
const MAX_ITEMS = 32;

/** step の小数桁数を返す（浮動小数点丸め用）*/
function stepDecimals(step) {
    const s = step.toFixed(10).replace(/0+$/, "");
    const d = s.indexOf(".");
    return d === -1 ? 0 : s.length - d - 1;
}

// ---------------------------------------------------------------------------
// ウィジェット非表示ユーティリティ
// ---------------------------------------------------------------------------

/** ウィジェットを視覚的に完全非表示にする。
 *  type は変更しない（変更すると ComfyUI がプロンプト収集でスキップする）。 */
function hideWidget(widget) {
    widget.computeSize = () => [0, -4];
    widget.draw        = () => {};
}

// ---------------------------------------------------------------------------
// 型メタデータ
// ---------------------------------------------------------------------------

const TYPE_META = {
    INT:     { badge: "INT", color: "#3a7bd5" },
    FLOAT:   { badge: "FLT", color: "#2d9e6b" },
    STRING:  { badge: "STR", color: "#c47c22" },
    BOOLEAN: { badge: "BOL", color: "#8c52c7" },
};

// ---------------------------------------------------------------------------
// アイテムファクトリ
// ---------------------------------------------------------------------------

function makeDefaultItem(type, name) {
    const base = { type, name };
    switch (type) {
        case "INT":     return { ...base, value: 0,     min: -(2 ** 31),    max: 2 ** 31 - 1,  step: 1   };
        case "FLOAT":   return { ...base, value: 0.0,   min: -1_000_000,    max: 1_000_000,    step: 0.1 };
        case "STRING":  return { ...base, value: ""  };
        case "BOOLEAN": return { ...base, value: false };
        default:        return { ...base, value: 0   };
    }
}

// ---------------------------------------------------------------------------
// アイテムストア（アクセサ）
// ---------------------------------------------------------------------------

function getNodeItems(node) {
    return node._primitiveItems ?? [];
}

// ---------------------------------------------------------------------------
// 出力スロット同期
// ---------------------------------------------------------------------------

function syncOutputSlots(node, items) {
    // スロット数を items.length に合わせる
    while ((node.outputs?.length ?? 0) > items.length)
        node.removeOutput(node.outputs.length - 1);
    while ((node.outputs?.length ?? 0) < items.length)
        node.addOutput("", "*");

    // 各スロットの名前・型を同期
    for (let i = 0; i < items.length; i++) {
        node.outputs[i].name = items[i].name;
        node.outputs[i].type = items[i].type;
    }

    // hidden widget に JSON を書き込む（Python への値渡し）
    // _links は内部管理用プロパティのため JSON から除外する
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

/** アイテム追加ダイアログ */
function showAddDialog(node, saveItems) {
    showItemEditDialog({
        title:     "Add Parameter",
        width:     340,
        className: "__sax_pstore_add",
        fields: [
            {
                key:     "type",
                label:   "Type",
                type:    "select",
                options: Object.entries(TYPE_META).map(([k, v]) => ({
                    value: k,
                    label: v.badge,   // 短縮形（"INT","FLT","STR","BOL"）でボタン幅を揃える
                    color: v.color,
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

/** 数値型（INT / FLOAT）の値・min/max/step 編集ポップアップ */
function showNumericEditPopup(item, saveItemsFn) {
    const isInt = item.type === "INT";
    const dec   = isInt ? 0 : 4;
    showItemEditDialog({
        title:     item.name,
        width:     300,
        className: "__sax_pstore_edit",
        // ダイアログを開く時点の min/max でクランプ（ダイアログ内で変更しても動的に追従しないが
        // onCommit でも再クランプするため問題なし）
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
                // value を新しい min/max でクランプ
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

/** STRING 型の値編集ダイアログ */
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

// ---------------------------------------------------------------------------
// 型バッジ描画
// ---------------------------------------------------------------------------

function drawTypeBadge(ctx, item, x, midY, w, h) {
    const meta  = TYPE_META[item.type] ?? { badge: "???", color: "#555" };
    // drawParamBox と高さを揃える（h-8 = 16px at ROW_H=24）
    // 左端は行背景の角丸の内側に収まるよう x+4 に寄せる
    const bh    = h - 8;
    const bw    = w - 8;
    rrect(ctx, x + 4, midY - bh / 2, bw, bh, 3, meta.color, meta.color);
    ctx.save();
    ctx.fillStyle    = "#fff";
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
    // node._primitiveItems を正規ストアとして直接参照する（クロージャの stale 問題を回避）
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
                // 型変更は不可（クリックしても何もしない）
            },
        ],

        params: [
            {
                key:  "value",
                w:    56,
                get:  item => item.value,
                set:  (item, v) => {
                    if (item.type === "BOOLEAN" || item.type === "STRING") return;
                    const min  = item.min  ?? (item.type === "INT" ? -(2 ** 31) : -1e9);
                    const max  = item.max  ?? (item.type === "INT" ? 2 ** 31 - 1 : 1e9);
                    const step = item.step ?? (item.type === "INT" ? 1 : 0.1);
                    // step スナップ後にクランプ、FLOAT は toFixed で浮動小数点誤差を除去
                    const snapped  = Math.round((v - min) / step) * step + min;
                    const clamped  = Math.max(min, Math.min(max, snapped));
                    if (item.type === "INT") {
                        item.value = Math.round(clamped);
                    } else {
                        const dec  = stepDecimals(step);
                        item.value = parseFloat(clamped.toFixed(dec));
                    }
                },
                format: v => {
                    if (typeof v === "boolean") return v ? "ON" : "OFF";
                    if (typeof v === "string")  return v.length > 9 ? v.slice(0, 8) + "…" : (v || "―");
                    if (typeof v === "number")  return Number.isInteger(v) ? String(v) : v.toFixed(3);
                    return String(v);
                },
                // INT は step の半分、FLOAT は step の 1/10、STRING/BOOLEAN は事実上無効
                dragScale: item => {
                    if (item.type === "INT")   return (item.step ?? 1) * 0.5;
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
                    showNumericEditPopup(item, () => saveItems(getItems()));
                },
            },
        ],

        content: {
            draw(ctx, item, x, y, w, h) {
                const t = getComfyTheme();
                txt(ctx, item.name, x + 4, y + h / 2, t.inputText ?? t.contentBg, "left", 11);
            },
        },

        hasMoveUpDown: true,
        hasDelete:     true,

        addButton: {
            label: "Add parameter",
            onAdd: (n, _items2, _save) => showAddDialog(node, saveItems),
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

        // --- onNodeCreated ---
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._primitiveItems = [];

            // Python が定義する "items_json" hidden widget を探して hidden に設定
            // （ComfyUI が INPUT_TYPES から自動生成する STRING ウィジェット）
            const hw = this.widgets?.find(w => w.name === "items_json");
            if (hw) hideWidget(hw);

            // 出力スロットは最初なし（アイテム追加で増える）
            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--)
                this.removeOutput(i);

            this.addCustomWidget(makeStoreWidget(this));
            this.size[0] = Math.max(this.size[0], 260);
            this.size[1] = 1;
        };

        // --- onConfigure ---
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);

            // hidden widget から items を復元
            const hw = this.widgets?.find(w => w.name === "items_json");
            if (hw) hideWidget(hw);

            let items = [];
            try {
                const raw = hw?.value ?? "[]";
                items = JSON.parse(raw);
            } catch { items = []; }

            this._primitiveItems = items;

            // ウィジェットを再生成（getItems が node._primitiveItems を参照するため
            // 既存ウィジェットを削除して新規作成することでクロージャを刷新する）
            if (this.widgets) {
                const idx = this.widgets.findIndex(w => w.name === "__sax_pstore_widget");
                if (idx !== -1) this.widgets.splice(idx, 1);
            }
            this.addCustomWidget(makeStoreWidget(this));
            this.size[0] = Math.max(this.size[0], 260);

            // 出力スロットを items に合わせて同期し、LiteGraph 復元後のリンクを記録
            setTimeout(() => {
                syncOutputSlots(this, items);
                captureOutputLinks(this, items);
            }, 0);
        };
    },
});
