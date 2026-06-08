import { app } from "../../scripts/app.js";
import { showPicker } from "./sax_picker.js";
import { ensureRenderLinkPatch, applySourceListLifecycle, initSourceBase } from "./sax_ui_base.js";
import { ensureCoordinator } from "./sax_dynamic_slot_coordinator.js";

const EXT_NAME  = "SAX.PipeCollector";
const NODE_TYPE = "SAX_Bridge_Pipe_Collector";
const MAX_SLOTS = 16;   // Python 側 MAX_SLOTS と合わせる

// ---------------------------------------------------------------------------
// makeSourceListWidget の spec (coordinator はノードごとに別個のため、
// onNodeCreated 内で makeSourceListWidget(spec, coordinator) を呼ぶ)
// ---------------------------------------------------------------------------

const SOURCE_SPEC = {
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
            ...initSourceBase(srcNode),
            pipeSlotIndex: gi,
            slotCount:     1,
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
};

// Pipe_Collector は実質 1:1 (slotCount=1 固定) だが、API は 1:N で統一。
// hasOutputSlots=false のため Coordinator の output 側 capture は no-op に近いが、
// mutate() トランザクション化により _captureDownstream 削除 (TODO 6) 後の既存挙動を維持。
function buildPipeCollectorSpec(node) {
    return {
        direction:         "output",
        getEntities:       () => node._remoteSources ?? [],
        setEntities:       (newSources) => { node._remoteSources = newSources; },
        entityToSlots:     (_src, _hints) => [{ name: "PIPE", type: "PIPE_LINE" }],
        syncSlotStructure: () => {},
        resolveLocalSlotBySlotName: null,
        resolveLocalSlotByGlobalIdx: null,
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
        applySourceListLifecycle(nodeType, {
            sourceSpec:           SOURCE_SPEC,
            buildCoordinatorSpec: buildPipeCollectorSpec,
            ensureCoordinator,
            initialSize:          [280, 1],
            clearOutputsOnCreate: false,
        });
    },
});
