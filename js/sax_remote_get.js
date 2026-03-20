import { app } from "../../scripts/app.js";
import { panCanvasTo, showPicker } from "./sax_picker.js";

const EXT_NAME  = "SAX.RemoteGet";
const NODE_TYPE = "SAX_Bridge_Remote_Get";
const MAX_SLOTS = 32;   // Python 側 MAX_SLOTS と合わせる
const ROW_H     = 28;   // ソース行の高さ (px)
const PAD       = 8;

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
// 描画ヘルパー
// ---------------------------------------------------------------------------

function rrect(ctx, x, y, w, hh, r, fill, stroke) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, hh, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y,      x + w, y + r,      r);
        ctx.lineTo(x + w, y + hh - r);
        ctx.arcTo(x + w, y + hh, x + w - r, y + hh, r);
        ctx.lineTo(x + r, y + hh);
        ctx.arcTo(x,      y + hh, x,      y + hh - r, r);
        ctx.lineTo(x,      y + r);
        ctx.arcTo(x,      y,      x + r,  y,          r);
        ctx.closePath();
    }
    if (fill)   { ctx.fillStyle   = fill;   ctx.fill();   }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
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

function makeSourceWidget(node) {
    // draw() で毎フレーム更新される。mouse() のヒットテストに使用
    let widgetY = 0;

    return {
        name:  "__sax_remote_source",
        type:  "__sax_remote_source",
        value: null,

        computeSize(W) {
            const n = getSources(node).length;
            return [W, ROW_H * (n + 1) + 8];
        },

        draw(ctx, drawNode, W, y) {
            widgetY = y;

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
                    // 描画サイクル外で構造変更を実行（レンダリング中の変更による不具合を防ぐ）
                    src.sig = sig;  // 再トリガー防止
                    const capturedSi = si;
                    const capturedSrcNode = srcNode;
                    const capturedSourceId = src.sourceId;
                    setTimeout(() => {
                        const currentSi = getSources(drawNode).findIndex(s => s.sourceId === capturedSourceId);
                        if (currentSi >= 0 && app.graph.getNodeById(capturedSourceId)) {
                            resyncSource(drawNode, currentSi, capturedSrcNode);
                        }
                    }, 0);
                    return;
                }
            }

            const linksVisible = drawNode._remoteLinksVisible ?? false;
            ctx.font         = "11px sans-serif";
            ctx.textBaseline = "middle";

            // ── ソース行 ──
            for (let si = 0; si < sources.length; si++) {
                const src  = sources[si];
                const rowY = y + si * ROW_H;
                const midY = rowY + ROW_H / 2;

                rrect(ctx, PAD, rowY + 3, W - PAD * 2, ROW_H - 4, 4, "#1a1a2e", "#3a6a3a");

                // [✕] ボタン（右端）
                const delW = 22;
                const delX = W - PAD - delW;
                rrect(ctx, delX, rowY + 6, delW, ROW_H - 10, 3, "#3a1a1a", "#6a2a2a");
                ctx.fillStyle = "#d77";
                ctx.textAlign = "center";
                ctx.fillText("✕", delX + delW / 2, midY);

                // ソース名ラベル（クリックでジャンプ）
                const label = `→ ${src.sourceTitle}  (${src.slotCount} slot${src.slotCount !== 1 ? "s" : ""})`;
                ctx.fillStyle = "#7d7";
                ctx.textAlign = "left";
                ctx.save();
                ctx.beginPath();
                ctx.rect(PAD + 6, rowY + 3, delX - PAD - 10, ROW_H - 4);
                ctx.clip();
                ctx.fillText(label, PAD + 6, midY);
                ctx.restore();
            }

            // ── ボタン行（最下行）──
            const noSrc   = sources.length === 0;
            const btnRowY = y + sources.length * ROW_H;
            const btnMidY = btnRowY + ROW_H / 2;

            rrect(ctx, PAD, btnRowY + 3, W - PAD * 2, ROW_H - 4, 4,
                "#1a1a2e", noSrc ? "#4a4a6a" : "#2a3a4a");

            // ソースなし: ボタン全幅。ソースあり: [👁] + [＋ ソース追加]
            const addW = noSrc ? W - PAD * 2 - 14 : 108;
            const eyeW = 26;
            const gap  = 4;
            const addX = W - PAD - addW;
            const eyeX = addX - gap - eyeW;

            // [👁] トグルボタン（ソースありのみ表示）
            if (!noSrc) {
                rrect(ctx, eyeX, btnRowY + 6, eyeW, ROW_H - 10, 3,
                    linksVisible ? "#2a3a4a" : "#1a1a1a",
                    linksVisible ? "#4a8acc" : "#3a3a3a");
                ctx.fillStyle = linksVisible ? "#7af" : "#555";
                ctx.textAlign = "center";
                ctx.fillText(linksVisible ? "👁" : "🚫", eyeX + eyeW / 2, btnMidY);
            }

            // [ソースを選択… / ＋ ソース追加] ボタン
            const canAdd = getTotalSlotCount(drawNode) < MAX_SLOTS;
            rrect(ctx, addX, btnRowY + 6, addW, ROW_H - 10, 3,
                canAdd ? "#1a3a1a" : "#2a2a2a",
                canAdd ? "#2a6a2a" : "#3a3a3a");
            ctx.fillStyle = canAdd ? "#7d7" : "#555";
            ctx.textAlign = "center";
            ctx.fillText(noSrc ? "Select source…" : "+ Add source", addX + addW / 2, btnMidY);
        },

        mouse(event, pos, mouseNode) {
            if (event.type !== "pointerdown") return false;
            const W       = mouseNode.size[0];
            const relY    = pos[1] - widgetY;
            const sources = getSources(mouseNode);

            // ソース行のヒットテスト
            for (let si = 0; si < sources.length; si++) {
                if (relY < si * ROW_H || relY >= (si + 1) * ROW_H) continue;
                const delW = 22;
                const delX = W - PAD - delW;

                // [✕] 削除ボタン
                if (pos[0] >= delX && pos[0] <= delX + delW) {
                    removeSourceAt(mouseNode, si);
                    return true;
                }
                // ラベル領域 → ソースノードへジャンプ
                if (pos[0] >= PAD && pos[0] < delX - 4) {
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

            // ボタン行のヒットテスト
            const btnRowTop = sources.length * ROW_H;
            if (relY < btnRowTop || relY >= btnRowTop + ROW_H) return false;

            const noSrc = sources.length === 0;
            const addW  = noSrc ? W - PAD * 2 - 14 : 108;
            const eyeW  = 26;
            const gap   = 4;
            const addX  = W - PAD - addW;
            const eyeX  = addX - gap - eyeW;

            // [＋ ソース追加 / ソースを選択…]
            if (pos[0] >= addX && pos[0] <= addX + addW) {
                if (getTotalSlotCount(mouseNode) < MAX_SLOTS) {
                    showAddSourcePicker(mouseNode);
                }
                return true;
            }
            // [👁] トグル（ソースありのみ）
            if (!noSrc && pos[0] >= eyeX && pos[0] <= eyeX + eyeW) {
                toggleLinkVisibility(mouseNode);
                return true;
            }
            return false;
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
