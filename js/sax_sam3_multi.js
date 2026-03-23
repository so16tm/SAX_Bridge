/**
 * sax_sam3_multi.js — SAX SAM3 Multi Segmenter カスタムウィジェット
 *
 * SAX_Bridge_Segmenter_Multi ノードのセグメントエントリーリストを
 * Canvas UI として管理する。
 *
 * 各行:
 *   [toggle pill] [mode badge] [prompt text] [thr] [p.w.] [grow] [▲▼] [✕]
 *
 * インタラクション:
 *   - Toggle pill / mode badge クリック : 直接切り替え
 *   - Param box ドラッグ               : 数値を連続調整
 *   - Prompt text / param box クリック : 統合編集ダイアログを開く
 */

import { app } from "../../scripts/app.js";
import {
    makeItemListWidget,
    showItemEditDialog,
    getComfyTheme,
    rrect,
    txt,
} from "./sax_ui_base.js";

const EXT_NAME    = "SAX.SAM3Multi";
const NODE_TYPE   = "SAX_Bridge_Segmenter_Multi";
const WIDGET_NAME = "__sax_sam3_segments";
const JSON_WIDGET = "segments_json";
const MIN_W       = 380;

// ── デフォルトエントリー ──────────────────────────────────────────────────────
function makeEntry() {
    return { on: true, mode: "positive", prompt: "person",
             threshold: 0.2, presence_weight: 0.5, mask_grow: 0 };
}

// ── アイテム取得 / 保存 ───────────────────────────────────────────────────────
function getItems(node) {
    const w = node.widgets?.find(w => w.name === JSON_WIDGET);
    if (!w) return [];
    try { return JSON.parse(w.value) || []; } catch { return []; }
}

function saveItems(node, items) {
    const w = node.widgets?.find(w => w.name === JSON_WIDGET);
    if (w) { w.value = JSON.stringify(items); w.callback?.(w.value); }
}

// ── モードバッジ描画 ─────────────────────────────────────────────────────────
function drawModeBadge(ctx, x, midY, w, mode) {
    const bH = 14, bY = midY - 7;
    rrect(ctx, x, bY, w, bH, 3, mode === "positive" ? "#3a8" : "#a33", null);
    txt(ctx, mode === "positive" ? "＋" : "－", x + w / 2, midY, "#fff", "center", 10);
}

// ── 統合編集ダイアログ ────────────────────────────────────────────────────────
function showEditDialog(node, items, rowIndex) {
    const item = items[rowIndex];
    showItemEditDialog({
        title:     "Edit Segment",
        className: "__sax_sam3_edit_dlg",
        fields: [
            { type: "text",   key: "prompt",          label: "Prompt" },
            { type: "select", key: "mode",             label: "Mode",
              options: [
                  { value: "positive", label: "＋ Positive", color: "#3a8" },
                  { value: "negative", label: "－ Negative", color: "#a33" },
              ]},
            { type: "number", key: "threshold",       label: "Threshold",       min: 0,    max: 1,   step: 0.01, decimals: 2 },
            { type: "number", key: "presence_weight", label: "Presence Weight", min: 0,    max: 1,   step: 0.05, decimals: 2 },
            { type: "number", key: "mask_grow",       label: "Mask Grow",       min: -512, max: 512, step: 1,    decimals: 0 },
        ],
        data: {
            prompt:          item.prompt          ?? "",
            mode:            item.mode            ?? "positive",
            threshold:       item.threshold       ?? 0.2,
            presence_weight: item.presence_weight ?? 0.5,
            mask_grow:       item.mask_grow       ?? 0,
        },
        onCommit(ed) {
            Object.assign(item, ed);
            saveItems(node, items);
            app.graph.setDirtyCanvas(true, false);
        },
    });
}

// ── UI 構築 ───────────────────────────────────────────────────────────────────
function buildUI(node) {
    // segments_json ウィジェットを完全に非表示化
    const jsonW = node.widgets?.find(w => w.name === JSON_WIDGET);
    if (jsonW && !jsonW._saxHidden) {
        jsonW._saxHidden  = true;
        jsonW.computeSize = () => [0, -4];
        jsonW.draw        = () => {};
        jsonW.mouse       = () => false;
        if (jsonW.element) jsonW.element.style.display = "none";
    }

    // 既存のカスタムウィジェットを除去し segments_json のみ保持
    node.widgets = (node.widgets ?? []).filter(w => w.name === JSON_WIDGET);

    // makeItemListWidget で SAM3 セグメントリスト UI を構築
    node.addCustomWidget(makeItemListWidget({
        widgetName:    WIDGET_NAME,
        getItems:      () => getItems(node),
        saveItems:     (items) => saveItems(node, items),
        maxItems:      20,
        hasToggle:     true,
        hasMoveUpDown: true,
        hasDelete:     true,

        leftElements: [
            {
                key: "mode",
                w:   28,
                draw(ctx, item, x, midY) {
                    drawModeBadge(ctx, x, midY, 28, item.mode || "positive");
                },
                onClick(item) {
                    item.mode = (item.mode === "negative") ? "positive" : "negative";
                    return true;
                },
            },
        ],

        params: [
            {
                key:       "thr",
                label:     "thr",
                w:         42,
                get:       item => item.threshold ?? 0.2,
                set:       (item, v) => { item.threshold = v; },
                min:       0, max: 1, step: 0.01,
                dragScale: 0.005,
                format:    v => v.toFixed(2),
                onPopup:   (item, idx, n) => showEditDialog(n, getItems(n), idx),
            },
            {
                key:       "pw",
                label:     "p.w.",
                w:         42,
                get:       item => item.presence_weight ?? 0.5,
                set:       (item, v) => { item.presence_weight = v; },
                min:       0, max: 1, step: 0.05,
                dragScale: 0.005,
                format:    v => v.toFixed(2),
                onPopup:   (item, idx, n) => showEditDialog(n, getItems(n), idx),
            },
            {
                key:       "grow",
                label:     "grow",
                w:         42,
                get:       item => item.mask_grow ?? 0,
                set:       (item, v) => { item.mask_grow = Math.round(v); },
                min:       -512, max: 512, step: 1,
                dragScale: 0.5,
                format:    v => String(Math.round(v)),
                onPopup:   (item, idx, n) => showEditDialog(n, getItems(n), idx),
            },
        ],

        content: {
            draw(ctx, item, x, y, w, h, on) {
                if (w <= 10) return;
                const t    = getComfyTheme();
                const midY = y + h / 2;
                txt(ctx, item.prompt || "— click to edit —", x + 4, midY,
                    item.prompt ? (on ? t.inputText : t.border) : t.contentBg,
                    "left", 11);
            },
            onClick(item, idx, n) {
                showEditDialog(n, getItems(n), idx);
            },
        },

        addButton: {
            onCreate: () => makeEntry(),
        },
    }));

    // 最小幅・高さを設定
    const [, newH] = node.computeSize();
    node.size[0] = Math.max(node.size[0], MIN_W);
    node.size[1] = Math.max(newH, 80);
    app.graph.setDirtyCanvas(true, false);
}

// ── エクステンション登録 ──────────────────────────────────────────────────────
app.registerExtension({
    name: EXT_NAME,
    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        buildUI(node);
    },
});
