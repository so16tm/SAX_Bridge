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
    showDialog, h,
    ensureRenderLinkPatch, hideSourceLinks, unhideSourceLinks,
    applyLinkVisibility, toggleLinkVisibility, _hiddenLinkIds,
} from "./sax_ui_base.js";

const EXT_NAME  = "SAX.NodeCollector";
const NODE_TYPE = "SAX_Bridge_Node_Collector";
const MAX_SLOTS = 32;   // Python 側 MAX_SLOTS と合わせる

// ---------------------------------------------------------------------------
// ソース状態アクセサ
// ---------------------------------------------------------------------------

function getSources(node) {
    return node._remoteSources ?? [];
}

/** ソース srcIdx の先頭スロットの絶対インデックス（物理スロット数ベース） */
function getOffset(node, srcIdx) {
    const sources = getSources(node);
    let offset = 0;
    for (let i = 0; i < srcIdx; i++) {
        const src = sources[i];
        offset += src.enabledSlots?.length ?? src.slotCount ?? 0;
    }
    return offset;
}

function getTotalSlotCount(node) {
    return getSources(node).reduce((sum, s) => sum + (s.enabledSlots?.length ?? s.slotCount ?? 0), 0);
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
    let absIdx = 0;
    for (const src of sources) {
        const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
        for (let li = 0; li < enabled.length; li++) {
            const gi   = enabled[li];
            const name = src.slotNames[gi] || `out_${absIdx}`;
            const type = src.slotTypes[gi] || "*";
            if (node.inputs[absIdx]) {
                node.inputs[absIdx].name = `slot_${absIdx}`;
                node.inputs[absIdx].type = "*";
            }
            if (node.outputs[absIdx]) {
                node.outputs[absIdx].name  = name;
                node.outputs[absIdx].label = name;
                node.outputs[absIdx].type  = type;
            }
            absIdx++;
        }
    }
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// ソースの追加・削除・再同期・リセット
// ---------------------------------------------------------------------------

function addSource(remoteNode, srcNode, enabledSlots = null) {
    const sources   = remoteNode._remoteSources ?? [];
    const offset    = getTotalSlotCount(remoteNode);
    const remaining = MAX_SLOTS - offset;
    if (remaining <= 0) return;

    const srcOutputs = srcNode.outputs ?? [];
    const allCount   = Math.min(srcOutputs.length, remaining);
    if (allCount === 0) return;

    // enabledSlots 未指定 → 全スロット有効
    const effective = enabledSlots
        ? enabledSlots.filter(i => i >= 0 && i < allCount)
        : Array.from({ length: allCount }, (_, i) => i);

    const slotNames = [], slotTypes = [];
    for (let i = 0; i < allCount; i++) {
        const out  = srcOutputs[i];
        const name = out.label || out.name || out.type || `out_${offset + i}`;
        const type = out.type || "*";
        slotNames.push(name);
        slotTypes.push(type);
    }

    for (let li = 0; li < effective.length; li++) {
        const gi     = effective[li];
        const absIdx = offset + li;
        remoteNode.addInput(`slot_${absIdx}`, "*");
        remoteNode.addOutput(slotNames[gi], slotTypes[gi]);
        srcNode.connect(gi, remoteNode, absIdx);
    }

    sources.push({
        sourceId:    srcNode.id,
        sourceTitle: srcNode.title || srcNode.type || `Node#${srcNode.id}`,
        slotCount:   allCount,
        enabledSlots: effective,
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

    const offset      = getOffset(node, idx);
    const physCount   = sources[idx].enabledSlots?.length ?? sources[idx].slotCount ?? 0;

    unhideSourceLinks(node);
    for (let i = offset + physCount - 1; i >= offset; i--) {
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
    const sources = getSources(node);
    const src     = sources[srcIdx];
    if (!src) return;

    const srcOutputs  = srcNode.outputs ?? [];
    const oldCount    = src.slotCount;
    const physCount   = src.enabledSlots?.length ?? oldCount;
    const afterSlots  = getTotalSlotCount(node) - getOffset(node, srcIdx) - physCount;
    const remaining   = MAX_SLOTS - getOffset(node, srcIdx) - afterSlots;
    const newCount    = Math.min(srcOutputs.length, remaining);
    const newNames    = srcOutputs.slice(0, newCount).map(
        (o, i) => o.label || o.name || o.type || `out_${i}`);
    const newTypes    = srcOutputs.slice(0, newCount).map(o => o.type || "*");

    // enabledSlots を更新（デフォルト有効: 新スロットは有効, 削除スロットは除去）
    const oldEnabled = src.enabledSlots ?? Array.from({ length: oldCount }, (_, i) => i);
    let newEnabled;
    if (newCount > oldCount) {
        newEnabled = [...oldEnabled, ...Array.from({ length: newCount - oldCount }, (_, i) => oldCount + i)];
    } else if (newCount < oldCount) {
        newEnabled = oldEnabled.filter(i => i < newCount);
    } else {
        newEnabled = [...oldEnabled];
    }

    src.slotCount    = newCount;
    src.slotNames    = newNames;
    src.slotTypes    = newTypes;
    src.enabledSlots = newEnabled;
    src.sig          = sourceSignature(srcNode);

    rebuildAllSources(node);
}

/** 中間ソースのスロット増加時に全ソースを再構築する（下流接続を保存・復元する） */
function rebuildAllSources(node) {
    const savedSources = [...getSources(node)];

    // 下流リンクを保存（sourceId + グローバルスロットインデックス → 下流ノード/スロット）
    const downstreamMap = [];
    for (let si = 0; si < savedSources.length; si++) {
        const src     = savedSources[si];
        const offset  = getOffset(node, si);
        const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
        for (let li = 0; li < enabled.length; li++) {
            const absIdx = offset + li;
            const out = node.outputs?.[absIdx];
            if (!out?.links?.length) continue;
            for (const lid of out.links) {
                const lnk = app.graph.links?.[lid];
                if (lnk) {
                    downstreamMap.push({
                        sourceId:      src.sourceId,
                        globalSlotIdx: enabled[li],
                        targetId:      lnk.target_id,
                        targetSlot:    lnk.target_slot,
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
        if (srcNode) addSource(node, srcNode, src.enabledSlots);
    }

    // 下流リンクを復元
    for (const ds of downstreamMap) {
        const newSi = getSources(node).findIndex(s => s.sourceId === ds.sourceId);
        if (newSi < 0) continue;
        const src      = getSources(node)[newSi];
        const localIdx = (src.enabledSlots ?? []).indexOf(ds.globalSlotIdx);
        if (localIdx < 0) continue;
        const newAbsIdx = getOffset(node, newSi) + localIdx;
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

    // 下流リンクを保存
    const downstreamMap = [];
    for (let idx = 0; idx < sources.length; idx++) {
        const src     = sources[idx];
        const offset  = getOffset(node, idx);
        const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
        for (let li = 0; li < enabled.length; li++) {
            const out = node.outputs?.[offset + li];
            if (!out?.links?.length) continue;
            for (const lid of out.links) {
                const lnk = app.graph.links?.[lid];
                if (lnk) downstreamMap.push({
                    sourceId:      src.sourceId,
                    globalSlotIdx: enabled[li],
                    targetId:      lnk.target_id,
                    targetSlot:    lnk.target_slot,
                });
            }
        }
    }

    [sources[si], sources[sj]] = [sources[sj], sources[si]];

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
        if (srcNode) addSource(node, srcNode, src.enabledSlots);
    }

    for (const ds of downstreamMap) {
        const newSi = getSources(node).findIndex(s => s.sourceId === ds.sourceId);
        if (newSi < 0) continue;
        const src      = getSources(node)[newSi];
        const localIdx = (src.enabledSlots ?? []).indexOf(ds.globalSlotIdx);
        if (localIdx < 0) continue;
        const newAbsIdx = getOffset(node, newSi) + localIdx;
        const tgtNode = app.graph.getNodeById(ds.targetId);
        if (tgtNode && node.outputs?.[newAbsIdx]) node.connect(newAbsIdx, tgtNode, ds.targetSlot);
    }

    applyLinkVisibility(node);
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// スロット選択の適用（enabledSlots 変更 → 物理スロット再構築）
// ---------------------------------------------------------------------------

/**
 * 指定ソースの表示スロットを変更して物理スロットを再構築する。
 *
 * rebuildAllSources は「enabledSlots と物理スロットが対応している」ことを前提とするため、
 * enabledSlots を先に更新してから rebuildAllSources を呼ぶと、リンク保存ループが
 * 新 enabledSlots × 旧物理スロットのミスマッチで誤ったグローバルインデックスを記録してしまう。
 * この関数ではリンク保存を enabledSlots 更新前（物理スロットと一致している状態）に行う。
 */
function applySlotSelection(node, si, newEnabledSlots) {
    const sources = getSources(node);

    // ── 1. 現在の物理スロット（旧 enabledSlots）で全ソースのリンクを保存 ──
    const downstreamMap = [];
    for (let idx = 0; idx < sources.length; idx++) {
        const s       = sources[idx];
        const off     = getOffset(node, idx);
        const enabled = s.enabledSlots ?? Array.from({ length: s.slotCount ?? 0 }, (_, i) => i);
        for (let li = 0; li < enabled.length; li++) {
            const out = node.outputs?.[off + li];
            if (!out?.links?.length) continue;
            for (const lid of out.links) {
                const lnk = app.graph.links?.[lid];
                if (lnk) downstreamMap.push({
                    sourceId:      s.sourceId,
                    globalSlotIdx: enabled[li],
                    targetId:      lnk.target_id,
                    targetSlot:    lnk.target_slot,
                });
            }
        }
    }

    // ── 2. 対象ソースの enabledSlots を更新 ──
    sources[si].enabledSlots = [...newEnabledSlots].sort((a, b) => a - b);

    // ── 3. 物理スロットをクリアして再構築 ──
    const savedSources = [...sources];
    unhideSourceLinks(node);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        node.removeInput(i);
    }
    for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) node.removeOutput(i);
    node._remoteSources = [];

    for (const src of savedSources) {
        const srcNode = app.graph.getNodeById(src.sourceId);
        if (srcNode) addSource(node, srcNode, src.enabledSlots);
    }

    // ── 4. 下流リンクを復元（非表示になったスロットへの接続は自然に消える） ──
    for (const ds of downstreamMap) {
        const newSi = getSources(node).findIndex(s => s.sourceId === ds.sourceId);
        if (newSi < 0) continue;
        const src      = getSources(node)[newSi];
        const localIdx = (src.enabledSlots ?? []).indexOf(ds.globalSlotIdx);
        if (localIdx < 0) continue;  // 非表示になったスロット → 復元しない
        const newAbsIdx = getOffset(node, newSi) + localIdx;
        const tgtNode = app.graph.getNodeById(ds.targetId);
        if (tgtNode && node.outputs?.[newAbsIdx]) node.connect(newAbsIdx, tgtNode, ds.targetSlot);
    }

    for (const id of [..._hiddenLinkIds]) {
        if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
    }
    applyLinkVisibility(node);
    autoResize(node);
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// スロット選択ダイアログ
// ---------------------------------------------------------------------------

function showSlotSelectDialog(node, si) {
    const sources = getSources(node);
    const src     = sources[si];
    if (!src) return;

    // 現在の enabled を Set で管理（編集用）
    const editEnabled = new Set(src.enabledSlots ?? Array.from({ length: src.slotCount }, (_, i) => i));
    const checkboxes  = [];

    showDialog({
        title:     `Edit Slots: "${src.sourceTitle}"`,
        width:     360,
        className: "__sax_slot_select_dlg",
        build(container, close) {
            // ── 一括ボタン行 ─────────────────────────────────────────────
            const btnRow = h("div", "display:flex;gap:6px;margin-bottom:8px;");

            const btnSelectAll = h("button", `
                flex:1;padding:4px 8px;border-radius:4px;border:1px solid #555;
                background:#333;color:#ccc;cursor:pointer;font-size:11px;
            `, "全選択");
            btnSelectAll.addEventListener("click", () => {
                checkboxes.forEach(({ gi, cb }) => {
                    cb.checked = true;
                    editEnabled.add(gi);
                });
            });

            const btnClearAll = h("button", `
                flex:1;padding:4px 8px;border-radius:4px;border:1px solid #555;
                background:#333;color:#ccc;cursor:pointer;font-size:11px;
            `, "全解除");
            btnClearAll.addEventListener("click", () => {
                checkboxes.forEach(({ gi, cb }) => {
                    cb.checked = false;
                    editEnabled.delete(gi);
                });
            });

            btnRow.appendChild(btnSelectAll);
            btnRow.appendChild(btnClearAll);
            container.appendChild(btnRow);

            // ── スロットリスト ────────────────────────────────────────────
            const list = h("div", `
                display:flex;flex-direction:column;gap:4px;
                max-height:320px;overflow-y:auto;
            `);

            for (let gi = 0; gi < src.slotCount; gi++) {
                const name = src.slotNames[gi] || `slot_${gi}`;
                const type = src.slotTypes[gi] || "*";

                const row = h("label", `
                    display:flex;align-items:center;gap:8px;padding:5px 8px;
                    border-radius:4px;background:#2a2a2a;cursor:pointer;
                    user-select:none;
                `);

                const cb = document.createElement("input");
                cb.type    = "checkbox";
                cb.checked = editEnabled.has(gi);
                cb.style.cssText = "width:14px;height:14px;accent-color:#4a9;cursor:pointer;";
                cb.addEventListener("change", () => {
                    if (cb.checked) editEnabled.add(gi);
                    else editEnabled.delete(gi);
                });

                const nameTxt = h("span", "flex:1;font-size:12px;color:#ddd;", name);
                const typeTxt = h("span", "font-size:10px;color:#888;", type);

                row.appendChild(cb);
                row.appendChild(nameTxt);
                row.appendChild(typeTxt);
                list.appendChild(row);
                checkboxes.push({ gi, cb });
            }
            container.appendChild(list);

            // ── Cancel / Apply ───────────────────────────────────────────
            const footer = h("div", "display:flex;gap:6px;margin-top:12px;justify-content:flex-end;");

            const btnCancel = h("button", `
                padding:5px 16px;border-radius:4px;border:1px solid #555;
                background:#333;color:#ccc;cursor:pointer;
            `, "Cancel");
            btnCancel.addEventListener("click", () => close());

            const btnApply = h("button", `
                padding:5px 16px;border-radius:4px;border:none;
                background:#4a9;color:#fff;cursor:pointer;font-weight:bold;
            `, "Apply");
            btnApply.addEventListener("click", () => {
                const newEnabled = Array.from(editEnabled).sort((a, b) => a - b);
                applySlotSelection(node, si, newEnabled);
                app.graph.setDirtyCanvas(true, false);
                close();
            });

            footer.appendChild(btnCancel);
            footer.appendChild(btnApply);
            container.appendChild(footer);
        },
    });
}

// ---------------------------------------------------------------------------
// ソース追加ピッカー
// ---------------------------------------------------------------------------

function showAddSourcePicker(remoteNode) {
    const existingIds = new Set([remoteNode.id, ...getSources(remoteNode).map(s => s.sourceId)]);
    showPicker({
        title:       "Select source nodes",
        sections:    ["subgraphs", "nodes"],
        mode:        "multi",
        selection:   new Map(),
        showWidgets: false,
        filterNode:  n => !existingIds.has(n.id) && (n.outputs ?? []).length > 0,
        onConfirm:   (items) => {
            for (const item of items) {
                if (item.type !== "node") continue;
                const n = app.graph.getNodeById(item.id);
                if (n) addSource(remoteNode, n);
            }
        },
    });
}

// ---------------------------------------------------------------------------
// ソース選択ウィジェット
// ---------------------------------------------------------------------------

// HEADER_H, ADD_H は sax_ui_base からインポート済み

function makeSourceWidget(node) {
    let widgetY = 0;

    return {
        name:  "__sax_node_collector",
        type:  "__sax_node_collector",
        value: null,

        computeSize(W) {
            const n = getSources(node).length;
            return [W, HEADER_H + n * ROW_H + ADD_H + BOTTOM_PAD];
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

            // ── ソース行 ──
            const layout = rowLayout(W, { hasJump: true, hasMoveUpDown: true, hasDelete: true });
            for (let si = 0; si < sources.length; si++) {
                const src     = sources[si];
                const rowY    = y + HEADER_H + si * ROW_H;
                const midY    = rowY + ROW_H / 2;
                const enabled = src.enabledSlots?.length ?? src.slotCount ?? 0;
                const total   = src.slotCount ?? 0;

                drawRowBg(ctx, W, rowY);

                const icon  = src.isSub ? "▣" : "◈";
                const color = src.isSub ? SAX_COLORS.subgraph : SAX_COLORS.node;
                const slots = enabled === total
                    ? `  (${total} slot${total !== 1 ? "s" : ""})`
                    : `  (${enabled}/${total})`;

                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                txt(ctx, `${icon}  ${src.sourceTitle}`, layout.contentX + 4, midY, color, "left", 11);
                txt(ctx, slots, layout.contentX + layout.contentW, midY, t.contentBg, "right", 10);
                ctx.restore();

                drawJumpBtn(ctx, layout.jump.x, midY);
                drawMoveArrows(ctx, layout.move.x, rowY, ROW_H, si > 0, si < sources.length - 1);
                drawDeleteBtn(ctx, layout.del.x, midY);
            }

            // ── Add ボタン ──
            const btnY   = y + HEADER_H + sources.length * ROW_H;
            const canAdd = getTotalSlotCount(drawNode) < MAX_SLOTS;
            drawAddBtn(ctx, W, btnY,
                sources.length === 0 ? "Select source…" : "+ Add source",
                canAdd);
        },

        mouse(event, pos, mouseNode) {
            if (event.type !== "pointerdown") return false;
            const W       = mouseNode.size[0];
            const relY    = pos[1] - widgetY;
            const sources = getSources(mouseNode);
            const layout  = rowLayout(W, { hasJump: true, hasMoveUpDown: true, hasDelete: true });

            // ── ヘッダー行: 目玉トグル pill ──
            if (relY < HEADER_H) {  // HEADER_H: sax_ui_base から import
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

                // コンテンツ領域クリック → スロット選択ダイアログ
                if (inX(pos, layout.contentX, layout.contentW)) {
                    showSlotSelectDialog(mouseNode, si);
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
            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--) this.removeOutput(i);
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) this.removeInput(i);
            this.addCustomWidget(makeSourceWidget(this));
            this.size[0] = Math.max(this.size[0], 320);
            this.size[1] = 1;   // slot 数に基づく ComfyUI デフォルト高さを破棄
        };

        // --- onSerialize ---
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            onSerialize?.apply(this, arguments);
            data.sax_node_collector = {
                sources:      getSources(this),
                linksVisible: this._remoteLinksVisible ?? false,
            };
        };

        // --- onConfigure ---
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);
            if (data.sax_node_collector) {
                const saved = data.sax_node_collector;

                // 旧フォーマット（v1: sourceId が直接ある）→ sources[] 形式へ移行
                let sources;
                if (saved.sources) {
                    sources = saved.sources;
                } else if (saved.sourceId != null) {
                    sources = [{
                        sourceId:    saved.sourceId,
                        sourceTitle: saved.sourceTitle ?? "",
                        slotCount:   saved.slotCount   ?? 0,
                        enabledSlots: null,  // 後続で全有効にフォールバック
                        slotNames:   saved.slotNames    ?? [],
                        slotTypes:   saved.slotTypes    ?? [],
                        sig:         "",
                    }];
                } else {
                    sources = [];
                }

                // 旧フォーマット互換: enabledSlots がない場合は全スロット有効
                for (const src of sources) {
                    if (!src.enabledSlots) {
                        src.enabledSlots = Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
                    }
                }

                this._remoteSources      = sources;
                this._remoteLinksVisible = saved.linksVisible ?? false;

                // スロット数を非破壊的差分更新（LiteGraph がリンク復元前に呼ぶため）
                const total  = getTotalSlotCount(this);
                const curOut = this.outputs?.length ?? 0;
                const curIn  = this.inputs?.length ?? 0;
                for (let i = curOut - 1; i >= total; i--) this.removeOutput(i);
                for (let i = curOut; i < total; i++) this.addOutput(`out_${i}`, "*");
                for (let i = curIn - 1; i >= total; i--) this.removeInput(i);
                for (let i = curIn; i < total; i++) this.addInput(`slot_${i}`, "*");
                syncSlotLabels(this);
            }

            if (!this.widgets?.some(w => w.name === "__sax_node_collector")) {
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
                    const offset  = getOffset(self, si);
                    const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
                    for (let li = 0; li < enabled.length; li++) {
                        if (self.inputs[offset + li]?.link == null) {
                            srcNode.connect(enabled[li], self, offset + li);
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
