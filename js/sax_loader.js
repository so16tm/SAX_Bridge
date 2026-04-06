/**
 * sax_loader.js — SAX_Bridge_Loader の COMBO を showFilePicker に差し替え
 */

import { app } from "../../scripts/app.js";
import { showFilePicker } from "./sax_ui_base.js";

const ckptDisplayName = (full) =>
    full.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

const loraDisplayName = (full) =>
    full.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

function dismissComboMenu() {
    document.querySelectorAll(".litecontextmenu").forEach(e => e.remove());
}

function replaceComboWithPicker(widget, { title, placeholder, className, displayName: displayFn }) {
    const origMouse = widget.mouse;
    widget.mouse = function (event, pos, node) {
        if (event.type === "pointerup") {
            requestAnimationFrame(() => {
                dismissComboMenu();
                showFilePicker({
                    items:        this.options.values || [],
                    currentValue: this.value,
                    title,
                    placeholder,
                    mode:         "single",
                    className,
                    displayName:  displayFn,
                    onSelect: (name) => {
                        this.value = name;
                        this.callback?.(name);
                        app.graph.setDirtyCanvas(true, false);
                    },
                });
            });
        }
        return origMouse?.call(this, event, pos, node) ?? false;
    };
}

app.registerExtension({
    name: "SAX.Loader",

    async nodeCreated(node) {
        if (node.comfyClass !== "SAX_Bridge_Loader") return;

        const ckptCombo = node.widgets?.find(w => w.name === "ckpt_name");
        if (ckptCombo) {
            replaceComboWithPicker(ckptCombo, {
                title:       "Select Checkpoint",
                placeholder: "Search checkpoint…",
                className:   "__sax_ckpt_picker",
                displayName: ckptDisplayName,
            });
        }

        const loraCombo = node.widgets?.find(w => w.name === "lora_name");
        if (loraCombo) {
            replaceComboWithPicker(loraCombo, {
                title:       "Select LoRA",
                placeholder: "Search LoRA name…",
                className:   "__sax_lora_picker",
                displayName: loraDisplayName,
            });
        }
    },
});
