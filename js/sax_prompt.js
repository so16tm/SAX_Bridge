import { app } from "../../scripts/app.js";
import {
    fileBasenameWithoutExt,
    replaceComboWithFilePicker,
    loadWildcardList,
} from "./sax_ui_base.js";

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

            replaceComboWithFilePicker(loraCombo, {
                title:       "Select LoRA to Insert",
                placeholder: "Search LoRA name…",
                className:   "__sax_prompt_lora_picker",
                displayName: fileBasenameWithoutExt,
                placeholderMode: "insert",
                filterValues: (values) => values.filter(v => v !== LORA_PLACEHOLDER),
                onSelect: (name) => {
                    if (!tbox) return;
                    let lora_name = name;
                    if (lora_name.endsWith(".safetensors")) lora_name = lora_name.slice(0, -12);
                    tbox.value += `<lora:${lora_name}>`;
                },
            });
        }

        if (wcCombo) {
            const WC_PLACEHOLDER = "Select the Wildcard to add to the text";
            Object.defineProperty(wcCombo, "value", {
                set: () => {},
                get: () => WC_PLACEHOLDER,
            });
            wcCombo.serializeValue = () => WC_PLACEHOLDER;

            const wcList = await loadWildcardList();
            if (wcList && wcList.length > 0) {
                let _wcValues = wcList;
                Object.defineProperty(wcCombo.options, "values", {
                    set: (v) => { if (Array.isArray(v) && v.length > 1) _wcValues = v; },
                    get: () => _wcValues,
                    configurable: true,
                });
            }

            replaceComboWithFilePicker(wcCombo, {
                title:       "Select Wildcard to Insert",
                placeholder: "Search wildcard…",
                className:   "__sax_prompt_wc_picker",
                placeholderMode: "insert",
                filterValues: (values) => values.filter(v => v !== WC_PLACEHOLDER),
                onSelect: (name) => {
                    if (!tbox) return;
                    if (tbox.value !== "") tbox.value += ", ";
                    tbox.value += name;
                },
            });
        }

        if (tbox && tbox.inputEl) {
            tbox.inputEl.placeholder = "Wildcard Prompt (LoRA / BREAK syntax supported)";
        }
    },
});
