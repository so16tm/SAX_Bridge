import torch

import folder_paths
import comfy.sd
import comfy.samplers
import comfy.utils
from comfy_api.latest import io

from .io_types import PipeLine, record_applied_loras


def _unet_model_options(weight_dtype: str) -> dict:
    """weight_dtype 選択値を load_diffusion_model 用 model_options へ変換する。

    ComfyUI 本体 UNETLoader の dtype マッピングを完全踏襲する。
    fp8_e4m3fn_fast は dtype に加え fp8_optimizations フラグも必要。
    """
    model_options: dict = {}
    if weight_dtype == "fp8_e4m3fn":
        model_options["dtype"] = torch.float8_e4m3fn
    elif weight_dtype == "fp8_e4m3fn_fast":
        model_options["dtype"] = torch.float8_e4m3fn
        model_options["fp8_optimizations"] = True
    elif weight_dtype == "fp8_e5m2":
        model_options["dtype"] = torch.float8_e5m2
    return model_options


class SAX_Bridge_Loader_Diffusion(io.ComfyNode):
    """UNET 単体 + CLIP 単体 + VAE 別構成の diffusion model を読み込むローダー。

    checkpoint に baked された model/clip/vae を一括ロードする SAX_Bridge_Loader と異なり、
    diffusion_models / text_encoders / vae の 3 フォルダから個別にロードする。
    Anima (Qwen3 0.6B テキストエンコーダ) など最近の分割配布モデルを対象とする。

    出力 pipe は SAX_Bridge_Loader と同一構造のため下流ノードは無改修で動作する。
    空 latent は 4ch 全ゼロで生成し、KSampler 側の fix_empty_latent_channels が
    モデルの latent_channels / latent_dimensions へ自動適応する。
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAX_Bridge_Loader_Diffusion",
            display_name="SAX Diffusion Loader",
            category="SAX/Bridge/Loader",
            description="CSB Diffusion Loader (V3) — UNET + CLIP + VAE separate load",
            inputs=[
                io.Combo.Input("unet_name", options=folder_paths.get_filename_list("diffusion_models")),
                io.Combo.Input("weight_dtype", options=["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]),
                io.Combo.Input("clip_name", options=folder_paths.get_filename_list("text_encoders")),
                io.Combo.Input("vae_name", options=folder_paths.get_filename_list("vae")),
                io.Combo.Input("lora_name", options=["None"] + folder_paths.get_filename_list("loras")),
                io.Float.Input("lora_model_strength", default=1.0, min=-10.0, max=10.0, step=0.01),
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
    def execute(
        cls,
        unet_name: str,
        weight_dtype: str,
        clip_name: str,
        vae_name: str,
        lora_name: str,
        lora_model_strength: float,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler_name: str,
        denoise: float,
        width: int,
        height: int,
        batch_size: int,
    ) -> io.NodeOutput:
        unet_path = folder_paths.get_full_path("diffusion_models", unet_name)
        if unet_path is None:
            raise ValueError("[SAX_Bridge] Diffusion Loader: diffusion model not found: %s" % unet_name)
        model = comfy.sd.load_diffusion_model(unet_path, model_options=_unet_model_options(weight_dtype))

        clip_path = folder_paths.get_full_path("text_encoders", clip_name)
        if clip_path is None:
            raise ValueError("[SAX_Bridge] Diffusion Loader: text encoder not found: %s" % clip_name)
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=comfy.sd.CLIPType.STABLE_DIFFUSION,
        )

        vae_path = folder_paths.get_full_path("vae", vae_name)
        if vae_path is None:
            raise ValueError("[SAX_Bridge] Diffusion Loader: VAE not found: %s" % vae_name)
        vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))

        applied_lora_names = []
        if lora_name != "None":
            lora_path = folder_paths.get_full_path("loras", lora_name)
            if lora_path is None:
                raise ValueError("[SAX_Bridge] Diffusion Loader: LoRA not found: %s" % lora_name)
            lora = comfy.utils.load_torch_file(lora_path)
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, lora_model_strength, lora_model_strength)
            applied_lora_names.append(lora_name)

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
