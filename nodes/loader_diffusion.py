import logging
from collections.abc import Mapping

import torch

import folder_paths
import comfy.sd
import comfy.supported_models
import comfy.utils
from comfy_api.latest import io

from .io_types import PipeLine, record_applied_loras
from .loader_common import apply_single_lora, build_pipe, empty_latent, resolve_path, sampling_inputs

logger = logging.getLogger("SAX_Bridge")

# INTERNAL API: comfy.supported_models.Krea2 / ModelPatcher.model.model_config は
# ComfyUI 内部 API。バージョン更新時に要確認。クラス identity キーのため
# 本体で改名/削除されると import 時に AttributeError で fail-fast する (意図的設計)。
_CLIP_TYPE_BY_CONFIG: dict[type, comfy.sd.CLIPType] = {
    comfy.supported_models.Krea2: comfy.sd.CLIPType.KREA2,
}


def _clip_type_for_model_config(
    model_config: object,
    mapping: Mapping[type, comfy.sd.CLIPType] = _CLIP_TYPE_BY_CONFIG,
) -> tuple[comfy.sd.CLIPType, bool]:
    """model_config の exact 型で CLIPType を引く純粋関数。未登録は STABLE_DIFFUSION。

    戻り値は (clip_type, matched)。matched=False はフォールバック適用を意味する。
    mapping はテスト注入用の read-only シーム。破壊的変更は禁止
    (デフォルトはモジュール共有の _CLIP_TYPE_BY_CONFIG 実体)。
    """
    clip_type = mapping.get(type(model_config))
    if clip_type is None:
        return comfy.sd.CLIPType.STABLE_DIFFUSION, False
    return clip_type, True


def _log_clip_type_detection(
    model_config: object, clip_type: comfy.sd.CLIPType, matched: bool
) -> None:
    if matched:
        logger.info(
            "[SAX_Bridge] Diffusion Loader: clip_type auto-detected: %s for %s",
            clip_type,
            type(model_config).__name__,
        )
    else:
        logger.debug(
            "[SAX_Bridge] Diffusion Loader: clip_type fallback: %s for %s",
            clip_type,
            type(model_config).__name__,
        )


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


# supported_models のクラス名 → テキストエンコーダの CLIPType 名。
# CLIPLoader の `type` に相当する値を、ロード済み UNET から自動で決める。
# 未登録のモデルは従来通り STABLE_DIFFUSION（Anima 等はこれで正しく読める）。
_CLIP_TYPE_BY_MODEL = {
    "QwenImage": "QWEN_IMAGE",
    "QwenImage21": "QWEN_IMAGE",
}


def _clip_type_for_model(model) -> "comfy.sd.CLIPType":
    """ロード済み UNET の model_config からテキストエンコーダの CLIPType を決める。

    Qwen-Image 2.1 の Qwen3-VL 8B は CLIPType.QWEN_IMAGE で読まないと汎用の
    Qwen3-VL として扱われ、テンプレートと画像スロットが Qwen-Image 用にならない。
    """
    # INTERNAL API: ModelPatcher.model.model_config は ComfyUI 内部 API。
    config = getattr(getattr(model, "model", None), "model_config", None)
    clip_type, matched = _clip_type_for_model_config(config)
    if not matched:
        name = _CLIP_TYPE_BY_MODEL.get(type(config).__name__)
        if name is not None:
            clip_type = getattr(comfy.sd.CLIPType, name, comfy.sd.CLIPType.STABLE_DIFFUSION)
            matched = clip_type is not comfy.sd.CLIPType.STABLE_DIFFUSION
    _log_clip_type_detection(config, clip_type, matched)
    return clip_type


class SAX_Bridge_Loader_Diffusion(io.ComfyNode):
    """UNET 単体 + CLIP 単体 + VAE 別構成の diffusion model を読み込むローダー。

    checkpoint に baked された model/clip/vae を一括ロードする SAX_Bridge_Loader と異なり、
    diffusion_models / text_encoders / vae の 3 フォルダから個別にロードする。
    Anima (Qwen3 0.6B テキストエンコーダ) や Qwen-Image 2.1 (Qwen3-VL 8B) など
    最近の分割配布モデルを対象とする。テキストエンコーダの種類 (CLIPType) は
    UNET から自動判定する（_clip_type_for_model）。

    出力 pipe は SAX_Bridge_Loader と同一構造のため下流ノードは無改修で動作する。
    空 latent は 4ch 全ゼロ (1/8) で生成し、KSampler 側の fix_empty_latent_channels が
    モデルの latent_channels / latent_dimensions / 縮小率へ自動適応する。
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
                *sampling_inputs(),
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
        unet_path = resolve_path("diffusion_models", unet_name, "Diffusion Loader: diffusion model")
        model = comfy.sd.load_diffusion_model(unet_path, model_options=_unet_model_options(weight_dtype))

        clip_type = _clip_type_for_model(model)

        clip_path = resolve_path("text_encoders", clip_name, "Diffusion Loader: text encoder")
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type,
        )

        vae_path = resolve_path("vae", vae_name, "Diffusion Loader: VAE")
        vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))

        model, clip, applied_lora_names = apply_single_lora(
            model, clip, lora_name, lora_model_strength, "Diffusion Loader"
        )

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
        pipe["loader_settings"]["ckpt_name"] = unet_name
        record_applied_loras(pipe, applied_lora_names)

        return io.NodeOutput(pipe, seed)
