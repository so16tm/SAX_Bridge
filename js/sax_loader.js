/**
 * sax_loader.js — SAX_Bridge_Loader の COMBO を showFilePicker に差し替え
 */

import { app } from "../../scripts/app.js";
import { replaceComboWithFilePicker, fileBasenameWithoutExt } from "./sax_ui_base.js";

app.registerExtension({
    name: "SAX.Loader",

    async nodeCreated(node) {
        if (node.comfyClass !== "SAX_Bridge_Loader") return;

        const ckptCombo = node.widgets?.find(w => w.name === "ckpt_name");
        if (ckptCombo) {
            replaceComboWithFilePicker(ckptCombo, {
                title:       "Select Checkpoint",
                placeholder: "Search checkpoint…",
                className:   "__sax_ckpt_picker",
                displayName: fileBasenameWithoutExt,
            });
        }

        const loraCombo = node.widgets?.find(w => w.name === "lora_name");
        if (loraCombo) {
            replaceComboWithFilePicker(loraCombo, {
                title:       "Select LoRA",
                placeholder: "Search LoRA name…",
                className:   "__sax_lora_picker",
                displayName: fileBasenameWithoutExt,
            });
        }
    },
});

// vae_name は SAX_Bridge_Loader と同方針でプレーン Combo のまま（VAE はファイル数が少なくピッカー不要）
app.registerExtension({
    name: "SAX.LoaderDiffusion",

    async nodeCreated(node) {
        if (node.comfyClass !== "SAX_Bridge_Loader_Diffusion") return;

        const unetCombo = node.widgets?.find(w => w.name === "unet_name");
        if (unetCombo) {
            replaceComboWithFilePicker(unetCombo, {
                title:       "Select Diffusion Model",
                placeholder: "Search diffusion model…",
                className:   "__sax_unet_picker",
                displayName: fileBasenameWithoutExt,
            });
        }

        const clipCombo = node.widgets?.find(w => w.name === "clip_name");
        if (clipCombo) {
            replaceComboWithFilePicker(clipCombo, {
                title:       "Select Text Encoder",
                placeholder: "Search text encoder…",
                className:   "__sax_clip_picker",
                displayName: fileBasenameWithoutExt,
            });
        }

        const loraCombo = node.widgets?.find(w => w.name === "lora_name");
        if (loraCombo) {
            replaceComboWithFilePicker(loraCombo, {
                title:       "Select LoRA",
                placeholder: "Search LoRA name…",
                className:   "__sax_lora_picker",
                displayName: fileBasenameWithoutExt,
            });
        }
    },
});
