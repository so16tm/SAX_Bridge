import { app } from "../../scripts/app.js";
import { showPicker } from "./sax_picker.js";
import { ensureRenderLinkPatch, applySourceListLifecycle, initSourceBase } from "./sax_ui_base.js";
import { ensureCoordinator } from "./sax_dynamic_slot_coordinator.js";
import { buildInputAnchors, resolveAnchorsToOutputSlots } from "./sax_collector_link.js";

const EXT_NAME  = "SAX.ImageCollector";
const NODE_TYPE = "SAX_Bridge_Image_Collector";
const MAX_SLOTS = 64;   // Python 側 MAX_SLOTS と合わせる

// ---------------------------------------------------------------------------
// makeSourceListWidget の spec (coordinator はノードごとに別個のため、
// onNodeCreated 内で makeSourceListWidget(spec, coordinator) を呼ぶ)
// ---------------------------------------------------------------------------

const SOURCE_SPEC = {
    widgetName:  "__sax_collector_source",
    serializeKey: "sax_collector",
    maxSlots:    MAX_SLOTS,

    filterSourceNode(n) {
        return (n.outputs ?? []).some(o => o.type === "IMAGE");
    },

    buildSource(srcNode, collectorNode, offset, remaining) {
        const imageOutputs = (srcNode.outputs ?? [])
            .map((o, gi) => ({ gi, out: o }))
            .filter(({ out }) => out.type === "IMAGE");
        if (imageOutputs.length === 0) return null;
        const slotsTaken       = Math.min(imageOutputs.length, remaining);
        const imageSlotIndices = imageOutputs.slice(0, slotsTaken).map(({ gi }) => gi);
        // B2: identity アンカー (name, type, originalSlotIndex) を常に現在の srcNode から
        // fresh 生成する。初回 identity の保持は rebuild 経路 (sax_ui_base.js の
        // mergeSourceAnchors 引継ぎ) が担い、buildSource では作り直す
        // (H-1: buildSource 内で旧 source を参照しない)。
        const inputAnchors = buildInputAnchors(srcNode, imageSlotIndices);
        return {
            ...initSourceBase(srcNode),
            imageSlotIndices,
            inputAnchors,
            slotCount:       imageSlotIndices.length,
        };
    },

    connectSource(srcNode, src, collectorNode, offset) {
        // B2: 保存アンカーで上流出力を段階解決し、位置 index 依存の誤接続を防ぐ。
        // アンカー欠落 (旧データ) は console.warn + imageSlotIndices フォールバック。
        const anchors = src.inputAnchors;
        const resolved = anchors ? resolveAnchorsToOutputSlots(srcNode, anchors) : null;
        for (let li = 0; li < src.imageSlotIndices.length; li++) {
            if (collectorNode.inputs[offset + li]?.link != null) continue;
            let gi = src.imageSlotIndices[li];
            const r = resolved?.[li];
            if (r) {
                gi = r.slotIndex;
            } else if (resolved) {
                // アンカー解決失敗 (対象出力が消えた) → 接続スキップ (誤接続回避)
                console.warn(`[sax_image_collector] anchor unresolved, skip slot li=${li} (src ${srcNode.id})`);
                continue;
            } else {
                console.warn(`[sax_image_collector] inputAnchors missing, fallback to position index (src ${srcNode.id})`);
            }
            srcNode.connect(gi, collectorNode, offset + li);
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
            filterNode:    n => (n.outputs ?? []).some(o => o.type === "IMAGE"),
            onConfirm,
        });
    },

    formatInfo(src) {
        const n = src.slotCount ?? 0;
        return `  (${n} image${n !== 1 ? "s" : ""})`;
    },
};

// Image_Collector は hasOutputSlots=false のため Coordinator の snapshot は空。
// それでも mutate() トランザクション経由で構造変更することで、
// TODO 6 (_captureDownstream 削除) 後も既存挙動を維持する。
function buildImageCollectorSpec(node) {
    return {
        direction:         "output",
        getEntities:       () => node._remoteSources ?? [],
        setEntities:       (newSources) => { node._remoteSources = newSources; },
        // 1:N (slotCount 個の IMAGE slot)。hints は使用しない。
        entityToSlots:     (src, _hints) => {
            const n = src?.slotCount ?? 0;
            return Array.from({ length: n }, (_, i) => ({
                name: `slot_${i}`,
                type: "IMAGE",
            }));
        },
        // 構造同期は makeSourceListWidget 内 (action 内 _syncSlotLabels) で完結するため no-op。
        syncSlotStructure: () => {},
        // Image_Collector は enabledSlots 編集機能なし → 段階1/2 fallback 不要、段階3 採用。
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
            buildCoordinatorSpec: buildImageCollectorSpec,
            ensureCoordinator,
            initialSize:          [280, 1],
            // Image_Collector は outputs を保持する (Python 定義 IMAGE 出力)
            clearOutputsOnCreate: false,
        });
    },
});
