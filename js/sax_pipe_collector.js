import { app } from "../../scripts/app.js";
import { panCanvasTo, showPicker } from "./sax_picker.js";
import {
    PAD, ROW_H, BOTTOM_PAD,
    HEADER_H, ADD_H,
    txt, inX,
    drawPill, drawMoveArrows, drawDeleteBtn, drawJumpBtn,
    drawRowBg, drawAddBtn,
    rowLayout,
    getComfyTheme,
    SAX_COLORS,
    ensureRenderLinkPatch, hideSourceLinks, unhideSourceLinks,
    applyLinkVisibility, toggleLinkVisibility, _hiddenLinkIds,
} from "./sax_ui_base.js";

const EXT_NAME  = "SAX.PipeCollector";
const NODE_TYPE = "SAX_Bridge_Pipe_Collector";
const MAX_SLOTS = 16;   // Python 側 MAX_SLOTS と合わせる

// ---------------------------------------------------------------------------
// ソース状態アクセサ
// ---------------------------------------------------------------------------

function getSources(node) {
    return node._remoteSources ?? [];
}

/** ソース srcIdx の物理スロット絶対インデックス */
function getOffset(node, srcIdx) {
    // 各ソースは常に slotCount=1 のため offset = srcIdx
    return srcIdx;
}

function getTotalSlotCount(node) {
    return getSources(node).length;   // 各ソース 1 スロット固定
}

/** ソースノードの出力構成を表す変化検知用シグネチャ */
function sourceSignature(srcNode) {
    return (srcNode.outputs ?? [])
        .map(o => `${o.label ?? o.name ?? ""}:${o.type ?? ""}`).join(",");
}

// ---------------------------------------------------------------------------
// ノードサイズ自動調整
// ---------------------------------------------------------------------------

function autoResize(node) {
    const sz = node.computeSize();
    if (node.size[1] !== sz[1]) {
        node.size[1] = sz[1];
        app.canvas?.setDirty(true, true);
    }
}

// ---------------------------------------------------------------------------
// スロットラベル同期
// ---------------------------------------------------------------------------

function syncSlotLabels(node) {
    const sources = getSources(node);
    for (let i = 0; i < sources.length; i++) {
        if (node.inputs[i]) {
            node.inputs[i].name = `slot_${i}`;
            node.inputs[i].type = "*";
        }
    }
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// ソースの追加・削除・再構築
// ---------------------------------------------------------------------------

/**
 * PIPE_LINE 型出力を持つノードをソースとして追加する。
 * PIPE_LINE 出力が存在しないノードは無視する（通知なし）。
 * 1 ソース = 1 スロット固定。
 */
function addSource(collectorNode, srcNode) {
    const sources = collectorNode._remoteSources ?? [];
    const offset  = getTotalSlotCount(collectorNode);
    if (offset >= MAX_SLOTS) return;

    // PIPE_LINE 型出力スロットを検索（先頭のみ使用）
    const pipeOutput = (srcNode.outputs ?? [])
        .find(o => o.type === "PIPE_LINE");

    if (!pipeOutput) return;

    const gi = (srcNode.outputs ?? []).indexOf(pipeOutput);

    collectorNode.addInput(`slot_${offset}`, "*");
    srcNode.connect(gi, collectorNode, offset);

    sources.push({
        sourceId:      srcNode.id,
        sourceTitle:   srcNode.title || srcNode.type || `Node#${srcNode.id}`,
        pipeSlotIndex: gi,   // ソース側の PIPE_LINE 出力インデックス
        slotCount:     1,    // 常に 1
        sig:           sourceSignature(srcNode),
        isSub:         srcNode.subgraph != null,
    });
    collectorNode._remoteSources = sources;

    syncSlotLabels(collectorNode);
    applyLinkVisibility(collectorNode);
    autoResize(collectorNode);
}

function removeSourceAt(node, idx) {
    const sources = getSources(node);
    if (idx < 0 || idx >= sources.length) return;

    const offset = getOffset(node, idx);

    unhideSourceLinks(node);
    const linkId = node.inputs[offset]?.link;
    if (linkId != null) app.graph.removeLink(linkId);
    node.removeInput(offset);
    sources.splice(idx, 1);
    node._remoteSources = sources;

    for (const id of [..._hiddenLinkIds]) {
        if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
    }

    syncSlotLabels(node);
    applyLinkVisibility(node);
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

/**
 * 全ソースを入力スロットから再構築する。
 */
function rebuildAllSources(node) {
    const savedSources = [...getSources(node)];

    unhideSourceLinks(node);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeInput(i);
    }
    node._remoteSources = [];

    for (const src of savedSources) {
        const srcNode = app.graph.getNodeById(src.sourceId);
        if (srcNode) addSource(node, srcNode);
    }
}

/** ソースノードの出力が変化した場合に再同期する。 */
function resyncSource(node, srcNode) {
    rebuildAllSources(node);
}

/** 全ソースをリセットする。 */
function resetAllSources(node) {
    for (const id of [..._hiddenLinkIds]) {
        if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
    }
    unhideSourceLinks(node);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeInput(i);
    }
    node._remoteSources = [];
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// ソース順入れ替え
// ---------------------------------------------------------------------------

function swapSources(node, si, sj) {
    const sources = getSources(node);
    [sources[si], sources[sj]] = [sources[sj], sources[si]];

    unhideSourceLinks(node);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeInput(i);
    }
    node._remoteSources = [];

    for (const src of sources) {
        const srcNode = app.graph.getNodeById(src.sourceId);
        if (srcNode) addSource(node, srcNode);
    }

    applyLinkVisibility(node);
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// ソース追加ピッカー
// ---------------------------------------------------------------------------

function showAddSourcePicker(collectorNode) {
    const existingIds = new Set([collectorNode.id, ...getSources(collectorNode).map(s => s.sourceId)]);
    showPicker({
        title:       "Select source nodes",
        sections:    ["subgraphs", "nodes"],
        mode:        "multi",
        selection:   new Map(),
        showWidgets: false,
        // PIPE_LINE 出力を持つノードのみ選択可能
        filterNode:  n => !existingIds.has(n.id) &&
            (n.outputs ?? []).some(o => o.type === "PIPE_LINE"),
        onConfirm:   (items) => {
            for (const item of items) {
                if (item.type !== "node") continue;
                const n = app.graph.getNodeById(item.id);
                if (n) addSource(collectorNode, n);
            }
        },
    });
}

// ---------------------------------------------------------------------------
// ソース選択ウィジェット
// ---------------------------------------------------------------------------

function makeSourceWidget(node) {
    let widgetY = 0;

    return {
        name:  "__sax_pipe_collector",
        type:  "__sax_pipe_collector",
        value: null,

        computeSize(W) {
            const n = getSources(node).length;
            return [W, HEADER_H + n * ROW_H + ADD_H + BOTTOM_PAD];
        },

        draw(ctx, drawNode, W, y) {
            widgetY = y;
            const t = getComfyTheme();

            // ソース状態を毎フレームチェック（ノード削除・タイトル変更・出力変更を検知）
            const sources = getSources(drawNode);
            for (let si = sources.length - 1; si >= 0; si--) {
                const src     = sources[si];
                const srcNode = app.graph.getNodeById(src.sourceId);
                if (!srcNode) {
                    removeSourceAt(drawNode, si);
                    return;
                }
                const currentTitle = srcNode.title || srcNode.type || `Node#${srcNode.id}`;
                if (currentTitle !== src.sourceTitle) {
                    src.sourceTitle = currentTitle;
                    app.canvas?.setDirty(true, false);
                }
                const sig = sourceSignature(srcNode);
                if (sig !== src.sig) {
                    src.sig = sig;
                    const capturedId = src.sourceId;
                    setTimeout(() => {
                        const still = getSources(drawNode).find(s => s.sourceId === capturedId);
                        if (still && app.graph.getNodeById(capturedId)) {
                            resyncSource(drawNode, app.graph.getNodeById(capturedId));
                        }
                    }, 0);
                    return;
                }
            }

            const linksVisible = drawNode._remoteLinksVisible ?? false;

            // ── ヘッダー行: リンク表示トグル pill ──
            const headerMidY = y + HEADER_H / 2;
            drawPill(ctx, PAD + 4, headerMidY, linksVisible);
            txt(ctx, "Show links", PAD + 38, headerMidY, t.contentBg, "left", 10);

            // ── ソース行 ──
            const layout = rowLayout(W, { hasJump: true, hasMoveUpDown: true, hasDelete: true });
            for (let si = 0; si < sources.length; si++) {
                const src  = sources[si];
                const rowY = y + HEADER_H + si * ROW_H;
                const midY = rowY + ROW_H / 2;

                drawRowBg(ctx, W, rowY);

                const icon  = src.isSub ? "▣" : "◈";
                const color = src.isSub ? SAX_COLORS.subgraph : SAX_COLORS.node;

                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                txt(ctx, `${icon}  ${src.sourceTitle}`, layout.contentX + 4, midY, color, "left", 11);
                txt(ctx, "  (pipe)", layout.contentX + layout.contentW, midY, t.contentBg, "right", 10);
                ctx.restore();

                drawJumpBtn(ctx, layout.jump.x, midY);
                drawMoveArrows(ctx, layout.move.x, rowY, ROW_H, si > 0, si < sources.length - 1);
                drawDeleteBtn(ctx, layout.del.x, midY);
            }

            // ── Add ボタン ──
            const btnY   = y + HEADER_H + sources.length * ROW_H;
            const canAdd = getTotalSlotCount(drawNode) < MAX_SLOTS;
            drawAddBtn(ctx, W, btnY,
                sources.length === 0 ? "Select source…" : "+ Add Source",
                canAdd);
        },

        mouse(event, pos, mouseNode) {
            if (event.type !== "pointerdown") return false;
            const W       = mouseNode.size[0];
            const relY    = pos[1] - widgetY;
            const sources = getSources(mouseNode);
            const layout  = rowLayout(W, { hasJump: true, hasMoveUpDown: true, hasDelete: true });

            // ── ヘッダー行: リンク表示トグル ──
            if (relY < HEADER_H) {
                if (pos[0] >= PAD && pos[0] < PAD + 34) {
                    toggleLinkVisibility(mouseNode);
                    return true;
                }
                return false;
            }

            const localY = relY - HEADER_H;

            // ── ソース行 ──
            for (let si = 0; si < sources.length; si++) {
                if (localY < si * ROW_H || localY >= (si + 1) * ROW_H) continue;

                // [✕] 削除
                if (inX(pos, layout.del.x, layout.del.w)) {
                    removeSourceAt(mouseNode, si);
                    return true;
                }

                // [▲▼] 上下移動
                if (inX(pos, layout.move.x, layout.move.w)) {
                    const moveUp = (localY - si * ROW_H) < ROW_H / 2;
                    if (moveUp && si > 0) swapSources(mouseNode, si - 1, si);
                    else if (!moveUp && si < sources.length - 1) swapSources(mouseNode, si, si + 1);
                    return true;
                }

                // [↗] ジャンプ
                if (inX(pos, layout.jump.x, layout.jump.w)) {
                    const srcNode = app.graph.getNodeById(sources[si].sourceId);
                    if (srcNode) {
                        panCanvasTo(
                            srcNode.pos[0] + (srcNode.size?.[0] ?? 0) / 2,
                            srcNode.pos[1] + (srcNode.size?.[1] ?? 0) / 2
                        );
                    }
                    return true;
                }

                return false;
            }

            // ── Add ボタン行 ──
            const btnRowTop = HEADER_H + sources.length * ROW_H;
            if (relY < btnRowTop || relY >= btnRowTop + ADD_H) return false;

            if (getTotalSlotCount(mouseNode) < MAX_SLOTS) {
                showAddSourcePicker(mouseNode);
            }
            return true;
        },
    };
}

// ---------------------------------------------------------------------------
// 拡張登録
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    setup() {
        ensureRenderLinkPatch();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // --- onNodeCreated ---
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._remoteSources      = [];
            this._remoteLinksVisible = false;
            // Python が定義する optional slot_* 入力をクリア（JS で動的管理する）
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) this.removeInput(i);
            // 出力スロット（"pipe" PIPE_LINE）は Python 定義のまま維持する
            this.addCustomWidget(makeSourceWidget(this));
            this.size[0] = Math.max(this.size[0], 280);
            this.size[1] = 1;   // slot 数に基づく ComfyUI デフォルト高さを破棄
        };

        // --- onSerialize ---
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            onSerialize?.apply(this, arguments);
            data.sax_pipe_collector = {
                sources:      getSources(this),
                linksVisible: this._remoteLinksVisible ?? false,
            };
        };

        // --- onConfigure ---
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);
            if (data.sax_pipe_collector) {
                const saved = data.sax_pipe_collector;
                this._remoteSources      = saved.sources ?? [];
                this._remoteLinksVisible = saved.linksVisible ?? false;

                // 入力スロット数を保存値に合わせる（LiteGraph がリンク復元前に呼ぶため）
                const total = getTotalSlotCount(this);
                const curIn = this.inputs?.length ?? 0;
                for (let i = curIn - 1; i >= total; i--) this.removeInput(i);
                for (let i = curIn; i < total; i++) this.addInput(`slot_${i}`, "*");
                syncSlotLabels(this);
            }

            if (!this.widgets?.some(w => w.name === "__sax_pipe_collector")) {
                this.addCustomWidget(makeSourceWidget(this));
            }
            this.size[0] = Math.max(this.size[0], 280);

            // ワークフロー読み込み後にリンクが確定してから再接続
            const self = this;
            setTimeout(() => {
                const sources = getSources(self);
                for (let si = 0; si < sources.length; si++) {
                    const src     = sources[si];
                    const srcNode = app.graph.getNodeById(src.sourceId);
                    if (!srcNode) continue;
                    const gi = src.pipeSlotIndex;
                    if (self.inputs[si]?.link == null) {
                        srcNode.connect(gi, self, si);
                    }
                    src.sig = sourceSignature(srcNode);
                }
                applyLinkVisibility(self);
                autoResize(self);
            }, 0);
        };
    },
});
