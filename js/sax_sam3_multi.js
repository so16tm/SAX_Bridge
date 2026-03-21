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
 *   - Prompt text / param box ドラッグ  : 数値を連続調整（param のみ）
 *   - Prompt text / param box クリック  : 統合編集ダイアログを開く
 */

import { app } from "../../scripts/app.js";
import {
    PAD, ROW_H,
    rrect, txt, inX,
    drawPill, drawMoveArrows, drawDeleteBtn, drawParamBox,
    showDialog, h,
    getComfyTheme,
} from "./sax_ui_base.js";

const EXT_NAME   = "SAX.SAM3Multi";
const NODE_TYPE  = "SAX_Bridge_Segmenter_Multi";
const WIDGET_NAME = "__sax_sam3_segments";
const JSON_WIDGET = "segments_json";

// ── レイアウト定数 ────────────────────────────────────────────────────────────
const PILL_W  = 26;
const MODE_W  = 28;
const THR_W   = 42;
const PW_W    = 42;
const GROW_W  = 42;
const MOVE_W  = 20;
const DEL_W   = 20;
const G       = 4;
const ADD_H   = ROW_H;
const HDR_H   = 16;   // 列ラベルヘッダー高
const MIN_W   = 380;  // ノード最小幅

// ── デフォルトエントリー ──────────────────────────────────────────────────────
function makeEntry() {
    return { on: true, mode: "positive", prompt: "person",
             threshold: 0.2, presence_weight: 0.5, mask_grow: 0 };
}

// ── 行レイアウト計算 ──────────────────────────────────────────────────────────
function segRowLayout(W) {
    let rx = W - PAD;

    rx -= DEL_W;  const del_z = { x: rx, w: DEL_W  }; rx -= G;
    rx -= MOVE_W; const move  = { x: rx, w: MOVE_W }; rx -= G;
    rx -= GROW_W; const grow  = { x: rx, w: GROW_W }; rx -= G;
    rx -= PW_W;   const pw    = { x: rx, w: PW_W   }; rx -= G;
    rx -= THR_W;  const thr   = { x: rx, w: THR_W  }; rx -= G;

    let lx = PAD + G;
    const pill   = { x: lx, w: PILL_W }; lx += PILL_W + G;
    const mode   = { x: lx, w: MODE_W }; lx += MODE_W + G;
    const prompt = { x: lx, w: Math.max(0, rx - lx) };

    return { pill, mode, prompt, thr, pw, grow, move, del: del_z };
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
    document.querySelectorAll(".__sax_sam3_edit_dlg").forEach(e => e.remove());

    // ローカルコピーで編集（Cancelで破棄）
    const ed = {
        prompt:          item.prompt          ?? "",
        mode:            item.mode            ?? "positive",
        threshold:       item.threshold       ?? 0.2,
        presence_weight: item.presence_weight ?? 0.5,
        mask_grow:       item.mask_grow       ?? 0,
    };

    const labelStyle =
        "font-size:10px;color:var(--border-color,#4e4e4e);" +
        "text-transform:uppercase;letter-spacing:0.05em;" +
        "min-width:110px;flex-shrink:0;align-self:center;";

    const inputStyle =
        "flex:1;background:var(--comfy-input-bg,#222);" +
        "border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;" +
        "color:var(--input-text,#ddd);padding:6px;font-size:13px;" +
        "outline:none;text-align:center;min-width:0;";

    const btnSmStyle =
        "width:34px;height:30px;flex-shrink:0;" +
        "background:var(--comfy-input-bg,#222);" +
        "border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;" +
        "color:var(--input-text,#ddd);font-size:18px;cursor:pointer;" +
        "display:flex;align-items:center;justify-content:center;padding:0;";

    // 数値行ファクトリ
    function numRow(label, key, min, max, step, dec) {
        const row = h("div", "display:flex;align-items:center;gap:6px;");
        row.appendChild(h("div", labelStyle, label));

        const minus = h("button", btnSmStyle, "−");
        const plus  = h("button", btnSmStyle, "+");
        const inp   = h("input", inputStyle);
        inp.type = "text";
        inp.inputMode = dec > 0 ? "decimal" : "numeric";
        inp.value = Number(ed[key]).toFixed(dec);

        const set = (v) => {
            v = Math.max(min, Math.min(max, v));
            if (dec === 0) v = Math.round(v);
            else           v = Math.round(v / step) * step;
            ed[key]   = v;
            inp.value = v.toFixed(dec);
        };

        inp.addEventListener("change", () => {
            const v = parseFloat(inp.value);
            set(isNaN(v) ? ed[key] : v);
        });

        // 長押し auto-repeat
        let _ht = null, _hi = null;
        const stopHold = () => {
            clearTimeout(_ht); clearInterval(_hi);
            _ht = _hi = null;
            window.removeEventListener("pointerup",     stopHold, { capture: true });
            window.removeEventListener("pointercancel", stopHold, { capture: true });
        };
        const startHold = (d) => {
            stopHold();
            set(ed[key] + d);
            _ht = setTimeout(() => { _hi = setInterval(() => set(ed[key] + d), 100); }, 400);
            window.addEventListener("pointerup",     stopHold, { capture: true });
            window.addEventListener("pointercancel", stopHold, { capture: true });
        };
        minus.addEventListener("pointerdown", e => { e.preventDefault(); startHold(-step); });
        plus.addEventListener( "pointerdown", e => { e.preventDefault(); startHold(+step); });

        row.appendChild(minus);
        row.appendChild(inp);
        row.appendChild(plus);
        return row;
    }

    showDialog({
        title:     "Edit Segment",
        width:     380,
        gap:       10,
        className: "__sax_sam3_edit_dlg",
        build(dlg, close) {
            // Prompt
            const promptRow = h("div", "display:flex;align-items:center;gap:6px;");
            promptRow.appendChild(h("div", labelStyle, "Prompt"));
            const promptInp = h("input",
                "flex:1;background:var(--comfy-input-bg,#222);" +
                "border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;" +
                "color:var(--input-text,#ddd);padding:6px;font-size:13px;outline:none;min-width:0;");
            promptInp.type  = "text";
            promptInp.value = ed.prompt;
            promptInp.addEventListener("input", () => { ed.prompt = promptInp.value; });
            promptRow.appendChild(promptInp);
            dlg.appendChild(promptRow);

            // Mode
            const modeRow = h("div", "display:flex;align-items:center;gap:6px;");
            modeRow.appendChild(h("div", labelStyle, "Mode"));
            const modeGroup = h("div", "display:flex;gap:6px;flex:1;");
            let posBtn, negBtn;

            const refreshMode = () => {
                [["positive", posBtn], ["negative", negBtn]].forEach(([val, btn]) => {
                    const active = ed.mode === val;
                    const color  = val === "positive" ? "#3a8" : "#a33";
                    btn.style.background   = active ? color : "var(--comfy-input-bg,#222)";
                    btn.style.borderColor  = active ? color : "var(--content-bg,#4e4e4e)";
                    btn.style.color        = active ? "#fff" : "var(--input-text,#ddd)";
                    btn.style.fontWeight   = active ? "bold" : "normal";
                });
            };

            const makeModeBtn = (label, val) => {
                const btn = h("button",
                    "flex:1;padding:6px;border-radius:4px;cursor:pointer;font-size:12px;" +
                    "border:1px solid;transition:background 0.1s;",
                    label);
                btn.addEventListener("click", () => { ed.mode = val; refreshMode(); });
                return btn;
            };
            posBtn = makeModeBtn("＋ Positive", "positive");
            negBtn = makeModeBtn("－ Negative", "negative");
            modeGroup.appendChild(posBtn);
            modeGroup.appendChild(negBtn);
            modeRow.appendChild(modeGroup);
            dlg.appendChild(modeRow);
            refreshMode();

            // Numeric rows
            dlg.appendChild(numRow("Threshold",        "threshold",       0,    1,   0.01, 2));
            dlg.appendChild(numRow("Presence Weight",  "presence_weight", 0,    1,   0.05, 2));
            dlg.appendChild(numRow("Mask Grow",        "mask_grow",       -512, 512, 1,    0));

            // OK / Cancel
            const footRow = h("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:2px;");
            const cancelBtn = h("button",
                "padding:7px 20px;border-radius:4px;border:1px solid var(--border-color,#4e4e4e);" +
                "background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);cursor:pointer;",
                "Cancel");
            const okBtn = h("button",
                "padding:7px 20px;border-radius:4px;border:none;" +
                "background:var(--primary-background,#0b8ce9);color:#fff;cursor:pointer;font-weight:bold;",
                "OK");
            cancelBtn.addEventListener("click", close);
            okBtn.addEventListener("click", () => {
                ed.prompt = promptInp.value.trim();
                Object.assign(item, ed);
                saveItems(node, items);
                app.graph.setDirtyCanvas(true, false);
                close();
            });
            promptInp.addEventListener("keydown", e => {
                if (e.key === "Enter")  okBtn.click();
                if (e.key === "Escape") close();
            });
            footRow.appendChild(cancelBtn);
            footRow.appendChild(okBtn);
            dlg.appendChild(footRow);

            requestAnimationFrame(() => { promptInp.focus(); promptInp.select(); });
        },
    });
}

// ── カスタムウィジェット ──────────────────────────────────────────────────────
function makeSam3Widget(node) {
    let _dragState = null; // { rowIndex, param, startY, startVal, dragged, cleanup }

    return {
        name:  WIDGET_NAME,
        type:  WIDGET_NAME,
        value: null,
        _y:    0,

        computeSize(W) {
            const items = getItems(node);
            return [W, HDR_H + items.length * ROW_H + ADD_H];
        },

        draw(ctx, n, W, y) {
            this._y = y;
            const items = getItems(n);
            const L     = segRowLayout(W);
            const t     = getComfyTheme();

            // 列ラベルヘッダー
            const hY = y + HDR_H / 2;
            txt(ctx, "thr",  L.thr.x  + L.thr.w  / 2, hY, t.border, "center", 9);
            txt(ctx, "p.w.", L.pw.x   + L.pw.w   / 2, hY, t.border, "center", 9);
            txt(ctx, "grow", L.grow.x + L.grow.w / 2, hY, t.border, "center", 9);

            // アイテム行
            const itemsY = y + HDR_H;
            items.forEach((item, i) => {
                const rowY = itemsY + i * ROW_H;
                const midY = rowY + ROW_H / 2;
                const on   = item.on ?? true;

                rrect(ctx, PAD, rowY + 2, W - PAD * 2, ROW_H - 4,
                    (ROW_H - 4) / 2, t.inputBg, t.contentBg);

                drawPill(ctx, L.pill.x, midY, on);
                drawModeBadge(ctx, L.mode.x, midY, L.mode.w, item.mode || "positive");

                if (L.prompt.w > 10) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(L.prompt.x, rowY, L.prompt.w, ROW_H);
                    ctx.clip();
                    txt(ctx, item.prompt || "— click to edit —", L.prompt.x + 4, midY,
                        (item.prompt) ? (on ? t.inputText : t.border) : t.contentBg,
                        "left", 11);
                    ctx.restore();
                }

                const thrA  = _dragState?.rowIndex === i && _dragState?.param === "thr";
                const pwA   = _dragState?.rowIndex === i && _dragState?.param === "pw";
                const growA = _dragState?.rowIndex === i && _dragState?.param === "grow";

                drawParamBox(ctx, L.thr.x,  rowY, L.thr.w,  ROW_H,
                    (item.threshold       ?? 0.2).toFixed(2), thrA);
                drawParamBox(ctx, L.pw.x,   rowY, L.pw.w,   ROW_H,
                    (item.presence_weight ?? 0.5).toFixed(2), pwA);
                drawParamBox(ctx, L.grow.x, rowY, L.grow.w, ROW_H,
                    String(Math.round(item.mask_grow ?? 0)), growA);

                drawMoveArrows(ctx, L.move.x, rowY, ROW_H, i > 0, i < items.length - 1);
                drawDeleteBtn(ctx, L.del.x, midY);
            });

            // Add ボタン
            const btnY   = itemsY + items.length * ROW_H;
            const canAdd = items.length < 20;
            rrect(ctx, PAD, btnY + 2, W - PAD * 2, ADD_H - 4, 4,
                canAdd ? t.inputBg : t.menuBg,
                canAdd ? t.contentBg : t.border);
            txt(ctx, "+ Add Segment", W / 2, btnY + ADD_H / 2,
                canAdd ? t.inputText : t.border, "center", 11);
        },

        mouse(event, pos, n) {
            if (event.type !== "pointerdown") return false;

            const items  = getItems(n);
            const W      = n.size[0];
            const L      = segRowLayout(W);
            const localY = pos[1] - this._y - HDR_H;
            const rowIdx = Math.floor(localY / ROW_H);

            if (localY < 0) return false;

            // ── Add ボタン ───────────────────────────────────────────────
            if (rowIdx === items.length) {
                if (items.length >= 20) return true;
                items.push(makeEntry());
                saveItems(n, items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            if (rowIdx < 0 || rowIdx >= items.length) return false;
            const item = items[rowIdx];

            // ── Delete ───────────────────────────────────────────────────
            if (inX(pos, L.del.x, L.del.w)) {
                items.splice(rowIdx, 1);
                saveItems(n, items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Move arrows ──────────────────────────────────────────────
            if (inX(pos, L.move.x, L.move.w)) {
                const relY = localY - rowIdx * ROW_H;
                if (relY < ROW_H / 2 && rowIdx > 0) {
                    [items[rowIdx - 1], items[rowIdx]] = [items[rowIdx], items[rowIdx - 1]];
                } else if (relY >= ROW_H / 2 && rowIdx < items.length - 1) {
                    [items[rowIdx], items[rowIdx + 1]] = [items[rowIdx + 1], items[rowIdx]];
                }
                saveItems(n, items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Param box ドラッグ ────────────────────────────────────────
            // クリック（非ドラッグ）では統合ダイアログを開く
            const paramDef =
                inX(pos, L.thr.x,  L.thr.w)  ? { key: "thr",  field: "threshold",       step: 0.01, scale: 0.005 } :
                inX(pos, L.pw.x,   L.pw.w)   ? { key: "pw",   field: "presence_weight", step: 0.05, scale: 0.005 } :
                inX(pos, L.grow.x, L.grow.w) ? { key: "grow", field: "mask_grow",       step: 1,    scale: 0.5   } :
                null;

            if (paramDef) {
                if (_dragState) { _dragState.cleanup(); _dragState = null; }

                const startY   = event.clientY;
                const startVal = item[paramDef.field] ?? 0;
                let dragged    = false;
                _dragState     = { rowIndex: rowIdx, param: paramDef.key };

                const min = paramDef.field === "mask_grow" ? -512 : 0;
                const max = paramDef.field === "mask_grow" ? 512  : 1;

                let ended = false;
                const onMove = (e) => {
                    if (ended) return;
                    const dy = startY - e.clientY;
                    if (!dragged && Math.abs(dy) < 3) return;
                    dragged = true;
                    let v = startVal + dy * paramDef.scale;
                    v = Math.max(min, Math.min(max, v));
                    if (paramDef.step >= 1) v = Math.round(v);
                    item[paramDef.field] = v;
                    saveItems(n, items);
                    app.graph.setDirtyCanvas(true, false);
                };
                const endDrag = (e) => {
                    if (ended) return;
                    ended = true;
                    const wasDragged = dragged;
                    _dragState = null;
                    window.removeEventListener("pointermove",   onMove);
                    window.removeEventListener("pointerup",     endDrag, { capture: true });
                    window.removeEventListener("pointercancel", endDrag, { capture: true });
                    app.graph.setDirtyCanvas(true, false);
                    // クリック（非ドラッグ）→ 統合編集ダイアログ
                    if (!wasDragged && e?.type === "pointerup") {
                        showEditDialog(n, items, rowIdx);
                    }
                };
                _dragState.cleanup = () => endDrag(null);
                window.addEventListener("pointermove",   onMove);
                window.addEventListener("pointerup",     endDrag, { capture: true });
                window.addEventListener("pointercancel", endDrag, { capture: true });
                return true;
            }

            // ── Mode badge ── 直接切り替え（クイックアクション）─────────
            if (inX(pos, L.mode.x, L.mode.w)) {
                item.mode = (item.mode === "negative") ? "positive" : "negative";
                saveItems(n, items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Toggle pill ── 直接切り替え ──────────────────────────────
            if (inX(pos, L.pill.x, L.pill.w + 6)) {
                item.on = !(item.on ?? true);
                saveItems(n, items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Prompt 領域クリック → 統合編集ダイアログ ─────────────────
            if (inX(pos, L.prompt.x, L.prompt.w)) {
                showEditDialog(n, items, rowIdx);
                return true;
            }

            return false;
        },
    };
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

    // カスタムウィジェットを追加
    node.addCustomWidget(makeSam3Widget(node));

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
