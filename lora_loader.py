import json
import logging

import folder_paths
import nodes

logger = logging.getLogger("SAX_Bridge")


# ---------------------------------------------------------------------------
# SAX_Bridge_Pipe_Lora_Loader ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Pipe_Lora_Loader:
    """
    Pipe 内の model / clip に複数の LoRA を一括適用するノード。

    - loras_json (STRING/hidden) に JSON 配列を格納。JS 側カスタム UI が書き込む。
    - 各エントリが on:true の場合のみ適用する。
    - LoRA 読み込みに失敗した場合は警告ログを出してスキップ（継続実行）。

    loras_json の構造:
    [
      {"on": true,  "lora": "some_lora.safetensors", "strength": 0.8},
      {"on": false, "lora": "another.safetensors",   "strength": 1.0}
    ]
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "When False, returns the pipe without applying any LoRA.",
                    },
                ),
                "loras_json": (
                    "STRING",
                    {
                        "default": "[]",
                        "tooltip": "JSON array of LoRA entries. Managed by the node UI.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("PIPE_LINE",)
    RETURN_NAMES = ("PIPE",)
    FUNCTION = "apply"
    CATEGORY = "SAX/Bridge/Pipe"
    DESCRIPTION = (
        "Applies multiple LoRAs to the model and CLIP in the pipe. "
        "Each LoRA can be individually toggled on/off via the node UI."
    )

    def apply(self, pipe, enabled, loras_json):
        if not enabled:
            return (pipe,)

        model = pipe.get("model")
        clip  = pipe.get("clip")

        if model is None:
            raise ValueError("[SAX_Bridge] Lora Loader: Pipe does not contain a model.")

        try:
            entries = json.loads(loras_json)
        except json.JSONDecodeError as e:
            logger.warning(f"[SAX_Bridge] Lora Loader: failed to parse loras_json: {e}")
            return (pipe,)

        if not isinstance(entries, list):
            logger.warning("[SAX_Bridge] Lora Loader: loras_json must be a JSON array.")
            return (pipe,)

        for entry in entries:
            if not entry.get("on", True):
                continue

            lora_name = entry.get("lora", "").strip()
            strength  = float(entry.get("strength", 1.0))

            if not lora_name or strength == 0.0:
                continue

            try:
                model, clip = nodes.LoraLoader().load_lora(
                    model, clip, lora_name, strength, strength
                )
                logger.debug(
                    f"[SAX_Bridge] Lora Loader: applied '{lora_name}' (strength={strength:.3f})"
                )
            except Exception as e:
                logger.warning(
                    f"[SAX_Bridge] Lora Loader: failed to apply '{lora_name}': {e}"
                )

        new_pipe = pipe.copy()
        new_pipe["model"] = model
        new_pipe["clip"]  = clip
        return (new_pipe,)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Pipe_Lora_Loader": SAX_Bridge_Pipe_Lora_Loader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Pipe_Lora_Loader": "SAX Lora Loader",
}
