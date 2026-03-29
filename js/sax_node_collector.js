import { app } from "../../scripts/app.js";
import { showPicker } from "./sax_picker.js";
import { makeSourceListWidget, ensureRenderLinkPatch, showDialog, h } from "./sax_ui_base.js";

const EXT_NAME  = "SAX.NodeCollector";
const NODE_TYPE = "SAX_Bridge_Node_Collector";
const MAX_SLOTS = 32;   // Python 側 MAX_SLOTS と合わせる

// ---------------------------------------------------------------------------
// rebuildAllSources 時に旧 enabledSlots を引き継ぐための一時ヒント
// applySlotSelection 呼出の前後でセット/クリアする
// ---------------------------------------------------------------------------

let _rebuildHints = null;

// ---------------------------------------------------------------------------
// makeSourceListWidget によるソースリストウィジェット構築
// ---------------------------------------------------------------------------

const SOURCE = makeSourceListWidget({
    widgetName:    "__sax_node_collector",
    serializeKey:  "sax_node_collector",
    maxSlots:      MAX_SLOTS,
    hasOutputSlots: true,

    filterSourceNode(n) {
        return (n.outputs ?? []).length > 0;
    },

    buildSource(srcNode, collectorNode, offset, remaining) {
        const srcOutputs = srcNode.outputs ?? [];
        const allCount   = Math.min(srcOutputs.length, MAX_SLOTS, remaining);
        if (allCount === 0) return null;

        // rebuildAllSources 時: 一時ヒントがあれば旧 enabledSlots を引き継ぐ
        const hint = _rebuildHints?.get(srcNode.id);
        let enabledSlots;
        if (hint?.enabledSlots) {
            const oldEnabled  = hint.enabledSlots;
            const oldCount    = hint.slotCount ?? oldEnabled.length;
            if (allCount > oldCount) {
                // 新スロットをデフォルト有効として追加
                enabledSlots = [
                    ...oldEnabled,
                    ...Array.from({ length: allCount - oldCount }, (_, i) => oldCount + i),
                ];
            } else if (allCount < oldCount) {
                // 範囲外スロットを除去
                enabledSlots = oldEnabled.filter(i => i < allCount);
            } else {
                enabledSlots = [...oldEnabled];
            }
        } else {
            // ヒントなし（新規追加、または sig 変化時のリビルド）: 全スロット有効
            enabledSlots = Array.from({ length: allCount }, (_, i) => i);
        }

        const slotNames = [];
        const slotTypes = [];
        for (let i = 0; i < allCount; i++) {
            const out  = srcOutputs[i];
            slotNames.push(out.label || out.name || out.type || `out_${offset + i}`);
            slotTypes.push(out.type || "*");
        }

        return {
            sourceId:     srcNode.id,
            sourceTitle:  srcNode.title || srcNode.type || `Node#${srcNode.id}`,
            slotCount:    allCount,
            enabledSlots,
            slotNames,
            slotTypes,
            sig:          "",
            isSub:        srcNode.subgraph != null,
        };
    },

    connectSource(srcNode, src, collectorNode, offset) {
        const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
        for (let li = 0; li < enabled.length; li++) {
            if (collectorNode.inputs[offset + li]?.link == null) {
                srcNode.connect(enabled[li], collectorNode, offset + li);
            }
        }
    },

    buildOutputSlots(src, absIdx, localIdx, collectorNode) {
        const gi   = (src.enabledSlots ?? [])[localIdx] ?? localIdx;
        const name = src.slotNames?.[gi] || `out_${absIdx}`;
        const type = src.slotTypes?.[gi] || "*";
        collectorNode.addOutput(name, type);
    },

    showAddPicker(collectorNode, selection, onConfirm) {
        showPicker({
            title:         "Add / Remove Items",
            sections:      ["subgraphs", "nodes"],
            mode:          "multi",
            selection,
            showWidgets:   false,
            excludeNodeId: collectorNode.id,
            filterNode:    n => (n.outputs ?? []).length > 0,
            onConfirm,
        });
    },

    formatInfo(src) {
        const enabled = src.enabledSlots?.length ?? src.slotCount ?? 0;
        const total   = src.slotCount ?? 0;
        if (enabled === total) return `  (${total} slot${total !== 1 ? "s" : ""})`;
        return `  (${enabled}/${total})`;
    },

    onContentClick(src, srcIdx, node) {
        showSlotSelectDialog(node, srcIdx);
    },

    getSlotCount(src) {
        return src.enabledSlots?.length ?? src.slotCount ?? 0;
    },

    getOffset(sources, srcIdx) {
        let offset = 0;
        for (let i = 0; i < srcIdx; i++) {
            const s = sources[i];
            offset += s.enabledSlots?.length ?? s.slotCount ?? 0;
        }
        return offset;
    },

    syncSlotLabels(node, sources) {
        let absIdx = 0;
        for (const src of sources) {
            const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
            for (let li = 0; li < enabled.length; li++) {
                const gi   = enabled[li];
                const name = src.slotNames?.[gi] || `out_${absIdx}`;
                const type = src.slotTypes?.[gi] || "*";
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
    },

    migrateData(saved) {
        let sources;
        if (saved.sources) {
            sources = saved.sources;
        } else if (saved.sourceId != null) {
            // v1 形式（sourceId が直接ある）→ sources[] 形式へ移行
            sources = [{
                sourceId:     saved.sourceId,
                sourceTitle:  saved.sourceTitle ?? "",
                slotCount:    saved.slotCount   ?? 0,
                enabledSlots: null,
                slotNames:    saved.slotNames   ?? [],
                slotTypes:    saved.slotTypes   ?? [],
                sig:          "",
            }];
        } else {
            sources = [];
        }

        for (const src of sources) {
            if (!src.enabledSlots) {
                src.enabledSlots = Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
            }
        }

        return sources;
    },
});

// ---------------------------------------------------------------------------
// スロット選択ダイアログ
// ---------------------------------------------------------------------------

function showSlotSelectDialog(node, si) {
    const sources = SOURCE.getSources(node);
    const src     = sources[si];
    if (!src) return;

    const editEnabled = new Set(src.enabledSlots ?? Array.from({ length: src.slotCount }, (_, i) => i));
    const checkboxes  = [];

    showDialog({
        title:     `Edit Slots: "${src.sourceTitle}"`,
        width:     360,
        className: "__sax_slot_select_dlg",
        build(container, close) {
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
                _applySlotSelection(node, si, newEnabled);
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
// スロット選択の適用
//
// modifySource は内部で rebuildAllSources を呼ぶ。その際に buildSource が
// 呼ばれるため、_rebuildHints に全ソースの旧 enabledSlots を保持しておき、
// buildSource 内でスロット数変化に対応しながら引き継げるようにする。
// ---------------------------------------------------------------------------

function _applySlotSelection(node, si, newEnabledSlots) {
    const allSources = SOURCE.getSources(node);
    const sorted = [...newEnabledSlots].sort((a, b) => a - b);
    _rebuildHints = new Map(
        allSources.map((s, i) => [
            s.sourceId,
            i === si
                ? { enabledSlots: sorted, slotCount: s.slotCount }
                : { enabledSlots: s.enabledSlots, slotCount: s.slotCount },
        ])
    );
    try {
        SOURCE.modifySource(node, si, (src) => {
            src.enabledSlots = sorted;
        });
    } finally {
        _rebuildHints = null;
    }
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

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            // 出力・入力の両方を JS で動的管理するため Python 定義スロットをクリア
            for (let i = (this.outputs?.length ?? 0) - 1; i >= 0; i--) this.removeOutput(i);
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) this.removeInput(i);
            SOURCE.onNodeCreated.call(this);
            this.size[0] = Math.max(this.size[0], 320);
            this.size[1] = 1;
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            origOnSerialize?.apply(this, arguments);
            SOURCE.onSerialize.call(this, data);
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            origOnConfigure?.apply(this, arguments);
            SOURCE.onConfigure.call(this, data);
        };
    },
});
