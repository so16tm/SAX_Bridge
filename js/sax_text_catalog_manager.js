import { app } from "../../scripts/app.js";
import { openCatalogManager } from "./sax_text_catalog_v2_manage.js";
import { autoResize } from "./sax_ui_base.js";
import { sharedController } from "./sax_text_catalog_v2_shared.js";

const TYPE = "SAX_Bridge_Text_Catalog_Manager";
const V2_TYPE = "SAX_Bridge_Text_Catalog_V2";

// このワークフロー内で、指定のカタログを参照している Text Catalog V2 ノード。他のワークフローは検出できない。
export function referencingNodes(graph, catalogId) {
    const nodes = [];
    for (const node of graph?._nodes ?? []) {
        if (node.comfyClass !== V2_TYPE && node.type !== V2_TYPE) continue;
        try { if (JSON.parse(node.widgets?.find(w => w.name === "config_json")?.value ?? "{}").catalog_id === catalogId) nodes.push(node); } catch { /* 壊れた参照は数えない */ }
    }
    return nodes;
}
export const workflowUsage = (graph, catalogId) => referencingNodes(graph, catalogId).length;

export function installManager(node) {
    if (node._saxCatalogManager) return;
    node._saxCatalogManager = true;
    const button = node.addWidget("button", "カタログの一覧・複製・アーカイブ", null, () => { openCatalogManager({ workflowUsage: id => workflowUsage(node.graph, id),
        // アーカイブ・復元で有無が変わったカタログは、参照ノードに編集セッションを取り直させる（古いセッションを残さない）。
        onCatalogChange: id => { for (const target of referencingNodes(node.graph, id)) sharedController(target)?.reload(); } }); }, { serialize: false });
    button.serialize = false; button.options = { ...button.options, serialize: false };
    node.size = [Math.max(node.size?.[0] ?? 0, 300), node.size?.[1] ?? 60];
    if (node.graph) autoResize(node);
}

app.registerExtension({ name: "SAX.TextCatalogManager", beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== TYPE) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); installManager(this); return result; };
} });
