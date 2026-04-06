import { app } from "../../scripts/app.js";
import { showFilePicker } from "./sax_ui_base.js";

const loraDisplayName = (full) =>
    full.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

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

app.registerExtension({
    name: "SAX.Prompt",

    async nodeCreated(node) {
        if (node.comfyClass !== "SAX_Bridge_Prompt") return;

        const tbox = node.widgets.find(w => w.name === "wildcard_text");
        const loraCombo = node.widgets.find(w => w.name === "select_to_add_lora");
        const wcCombo = node.widgets.find(w => w.name === "select_to_add_wildcard");

        if (loraCombo) {
            const LORA_PLACEHOLDER = "Select the LoRA to add to the text";
            Object.defineProperty(loraCombo, "value", {
                set: () => {},
                get: () => LORA_PLACEHOLDER,
            });
            loraCombo.serializeValue = () => LORA_PLACEHOLDER;

            const origLoraMouse = loraCombo.mouse;
            loraCombo.mouse = function(event, pos, node) {
                if (event.type === "mouseup") {
                    const values = (this.options?.values || []).filter(v => v !== LORA_PLACEHOLDER);
                    showFilePicker({
                        items: values,
                        title: "Select LoRA to Insert",
                        placeholder: "Search LoRA name…",
                        mode: "single",
                        className: "__sax_prompt_lora_picker",
                        displayName: loraDisplayName,
                        onSelect(name) {
                            if (!tbox) return;
                            let lora_name = name;
                            if (lora_name.endsWith(".safetensors")) lora_name = lora_name.slice(0, -12);
                            tbox.value += `<lora:${lora_name}>`;
                        },
                    });
                    return true;
                }
                return origLoraMouse?.call(this, event, pos, node) ?? false;
            };
        }

        if (wcCombo) {
            const WC_PLACEHOLDER = "Select the Wildcard to add to the text";
            Object.defineProperty(wcCombo, "value", {
                set: () => {},
                get: () => WC_PLACEHOLDER,
            });
            wcCombo.serializeValue = () => WC_PLACEHOLDER;

            const wcList = await loadWildcardsFromAPI();
            if (wcList && wcList.length > 0) {
                let _wcValues = wcList;
                Object.defineProperty(wcCombo.options, "values", {
                    set: (v) => { if (Array.isArray(v) && v.length > 1) _wcValues = v; },
                    get: () => _wcValues,
                    configurable: true,
                });
            }

            const origWcMouse = wcCombo.mouse;
            wcCombo.mouse = function(event, pos, node) {
                if (event.type === "mouseup") {
                    const values = (this.options?.values || []).filter(v => v !== WC_PLACEHOLDER);
                    showFilePicker({
                        items: values,
                        title: "Select Wildcard to Insert",
                        placeholder: "Search wildcard…",
                        mode: "single",
                        className: "__sax_prompt_wc_picker",
                        onSelect(name) {
                            if (!tbox) return;
                            if (tbox.value !== "") tbox.value += ", ";
                            tbox.value += name;
                        },
                    });
                    return true;
                }
                return origWcMouse?.call(this, event, pos, node) ?? false;
            };
        }

        if (tbox && tbox.inputEl) {
            tbox.inputEl.placeholder = "Wildcard Prompt (LoRA / BREAK syntax supported)";
        }
    },
});
