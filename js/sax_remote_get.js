import { app } from "../../scripts/app.js";
import { panCanvasTo, showPicker } from "./sax_picker.js";
import {
    PAD,
    rrect, txt, inX,
    drawPill, drawMoveArrows, drawDeleteBtn,
    rowLayout,
    getComfyTheme,
    SAX_COLORS,
} from "./sax_ui_base.js";

const EXT_NAME  = "SAX.RemoteGet";
const NODE_TYPE = "SAX_Bridge_Remote_Get";
const MAX_SLOTS = 32;   // Python 側 MAX_SLOTS と合わせる
const ROW_H     = 28;   // ソース行の高さ（sax_ui_base ROW_H=24 より大きい）

// ---------------------------------------------------------------------------
// renderLink パッチ — 非表示リンクをスキップする
// ---------------------------------------------------------------------------

const _hiddenLinkIds   = new Set();
let   _renderLinkPatched = false;

function ensureRenderLinkPatch() {
    if (_renderLinkPatched) return;
    _renderLinkPatched = true;
    const proto    = Object.getPrototypeOf(app.canvas);
    const original = proto.renderLink;
    if (!original) return;
    proto.renderLink = function (ctx, a, b, link, ...rest) {
        if (link && _hiddenLinkIds.has(link.id)) return;
        return original.call(this, ctx, a, b, link, ...rest);
    };
}

function hideSourceLinks(node) {
    for (let i = 0; i < (node.inputs?.length ?? 0); i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.add(linkId);
    }
    app.canvas?.setDirty(true, false);
}

function unhideSourceLinks(node) {
    for (let i = 0; i < (node.inputs?.length ?? 0); i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.delete(linkId);
    }
}

function applyLinkVisibility(node) {
    if (node._remoteLinksVisible) {
        unhideSourceLinks(node);
    } else {
        hideSourceLinks(node);
    }
    app.canvas?.setDirty(true, false);
}

function toggleLinkVisibility(node) {
    node._remoteLinksVisible = !node._remoteLinksVisible;
    applyLinkVisibility(node);
}

// ---------------------------------------------------------------------------
// ソース状態アクセサ
// ---------------------------------------------------------------------------

function getSources(node) {
    return node._remoteSources ?? [];
}

/** ソース srcIdx の先頭スロットの絶対インデックス */
function getOffset(node, srcIdx) {
    const sources = getSources(node);
    let offset = 0;
    for (let i = 0; i < srcIdx; i++) offset += sources[i]?.slotCount ?? 0;
    return offset;
}

function getTotalSlotCount(node) {
    return getSources(node).reduce((sum, s) => sum + (s.slotCount ?? 0), 0);
}

/** ソースノードの出力構成を表す変化検知用シグネチャ */
function sourceSignature(srcNode) {
    return (srcNode.outputs ?? []).slice(0, MAX_SLOTS)
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
// スロットラベル・型の同期
// ---------------------------------------------------------------------------

function syncSlotLabels(node) {
    const sources = getSources(node);
    let idx = 0;
    for (const src of sources) {
        for (let i = 0; i < src.slotCount; i++) {
            const name = src.slotNames[i] || `out_${idx}`;
            const type = src.slotTypes[i] || "*";
            if (node.inputs[idx]) {
                node.inputs[idx].name = `slot_${idx}`;
                node.inputs[idx].type = "*";
            }
            if (node.outputs[idx]) {
                node.outputs[idx].name  = name;
                node.outputs[idx].label = name;
                node.outputs[idx].type  = type;
            }
            idx++;
        }
    }
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// ソースの追加・削除・再同期・リセット
// ---------------------------------------------------------------------------

function addSource(remoteNode, srcNode) {
    const sources   = remoteNode._remoteSources ?? [];
    const offset    = getTotalSlotCount(remoteNode);
    const remaining = MAX_SLOTS - offset;
    if (remaining <= 0) return;

    const srcOutputs = srcNode.outputs ?? [];
    const count = Math.min(srcOutputs.length, remaining);
    if (count === 0) return;

    const slotNames = [], slotTypes = [];
    for (let i = 0; i < count; i++) {
        const out  = srcOutputs[i];
        const name = out.label || out.name || out.type || `out_${offset + i}`;
        const type = out.type || "*";
        slotNames.push(name);
        slotTypes.push(type);
        remoteNode.addInput(`slot_${offset + i}`, "*");
        remoteNode.addOutput(name, type);
        srcNode.connect(i, remoteNode, offset + i);
    }

    sources.push({
        sourceId:    srcNode.id,
        sourceTitle: srcNode.title || srcNode.type || `Node#${srcNode.id}`,
        slotCount:   count,
        slotNames,
        slotTypes,
        sig:         sourceSignature(srcNode),
        isSub:       srcNode.subgraph != null,
    });
    remoteNode._remoteSources = sources;

    syncSlotLabels(remoteNode);
    applyLinkVisibility(remoteNode);
    autoResize(remoteNode);
}

function removeSourceAt(node, idx) {
    const sources = getSources(node);
    if (idx < 0 || idx >= sources.length) return;

    const offset = getOffset(node, idx);
    const count  = sources[idx].slotCount;

    unhideSourceLinks(node);
    for (let i = offset + count - 1; i >= offset; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeOutput(i);
        node.removeInput(i);
    }
    sources.splice(idx, 1);
    node._remoteSources = sources;

    // stale な linkId を掃除
    for (const id of [..._hiddenLinkIds]) {
        if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
    }

    syncSlotLabels(node);
    applyLinkVisibility(node);
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

/** ソース idx のスロット構成を再同期する（F: スロット変更追従） */
function resyncSource(node, srcIdx, srcNode) {
    const sources    = getSources(node);
    const src        = sources[srcIdx];
    if (!src) return;

    const offset     = getOffset(node, srcIdx);
    const srcOutputs = srcNode.outputs ?? [];
    const oldCount   = src.slotCount;
    // このソース以降の残スロット数（他ソース分）
    const afterSlots = getTotalSlotCount(node) - offset - oldCount;
    const remaining  = MAX_SLOTS - offset - afterSlots;
    const newCount   = Math.min(srcOutputs.length, remaining);
    const newNames   = srcOutputs.slice(0, newCount).map(
        (o, i) => o.label || o.name || o.type || `out_${offset + i}`);
    const newTypes   = srcOutputs.slice(0, newCount).map(o => o.type || "*");

    if (newCount < oldCount) {
        // 減少: 後ろから削除
        for (let i = oldCount - 1; i >= newCount; i--) {
            const absIdx = offset + i;
            const linkId = node.inputs[absIdx]?.link;
            if (linkId != null) app.graph.removeLink(linkId);
            node.removeOutput(absIdx);
            node.removeInput(absIdx);
        }
    } else if (newCount > oldCount) {
        const isLast = srcIdx === sources.length - 1;
        if (isLast) {
            // 末尾ソースの増加: 安全にアペンド
            for (let i = oldCount; i < newCount; i++) {
                const absIdx = offset + i;
                node.addInput(`slot_${absIdx}`, "*");
                node.addOutput(newNames[i], newTypes[i]);
                srcNode.connect(i, node, absIdx);
            }
        } else {
            // 中間ソースの増加: 全体リビルド（下流接続を保存・復元）
            rebuildAllSources(node);
            return;
        }
    }

    src.slotCount = newCount;
    src.slotNames = newNames;
    src.slotTypes = newTypes;
    src.sig       = sourceSignature(srcNode);

    syncSlotLabels(node);
    if (newCount !== oldCount) {
        for (const id of [..._hiddenLinkIds]) {
            if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
        }
        applyLinkVisibility(node);
        autoResize(node);
    }
}

/** 中間ソースのスロット増加時に全ソースを再構築する（下流接続を保存・復元する） */
function rebuildAllSources(node) {
    const savedSources = [...getSources(node)];

    // 下流リンクを保存（ソース ID + ソース内ローカルスロット → 下流ノード/スロット）
    const downstreamMap = [];
    for (let si = 0; si < savedSources.length; si++) {
        const offset = getOffset(node, si);
        for (let li = 0; li < savedSources[si].slotCount; li++) {
            const absIdx = offset + li;
            const out = node.outputs?.[absIdx];
            if (!out?.links?.length) continue;
            for (const lid of out.links) {
                const lnk = app.graph.links?.[lid];
                if (lnk) {
                    downstreamMap.push({
                        sourceId:   savedSources[si].sourceId,
                        localSlot:  li,
                        targetId:   lnk.target_id,
                        targetSlot: lnk.target_slot,
                    });
                }
            }
        }
    }

    unhideSourceLinks(node);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeInput(i);
    }
    for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) {
        node.removeOutput(i);
    }
    node._remoteSources = [];

    for (const src of savedSources) {
        const srcNode = app.graph.getNodeById(src.sourceId);
        if (srcNode) addSource(node, srcNode);
    }

    // 下流リンクを復元
    for (const ds of downstreamMap) {
        const newSi = getSources(node).findIndex(s => s.sourceId === ds.sourceId);
        if (newSi < 0) continue;
        const src = getSources(node)[newSi];
        if (ds.localSlot >= src.slotCount) continue;  // スロットが減って消えた場合
        const newAbsIdx = getOffset(node, newSi) + ds.localSlot;
        const tgtNode = app.graph.getNodeById(ds.targetId);
        if (tgtNode && node.outputs?.[newAbsIdx]) {
            node.connect(newAbsIdx, tgtNode, ds.targetSlot);
        }
    }
}

/** 全ソースをリセットする（ソース削除・手動クリア用） */
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
    for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) {
        node.removeOutput(i);
    }
    node._remoteSources = [];
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// ソース順入れ替え（スロット再構築付き）
// ---------------------------------------------------------------------------

function swapSources(node, si, sj) {
    const sources = getSources(node);

    // 下流リンクを現在の物理スロット順で保存
    const downstreamMap = [];
    for (let idx = 0; idx < sources.length; idx++) {
        const offset = getOffset(node, idx);
        for (let li = 0; li < sources[idx].slotCount; li++) {
            const out = node.outputs?.[offset + li];
            if (!out?.links?.length) continue;
            for (const lid of out.links) {
                const lnk = app.graph.links?.[lid];
                if (lnk) downstreamMap.push({
                    sourceId:   sources[idx].sourceId,
                    localSlot:  li,
                    targetId:   lnk.target_id,
                    targetSlot: lnk.target_slot,
                });
            }
        }
    }

    // ソース順を入れ替え（物理スロットは未変更のまま）
    [sources[si], sources[sj]] = [sources[sj], sources[si]];

    // スロットをクリアして新しい順で再構築
    unhideSourceLinks(node);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeInput(i);
    }
    for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) node.removeOutput(i);
    node._remoteSources = [];

    for (const src of sources) {
        const srcNode = app.graph.getNodeById(src.sourceId);
        if (srcNode) addSource(node, srcNode);
    }

    // 下流リンクを復元
    for (const ds of downstreamMap) {
        const newSi = getSources(node).findIndex(s => s.sourceId === ds.sourceId);
        if (newSi < 0) continue;
        const src = getSources(node)[newSi];
        if (ds.localSlot >= src.slotCount) continue;
        const newAbsIdx = getOffset(node, newSi) + ds.localSlot;
        const tgtNode = app.graph.getNodeById(ds.targetId);
        if (tgtNode && node.outputs?.[newAbsIdx]) node.connect(newAbsIdx, tgtNode, ds.targetSlot);
    }

    applyLinkVisibility(node);
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// ソース追加ピッカー
// ---------------------------------------------------------------------------

function showAddSourcePicker(remoteNode) {
    const existingIds = new Set([remoteNode.id, ...getSources(remoteNode).map(s => s.sourceId)]);
    showPicker({
        title:      "Select source node",
        sections:   ["subgraphs", "nodes"],
        mode:       "single",
        filterNode: n => !existingIds.has(n.id) && (n.outputs ?? []).length > 0,
        onSelect:   n => addSource(remoteNode, n),
    });
}

// ---------------------------------------------------------------------------
// ソース選択ウィジェット
// ---------------------------------------------------------------------------

const HEADER_H = 20;   // ヘッダー行（目玉トグル）の高さ
const ADD_H    = ROW_H; // Add ボタン行の高さ（common UI に合わせる）

function makeSourceWidget(node) {
    // draw() で毎フレーム更新される。mouse() のヒットテストに使用
    let widgetY = 0;

    return {
        name:  "__sax_remote_source",
        type:  "__sax_remote_source",
        value: null,

        computeSize(W) {
            const n = getSources(node).length;
            return [W, HEADER_H + n * ROW_H + ADD_H];
        },

        draw(ctx, drawNode, W, y) {
            widgetY = y;
            const t = getComfyTheme();

            // C/E/F: ソース状態を毎フレームチェック（後ろから検査して安全に削除）
            const sources = getSources(drawNode);
            for (let si = sources.length - 1; si >= 0; si--) {
                const src     = sources[si];
                const srcNode = app.graph.getNodeById(src.sourceId);
                if (!srcNode) {
                    // C: ソース削除を検知
                    removeSourceAt(drawNode, si);
                    return;
                }
                // E: タイトル変更追従
                const currentTitle = srcNode.title || srcNode.type || `Node#${srcNode.id}`;
                if (currentTitle !== src.sourceTitle) {
                    src.sourceTitle = currentTitle;
                    app.canvas?.setDirty(true, false);
                }
                // F: スロット構成変更追従
                const sig = sourceSignature(srcNode);
                if (sig !== src.sig) {
                    src.sig = sig;  // 再トリガー防止
                    const capturedSourceId = src.sourceId;
                    setTimeout(() => {
                        const currentSi = getSources(drawNode).findIndex(s => s.sourceId === capturedSourceId);
                        if (currentSi >= 0 && app.graph.getNodeById(capturedSourceId)) {
                            resyncSource(drawNode, currentSi, app.graph.getNodeById(capturedSourceId));
                        }
                    }, 0);
                    return;
                }
            }

            const linksVisible = drawNode._remoteLinksVisible ?? false;

            // ── ヘッダー行: 目玉トグル pill ──
            const headerMidY = y + HEADER_H / 2;
            drawPill(ctx, PAD + 4, headerMidY, linksVisible);
            txt(ctx, "Show links", PAD + 38, headerMidY, t.contentBg, "left", 10);

            // ── ソース行（Toggle Manager に合わせた pill 形状 + アイコン + 種別色）──
            const layout = rowLayout(W, { hasMoveUpDown: true, hasDelete: true });
            for (let si = 0; si < sources.length; si++) {
                const src  = sources[si];
                const rowY = y + HEADER_H + si * ROW_H;
                const midY = rowY + ROW_H / 2;

                // 行: pill 形状、contentBg ボーダー（Toggle Manager と同じ）
                rrect(ctx, PAD, rowY + 2, W - PAD * 2, ROW_H - 4, (ROW_H - 4) / 2,
                    t.inputBg, t.contentBg);

                // ソース名ラベル（種別アイコン + 色）
                const icon  = src.isSub ? "▣" : "◈";
                const color = src.isSub ? SAX_COLORS.subgraph : SAX_COLORS.node;
                const slots = `  (${src.slotCount} slot${src.slotCount !== 1 ? "s" : ""})`;
                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                txt(ctx, `${icon}  ${src.sourceTitle}`, layout.contentX + 4, midY, color, "left", 11);
                txt(ctx, slots, layout.contentX + layout.contentW, midY, t.contentBg, "right", 10);
                ctx.restore();

                // ▲▼
                drawMoveArrows(ctx, layout.move.x, rowY, ROW_H, si > 0, si < sources.length - 1);

                // ✕
                drawDeleteBtn(ctx, layout.del.x, midY);
            }

            // ── Add ボタン（common UI の addButton と同じスタイル）──
            const btnY   = y + HEADER_H + sources.length * ROW_H;
            const canAdd = getTotalSlotCount(drawNode) < MAX_SLOTS;
            rrect(ctx, PAD, btnY + 2, W - PAD * 2, ADD_H - 4, 4,
                canAdd ? t.inputBg : t.menuBg,
                canAdd ? t.contentBg : t.border);
            txt(ctx,
                sources.length === 0 ? "Select source…" : "+ Add source",
                W / 2, btnY + ADD_H / 2,
                canAdd ? t.inputText : t.border,
                "center", 11);
        },

        mouse(event, pos, mouseNode) {
            if (event.type !== "pointerdown") return false;
            const W       = mouseNode.size[0];
            const relY    = pos[1] - widgetY;
            const sources = getSources(mouseNode);
            const layout  = rowLayout(W, { hasMoveUpDown: true, hasDelete: true });

            // ── ヘッダー行: 目玉トグル pill ──
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
                    if (moveUp && si > 0) {
                        swapSources(mouseNode, si - 1, si);
                    } else if (!moveUp && si < sources.length - 1) {
                        swapSources(mouseNode, si, si + 1);
                    }
                    return true;
                }

                // コンテンツ領域 → ソースノードへジャンプ
                if (inX(pos, layout.contentX, layout.contentW)) {
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
            // Python 定義の固定スロットを削除してゼロ起点で管理
            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--) this.removeOutput(i);
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) this.removeInput(i);
            this.addCustomWidget(makeSourceWidget(this));
            this.size[0] = Math.max(this.size[0], 320);
        };

        // --- onSerialize ---
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            onSerialize?.apply(this, arguments);
            data.sax_remote = {
                sources:      getSources(this),
                linksVisible: this._remoteLinksVisible ?? false,
            };
        };

        // --- onConfigure ---
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);
            if (data.sax_remote) {
                const saved = data.sax_remote;

                // 旧フォーマット（v1: sourceId が直接ある）→ sources[] 形式へ移行
                let sources;
                if (saved.sources) {
                    sources = saved.sources;
                } else if (saved.sourceId != null) {
                    sources = [{
                        sourceId:    saved.sourceId,
                        sourceTitle: saved.sourceTitle ?? "",
                        slotCount:   saved.slotCount   ?? 0,
                        slotNames:   saved.slotNames    ?? [],
                        slotTypes:   saved.slotTypes    ?? [],
                        sig:         "",
                    }];
                } else {
                    sources = [];
                }

                this._remoteSources      = sources;
                this._remoteLinksVisible = saved.linksVisible ?? false;

                // スロット数を非破壊的差分更新（LiteGraph がリンク復元前に呼ぶため）
                const total  = getTotalSlotCount(this);
                const curOut = this.outputs?.length ?? 0;
                const curIn = this.inputs?.length ?? 0;
                for (let i = curOut - 1; i >= total; i--) this.removeOutput(i);
                for (let i = curOut; i < total; i++) this.addOutput(`out_${i}`, "*");
                for (let i = curIn - 1; i >= total; i--) this.removeInput(i);
                for (let i = curIn; i < total; i++) this.addInput(`slot_${i}`, "*");
                syncSlotLabels(this);
            }

            if (!this.widgets?.some(w => w.name === "__sax_remote_source")) {
                this.addCustomWidget(makeSourceWidget(this));
            }
            this.size[0] = Math.max(this.size[0], 320);

            // ワークフロー読み込み・ペースト後にリンクが確定してから補完
            const self = this;
            setTimeout(() => {
                const sources = getSources(self);
                for (let si = 0; si < sources.length; si++) {
                    const src     = sources[si];
                    const srcNode = app.graph.getNodeById(src.sourceId);
                    if (!srcNode) continue;
                    const offset = getOffset(self, si);
                    for (let i = 0; i < src.slotCount; i++) {
                        if (self.inputs[offset + i]?.link == null) {
                            srcNode.connect(i, self, offset + i);
                        }
                    }
                    src.sig = sourceSignature(srcNode);
                }
                applyLinkVisibility(self);
                autoResize(self);
            }, 0);
        };
    },
});
