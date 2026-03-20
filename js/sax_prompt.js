import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Impact Pack のワイルドカードリストを取得する関数群
// ---------------------------------------------------------------------------
let _wildcards_list_cache = null;

async function loadWildcardsFromAPI() {
    try {
        const { api } = await import("../../scripts/api.js");
        const res = await api.fetchApi("/impact/wildcards/list");
        if (res.ok) {
            const data = await res.json();
            _wildcards_list_cache = data.data || [];
            return _wildcards_list_cache;
        }
    } catch (e) {
        // Impact Pack のサーバーAPIが無い場合は空リスト
    }
    return [];
}

// ---------------------------------------------------------------------------
// ノード拡張登録
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "SAX.Prompt",

    async nodeCreated(node, app) {
        if (node.comfyClass !== "SAX_Bridge_Prompt") return;

        const tbox = node.widgets.find((w) => w.name === "wildcard_text");
        const loraCombo = node.widgets.find((w) => w.name === "select_to_add_lora");
        const wcCombo = node.widgets.find((w) => w.name === "select_to_add_wildcard");

        node._lora_value = "Select the LoRA to add to the text";
        node._wildcard_value = "Select the Wildcard to add to the text";

        if (loraCombo) {
            loraCombo.callback = () => {
                if (node && tbox) {
                    let lora_name = node._lora_value;
                    if (lora_name.endsWith(".safetensors")) lora_name = lora_name.slice(0, -12);
                    tbox.value += `<lora:${lora_name}>`;
                }
            };
            Object.defineProperty(loraCombo, "value", {
                set: (value) => { if (value !== "Select the LoRA to add to the text") node._lora_value = value; },
                get: () => "Select the LoRA to add to the text",
            });
            loraCombo.serializeValue = () => "Select the LoRA to add to the text";
        }

        if (wcCombo) {
            wcCombo.callback = async () => {
                if (node && tbox) {
                    if (tbox.value !== "") tbox.value += ", ";
                    tbox.value += node._wildcard_value;
                }
            };
            Object.defineProperty(wcCombo, "value", {
                set: (value) => { if (value !== "Select the Wildcard to add to the text") node._wildcard_value = value; },
                get: () => "Select the Wildcard to add to the text",
            });
            wcCombo.serializeValue = () => "Select the Wildcard to add to the text";

            const currentValues = wcCombo.options?.values;
            if (!currentValues || currentValues.length <= 1) {
                const list = await loadWildcardsFromAPI();
                if (list && list.length > 0) {
                    Object.defineProperty(wcCombo.options, "values", {
                        set: () => { },
                        get: () => list,
                    });
                }
            }
        }

        if (tbox && tbox.inputEl) {
            tbox.inputEl.placeholder = "Wildcard Prompt (LoRA・BREAK 構文対応)";
        }
    },
});
