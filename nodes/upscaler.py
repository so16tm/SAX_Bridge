import logging

import torch
import nodes
import comfy.utils
import folder_paths
from comfy_api.latest import io

from .detailer import _extract_pipe, _ensure_negative
from .guidance import apply_guidance_to_model, _ALL_MODES
from .io_types import PipeLine
from .structure_control import STRUCTURE_CONTROL_KEY, apply_structure_control_cfg
from .vae_utils import decode_image

logger = logging.getLogger("SAX_Bridge")

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
    upscaled = ImageUpscaleWithModel().upscale(upscale_model, images[..., :3])[0]

    if upscaled.shape[1] != target_h or upscaled.shape[2] != target_w:
        bchw = upscaled.permute(0, 3, 1, 2)
        bchw = comfy.utils.common_upscale(bchw, target_w, target_h, method, "disabled")
        upscaled = bchw.permute(0, 2, 3, 1)

    if images.shape[-1] > 3:
        extra_channels = _pixel_upscale(images[..., 3:], target_h, target_w, method)
        upscaled = torch.cat([upscaled, extra_channels], dim=-1)
    return upscaled


class SAX_Bridge_Upscaler(io.ComfyNode):
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
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Upscaler",
            display_name="SAX Upscaler",
            category="SAX/Bridge/Enhance",
            description=(
                "Upscales images in the pipe. "
                "Using an ESRGAN model enables high-quality enlargement and allows lower denoise in downstream Detailer nodes."
            ),
            inputs=[
                PipeLine.Input("pipe"),
                io.Combo.Input("upscale_model_name",
                               options=["None"] + folder_paths.get_filename_list("upscale_models"),
                               tooltip="Upscale model to use. None = pixel interpolation only."),
                io.Combo.Input("method",
                               options=["lanczos", "bilinear", "bicubic", "nearest-exact"],
                               tooltip="Pixel interpolation method. When upscale_model_name is set, model-based upscaling takes priority; this method is used only for final resize adjustment."),
                io.Float.Input("scale_by", default=2.0, min=0.25, max=8.0, step=0.05,
                               tooltip="Scale factor relative to original resolution. For a 4x ESRGAN model, scale_by=2 upscales 4x then downscales to 1/2."),
                io.Float.Input("denoise", default=0.0, min=0.0, max=1.0, step=0.01,
                               tooltip="0=upscale only / Values > 0 run a lightweight img2img pass after upscaling."),
                io.Int.Input("steps_override", default=0, min=0, max=200, optional=True,
                             tooltip="Steps for img2img pass. 0 = inherit from loader_settings."),
                io.Float.Input("cfg_override", default=0.0, min=0.0, max=100.0, step=0.5, optional=True,
                               tooltip="CFG for img2img pass. 0.0 = inherit from loader_settings. Values > 0 override it."),
                io.Combo.Input("guidance_mode", options=_ALL_MODES, default="off", optional=True,
                               tooltip="CFG guidance enhancement for the img2img pass. agc=spike suppression, fdg=detail emphasis, agc+fdg=both, post_fdg=low CFG."),
                io.Float.Input("guidance_strength", default=0.5, min=0.0, max=1.0, step=0.05, optional=True,
                               tooltip="Guidance effect intensity. 0.0=none, 1.0=maximum."),
                io.Float.Input("pag_strength", default=0.0, min=0.0, max=1.0, step=0.05, optional=True,
                               tooltip="Perturbed Attention Guidance. Works at any CFG. 0.5=standard. Adds one extra forward pass per step."),
                io.String.Input("positive_prompt", multiline=True, force_input=True, optional=True,
                                tooltip="Overrides the positive prompt for the img2img pass. Only effective when denoise > 0."),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
                io.Image.Output("IMAGE"),
            ],
        )

    @classmethod
    def execute(
        cls,
        pipe: dict,
        upscale_model_name: str,
        method: str,
        scale_by: float,
        denoise: float,
        steps_override: int = 0,
        cfg_override: float = 0.0,
        guidance_mode: str = "off",
        guidance_strength: float = 0.5,
        pag_strength: float = 0.0,
        positive_prompt: str | None = None,
    ) -> io.NodeOutput:
        images = pipe.get("images")
        if images is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain images. Run SAX Loader → KSampler → VAEDecode first.")

        b, h, w, c = images.shape
        target_h = max(8, int(h * scale_by))
        target_w = max(8, int(w * scale_by))
        # VAE ダウンサンプリングに合わせて 8px アライメント
        target_h = (target_h // 8) * 8
        target_w = (target_w // 8) * 8

        if upscale_model_name != "None":
            logger.info("[SAX_Bridge] Upscaler: ESRGAN mode / model=%s / %dx%d -> %dx%d",
                        upscale_model_name, w, h, target_w, target_h)
            from comfy_extras.nodes_upscale_model import UpscaleModelLoader
            upscale_model = UpscaleModelLoader().load_model(upscale_model_name)[0]
            upscaled = _esrgan_upscale(upscale_model, images, target_h, target_w, method)
            logger.info("[SAX_Bridge] Upscaler: ESRGAN done / output size %dx%d",
                        upscaled.shape[2], upscaled.shape[1])
        elif target_h == h and target_w == w:
            logger.info("[SAX_Bridge] Upscaler: no size change / skipping")
            upscaled = images
        else:
            logger.info("[SAX_Bridge] Upscaler: pixel interpolation (%s) / %dx%d -> %dx%d",
                        method, w, h, target_w, target_h)
            upscaled = _pixel_upscale(images, target_h, target_w, method)

        upscaled = torch.clamp(upscaled, 0.0, 1.0)

        positive_out = pipe.get("positive")
        if denoise > 0:
            p = _extract_pipe(pipe)
            if p["model"] is None or p["vae"] is None or p["positive"] is None:
                logger.warning(
                    "[SAX_Bridge] Upscaler: pipe is missing required elements for img2img (model/vae/positive). "
                    "Upscaling only."
                )
            else:
                _ensure_negative(p)
                steps_eff = steps_override if steps_override > 0 else p["steps"]
                cfg_eff   = cfg_override   if cfg_override   > 0 else p["cfg"]

                positive = p["positive"]
                if positive_prompt and p["clip"] is not None:
                    positive = nodes.CLIPTextEncode().encode(p["clip"], positive_prompt)[0]
                negative = p["negative"]
                # prompt 上書き済み・CN 未パッチの positive のみ下流へ伝播する
                # （Detailer と同様、CN パッチは i2i ローカル限定とし二重適用を防ぐ）。
                positive_out = positive

                guided = apply_guidance_to_model(
                    p["model"], guidance_mode, guidance_strength, pag_strength
                )
                sample_model = guided if guided is not None else p["model"]

                # ControlNet 構造拘束はフル画像 i2i 対象なので encode 前に適用する。
                # パッチ済み conditioning は ksampler ローカルに留め、pipe へは書き戻さない。
                # model は standard_cn では素通しだが、将来の lllite 用の seam を通す。
                structure_result = apply_structure_control_cfg(
                    pipe.get(STRUCTURE_CONTROL_KEY), positive, negative,
                    upscaled[:, :, :, :3], sample_model,
                )
                cn_positive = structure_result.positive
                cn_negative = structure_result.negative
                sample_model = structure_result.model

                latent = p["vae"].encode(upscaled[:, :, :, :3])
                samples_dict = {"samples": latent}

                sampler_result = nodes.common_ksampler(
                    sample_model,
                    p["seed"],
                    steps_eff,
                    cfg_eff,
                    p["sampler_name"],
                    p["scheduler"],
                    cn_positive,
                    cn_negative,
                    samples_dict,
                    denoise=denoise,
                )
                decoded = decode_image(p["vae"], sampler_result[0]["samples"])
                if upscaled.shape[-1] > decoded.shape[-1]:
                    extra_channels = upscaled[..., decoded.shape[-1]:]
                    if extra_channels.shape[1:3] != decoded.shape[1:3]:
                        extra_channels = _pixel_upscale(
                            extra_channels, decoded.shape[1], decoded.shape[2], method
                        )
                    decoded = torch.cat([decoded, extra_channels.to(decoded)], dim=-1)
                upscaled = decoded
                upscaled = torch.clamp(upscaled, 0.0, 1.0)

                logger.info(
                    "[SAX_Bridge] Upscaler i2i: %dx%d -> %dx%d, steps=%d, cfg=%s, denoise=%s",
                    w, h, target_w, target_h, steps_eff, cfg_eff, denoise,
                )

        new_pipe = {**pipe, "images": upscaled, "positive": positive_out}
        return io.NodeOutput(new_pipe, upscaled)
