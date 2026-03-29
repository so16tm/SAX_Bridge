import { app } from "../../scripts/app.js";
import { showPicker } from "./sax_picker.js";
import { makeSourceListWidget, ensureRenderLinkPatch } from "./sax_ui_base.js";

const EXT_NAME  = "SAX.PipeCollector";
const NODE_TYPE = "SAX_Bridge_Pipe_Collector";
const MAX_SLOTS = 16;   // Python 側 MAX_SLOTS と合わせる

// ---------------------------------------------------------------------------
// makeSourceListWidget によるソースリストウィジェット構築
// ---------------------------------------------------------------------------

const SOURCE = makeSourceListWidget({
    widgetName:  "__sax_pipe_collector",
    serializeKey: "sax_pipe_collector",
    maxSlots:    MAX_SLOTS,

    filterSourceNode(n) {
        return (n.outputs ?? []).some(o => o.type === "PIPE_LINE");
    },

    buildSource(srcNode, _collectorNode, _offset, _remaining) {
        const pipeOutput = (srcNode.outputs ?? []).find(o => o.type === "PIPE_LINE");
        if (!pipeOutput) return null;
        const gi = (srcNode.outputs ?? []).indexOf(pipeOutput);
        return {
            sourceId:      srcNode.id,
            sourceTitle:   srcNode.title || srcNode.type || `Node#${srcNode.id}`,
            pipeSlotIndex: gi,
            slotCount:     1,
            sig:           "",
            isSub:         srcNode.subgraph != null,
        };
    },

    connectSource(srcNode, src, collectorNode, offset) {
        const gi = src.pipeSlotIndex;
        if (collectorNode.inputs[offset]?.link == null) {
            srcNode.connect(gi, collectorNode, offset);
        }
    },

    showAddPicker(collectorNode, selection, onConfirm) {
        showPicker({
            title:         "Add / Remove Items",
            sections:      ["subgraphs", "nodes"],
            mode:          "multi",
            selection,
            showWidgets:   false,
            excludeNodeId: collectorNode.id,
            filterNode:    n => (n.outputs ?? []).some(o => o.type === "PIPE_LINE"),
            onConfirm,
        });
    },

    formatInfo() {
        return "  (pipe)";
    },

    getOffset(_sources, srcIdx) {
        return srcIdx;
    },
});

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
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) this.removeInput(i);
            SOURCE.onNodeCreated.call(this);
            this.size[0] = Math.max(this.size[0], 280);
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
