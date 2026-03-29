import json
import logging
import torch

import folder_paths
import nodes
import comfy.model_management
import comfy.model_sampling
import comfy.sd
import comfy.samplers
import comfy.utils
from comfy_api.latest import io

from .io_types import PipeLine, _APPLIED_LORAS_KEY, _normalize_lora_name, record_applied_loras

logger = logging.getLogger("SAX_Bridge")


class SAX_Bridge_Loader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAX_Bridge_Loader",
            display_name="SAX Loader",
            category="SAX/Bridge/Loader",
            description="CSB Loader (V3)",
            inputs=[
                io.Combo.Input("ckpt_name", options=folder_paths.get_filename_list("checkpoints")),
                io.Int.Input("clip_skip", default=-1, min=-24, max=-1, step=1),
                io.Combo.Input("vae_name", options=["baked_vae"] + folder_paths.get_filename_list("vae")),
                io.Combo.Input("lora_name", options=["None"] + folder_paths.get_filename_list("loras")),
                io.Float.Input("lora_model_strength", default=1.0, min=-10.0, max=10.0, step=0.01),
                io.Boolean.Input("v_pred", default=False),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff, control_after_generate=True),
                io.Int.Input("steps", default=20, min=1, max=10000),
                io.Float.Input("cfg", default=8.0, min=0.0, max=100.0, step=0.5),
                io.Combo.Input("sampler_name", options=comfy.samplers.KSampler.SAMPLERS),
                io.Combo.Input("scheduler_name", options=comfy.samplers.KSampler.SCHEDULERS),
                io.Float.Input("denoise", default=1.0, min=0.0, max=1.0, step=0.01),
                io.Int.Input("width", default=512, min=8, max=8192, step=8),
                io.Int.Input("height", default=512, min=8, max=8192, step=8),
                io.Int.Input("batch_size", default=1, min=1, max=4096),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
                io.Int.Output("SEED"),
            ],
        )

    @classmethod
    def execute(cls, ckpt_name, clip_skip, vae_name, lora_name, lora_model_strength, v_pred, seed, steps, cfg, sampler_name, scheduler_name, denoise, width, height, batch_size) -> io.NodeOutput:
        ckpt_path = folder_paths.get_full_path("checkpoints", ckpt_name)
        out = comfy.sd.load_checkpoint_guess_config(ckpt_path, output_vae=True, output_clip=True, embedding_directory=folder_paths.get_folder_paths("embeddings"))
        model, clip, vae = out[0], out[1], out[2]

        clip = clip.clone()
        clip.clip_layer(clip_skip)

        if vae_name != "baked_vae":
            vae_path = folder_paths.get_full_path("vae", vae_name)
            vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))

        applied_lora_names = []
        if lora_name != "None":
            lora_path = folder_paths.get_full_path("loras", lora_name)
            lora = comfy.utils.load_torch_file(lora_path)
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, lora_model_strength, lora_model_strength)
            applied_lora_names.append(lora_name)

        if v_pred:
            class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscrete, comfy.model_sampling.V_PREDICTION):
                pass
            model = model.clone()
            model_sampling = ModelSamplingAdvanced(model.model.model_config, zsnr=True)
            model.add_object_patch("model_sampling", model_sampling)

        latent = torch.zeros([batch_size, 4, height // 8, width // 8], device="cpu")
        latent_out = {"samples": latent}

        pipe = {
            "model": model,
            "clip": clip,
            "vae": vae,
            "positive": None,
            "negative": None,
            "samples": latent_out,
            "images": None,
            "seed": seed,
            "loader_settings": {
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler_name,
                "denoise": denoise,
                "clip_width": width,
                "clip_height": height,
                "positive": "",
                "negative": "",
                "xyplot": None,
                "batch_size": batch_size,
            }
        }
        record_applied_loras(pipe, applied_lora_names)

        return io.NodeOutput(pipe, seed)


class SAX_Bridge_Loader_Lora:
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
    CATEGORY = "SAX/Bridge/Loader"
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

        applied = pipe.get(_APPLIED_LORAS_KEY, set())
        newly_applied = []

        for entry in entries:
            if not entry.get("on", True):
                continue

            lora_name = entry.get("lora", "").strip()
            strength  = float(entry.get("strength", 1.0))

            if not lora_name or strength == 0.0:
                continue

            if _normalize_lora_name(lora_name) in applied:
                logger.debug(
                    f"[SAX_Bridge] Lora Loader: skipping already applied '{lora_name}'"
                )
                continue

            try:
                model, clip = nodes.LoraLoader().load_lora(
                    model, clip, lora_name, strength, strength
                )
                newly_applied.append(lora_name)
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
        record_applied_loras(new_pipe, newly_applied)
        return (new_pipe,)
