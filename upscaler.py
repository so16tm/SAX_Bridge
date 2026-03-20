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


def _esrgan_upscale(upscale_model, images: torch.Tensor, target_h: int, target_w: int, method: str) -> torch.Tensor:
    """
    ESRGAN 系モデルでアップスケールし、target サイズに縮小する。
    images: (B, H, W, C) float32
    """
    from comfy_extras.nodes_upscale_model import ImageUpscaleWithModel
    upscaled = ImageUpscaleWithModel().upscale(upscale_model, images)[0]  # (B, H', W', C)

    if upscaled.shape[1] != target_h or upscaled.shape[2] != target_w:
        bchw = upscaled.permute(0, 3, 1, 2)
        bchw = comfy.utils.common_upscale(bchw, target_w, target_h, method, "disabled")
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
                    {"tooltip": "Upscale model to use. None = pixel interpolation only."},
                ),
                "method": (["lanczos", "bilinear", "bicubic", "nearest-exact"],
                           {"tooltip": "Pixel interpolation method. When upscale_model_name is set, model-based upscaling takes priority; this method is used only for final resize adjustment."}),
                "scale_by": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 0.25,
                        "max": 8.0,
                        "step": 0.05,
                        "tooltip": "Scale factor relative to original resolution. For a 4x ESRGAN model, scale_by=2 upscales 4x then downscales to 1/2.",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "0=upscale only / Values > 0 run a lightweight img2img pass after upscaling.",
                    },
                ),
                "steps_override": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 200,
                        "tooltip": "Steps for img2img pass. 0 = inherit from loader_settings.",
                    },
                ),
                "cfg_override": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.5,
                        "tooltip": "CFG for img2img pass. 0.0 = inherit from loader_settings. Values > 0 override it.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("PIPE_LINE", "IMAGE")
    RETURN_NAMES = ("PIPE", "IMAGE")
    FUNCTION = "upscale"
    CATEGORY = "SAX/Bridge/Upscaler"
    DESCRIPTION = (
        "Upscales images in the pipe. "
        "Using an ESRGAN model enables high-quality enlargement and allows lower denoise in downstream Detailer nodes."
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
            raise ValueError("[SAX_Bridge] Pipe does not contain images. Run SAX Loader → KSampler → VAEDecode first.")

        b, h, w, c = images.shape
        target_h = max(8, int(h * scale_by))
        target_w = max(8, int(w * scale_by))
        # 8px アライメント（VAE ダウンサンプリング互換）
        target_h = (target_h // 8) * 8
        target_w = (target_w // 8) * 8

        # --- 1. アップスケール ---
        if upscale_model_name != "None":
            logger.info(f"[SAX_Bridge] Upscaler: ESRGAN mode / model={upscale_model_name} / {w}x{h} -> {target_w}x{target_h}")
            from comfy_extras.nodes_upscale_model import UpscaleModelLoader
            upscale_model = UpscaleModelLoader().load_model(upscale_model_name)[0]
            upscaled = _esrgan_upscale(upscale_model, images, target_h, target_w, method)
            logger.info(f"[SAX_Bridge] Upscaler: ESRGAN done / output size {upscaled.shape[2]}x{upscaled.shape[1]}")
        elif target_h == h and target_w == w:
            logger.info("[SAX_Bridge] Upscaler: no size change / skipping")
            upscaled = images
        else:
            logger.info(f"[SAX_Bridge] Upscaler: pixel interpolation ({method}) / {w}x{h} -> {target_w}x{target_h}")
            upscaled = _pixel_upscale(images, target_h, target_w, method)

        upscaled = torch.clamp(upscaled, 0.0, 1.0)

        # --- 2. 軽量 i2i（denoise > 0 のとき） ---
        if denoise > 0:
            p = _extract_pipe(pipe)
            if p["model"] is None or p["vae"] is None \
                    or p["positive"] is None or p["negative"] is None:
                logger.warning(
                    "[SAX_Bridge] Upscaler: pipe is missing required elements for img2img (model/vae/positive/negative). "
                    "Upscaling only."
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
                    f"[SAX_Bridge] Upscaler i2i: {w}x{h} -> {target_w}x{target_h}, "
                    f"steps={steps_eff}, cfg={cfg_eff}, denoise={denoise}"
                )

        new_pipe = pipe.copy()
        new_pipe["images"] = upscaled
        return (new_pipe, upscaled)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Pipe_Upscaler": SAX_Bridge_Pipe_Upscaler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Pipe_Upscaler": "SAX Upscaler",
}
