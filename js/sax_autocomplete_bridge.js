// Autocomplete++ が読むのは入力直下の文字列だけ。構造化データをオブジェクトへ
// 退避し、本文だけを一時入力として渡す。保存用 workflow は変更しない。
export const TRANSFER = "_sax_ac_transfer";
const PREFIX = "_sax_ac_text_";

export async function prepareAutocompletePrompt(output, loadCatalog) {
    const result = structuredClone(output);
    const catalogs = new Map();
    for (const node of Object.values(result ?? {})) {
        if (!node?.class_type?.startsWith("SAX_Bridge_") || !node.inputs) continue;
        const inputs = node.inputs;
        const packet = { version: 1, inputs: {}, texts: [] };
        for (const [name, value] of Object.entries(inputs)) {
            if (!name.endsWith("_json") || typeof value !== "string") continue;
            let data;
            try { data = JSON.parse(value); } catch { continue; }
            if (!data || typeof data !== "object") continue;
            packet.inputs[name] = { raw: value, data };
            delete inputs[name];
        }
        const name = node.class_type === "SAX_Bridge_Text_Catalog" ? "items_json"
            : node.class_type === "SAX_Bridge_Text_Catalog_V2" ? "config_json" : null;
        const protectedInput = packet.inputs[name];
        if (protectedInput) {
            let data = protectedInput.data;
            if (node.class_type === "SAX_Bridge_Text_Catalog_V2" && data.version === 3 && data.catalog_id) {
                if (!catalogs.has(data.catalog_id)) catalogs.set(data.catalog_id, await loadCatalog(data.catalog_id));
                data._sax_queued_catalog = structuredClone(catalogs.get(data.catalog_id));
                data = data._sax_queued_catalog;
                protectedInput.changed = true;
            }
            const items = data.catalog?.items;
            if (Array.isArray(items)) {
                for (let index = 0; index < items.length; index++) {
                    if (typeof items[index]?.text !== "string") continue;
                    const key = PREFIX + packet.texts.length;
                    inputs[key] = items[index].text;
                    packet.texts.push({ key, input: name, index, shared: data !== protectedInput.data });
                }
            }
        }
        if (Object.keys(packet.inputs).length) inputs[TRANSFER] = packet;
    }
    return result;
}
