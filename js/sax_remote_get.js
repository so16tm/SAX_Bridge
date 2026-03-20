import { app } from "../../scripts/app.js";
import { panCanvasTo, showPicker } from "./sax_picker.js";

const EXT_NAME  = "SAX.RemoteGet";
const NODE_TYPE = "SAXRemoteGet";
const MAX_SLOTS = 16;

// ---------------------------------------------------------------------------
// renderLink パッチ — 非表示リンクをスキップする
// ---------------------------------------------------------------------------

const _hiddenLinkIds = new Set();
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

// Remote Get の入力リンクを非表示セットに登録する
function hideSourceLinks(node) {
    for (let i = 0; i < node.inputs.length; i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.add(linkId);
    }
    app.canvas?.setDirty(true, false);
}

// Remote Get の入力リンクを非表示セットから解除する
function unhideSourceLinks(node) {
    for (let i = 0; i < node.inputs.length; i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.delete(linkId);
    }
}

// リンク表示状態を適用する（node._remoteLinksVisible に従う）
function applyLinkVisibility(node) {
    if (node._remoteLinksVisible) {
        unhideSourceLinks(node);
    } else {
        hideSourceLinks(node);
    }
    app.canvas?.setDirty(true, false);
}

// リンク表示トグル
function toggleLinkVisibility(node) {
    node._remoteLinksVisible = !node._remoteLinksVisible;
    applyLinkVisibility(node);
}

// ---------------------------------------------------------------------------
// DOM ヘルパー
// ---------------------------------------------------------------------------

function h(tag, css = "", text = "") {
    const e = document.createElement(tag);
    if (css)  e.style.cssText = css;
    if (text) e.textContent   = text;
    return e;
}

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
// ソース情報の取得・保存ヘルパー
// ---------------------------------------------------------------------------

function getRemoteExtra(node) {
    return {
        sourceId:     node._remoteSourceId    ?? null,
        sourceTitle:  node._remoteSourceTitle ?? null,
        slotCount:    node._remoteSlotCount   ?? 0,
        slotNames:    node._remoteSlotNames   ?? [],
        slotTypes:    node._remoteSlotTypes   ?? [],
        linksVisible: node._remoteLinksVisible ?? false,
    };
}

function setRemoteExtra(node, { sourceId, sourceTitle, slotCount, slotNames, slotTypes, linksVisible }) {
    node._remoteSourceId     = sourceId;
    node._remoteSourceTitle  = sourceTitle;
    node._remoteSlotCount    = slotCount;
    node._remoteSlotNames    = slotNames;
    node._remoteSlotTypes    = slotTypes;
    node._remoteLinksVisible = linksVisible ?? false;
}

// ---------------------------------------------------------------------------
// ノードのスロット名・型を同期する
// ---------------------------------------------------------------------------

function syncSlotLabels(node) {
    const { slotCount, slotNames, slotTypes } = getRemoteExtra(node);
    // 入力スロット名は Python パラメータ名 slot_i に固定（変更禁止）
    for (let i = 0; i < node.inputs.length; i++) {
        node.inputs[i].name = `slot_${i}`;
        node.inputs[i].type = "*";
    }
    // 出力スロットのラベル・型を更新（スロット数の増減は applySource / resyncSlots が管理）
    for (let i = 0; i < slotCount; i++) {
        const name = slotNames[i] || `slot_${i}`;
        const type = slotTypes[i] || "*";
        if (node.outputs[i]) { node.outputs[i].name = name; node.outputs[i].label = name; node.outputs[i].type = type; }
    }
    app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// ソース選択を適用する（リンク + ラベル更新）
// ---------------------------------------------------------------------------

function applySource(remoteNode, srcNode) {
    const srcOutputs = srcNode.outputs ?? [];
    const count = Math.min(srcOutputs.length, MAX_SLOTS);

    // 既存の入力リンクを非表示セットから除去してから削除
    unhideSourceLinks(remoteNode);
    for (let i = (remoteNode.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const linkId = remoteNode.inputs[i]?.link;
        if (linkId != null) app.graph.removeLink(linkId);
        remoteNode.removeInput(i);
    }

    // 既存の出力スロットをすべて削除（後ろから削除しないとインデックスがずれる）
    for (let i = (remoteNode.outputs?.length ?? 0) - 1; i >= 0; i--) {
        remoteNode.removeOutput(i);
    }

    const slotNames = [];
    const slotTypes = [];

    for (let i = 0; i < count; i++) {
        const out = srcOutputs[i];
        const name = out.label || out.name || out.type || `slot_${i}`;
        const type = out.type || "*";
        slotNames.push(name);
        slotTypes.push(type);
        remoteNode.addInput(`slot_${i}`, "*");
        remoteNode.addOutput(name, type);
        srcNode.connect(i, remoteNode, i);
    }

    setRemoteExtra(remoteNode, {
        sourceId:    srcNode.id,
        sourceTitle: srcNode.title || srcNode.type || `Node#${srcNode.id}`,
        slotCount:   count,
        slotNames,
        slotTypes,
    });

    syncSlotLabels(remoteNode);
    applyLinkVisibility(remoteNode);
}

// ---------------------------------------------------------------------------
// ソースのリセット（削除検知・手動解除に共通）
// ---------------------------------------------------------------------------

// ソースの出力構成を表すシグネチャ文字列（変化検知用）
function sourceSignature(srcNode) {
    return (srcNode.outputs ?? []).slice(0, MAX_SLOTS)
        .map(o => `${o.label ?? o.name ?? ""}:${o.type ?? ""}`).join(",");
}

// リンクを維持しつつスロット情報を再同期する（F: スロット構成変更追従）
function resyncSlots(node, srcNode) {
    const srcOutputs = srcNode.outputs ?? [];
    const oldCount   = node._remoteSlotCount ?? 0;
    const count      = Math.min(srcOutputs.length, MAX_SLOTS);
    const slotNames  = srcOutputs.slice(0, count).map((o, i) => o.label || o.name || o.type || `slot_${i}`);
    const slotTypes  = srcOutputs.slice(0, count).map(o => o.type || "*");

    // 減った分: 後ろから入出力スロットを削除
    for (let i = oldCount - 1; i >= count; i--) {
        node.removeOutput(i);
        node.removeInput(i);
    }
    // 増えた分: 入出力スロットを追加して接続
    for (let i = oldCount; i < count; i++) {
        node.addInput(`slot_${i}`, "*");
        node.addOutput(slotNames[i], slotTypes[i]);
        srcNode.connect(i, node, i);
    }

    node._remoteSlotCount = count;
    node._remoteSlotNames = slotNames;
    node._remoteSlotTypes = slotTypes;

    syncSlotLabels(node);
    if (count !== oldCount) applyLinkVisibility(node);
}

function resetSource(node) {
    // 存在しなくなったリンク ID を _hiddenLinkIds から掃除
    for (const id of [..._hiddenLinkIds]) {
        if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
    }
    // 全入出力スロットを削除
    for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) {
        node.removeOutput(i);
    }
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        node.removeInput(i);
    }
    setRemoteExtra(node, {
        sourceId:    null,
        sourceTitle: null,
        slotCount:   0,
        slotNames:   [],
        slotTypes:   [],
    });
    app.canvas?.setDirty(true, false);
}

// ---------------------------------------------------------------------------
// ソース選択ピッカー（sax_picker.js の共通ピッカーを使用）
// ---------------------------------------------------------------------------

function showSourcePicker(remoteNode) {
    const { sourceId } = getRemoteExtra(remoteNode);
    showPicker({
        title:         "Select Source Node",
        sections:      ["subgraphs", "nodes"],
        mode:          "single",
        currentNodeId: sourceId,
        excludeNodeId: remoteNode.id,
        filterNode:    n => (n.outputs ?? []).length > 0,
        onSelect:      n => applySource(remoteNode, n),
    });
}

// ---------------------------------------------------------------------------
// ソース選択ウィジェット（ノード上部に表示）
// ---------------------------------------------------------------------------

function makeSourceWidget(node) {
    return {
        name:  "__sax_remote_source",
        type:  "__sax_remote_source",
        value: null,
        computeSize: (W) => [W, 32],

        draw(ctx, node, W, y) {
            // C: ソースノード削除検知 / E: タイトル変更追従
            const { sourceId } = getRemoteExtra(node);
            if (sourceId != null) {
                const srcNode = app.graph.getNodeById(sourceId);
                if (!srcNode) {
                    resetSource(node);
                    return;
                }
                // E: タイトルが変わっていたら追従
                const currentTitle = srcNode.title || srcNode.type || `Node#${srcNode.id}`;
                if (currentTitle !== node._remoteSourceTitle) {
                    node._remoteSourceTitle = currentTitle;
                }
                // F: スロット構成が変わっていたらラベルのみ再同期（リンクは維持）
                const sig = sourceSignature(srcNode);
                if (sig !== node._remoteSourceSig) {
                    node._remoteSourceSig = sig;
                    resyncSlots(node, srcNode);
                }
            }

            const { sourceTitle, slotCount, linksVisible } = getRemoteExtra(node);
            const hasSource = !!sourceTitle;
            const midY = y + 16;

            // レイアウト定数
            const PAD    = 8;
            const selectW = 68;
            const eyeW    = 26;
            const gap     = 4;
            const selectX = W - PAD - selectW;
            const eyeX    = selectX - gap - eyeW;

            // 背景
            rrect(ctx, PAD, y + 3, W - PAD * 2, 26, 4,
                "#1a1a2e",
                hasSource ? "#3a6a3a" : "#4a4a6a");

            // ソース名ラベル（眼アイコンの左まで）
            ctx.font = "11px sans-serif";
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillStyle = hasSource ? "#7d7" : "#555";
            const label = hasSource
                ? `→ ${sourceTitle}  (${slotCount} slot${slotCount !== 1 ? "s" : ""})`
                : "No source — click Select to connect";
            ctx.save();
            ctx.beginPath();
            ctx.rect(PAD + 6, y + 3, eyeX - PAD - 10, 26);
            ctx.clip();
            ctx.fillText(label, PAD + 6, midY);
            ctx.restore();

            // [👁] トグルボタン（ソースあり時のみ表示）
            if (hasSource) {
                const eyeOn = linksVisible;
                rrect(ctx, eyeX, y + 6, eyeW, 20, 3,
                    eyeOn ? "#2a3a4a" : "#1a1a1a",
                    eyeOn ? "#4a8acc" : "#3a3a3a");
                ctx.fillStyle = eyeOn ? "#7af" : "#555";
                ctx.textAlign = "center";
                ctx.fillText(eyeOn ? "👁" : "🚫", eyeX + eyeW / 2, midY);
            }

            // [Select] ボタン
            rrect(ctx, selectX, y + 6, selectW, 20, 3, "#1a3a1a", "#2a6a2a");
            ctx.fillStyle = "#7d7";
            ctx.textAlign = "center";
            ctx.fillText("Select…", selectX + selectW / 2, midY);
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;
            const W = node.size[0];
            const PAD    = 8;
            const selectW = 68;
            const eyeW    = 26;
            const gap     = 4;
            const selectX = W - PAD - selectW;
            const eyeX    = selectX - gap - eyeW;

            // [Select]
            if (pos[0] >= selectX && pos[0] <= selectX + selectW) {
                showSourcePicker(node);
                return true;
            }
            const { sourceId, sourceTitle } = getRemoteExtra(node);
            // [👁] トグル（ソースありのとき）
            if (sourceTitle && pos[0] >= eyeX && pos[0] <= eyeX + eyeW) {
                toggleLinkVisibility(node);
                return true;
            }
            // D: ラベル領域クリック → ソースノードへジャンプ
            if (sourceTitle && pos[0] >= PAD && pos[0] < eyeX) {
                const srcNode = app.graph.getNodeById(sourceId);
                if (srcNode) {
                    panCanvasTo(
                        srcNode.pos[0] + (srcNode.size?.[0] ?? 0) / 2,
                        srcNode.pos[1] + (srcNode.size?.[1] ?? 0) / 2
                    );
                }
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

    // renderLink パッチはキャンバスが確定した後に適用する
    setup() {
        ensureRenderLinkPatch();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // --- onNodeCreated ---
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            setRemoteExtra(this, {
                sourceId:    null,
                sourceTitle: null,
                slotCount:   0,
                slotNames:   [],
                slotTypes:   [],
            });
            // Python 定義の固定スロット(各16個)を削除してゼロ起点で管理
            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--) {
                this.removeOutput(i);
            }
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) {
                this.removeInput(i);
            }
            this.addCustomWidget(makeSourceWidget(this));
            this.size[0] = Math.max(this.size[0], 320);
        };

        // --- onSerialize ---
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            onSerialize?.apply(this, arguments);
            data.sax_remote = getRemoteExtra(this);
        };

        // --- onConfigure ---
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            onConfigure?.apply(this, arguments);
            if (data.sax_remote) {
                setRemoteExtra(this, data.sax_remote);
                const { slotCount, slotNames, slotTypes } = getRemoteExtra(this);
                // 出力スロット（非破壊的に差分のみ更新）
                const currentOutCount = this.outputs?.length ?? 0;
                for (let i = currentOutCount - 1; i >= slotCount; i--) {
                    this.removeOutput(i);
                }
                for (let i = currentOutCount; i < slotCount; i++) {
                    this.addOutput(slotNames[i] || `slot_${i}`, slotTypes[i] || "*");
                }
                // 入力スロット（非破壊的に差分のみ更新）
                const currentInCount = this.inputs?.length ?? 0;
                for (let i = currentInCount - 1; i >= slotCount; i--) {
                    this.removeInput(i);
                }
                for (let i = currentInCount; i < slotCount; i++) {
                    this.addInput(`slot_${i}`, "*");
                }
                syncSlotLabels(this);
            }
            if (!this.widgets?.some(w => w.name === "__sax_remote_source")) {
                this.addCustomWidget(makeSourceWidget(this));
            }
            this.size[0] = Math.max(this.size[0], 320);
            // ワークフロー読み込み・ペースト後にリンクを補完してから表示状態を適用
            const self = this;
            setTimeout(() => {
                const srcNode = app.graph.getNodeById(self._remoteSourceId);
                if (srcNode) {
                    // リンクが切れているスロットのみ再接続（ペースト復元 / ワークフロー読み込みは既存リンクをスキップ）
                    const { slotCount } = getRemoteExtra(self);
                    for (let i = 0; i < slotCount; i++) {
                        if (self.inputs[i]?.link == null) {
                            srcNode.connect(i, self, i);
                        }
                    }
                    self._remoteSourceSig = sourceSignature(srcNode);
                }
                applyLinkVisibility(self);
            }, 0);
        };
    },
});
