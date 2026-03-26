import { app } from "../../scripts/app.js";
import { getComfyTheme, rrect, txt, BOTTOM_PAD } from "./sax_ui_base.js";

const EXT_NAME   = "SAX.ImagePreview";
const NODE_TYPE  = "SAX_Bridge_Image_Preview";
const GAP        = 4;
const EMPTY_H    = 40;
const MAIN_NAV_H = 28;   // メインシークバー高さ（常時表示）
const TOGGLE_H   = 20;   // トグルバー高さ
const THUMB_SZ   = 32;   // グリッドサムネイルサイズ (px)
const GRID_ROWS  = 3;    // グリッド 1 ページの行数
const GRID_BTN_H = 24;   // グリッドページボタン高さ

const SEEK_PAD = 16;
const PAGE_W   = 44;
const THUMB_R  = 5;

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function getLayoutParams(node) {
    const ws = node.widgets;
    const cellW   = ws?.find(w => w.name === "cell_w")?.value   ?? 200;
    const maxCols = ws?.find(w => w.name === "max_cols")?.value ?? 3;
    return { cellW, maxCols };
}

function calcNodeWidth(cellW, maxCols) {
    return maxCols * (cellW + GAP) + GAP;
}

/**
 * 全画像の実アスペクト比から cellW 幅に対する最大セル高さを算出する。
 * calcCellH(images, cellW) = max(cellW × H_i / W_i)
 * 未ロード画像はスキップし、1 枚もロードされていなければ cellW（正方形）を返す。
 *
 * 【重要な不変条件】
 *   任意の画像 i について: naturalH_i = cellW × H_i/W_i ≤ calcCellH
 *   → draw() で幅いっぱいに描画しても高さは必ず cellH 以内に収まる
 *   → 横方向の黒帯が原理的に発生しない
 */
function calcCellH(images, cellW) {
    let maxH = 0;
    for (const img of images) {
        if (img?.complete && img.naturalWidth > 0) {
            maxH = Math.max(maxH, Math.round(cellW * img.naturalHeight / img.naturalWidth));
        }
    }
    return maxH > 0 ? maxH : cellW;
}

function calcGridLayout(W, imageCount) {
    const cols       = Math.max(1, Math.floor((W - GAP) / (THUMB_SZ + GAP)));
    const perPage    = cols * GRID_ROWS;
    const totalPages = Math.max(1, Math.ceil(imageCount / perPage));
    return { cols, perPage, totalPages };
}

function trackRange(W) {
    return { x: SEEK_PAD, w: W - SEEK_PAD * 2 - PAGE_W };
}

/**
 * 有効な選択インデックス配列を返す。
 *  - グリッド非表示: 全インデックス（全選択）
 *  - グリッド表示中: _selected Set の内容を昇順ソート
 */
function getEffectiveSelected(widget) {
    if (!widget._showGrid) {
        return widget._images.map((_, i) => i);
    }
    return [...widget._selected].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// メインシークバー描画
// ---------------------------------------------------------------------------

function drawMainSeekbar(ctx, W, navY, page, totalPages, interactive, t) {
    const midY  = navY + MAIN_NAV_H / 2;
    const track = trackRange(W);

    ctx.fillStyle = t.inputBg;
    ctx.fillRect(0, navY, W, MAIN_NAV_H);

    // 非インタラクティブ: 薄いトラック線のみ
    if (!interactive) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.3;
        ctx.strokeStyle = t.border;
        ctx.lineWidth   = 2;
        ctx.lineCap     = "round";
        ctx.beginPath();
        ctx.moveTo(track.x, midY);
        ctx.lineTo(track.x + track.w, midY);
        ctx.stroke();
        ctx.globalAlpha = a;
        return;
    }

    // トラック線
    ctx.strokeStyle = t.border;
    ctx.lineWidth   = 2;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(track.x, midY);
    ctx.lineTo(track.x + track.w, midY);
    ctx.stroke();

    // ティック（16 ページ以下）
    if (totalPages <= 16) {
        ctx.fillStyle = t.border;
        for (let p = 0; p < totalPages; p++) {
            const tx = track.x + (totalPages > 1 ? p / (totalPages - 1) : 0) * track.w;
            ctx.beginPath();
            ctx.arc(tx, midY, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // サム
    const ratio  = totalPages > 1 ? page / (totalPages - 1) : 0;
    const thumbX = track.x + ratio * track.w;
    ctx.fillStyle = t.inputText;
    ctx.beginPath();
    ctx.arc(thumbX, midY, THUMB_R, 0, Math.PI * 2);
    ctx.fill();

    // ページテキスト（右端）
    txt(ctx, `${page + 1}/${totalPages}`, W - PAGE_W / 2, midY, t.contentBg, "center", 10);
}

// ---------------------------------------------------------------------------
// プレビューウィジェット
// ---------------------------------------------------------------------------

function makePreviewWidget(node) {
    const widget = {
        name:      "__sax_image_preview",
        type:      "__sax_image_preview",
        value:     null,
        _images:   [],
        _selected: new Set(),  // 選択中インデックス（グリッド表示時のみ参照）
        _showGrid: false,
        _mainPage: 0,          // メインビューのページ
        _gridPage: 0,          // グリッドのページ

        computeSize(W) {
            const { cellW: desiredCellW, maxCols } = getLayoutParams(node);
            // draw() と同一の w（Math.max を使わない）
            const w = W ?? node.size[0] ?? calcNodeWidth(desiredCellW, maxCols);
            if (widget._images.length === 0) return [w, EMPTY_H];

            // draw() と同一の cellW 計算式で cellH を算出
            const cellW = Math.max(1, Math.floor((w - (maxCols + 1) * GAP) / maxCols));
            const cellH = calcCellH(widget._images, cellW);
            const baseH = GAP + cellH + GAP + MAIN_NAV_H + TOGGLE_H;
            if (!widget._showGrid) return [w, baseH + BOTTOM_PAD];

            const gridH = GAP + GRID_ROWS * (THUMB_SZ + GAP) + GRID_BTN_H;
            return [w, baseH + gridH + BOTTOM_PAD];
        },

        draw(ctx, drawNode, W, y) {
            widget._lastY = y;
            const { maxCols } = getLayoutParams(drawNode);
            const cellW = Math.max(1, Math.floor((W - (maxCols + 1) * GAP) / maxCols));
            const cellH = calcCellH(widget._images, cellW);

            if (widget._images.length === 0) {
                const t = getComfyTheme();
                rrect(ctx, GAP, y + 2, W - GAP * 2, EMPTY_H - 4, 4, t.inputBg, t.contentBg);
                txt(ctx, "No preview", W / 2, y + EMPTY_H / 2, t.border, "center", 11);
                return;
            }

            const t            = getComfyTheme();
            const effectiveSel = getEffectiveSelected(widget);
            const totalMainPages = Math.max(1, Math.ceil(
                Math.max(effectiveSel.length, 1) / maxCols,
            ));
            widget._mainPage = Math.max(0, Math.min(widget._mainPage, totalMainPages - 1));

            const mainY  = y + GAP;
            const mStart = widget._mainPage * maxCols;
            const mEnd   = Math.min(mStart + maxCols, effectiveSel.length);

            for (let col = 0; col < maxCols; col++) {
                const x      = GAP + col * (cellW + GAP);
                const imgIdx = mStart + col < mEnd ? effectiveSel[mStart + col] : -1;

                ctx.fillStyle = "#111";
                ctx.fillRect(x, mainY, cellW, cellH);

                if (imgIdx >= 0) {
                    const img = widget._images[imgIdx];
                    if (img?.complete && img.naturalWidth > 0) {
                        // 幅埋め（calcCellH の不変条件により横黒帯なし、縦は余白あり）
                        const naturalH = Math.round(cellW * img.naturalHeight / img.naturalWidth);
                        ctx.drawImage(img, x, mainY, cellW, Math.min(naturalH, cellH));
                    }
                }
            }

            // 選択なし（グリッド表示中かつ未選択）のプレースホルダー
            if (widget._showGrid && effectiveSel.length === 0) {
                txt(ctx, "Select images from grid ↓",
                    GAP + cellW / 2, mainY + cellH / 2, t.border, "center", 11);
            }

            const seekbarY    = mainY + cellH + GAP;
            const interactive = effectiveSel.length > maxCols;
            drawMainSeekbar(ctx, W, seekbarY, widget._mainPage, totalMainPages, interactive, t);
            widget._seekbarY = seekbarY;   // mouse() で参照

            const toggleY = seekbarY + MAIN_NAV_H;
            widget._toggleY = toggleY;
            ctx.fillStyle = t.inputBg;
            ctx.fillRect(0, toggleY, W, TOGGLE_H);

            const arrow   = widget._showGrid ? "▲" : "▼";
            const selInfo = widget._showGrid
                ? `${widget._selected.size} / ${widget._images.length} selected`
                : `${widget._images.length} images`;
            txt(ctx, `${arrow} Grid    ${selInfo}`,
                W / 2, toggleY + TOGGLE_H / 2, t.border, "center", 10);

            if (!widget._showGrid) return;

            const gridTopY = toggleY + TOGGLE_H;
            const { cols, perPage, totalPages } = calcGridLayout(W, widget._images.length);

            widget._gridPage = Math.max(0, Math.min(widget._gridPage, totalPages - 1));
            const gStart = widget._gridPage * perPage;
            const gEnd   = Math.min(gStart + perPage, widget._images.length);

            widget._gridTopY    = gridTopY;
            widget._gridCols    = cols;
            widget._gridPerPage = perPage;

            for (let i = gStart; i < gEnd; i++) {
                const li  = i - gStart;
                const col = li % cols;
                const row = Math.floor(li / cols);
                const x   = GAP + col * (THUMB_SZ + GAP);
                const ty  = gridTopY + GAP + row * (THUMB_SZ + GAP);
                const img = widget._images[i];

                ctx.fillStyle = "#111";
                ctx.fillRect(x, ty, THUMB_SZ, THUMB_SZ);

                if (img?.complete && img.naturalWidth > 0) {
                    const scale = Math.min(THUMB_SZ / img.naturalWidth, THUMB_SZ / img.naturalHeight);
                    const dw    = img.naturalWidth  * scale;
                    const dh    = img.naturalHeight * scale;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(x, ty, THUMB_SZ, THUMB_SZ);
                    ctx.clip();
                    ctx.drawImage(img,
                        x + (THUMB_SZ - dw) / 2, ty + (THUMB_SZ - dh) / 2, dw, dh);
                    ctx.restore();
                }

                if (widget._selected.has(i)) {
                    ctx.strokeStyle = "#e04040";
                    ctx.lineWidth   = 2;
                    ctx.strokeRect(x - 1, ty - 1, THUMB_SZ + 2, THUMB_SZ + 2);
                }
            }

            const gridBtnY = gridTopY + GAP + GRID_ROWS * (THUMB_SZ + GAP);
            widget._gridBtnY = gridBtnY;

            ctx.fillStyle = t.inputBg;
            ctx.fillRect(0, gridBtnY, W, GRID_BTN_H);

            const btnMidY    = gridBtnY + GRID_BTN_H / 2;
            const prevActive = widget._gridPage > 0;
            const nextActive = widget._gridPage < totalPages - 1;

            txt(ctx, "◀", SEEK_PAD + PAGE_W / 2,     btnMidY,
                prevActive ? t.inputText : t.border, "center", 12);
            txt(ctx, `${widget._gridPage + 1} / ${totalPages}`, W / 2, btnMidY,
                t.border, "center", 10);
            txt(ctx, "▶", W - SEEK_PAD - PAGE_W / 2, btnMidY,
                nextActive ? t.inputText : t.border, "center", 12);
        },

        mouse(event, pos, mouseNode) {
            if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
            if (widget._images.length === 0) return false;

            const seekbarY = widget._seekbarY;
            const toggleY  = widget._toggleY;
            if (seekbarY === undefined || toggleY === undefined) return false;

            const { maxCols } = getLayoutParams(mouseNode);

            if (pos[1] >= seekbarY && pos[1] < seekbarY + MAIN_NAV_H) {
                const effectiveSel = getEffectiveSelected(widget);
                if (effectiveSel.length > maxCols) {
                    const totalMainPages = Math.ceil(effectiveSel.length / maxCols);
                    const W     = mouseNode.size[0];
                    const track = trackRange(W);
                    const xToPage = (px) => {
                        const t = Math.max(0, Math.min(1, (px - track.x) / track.w));
                        return Math.max(0, Math.min(totalMainPages - 1,
                            Math.round(t * (totalMainPages - 1))));
                    };

                    widget._mainPage = xToPage(pos[0]);
                    app.graph.setDirtyCanvas(true, false);

                    const dragStart      = widget._mainPage;
                    const initialClientX = event.clientX;
                    const canvas         = app.canvas;

                    const onMove = (ev) => {
                        const scale  = canvas.ds?.scale ?? 1;
                        const deltaX = (ev.clientX - initialClientX) / scale;
                        widget._mainPage = Math.max(0, Math.min(
                            totalMainPages - 1,
                            Math.round(dragStart + (deltaX / track.w) * (totalMainPages - 1)),
                        ));
                        app.graph.setDirtyCanvas(true, false);
                    };
                    const endDrag = () => {
                        window.removeEventListener("pointermove",   onMove,   { capture: true });
                        window.removeEventListener("pointerup",     endDrag,  { capture: true });
                        window.removeEventListener("pointercancel", endDrag,  { capture: true });
                    };
                    window.addEventListener("pointermove",   onMove,   { capture: true });
                    window.addEventListener("pointerup",     endDrag,  { capture: true });
                    window.addEventListener("pointercancel", endDrag,  { capture: true });
                }
                return true;   // 非インタラクティブでもイベントを消費
            }

            if (pos[1] >= toggleY && pos[1] < toggleY + TOGGLE_H) {
                widget._showGrid = !widget._showGrid;
                widget._mainPage = 0;   // 有効選択プールが変わるためリセット
                node.size[1] = 1;
                app.graph.setDirtyCanvas(true, true);
                return true;
            }

            if (!widget._showGrid) return false;

            const W        = mouseNode.size[0];
            const gridTopY = widget._gridTopY;
            const gridBtnY = widget._gridBtnY;
            if (gridTopY === undefined || gridBtnY === undefined) return false;

            const { cols, perPage, totalPages } = calcGridLayout(W, widget._images.length);

            if (pos[1] >= gridBtnY && pos[1] < gridBtnY + GRID_BTN_H) {
                if (pos[0] < W / 2) {
                    widget._gridPage = Math.max(0, widget._gridPage - 1);
                } else {
                    widget._gridPage = Math.min(totalPages - 1, widget._gridPage + 1);
                }
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            if (pos[1] >= gridTopY && pos[1] < gridBtnY) {
                const relX = pos[0] - GAP;
                const relY = pos[1] - gridTopY - GAP;

                if (relX >= 0 && relY >= 0) {
                    const col = Math.floor(relX / (THUMB_SZ + GAP));
                    const row = Math.floor(relY / (THUMB_SZ + GAP));

                    if (col < cols && row < GRID_ROWS) {
                        const idx = widget._gridPage * perPage + row * cols + col;
                        if (idx < widget._images.length) {
                            if (widget._selected.has(idx)) {
                                widget._selected.delete(idx);
                            } else {
                                widget._selected.add(idx);
                            }
                            const eff = getEffectiveSelected(widget);
                            const totalMP = Math.max(1, Math.ceil(
                                Math.max(eff.length, 1) / maxCols,
                            ));
                            widget._mainPage = Math.min(widget._mainPage, totalMP - 1);
                            app.graph.setDirtyCanvas(true, false);
                            return true;
                        }
                    }
                }
            }

            return false;
        },
    };
    return widget;
}

// ---------------------------------------------------------------------------
// 拡張登録
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            // imgs を常に空配列に固定して ComfyUI 標準プレビューを抑制
            Object.defineProperty(this, "imgs", {
                get() { return []; },
                set(_v) { /* noop */ },
                configurable: true,
                enumerable:   true,
            });
            this._previewWidget = makePreviewWidget(this);
            this.addCustomWidget(this._previewWidget);
            const { cellW, maxCols } = getLayoutParams(this);
            this.size[0] = calcNodeWidth(cellW, maxCols);
        };

        nodeType.prototype.onWidgetChanged = function (name) {
            if (!["cell_w", "max_cols"].includes(name)) return;
            const { cellW, maxCols } = getLayoutParams(this);
            this.size[0] = calcNodeWidth(cellW, maxCols);
            this.size[1] = 1;
            app.graph.setDirtyCanvas(true, true);
        };

        nodeType.prototype.onExecuted = function (output) {
            const images = output?.images ?? [];
            const w      = this._previewWidget;
            if (!w) return;

            w._images    = [];
            w._selected  = new Set();
            w._mainPage  = 0;
            w._gridPage  = 0;

            const self = this;
            const resizeNode = () => {
                const { cellW, maxCols } = getLayoutParams(self);
                // 優先幅を下回る場合のみ拡張（手動リサイズ後の幅は維持）
                self.size[0] = Math.max(self.size[0], calcNodeWidth(cellW, maxCols));
                self.size[1] = 1;
                app.graph.setDirtyCanvas(true, true);
            };

            if (images.length === 0) {
                resizeNode();
                return;
            }

            for (const info of images) {
                const params = new URLSearchParams({
                    filename:  info.filename,
                    subfolder: info.subfolder || "",
                    type:      info.type || "temp",
                    rand:      Math.random(),
                });
                const img = new Image();
                img.onload = () => resizeNode();
                img.src = `/api/view?${params}`;
                w._images.push(img);
            }
        };
    },
});
