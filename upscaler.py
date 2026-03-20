import logging

import torch
import torch.nn.functional as F
import nodes
import comfy.utils
import folder_paths

from .detailer import _extract_pipe

logger = logging.getLogger("SAX_Bridge")

# ---------------------------------------------------------------------------
# アップスケール手法マッピング
# ---------------------------------------------------------------------------
# comfy.utils.common_upscale が受け付けるメソッド名
_PIXEL_METHODS = ["lanczos", "bilinear", "bicubic", "nearest-exact", "area"]


def _pixel_upscale(images: torch.Tensor, target_h: int, target_w: int, method: str) -> torch.Tensor:
    """
    images: (B, H, W, C) float32
    comfy.utils.common_upscale を利用してピクセル空間でリサイズする。
    """
    bchw = images.permute(0, 3, 1, 2)  # (B, C, H, W)
    upscaled = comfy.utils.common_upscale(bchw, target_w, target_h, method, "disabled")
    return upscaled.permute(0, 2, 3, 1)  # (B, H, W, C)


def _esrgan_upscale(upscale_model, images: torch.Tensor, target_h: int, target_w: int) -> torch.Tensor:
    """
    ESRGAN 系モデルでアップスケールし、target サイズに縮小する。
    images: (B, H, W, C) float32
    """
    from comfy_extras.nodes_upscale_model import ImageUpscaleWithModel
    upscaled = ImageUpscaleWithModel().upscale(upscale_model, images)[0]  # (B, H', W', C)

    if upscaled.shape[1] != target_h or upscaled.shape[2] != target_w:
        bchw = upscaled.permute(0, 3, 1, 2)
        bchw = comfy.utils.common_upscale(bchw, target_w, target_h, "lanczos", "disabled")
        upscaled = bchw.permute(0, 2, 3, 1)

    return upscaled


# ---------------------------------------------------------------------------
# SAX_Bridge_Pipe_Upscaler ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Pipe_Upscaler:
    """
    Pipe 内の images をアップスケールし、オプションで軽量 i2i を適用するノード。

    method:
      - lanczos / bilinear / bicubic / nearest-exact : ピクセル補間
      - esrgan : ESRGAN 系モデルによる高品質アップスケール（upscale_model 接続が必要）

    upscale_model 接続時はモデルによる高品質アップスケールを優先する。
    未接続の場合は method で指定したピクセル補間を使用する。
    denoise > 0 のとき、アップスケール後に KSampler (i2i) を実行してテクスチャを補完する。
    steps_override = 0 の場合は loader_settings から steps を継承する。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "upscale_model_name": (
                    ["None"] + folder_paths.get_filename_list("upscale_models"),
                    {"tooltip": "使用するアップスケールモデル。None = ピクセル補間のみ。"},
                ),
                "method": (["lanczos", "bilinear", "bicubic", "nearest-exact"],
                           {"tooltip": "ピクセル補間メソッド。upscale_model_name 選択時はモデルによるアップスケールを優先し、このメソッドは最終リサイズ調整にのみ使用する。"}),
                "scale_by": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 0.25,
                        "max": 8.0,
                        "step": 0.05,
                        "tooltip": "元解像度に対する拡大倍率。esrgan モデルが 4x の場合、scale_by=2 で 4x 後に 1/2 縮小する。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "0=アップスケールのみ / 0より大きい値でアップスケール後に軽量 i2i を実行する。",
                    },
                ),
                "steps_override": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 200,
                        "tooltip": "i2i 時の steps。0 = loader_settings の steps を継承。",
                    },
                ),
                "cfg_override": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.5,
                        "tooltip": "i2i 時の cfg。0.0 = loader_settings の cfg を継承。0 より大きい値で上書き。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("PIPE_LINE", "IMAGE")
    RETURN_NAMES = ("PIPE", "IMAGE")
    FUNCTION = "upscale"
    CATEGORY = "SAX/Bridge/Upscaler"
    DESCRIPTION = (
        "Pipe 内の画像をアップスケールする。"
        "ESRGAN モデルを使用すると高品質な拡大が可能で、後段 Detailer の denoise を下げられる。"
    )

    def upscale(
        self,
        pipe,
        upscale_model_name,
        method,
        scale_by,
        denoise,
        steps_override=0,
        cfg_override=0.0,
    ):
        images = pipe.get("images")
        if images is None:
            raise ValueError("[CSB] Pipe に images が含まれていません。SAX Loader → KSampler → VAEDecode を先に実行してください。")

        b, h, w, c = images.shape
        target_h = max(8, int(h * scale_by))
        target_w = max(8, int(w * scale_by))
        # 8px アライメント（VAE ダウンサンプリング互換）
        target_h = (target_h // 8) * 8
        target_w = (target_w // 8) * 8

        # --- 1. アップスケール ---
        if upscale_model_name != "None":
            logger.info(f"[CSB] Upscaler: ESRGAN モード / model={upscale_model_name} / {w}x{h} -> {target_w}x{target_h}")
            from comfy_extras.nodes_upscale_model import UpscaleModelLoader
            upscale_model = UpscaleModelLoader().load_model(upscale_model_name)[0]
            upscaled = _esrgan_upscale(upscale_model, images, target_h, target_w)
            logger.info(f"[CSB] Upscaler: ESRGAN 完了 / 出力サイズ {upscaled.shape[2]}x{upscaled.shape[1]}")
        elif target_h == h and target_w == w:
            logger.info(f"[CSB] Upscaler: サイズ変化なし / スキップ")
            upscaled = images
        else:
            logger.info(f"[CSB] Upscaler: ピクセル補間 ({method}) / {w}x{h} -> {target_w}x{target_h}")
            upscaled = _pixel_upscale(images, target_h, target_w, method)

        upscaled = torch.clamp(upscaled, 0.0, 1.0)

        # --- 2. 軽量 i2i（denoise > 0 のとき） ---
        if denoise > 0:
            p = _extract_pipe(pipe)
            if p["model"] is None or p["vae"] is None \
                    or p["positive"] is None or p["negative"] is None:
                logger.warning(
                    "[CSB] Upscaler: i2i に必要な pipe 要素 (model/vae/positive/negative) が不足しています。"
                    "アップスケールのみ実行します。"
                )
            else:
                steps_eff = steps_override if steps_override > 0 else p["steps"]
                cfg_eff   = cfg_override   if cfg_override   > 0 else p["cfg"]

                latent = p["vae"].encode(upscaled[:, :, :, :3])
                samples_dict = {"samples": latent}

                sampler_result = nodes.common_ksampler(
                    p["model"],
                    p["seed"],
                    steps_eff,
                    cfg_eff,
                    p["sampler_name"],
                    p["scheduler_name"],
                    p["positive"],
                    p["negative"],
                    samples_dict,
                    denoise=denoise,
                )
                upscaled = p["vae"].decode(sampler_result[0]["samples"])
                upscaled = torch.clamp(upscaled, 0.0, 1.0)

                logger.info(
                    f"[CSB] Upscaler i2i: {w}x{h} -> {target_w}x{target_h}, "
                    f"steps={steps_eff}, cfg={cfg_eff}, denoise={denoise}"
                )

        new_pipe = pipe.copy()
        new_pipe["images"] = upscaled
        return (new_pipe, upscaled)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Pipe_Upscaler": SAX_Bridge_Pipe_Upscaler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Pipe_Upscaler": "SAX Pipe Upscaler",
}
