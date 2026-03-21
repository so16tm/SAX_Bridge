/**
 * sax_ui_base.js — SAX シリーズ共通 Canvas UI テンプレート
 *
 * Exports:
 *   PAD, ROW_H
 *   rrect(ctx, x, y, w, h, r, fill, stroke)
 *   txt(ctx, s, x, y, color, align, size)
 *   inX(pos, x, w)
 *   drawPill(ctx, x, midY, on)
 *   drawMoveArrows(ctx, x, y, h, canUp, canDown)
 *   drawDeleteBtn(ctx, x, midY)
 *   drawParamBox(ctx, x, y, w, h, text, active)
 *   rowLayout(W, flags)
 *   showParamPopup(screenX, screenY, currentVal, cfg, onCommit)
 *   makeItemListWidget(node, spec)
 */

import { app } from "../../scripts/app.js";

export const PAD   = 8;
export const ROW_H = 24;

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

export function rrect(ctx, x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y,     x + w, y + r,     r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x,     y + h, x,     y + h - r, r);
        ctx.lineTo(x,     y + r);
        ctx.arcTo(x,     y,     x + r, y,         r);
        ctx.closePath();
    }
    if (fill)   { ctx.fillStyle = fill;     ctx.fill();   }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

export function txt(ctx, s, x, y, color, align = "left", size = 11) {
    ctx.font        = `${size}px sans-serif`;
    ctx.fillStyle   = color;
    ctx.textAlign   = align;
    ctx.textBaseline = "middle";
    ctx.fillText(s, x, y);
}

/** pos = [x, y] がエリア [x0, x0+w] 内かどうか */
export function inX(pos, x0, w) {
    return pos[0] >= x0 && pos[0] <= x0 + w;
}

// ---------------------------------------------------------------------------
// 共通 UI パーツ描画
// ---------------------------------------------------------------------------

/** トグル pill を描画。x: pill 左端、midY: 行中央Y */
export function drawPill(ctx, x, midY, on) {
    const pW = 26, pH = 14;
    const pY = midY - pH / 2;
    rrect(ctx, x, pY, pW, pH, 7,
        on ? "#1e5a32" : "#5a1e1e",
        on ? "#2a8a4a" : "#8a2a2a");
    const kX = on ? x + pW - 12 : x + 2;
    rrect(ctx, kX, pY + 3, 8, 8, 4, "#fff", null);
}

/** ▲▼ 移動矢印を描画。x: エリア左端、y: 行上端、h: 行高 */
export function drawMoveArrows(ctx, x, y, h, canUp, canDown) {
    txt(ctx, "▲", x + 10, y + h / 4,     canUp   ? "#888" : "#383838", "center", 9);
    txt(ctx, "▼", x + 10, y + h * 3 / 4, canDown ? "#888" : "#383838", "center", 9);
}

/** ✕ 削除ボタンを描画。x: エリア左端、midY: 行中央Y */
export function drawDeleteBtn(ctx, x, midY) {
    txt(ctx, "✕", x + 10, midY, "#666", "center", 10);
}

/**
 * パラメータ値ボックスを描画。
 * x: ボックス左端、y: 行上端、w: 幅、h: 行高、active: ドラッグ中かどうか
 */
export function drawParamBox(ctx, x, y, w, h, text, active) {
    rrect(ctx, x, y + 3, w, h - 6, 3,
        active ? "#1a2a3e" : "#1a1a2a",
        active ? "#4a8acc" : "#3a3a5a");
    txt(ctx, text, x + w / 2, y + h / 2, active ? "#aef" : "#88a", "center", 11);
}

// ---------------------------------------------------------------------------
// Layout calculator
// ---------------------------------------------------------------------------

/**
 * rowLayout — 右端から del → move → param を確保し、残りを content 幅とする。
 *
 * @param {number} W - ウィジェット全幅（node.size[0] をそのまま渡す）
 * @param {{ hasToggle?, hasParam?, hasMoveUpDown?, hasDelete? }} flags
 * @returns {{
 *   pill?:    { x: number, w: number },
 *   contentX: number,
 *   contentW: number,
 *   param?:   { x: number, w: number },
 *   move?:    { x: number, w: number },
 *   del?:     { x: number, w: number },
 * }}
 */
export function rowLayout(W, {
    hasToggle     = false,
    hasParam      = false,
    hasMoveUpDown = false,
    hasDelete     = false,
} = {}) {
    const layout = {};

    // 左側: pill があれば確保し、content の開始 X を決める
    let lx = PAD;
    if (hasToggle) {
        layout.pill = { x: lx, w: 26 };
        lx += 26 + 4;   // pill 幅 + ギャップ
    }
    layout.contentX = lx;

    // 右側: 内側に向かって del → move → param を積む
    let rx = W - PAD;

    if (hasDelete) {
        rx -= 20;
        layout.del = { x: rx, w: 20 };
        rx -= 4;
    }
    if (hasMoveUpDown) {
        rx -= 20;
        layout.move = { x: rx, w: 20 };
        rx -= 4;
    }
    if (hasParam) {
        rx -= 64;
        layout.param = { x: rx, w: 64 };
        rx -= 4;
    }

    layout.contentW = Math.max(0, rx - layout.contentX);

    return layout;
}

// ---------------------------------------------------------------------------
// パラメータ入力ポップアップ
// ---------------------------------------------------------------------------

/**
 * パラメータ直接入力用オーバーレイポップアップを表示する。
 *
 * @param {number} screenX - ポップアップを中央揃えする画面X座標
 * @param {number} screenY - ポップアップの下端に合わせる画面Y座標
 * @param {number} currentVal - 現在値
 * @param {{ min?, max?, step? }} cfg - 値の制約
 * @param {function(number)} onCommit - 確定時コールバック
 */
export function showParamPopup(screenX, screenY, currentVal, cfg, onCommit) {
    // 既存ポップアップを除去
    document.querySelectorAll(".__sax_param_popup").forEach(e => e.remove());

    const step     = cfg.step ?? 0.01;
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;

    const overlay = document.createElement("div");
    overlay.className = "__sax_param_popup";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10010;";

    const box = document.createElement("div");
    box.style.cssText =
        "position:absolute;background:#1a1a2e;border:1px solid #4a8acc;border-radius:8px;" +
        "padding:12px 14px;display:flex;flex-direction:column;gap:8px;" +
        "font:13px sans-serif;color:#ccc;box-shadow:0 4px 20px rgba(0,0,0,.7);min-width:200px;";

    // ラベル（cfg.label があれば表示）
    if (cfg.label) {
        const lbl = document.createElement("div");
        lbl.style.cssText = "font-size:11px;color:#556;text-transform:uppercase;letter-spacing:.06em;";
        lbl.textContent = cfg.label;
        box.appendChild(lbl);
    }

    // ±ボタン + 入力欄 行
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;align-items:stretch;gap:4px;";

    const btnStyle =
        "width:44px;background:#1e2a3e;border:1px solid #3a5a8a;border-radius:5px;" +
        "color:#7ac8ff;font-size:24px;cursor:pointer;display:flex;align-items:center;" +
        "justify-content:center;user-select:none;flex-shrink:0;padding:0;line-height:1;";

    const minusBtn = document.createElement("button");
    minusBtn.style.cssText = btnStyle;
    minusBtn.textContent = "−";

    const plusBtn = document.createElement("button");
    plusBtn.style.cssText = btnStyle;
    plusBtn.textContent = "+";

    const input = document.createElement("input");
    input.type      = "text";
    input.inputMode = "decimal";
    input.value     = currentVal.toFixed(decimals);
    input.style.cssText =
        "flex:1;background:#0e0e20;border:1px solid #3a3a5a;border-radius:5px;" +
        "color:#fff;padding:8px;font-size:20px;font-weight:bold;outline:none;" +
        "text-align:center;min-width:0;";

    btnRow.appendChild(minusBtn);
    btnRow.appendChild(input);
    btnRow.appendChild(plusBtn);
    box.appendChild(btnRow);

    // ヒント
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:#445;text-align:center;";
    hint.textContent   = `${cfg.min ?? "−∞"} – ${cfg.max ?? "+∞"}  ·  Enter to confirm`;
    box.appendChild(hint);

    // append 前に概算位置を設定（二重クリック時の即閉じ防止）
    const approxW = 220, approxH = 110;
    box.style.left = `${Math.max(4, Math.min(screenX - approxW / 2, window.innerWidth  - approxW - 4))}px`;
    box.style.top  = `${Math.max(4, Math.min(screenY - approxH - 6, window.innerHeight - approxH - 4))}px`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();

    // レイアウト確定後に正確な位置へ調整
    requestAnimationFrame(() => {
        const bw = box.offsetWidth;
        const bh = box.offsetHeight;
        let left = screenX - bw / 2;
        let top  = screenY - bh - 6;
        left = Math.max(4, Math.min(left, window.innerWidth  - bw - 4));
        top  = Math.max(4, Math.min(top,  window.innerHeight - bh - 4));
        box.style.left = `${left}px`;
        box.style.top  = `${top}px`;
    });

    // 値変更
    const applyDelta = (d) => {
        let val = parseFloat(input.value);
        if (isNaN(val)) val = currentVal;
        val += d;
        if (cfg.min != null) val = Math.max(cfg.min, val);
        if (cfg.max != null) val = Math.min(cfg.max, val);
        val = Math.round(val / step) * step;
        input.value = parseFloat(val.toFixed(decimals)).toFixed(decimals);
        input.select();
    };

    // 長押し auto-repeat
    let _holdTimer = null, _holdInterval = null;
    const stopHold = () => {
        clearTimeout(_holdTimer);
        clearInterval(_holdInterval);
        _holdTimer = _holdInterval = null;
        window.removeEventListener("pointerup",     stopHold, { capture: true });
        window.removeEventListener("pointercancel", stopHold, { capture: true });
    };
    const startHold = (d) => {
        stopHold();
        applyDelta(d);
        _holdTimer = setTimeout(() => {
            _holdInterval = setInterval(() => applyDelta(d), 100);
        }, 400);
        window.addEventListener("pointerup",     stopHold, { capture: true });
        window.addEventListener("pointercancel", stopHold, { capture: true });
    };

    minusBtn.addEventListener("pointerdown", e => { e.preventDefault(); startHold(-step); });
    plusBtn.addEventListener( "pointerdown", e => { e.preventDefault(); startHold(+step); });

    // confirm / cancel
    const close = () => { stopHold(); overlay.remove(); };
    const commit = () => {
        stopHold();
        const raw = parseFloat(input.value);
        if (!isNaN(raw)) {
            let val = raw;
            if (cfg.min != null) val = Math.max(cfg.min, val);
            if (cfg.max != null) val = Math.min(cfg.max, val);
            onCommit(parseFloat(val.toFixed(decimals)));
        }
        overlay.remove();
    };

    input.addEventListener("keydown", e => {
        if (e.key === "Enter")                              { e.preventDefault(); commit(); }
        if (e.key === "Escape")                             { close(); }
        if (e.key === "ArrowLeft"  || e.key === "ArrowDown")  { e.preventDefault(); applyDelta(-step); }
        if (e.key === "ArrowRight" || e.key === "ArrowUp")    { e.preventDefault(); applyDelta(+step); }
    });

    // ホイールで値増減
    overlay.addEventListener("wheel", e => {
        e.preventDefault();
        applyDelta((e.deltaY < 0 ? 1 : -1) * step);
    }, { passive: false });

    // 開いた直後の pointerdown では閉じない（二重クリック対策）
    let closeEnabled = false;
    requestAnimationFrame(() => { closeEnabled = true; });
    overlay.addEventListener("pointerdown", e => {
        if (!closeEnabled) return;
        if (e.target === overlay) close();
    });
}

// ---------------------------------------------------------------------------
// makeItemListWidget — アイテムリスト共通ウィジェットファクトリ
// ---------------------------------------------------------------------------

/**
 * アイテムリスト形式のカスタムウィジェットを生成して返す。
 *
 * @param {object} node - LiteGraph ノードオブジェクト
 * @param {{
 *   widgetName?:    string,
 *   getItems:       () => object[],
 *   saveItems:      (items: object[]) => void,
 *   maxItems?:      number,
 *   hasToggle?:     boolean,
 *   hasMoveUpDown?: boolean,
 *   hasDelete?:     boolean,
 *   hasParam?:      boolean,
 *   param?: {
 *     key:         string,
 *     get:         (item: object) => number,
 *     set:         (item: object, v: number) => void,
 *     min?:        number,
 *     max?:        number,
 *     step?:       number,
 *     format?:     (v: number) => string,
 *     dragScale?:  number,
 *   },
 *   content: {
 *     draw:    (ctx, item, x, y, w, h, on: boolean) => void,
 *     onClick?: (item, index, node) => void,
 *   },
 *   addButton?: {
 *     label:    string,
 *     onCreate: (node) => object | null,
 *   },
 * }} spec
 * @returns {object} LiteGraph custom widget
 */
export function makeItemListWidget(node, spec) {
    const {
        widgetName    = "__sax_item_list",
        getItems,
        saveItems,
        maxItems      = 20,
        hasToggle     = false,
        hasMoveUpDown = false,
        hasDelete     = false,
        hasParam      = false,
        param         = {},
        content,
        addButton     = null,
        enabledWidget = null,   // { name: string } — 指定時はヘッダー行に pill として表示
    } = spec;

    const ADD_H    = addButton ? ROW_H : 0;
    // enabledWidget または param.label があればヘッダー行を表示する
    const HEADER_H = (enabledWidget || (hasParam && param.label)) ? 20 : 0;

    // ドラッグ状態（クロージャで保持）
    let _dragIndex   = -1;   // draw() でのアクティブ表示に使用
    let _dragged     = false;
    let _moveCleanup = null; // 外部から強制終了できるクリーンアップ関数

    return {
        name:  widgetName,
        type:  widgetName,
        value: null,
        _y:    0,   // draw() で更新 → mouse() の相対 Y 計算に使用

        computeSize(W) {
            const items = getItems();
            return [W, HEADER_H + items.length * ROW_H + ADD_H];
        },

        draw(ctx, node, W, y) {
            this._y = y;
            const items  = getItems();
            const layout = rowLayout(W, { hasToggle, hasParam, hasMoveUpDown, hasDelete });

            // ヘッダー行（enabledWidget pill + param.label）
            if (HEADER_H > 0) {
                const headerMidY = y + HEADER_H / 2;
                if (enabledWidget) {
                    const ew = node.widgets?.find(w => w.name === enabledWidget.name);
                    drawPill(ctx, PAD, headerMidY, ew ? !!ew.value : true);
                }
                if (hasParam && param.label) {
                    txt(ctx, param.label,
                        layout.param.x + layout.param.w / 2,
                        headerMidY,
                        "#557", "center", 10);
                }
            }

            const itemsY = y + HEADER_H;
            items.forEach((item, i) => {
                const rowY = itemsY + i * ROW_H;
                const midY = rowY + ROW_H / 2;
                const on   = hasToggle ? (item.on ?? true) : true;

                // 行背景
                rrect(ctx, PAD, rowY + 1, W - PAD * 2, ROW_H - 2, 3,
                    i % 2 === 0 ? "#1c1c2c" : "#20202e", null);

                // Toggle pill
                if (layout.pill) {
                    drawPill(ctx, layout.pill.x, midY, on);
                }

                // Content（ノード固有の描画 — クリップ済み）
                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                content.draw(ctx, item, layout.contentX, rowY, layout.contentW, ROW_H, on);
                ctx.restore();

                // Param ボックス
                if (layout.param) {
                    const v    = param.get(item);
                    const text = param.format ? param.format(v) : v.toFixed(2);
                    drawParamBox(ctx,
                        layout.param.x, rowY, layout.param.w, ROW_H,
                        text, _dragIndex === i);
                }

                // Move arrows
                if (layout.move) {
                    drawMoveArrows(ctx, layout.move.x, rowY, ROW_H,
                        i > 0, i < items.length - 1);
                }

                // Delete ボタン
                if (layout.del) {
                    drawDeleteBtn(ctx, layout.del.x, midY);
                }
            });

            // Add ボタン
            if (addButton) {
                const btnY  = itemsY + items.length * ROW_H;
                const canAdd = items.length < maxItems;
                rrect(ctx, PAD, btnY + 3, W - PAD * 2, ADD_H - 6, 3,
                    canAdd ? "#1a2a1a" : "#1a1a1a",
                    canAdd ? "#2a4a2a" : "#2a2a2a");
                txt(ctx, addButton.label, W / 2, btnY + ADD_H / 2,
                    canAdd ? "#7d7" : "#444", "center", 11);
            }
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;

            const items  = getItems();
            const W      = node.size[0];
            const layout = rowLayout(W, { hasToggle, hasParam, hasMoveUpDown, hasDelete });

            const rawY   = pos[1] - this._y;
            const localY = rawY - HEADER_H;

            // ── ヘッダー行クリック（enabledWidget トグル） ──
            if (rawY < HEADER_H) {
                if (enabledWidget && inX(pos, PAD, 30)) {
                    const ew = node.widgets?.find(w => w.name === enabledWidget.name);
                    if (ew) {
                        ew.value = !ew.value;
                        ew.callback?.(ew.value);
                    }
                    app.graph.setDirtyCanvas(true, false);
                    return true;
                }
                return false;
            }

            if (localY < 0) return false;
            const rowIndex = Math.floor(localY / ROW_H);

            // ── Add ボタン ──
            if (addButton && rowIndex === items.length) {
                if (items.length >= maxItems) return true;
                const newItem = addButton.onCreate(node);
                if (newItem) {
                    items.push(newItem);
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                }
                return true;
            }

            if (rowIndex < 0 || rowIndex >= items.length) return false;

            const item = items[rowIndex];

            // ── Delete ──
            if (layout.del && inX(pos, layout.del.x, layout.del.w)) {
                items.splice(rowIndex, 1);
                saveItems(items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Move arrows ──
            if (layout.move && inX(pos, layout.move.x, layout.move.w)) {
                const relY   = localY - rowIndex * ROW_H;
                const moveUp = relY < ROW_H / 2;
                if (moveUp && rowIndex > 0) {
                    [items[rowIndex - 1], items[rowIndex]] =
                    [items[rowIndex],     items[rowIndex - 1]];
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                } else if (!moveUp && rowIndex < items.length - 1) {
                    [items[rowIndex],     items[rowIndex + 1]] =
                    [items[rowIndex + 1], items[rowIndex]];
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                }
                return true;
            }

            // ── Param（drag or click） ──
            if (layout.param && hasParam && inX(pos, layout.param.x, layout.param.w)) {
                // 既存ドラッグを強制終了してから新しいドラッグを開始
                if (_moveCleanup) { _moveCleanup(); _moveCleanup = null; }

                _dragIndex = rowIndex;
                _dragged   = false;

                const startY    = event.clientY;
                const startVal  = param.get(item);
                const scale     = param.dragScale ?? (param.step ?? 0.01);

                // endCalled フラグで idempotent なクリーンアップを保証
                // — pointerup が canvas + window の両方から届いても二重処理しない
                let endCalled = false;

                const onMove = (e) => {
                    if (endCalled) return;
                    const dy = startY - e.clientY; // 上方向が正
                    if (!_dragged && Math.abs(dy) < 3) return;
                    _dragged = true;
                    const newVal = Math.max(
                        param.min ?? -Infinity,
                        Math.min(param.max ?? Infinity, startVal + dy * scale)
                    );
                    param.set(item, newVal);
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                };

                const endDrag = (e) => {
                    if (endCalled) return;
                    endCalled    = true;
                    const wasDragged = _dragged;
                    _dragIndex   = -1;
                    _dragged     = false;
                    _moveCleanup = null;
                    // window capture で登録したリスナーをすべて除去
                    window.removeEventListener("pointermove",   onMove);
                    window.removeEventListener("pointerup",     endDrag, { capture: true });
                    window.removeEventListener("pointercancel", endDrag, { capture: true });
                    app.graph.setDirtyCanvas(true, false);

                    // ドラッグなし（クリック）かつ有効な pointerup → ポップアップ表示
                    if (!wasDragged && e?.type === "pointerup") {
                        showParamPopup(
                            e.clientX,
                            e.clientY,
                            param.get(item),
                            { min: param.min, max: param.max, step: param.step, label: param.label },
                            (v) => {
                                param.set(item, v);
                                saveItems(items);
                                app.graph.setDirtyCanvas(true, false);
                            }
                        );
                    }
                };

                // window + { capture: true } で登録する理由:
                //   LiteGraph がキャンバスに setPointerCapture している場合や
                //   canvas の pointerup ハンドラが stopPropagation しても
                //   window capture リスナーはキャプチャフェーズ先頭で必ず発火する
                window.addEventListener("pointermove",   onMove);
                window.addEventListener("pointerup",     endDrag, { capture: true });
                window.addEventListener("pointercancel", endDrag, { capture: true });

                // 外部クリーンアップ用（次ドラッグ開始時・ウィジェット破棄時に呼ばれる）
                _moveCleanup = () => endDrag(null);
                return true;
            }

            // ── Toggle pill ──
            if (layout.pill && hasToggle && inX(pos, layout.pill.x, layout.pill.w + 6)) {
                item.on = !(item.on ?? true);
                saveItems(items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Content クリック ──
            if (content.onClick && inX(pos, layout.contentX, layout.contentW)) {
                content.onClick(item, rowIndex, node);
                return true;
            }

            return false;
        },
    };
}
