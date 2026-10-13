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

# アップスケール + i2i を繰り返せる最大サイクル数
_MAX_CYCLES = 10


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
    cycle > 1 のとき、scale_by を総倍率として等比で分割し、アップスケール + i2i を cycle 回繰り返す
    （denoise > 0 かつ i2i 可能な pipe のときのみ有効。それ以外は 1 回扱い）。
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
                io.Int.Input("cycle", default=1, min=1, max=_MAX_CYCLES, optional=True,
                             tooltip="Number of upscale + img2img cycles. scale_by is the total factor, split geometrically across cycles. Only effective when denoise > 0 (otherwise treated as 1)."),
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
        cycle: int = 1,
    ) -> io.NodeOutput:
        images = pipe.get("images")
        if images is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain images. Run SAX Loader → KSampler → VAEDecode first.")
        if not 1 <= cycle <= _MAX_CYCLES:
            raise ValueError(f"[SAX_Bridge] Upscaler: cycle must be between 1 and {_MAX_CYCLES} (got {cycle}).")

        b, h, w, c = images.shape

        # i2i が実行可能かを先に判定する（欠落時は従来どおりアップスケールのみ）
        i2i_pipe = None
        if denoise > 0:
            p = _extract_pipe(pipe)
            if p["model"] is None or p["vae"] is None or p["positive"] is None:
                logger.warning(
                    "[SAX_Bridge] Upscaler: pipe is missing required elements for img2img (model/vae/positive). "
                    "Upscaling only."
                )
            else:
                i2i_pipe = p

        # 中間サイクルは i2i で補完する意味があるときのみ。i2i なしなら 1 回で最終サイズへ。
        cycles_eff = cycle if i2i_pipe is not None else 1
        if cycle > 1 and cycles_eff == 1:
            logger.info("[SAX_Bridge] Upscaler: cycle=%d ignored (requires denoise > 0 and a complete pipe)", cycle)

        positive_out = pipe.get("positive")
        upscale_model = None
        sample_model_base = positive = negative = None
        steps_eff = cfg_eff = None
        if i2i_pipe is not None:
            p = i2i_pipe
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
            sample_model_base = guided if guided is not None else p["model"]

        upscaled = images
        for i in range(cycles_eff):
            # scale_by を総倍率とし、サイクルごとに等比で段階的に拡大する（最終サイクルで scale_by に到達）
            factor = scale_by ** ((i + 1) / cycles_eff)
            cur_h, cur_w = upscaled.shape[1], upscaled.shape[2]
            # VAE ダウンサンプリングに合わせて 8px アライメント
            target_h = (max(8, int(h * factor)) // 8) * 8
            target_w = (max(8, int(w * factor)) // 8) * 8

            if upscale_model_name != "None":
                logger.info("[SAX_Bridge] Upscaler: ESRGAN mode / model=%s / cycle %d/%d / %dx%d -> %dx%d",
                            upscale_model_name, i + 1, cycles_eff, cur_w, cur_h, target_w, target_h)
                if upscale_model is None:
                    from comfy_extras.nodes_upscale_model import UpscaleModelLoader
                    upscale_model = UpscaleModelLoader().load_model(upscale_model_name)[0]
                upscaled = _esrgan_upscale(upscale_model, upscaled, target_h, target_w, method)
                logger.info("[SAX_Bridge] Upscaler: ESRGAN done / output size %dx%d",
                            upscaled.shape[2], upscaled.shape[1])
            elif target_h == cur_h and target_w == cur_w:
                logger.info("[SAX_Bridge] Upscaler: no size change / skipping")
            else:
                logger.info("[SAX_Bridge] Upscaler: pixel interpolation (%s) / cycle %d/%d / %dx%d -> %dx%d",
                            method, i + 1, cycles_eff, cur_w, cur_h, target_w, target_h)
                upscaled = _pixel_upscale(upscaled, target_h, target_w, method)

            upscaled = torch.clamp(upscaled, 0.0, 1.0)

            if i2i_pipe is None:
                continue
            p = i2i_pipe

            # ControlNet 構造拘束はフル画像 i2i 対象なので encode 前に適用する。
            # パッチ済み conditioning は ksampler ローカルに留め、pipe へは書き戻さない。
            # model は standard_cn では素通しだが、将来の lllite 用の seam を通す。
            structure_result = apply_structure_control_cfg(
                pipe.get(STRUCTURE_CONTROL_KEY), positive, negative,
                upscaled[:, :, :, :3], sample_model_base,
            )

            latent = p["vae"].encode(upscaled[:, :, :, :3])
            samples_dict = {"samples": latent}

            sampler_result = nodes.common_ksampler(
                structure_result.model,
                p["seed"] + i,
                steps_eff,
                cfg_eff,
                p["sampler_name"],
                p["scheduler"],
                structure_result.positive,
                structure_result.negative,
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
            upscaled = torch.clamp(decoded, 0.0, 1.0)

            logger.info(
                "[SAX_Bridge] Upscaler i2i: cycle %d/%d -> %dx%d, steps=%d, cfg=%s, denoise=%s",
                i + 1, cycles_eff, upscaled.shape[2], upscaled.shape[1], steps_eff, cfg_eff, denoise,
            )

        new_pipe = {**pipe, "images": upscaled, "positive": positive_out}
        return io.NodeOutput(new_pipe, upscaled)
