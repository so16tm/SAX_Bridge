/**
 * sax_loader.js — SAX_Bridge_Loader の ckpt_name COMBO を showFilePicker に差し替え
 */

import { app } from "../../scripts/app.js";
import { showFilePicker } from "./sax_ui_base.js";

const displayName = (full) =>
    full.replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");

app.registerExtension({
    name: "SAX.Loader",

    async nodeCreated(node) {
        if (node.comfyClass !== "SAX_Bridge_Loader") return;

        const ckptCombo = node.widgets?.find(w => w.name === "ckpt_name");
        if (!ckptCombo) return;

        // COMBO のクリックでデフォルトの ContextMenu ではなく showFilePicker を開く
        const origMouse = ckptCombo.mouse;
        ckptCombo.mouse = function (event, pos, node) {
            if (event.type === "mouseup") {
                showFilePicker({
                    items:        this.options.values || [],
                    currentValue: this.value,
                    title:        "Select Checkpoint",
                    placeholder:  "Search checkpoint…",
                    mode:         "single",
                    className:    "__sax_ckpt_picker",
                    displayName,
                    onSelect: (name) => {
                        this.value = name;
                        this.callback?.(name);
                        app.graph.setDirtyCanvas(true, false);
                    },
                });
                return true;
            }
            return origMouse?.call(this, event, pos, node) ?? false;
        };
    },
});
