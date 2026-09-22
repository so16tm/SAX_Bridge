import json
import logging

import folder_paths
import nodes
import comfy.model_sampling
import comfy.sd
import comfy.utils
from comfy_api.latest import io

from .io_types import PipeLine, _APPLIED_LORAS_KEY, _normalize_lora_name, record_applied_loras
from .loader_common import apply_single_lora, build_pipe, empty_latent, resolve_path, sampling_inputs

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
                *sampling_inputs(),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
                io.Int.Output("SEED"),
            ],
        )

    @classmethod
    def execute(cls, ckpt_name, clip_skip, vae_name, lora_name, lora_model_strength, v_pred, seed, steps, cfg, sampler_name, scheduler_name, denoise, width, height, batch_size) -> io.NodeOutput:
        ckpt_path = resolve_path("checkpoints", ckpt_name, "Loader: checkpoint")
        out = comfy.sd.load_checkpoint_guess_config(ckpt_path, output_vae=True, output_clip=True, embedding_directory=folder_paths.get_folder_paths("embeddings"))
        model, clip, vae = out[0], out[1], out[2]

        clip = clip.clone()
        clip.clip_layer(clip_skip)

        if vae_name != "baked_vae":
            vae_path = resolve_path("vae", vae_name, "Loader: VAE")
            vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))

        model, clip, applied_lora_names = apply_single_lora(
            model, clip, lora_name, lora_model_strength, "Loader"
        )

        if v_pred:
            class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscrete, comfy.model_sampling.V_PREDICTION):
                pass
            model = model.clone()
            model_sampling = ModelSamplingAdvanced(model.model.model_config, zsnr=True)
            model.add_object_patch("model_sampling", model_sampling)

        pipe = build_pipe(
            model=model,
            clip=clip,
            vae=vae,
            latent=empty_latent(width, height, batch_size),
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler_name=scheduler_name,
            denoise=denoise,
            width=width,
            height=height,
            batch_size=batch_size,
        )
        record_applied_loras(pipe, applied_lora_names)

        return io.NodeOutput(pipe, seed)


class SAX_Bridge_Loader_Lora(io.ComfyNode):
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
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Loader_Lora",
            display_name="SAX Lora Loader",
            category="SAX/Bridge/Loader",
            description=(
                "Applies multiple LoRAs to the model and CLIP in the pipe. "
                "Each LoRA can be individually toggled on/off via the node UI."
            ),
            inputs=[
                PipeLine.Input("pipe"),
                io.Boolean.Input("enabled", default=True,
                                 tooltip="When False, returns the pipe without applying any LoRA."),
                io.String.Input("loras_json", default="[]",
                                tooltip="JSON array of LoRA entries. Managed by the node UI."),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
            ],
        )

    @classmethod
    def execute(cls, pipe, enabled, loras_json) -> io.NodeOutput:
        if not enabled:
            return io.NodeOutput(pipe)

        model = pipe.get("model")
        clip  = pipe.get("clip")

        if model is None:
            raise ValueError("[SAX_Bridge] Lora Loader: Pipe does not contain a model.")

        try:
            entries = json.loads(loras_json)
        except json.JSONDecodeError as e:
            logger.warning(f"[SAX_Bridge] Lora Loader: failed to parse loras_json: {e}")
            return io.NodeOutput(pipe)

        if not isinstance(entries, list):
            logger.warning("[SAX_Bridge] Lora Loader: loras_json must be a JSON array.")
            return io.NodeOutput(pipe)

        applied = pipe.get(_APPLIED_LORAS_KEY, set())
        newly_applied = []

        for entry in entries:
            # loras_json は JS UI が書くが、手編集や旧形式のワークフローで
            # 型の崩れたエントリが混ざる。docstring 通り「警告してスキップ」に揃える
            # （ここで例外を投げるとノード全体が落ちる）。
            if not isinstance(entry, dict):
                logger.warning("[SAX_Bridge] Lora Loader: skipping non-object entry: %r", entry)
                continue

            if not entry.get("on", True):
                continue

            try:
                lora_name = str(entry.get("lora", "")).strip()
                strength = float(entry.get("strength", 1.0))
            except (TypeError, ValueError) as exc:
                logger.warning(
                    "[SAX_Bridge] Lora Loader: skipping malformed entry %r (%s)", entry, exc
                )
                continue

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
        return io.NodeOutput(new_pipe)
