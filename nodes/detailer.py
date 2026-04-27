import logging

import torch
import torch.nn.functional as F
import nodes

from comfy_api.latest import io
from .io_types import PipeLine
from .noise import SAXNoiseEngine
from .guidance import apply_guidance_to_model, _ALL_MODES

try:
    import comfy_extras.nodes_differential_diffusion as _diff_diffusion
    _HAS_DIFF_DIFFUSION = True
except ImportError:
    _HAS_DIFF_DIFFUSION = False

_logger = logging.getLogger(__name__)


def unsharp_mask(image_bchw: torch.Tensor, strength: float, sigma: float) -> torch.Tensor:
    """アンシャープマスクで画像を鮮鋭化する。(B, C, H, W) float32"""
    blurred = SAXNoiseEngine.gaussian_blur(image_bchw, sigma)
    return torch.clamp(image_bchw + strength * (image_bchw - blurred), 0.0, 1.0)


def blur_context_boundary(
    image_bchw: torch.Tensor,
    mask_bhw: torch.Tensor,
    sigma: float,
    dilation_radius: int,
) -> torch.Tensor:
    """
    マスク外のコンテキスト領域（マスク境界から dilation_radius px のリング）を
    sigma でぼかすことで、モデルがマスク近傍のテキストを「続けようとする」現象を抑制する。

    image_bchw : (B, C, H, W) float32 — クロップ済み画像
    mask_bhw   : (B, H, W)    float32 — 0/1 マスク（1=インペイント対象）
    sigma      : ぼかし強度（ピクセル単位、0 で無効）
    dilation_radius : マスク境界から外側に何 px のリングをぼかすか（0=全コンテキスト）
    """
    if sigma <= 0:
        return image_bchw

    device = image_bchw.device
    mask_b1hw = mask_bhw.unsqueeze(1).float().to(device)  # (B, 1, H, W)

    if dilation_radius > 0:
        dilation_sigma = dilation_radius / 2.5
        dilated_soft = SAXNoiseEngine.gaussian_blur(mask_b1hw, dilation_sigma).clamp(0.0, 1.0)
        context_zone = (dilated_soft - mask_b1hw).clamp(0.0, 1.0)
        zone_max = context_zone.amax(dim=(2, 3), keepdim=True).clamp(min=1e-6)
        context_zone = context_zone / zone_max
    else:
        context_zone = (1.0 - mask_b1hw).clamp(0.0, 1.0)

    blurred = SAXNoiseEngine.gaussian_blur(image_bchw, sigma)
    return image_bchw * (1.0 - context_zone) + blurred * context_zone


def _align_bbox_8px(y_min, x_min, y_max, x_max, image_h, image_w):
    """bbox を 8px アライメントする（VAE ダウンサンプリング互換）"""
    h_c = y_max - y_min + 1
    w_c = x_max - x_min + 1
    h_aligned = ((h_c + 7) // 8) * 8
    w_aligned = ((w_c + 7) // 8) * 8
    dh = h_aligned - h_c
    dw = w_aligned - w_c

    y_min = max(0, y_min - dh // 2)
    y_max = y_min + h_aligned - 1
    if y_max >= image_h:
        y_max = image_h - 1
        y_min = max(0, image_h - h_aligned)

    x_min = max(0, x_min - dw // 2)
    x_max = x_min + w_aligned - 1
    if x_max >= image_w:
        x_max = image_w - 1
        x_min = max(0, image_w - w_aligned)

    return y_min, x_min, y_max, x_max


def expand_bbox_by_factor(bbox, image_h, image_w, crop_factor):
    """
    bbox をcrop_factorで中心基準に拡張し、8ピクセルアライメントを適用する。
    crop_factor=1.0 で元のサイズ、3.0 でセグメントサイズの3倍のコンテキストを確保。
    """
    y_min, x_min, y_max, x_max = bbox
    center_y = (y_min + y_max) / 2
    center_x = (x_min + x_max) / 2
    h = (y_max - y_min + 1) * crop_factor
    w = (x_max - x_min + 1) * crop_factor

    y_min_new = max(0, int(center_y - h / 2))
    x_min_new = max(0, int(center_x - w / 2))
    y_max_new = min(image_h - 1, int(center_y + h / 2))
    x_max_new = min(image_w - 1, int(center_x + w / 2))

    return _align_bbox_8px(y_min_new, x_min_new, y_max_new, x_max_new, image_h, image_w)


def get_bbox_from_mask(mask: torch.Tensor, padding: int = 0):
    """
    mask: (B, H, W) float32
    returns: (y_min, x_min, y_max, x_max) or None
    バッチ内の全てのマスクを包含するBBOXを返し、さらに8ピクセルアライメントを行う。
    """
    if len(mask.shape) == 4:
        mask = mask.squeeze(1)

    ys, xs = torch.where(mask > 0.5)[-2:]
    if len(ys) == 0:
        return None

    y_min, x_min = int(ys.min().item()), int(xs.min().item())
    y_max, x_max = int(ys.max().item()), int(xs.max().item())

    h, w = mask.shape[1], mask.shape[2]
    y_min = max(0, y_min - padding)
    x_min = max(0, x_min - padding)
    y_max = min(h - 1, y_max + padding)
    x_max = min(w - 1, x_max + padding)

    return _align_bbox_8px(y_min, x_min, y_max, x_max, h, w)


def crop_bbox(image: torch.Tensor, bbox: tuple):
    """
    image: (B, H, W, C)
    bbox: (y_min, x_min, y_max, x_max)
    """
    y_min, x_min, y_max, x_max = bbox
    return image[:, y_min:y_max+1, x_min:x_max+1, :]


def uncrop_and_blend(original: torch.Tensor, cropped: torch.Tensor, mask: torch.Tensor, bbox: tuple, feather: int = 5):
    """
    original: (B, H, W, C) - オリジナルのフル画像
    cropped: (B, h_c, w_c, C) - 処理済みのクロップ画像
    mask: (B, H, W) - フルサイズのマスク
    bbox: (y_min, x_min, y_max, x_max)
    """
    y_min, x_min, y_max, x_max = bbox
    result = original.clone()

    device = result.device

    crop_mask = mask[:, y_min:y_max+1, x_min:x_max+1].to(device)
    if len(crop_mask.shape) == 3:
        crop_mask = crop_mask.unsqueeze(-1)  # (B, H_c, W_c, 1)

    target_h = y_max - y_min + 1
    target_w = x_max - x_min + 1

    if cropped.shape[1] != target_h or cropped.shape[2] != target_w:
        cropped = F.interpolate(
            cropped.permute(0, 3, 1, 2),
            size=(target_h, target_w),
            mode="bilinear",
            align_corners=False,
        ).permute(0, 2, 3, 1)

    cropped = cropped.to(device)

    if feather > 0:
        feathered_mask = SAXNoiseEngine.gaussian_blur(crop_mask.permute(0, 3, 1, 2), float(feather) / 3.0)
        crop_mask = feathered_mask.permute(0, 2, 3, 1)

    target_area = result[:, y_min:y_max+1, x_min:x_max+1, :]
    blended_area = target_area * (1.0 - crop_mask) + cropped * crop_mask
    result[:, y_min:y_max+1, x_min:x_max+1, :] = torch.clamp(blended_area, 0.0, 1.0)

    return result


_GRAIN_SEED_OFFSET = 10000  # shadow grain と latent noise のシード分離用オフセット
_SHADOW_STRENGTH_SCALE = 0.2  # shadow_enhance を grain 振幅へ変換する係数（経験値）

CYCLE_MODES: tuple[str, ...] = ("latent_persistent", "image_roundtrip")


def _apply_image_preprocess(
    cropped_images: torch.Tensor,
    mask_in_bbox: torch.Tensor,
    shadow_strength: float,
    edge_weight: float,
    edge_blur_sigma: float,
    context_blur_sigma: float,
    context_blur_radius: int,
    grain_seed: int,
) -> torch.Tensor:
    """画像領域での前処理（shadow grain → edge unsharp → context blur）を順に適用する。"""
    if shadow_strength > 0:
        crop_rgb = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
        luminance = 0.299 * crop_rgb[:, 0:1] + 0.587 * crop_rgb[:, 1:2] + 0.114 * crop_rgb[:, 2:3]
        grain_weight = (1.0 - luminance).clamp(0.0, 1.0)
        generator = torch.Generator(device='cpu')
        generator.manual_seed(grain_seed)
        grain = torch.randn(
            crop_rgb.shape, generator=generator, dtype=crop_rgb.dtype, device='cpu'
        ).to(crop_rgb.device)
        crop_mask_2d = mask_in_bbox.unsqueeze(1).float().to(crop_rgb.device)
        crop_rgb = torch.clamp(
            crop_rgb + grain * shadow_strength * grain_weight * crop_mask_2d, 0.0, 1.0
        )
        cropped_images = torch.cat(
            [crop_rgb.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3
        )

    if edge_weight > 0:
        rgb_bchw = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
        rgb_bchw = unsharp_mask(rgb_bchw, edge_weight, edge_blur_sigma)
        cropped_images = torch.cat(
            [rgb_bchw.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3
        )

    if context_blur_sigma > 0:
        crop_rgb = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
        crop_rgb = blur_context_boundary(
            crop_rgb, mask_in_bbox, context_blur_sigma, context_blur_radius
        )
        cropped_images = torch.cat(
            [crop_rgb.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3
        )

    return cropped_images


def _build_noise_mask(
    mask_in_bbox: torch.Tensor,
    latent_shape_hw: tuple[int, int],
    device: torch.device,
    noise_mask_feather: int,
) -> torch.Tensor:
    """latent サイズに合わせた noise_mask を生成する。feather 適用込み。"""
    h_lat, w_lat = latent_shape_hw
    noise_mask = F.interpolate(
        mask_in_bbox.unsqueeze(1).float().to(device),
        size=(h_lat, w_lat),
        mode="bilinear",
        align_corners=False,
    ).squeeze(1)

    if noise_mask_feather > 0:
        noise_mask = SAXNoiseEngine.gaussian_blur(
            noise_mask.unsqueeze(1), float(noise_mask_feather) / 3.0
        ).squeeze(1).clamp(0.0, 1.0)

    return noise_mask


def _add_latent_noise(
    t: torch.Tensor,
    latent_noise_intensity: float,
    noise_type: str,
    noise_mask: torch.Tensor,
    seed: int,
) -> torch.Tensor:
    """latent にマスク領域限定でノイズを加算した新しいテンソルを返す（t は変更しない）。"""
    if latent_noise_intensity <= 0:
        return t
    generator = torch.Generator(device='cpu')
    generator.manual_seed(seed)
    if noise_type == "gaussian":
        lat_noise = torch.randn(t.shape, generator=generator, dtype=t.dtype, device='cpu')
    else:
        lat_noise = torch.rand(t.shape, generator=generator, dtype=t.dtype, device='cpu') * 2.0 - 1.0
    return t + lat_noise.to(t.device) * latent_noise_intensity * noise_mask.unsqueeze(1)


def _run_detail_loop(
    model, vae, images: torch.Tensor, positive, negative, seed: int,
    steps: int, cfg: float, sampler_name: str, scheduler_name: str,
    denoise: float, denoise_decay: float, cycle: int,
    noise_mask_feather: int, blend_feather: int, crop_factor: float,
    context_blur_sigma: float, context_blur_radius: int,
    mask: torch.Tensor | None = None,
    # Enhanced Detailer のみ有効（デフォルト=無効）
    latent_noise_intensity: float = 0.0, noise_type: str = "gaussian",
    shadow_enhance: float = 0.0, shadow_decay: float = 0.0,
    edge_weight: float = 0.0, edge_blur_sigma: float = 1.0,
    # Guidance（共通）
    guidance_mode: str = "off", guidance_strength: float = 0.0, pag_strength: float = 0.0,
    # Cycle 戦略
    cycle_mode: str = "latent_persistent",
) -> torch.Tensor | None:
    """
    Detailer / Enhanced Detailer 共通のディテーリングループ。
    マスク領域が存在しない場合は None を返す。

    cycle_mode:
      - "latent_persistent": cycle 間で latent を保持し、VAE encode/decode を各 1 回に削減。
        画像領域の前処理（shadow_enhance / edge_weight / context_blur_sigma）は初回のみ適用。
        latent_noise_intensity は denoise_decay と連動して各 cycle で減衰する。
        shadow_decay は機能しない。
      - "image_roundtrip": 旧来の挙動。cycle 毎に encode/decode を繰り返す。
        latent_noise_intensity は cycle 毎に同強度（cycle 毎に latent がリセットされるため）。
    """
    if cycle_mode not in CYCLE_MODES:
        _logger.warning(
            "[SAX_Bridge] Unknown cycle_mode %r, falling back to %r",
            cycle_mode, "image_roundtrip",
        )
        cycle_mode = "image_roundtrip"

    if mask is None:
        b, h, w, c = images.shape
        mask = torch.ones((b, h, w), dtype=torch.float32, device=images.device)
    elif mask.shape[1] != images.shape[1] or mask.shape[2] != images.shape[2]:
        mask = F.interpolate(
            mask.unsqueeze(1).float(),
            size=(images.shape[1], images.shape[2]),
            mode="bilinear",
            align_corners=False,
        ).squeeze(1)

    tight_bbox = get_bbox_from_mask(mask, padding=0)
    if tight_bbox is None:
        return None

    _, image_h, image_w, _ = images.shape
    bbox = expand_bbox_by_factor(tight_bbox, image_h, image_w, crop_factor)
    y_min, x_min, y_max, x_max = bbox
    mask_in_bbox = mask[:, y_min:y_max+1, x_min:x_max+1]

    # ループ前に 1 回だけ clone してパッチを設定
    guided_model = apply_guidance_to_model(model, guidance_mode, guidance_strength, pag_strength)
    base_model = guided_model if guided_model is not None else model

    if noise_mask_feather > 0 and _HAS_DIFF_DIFFUSION:
        sample_model = base_model if base_model is not model else model.clone()
        sample_model.set_model_denoise_mask_function(
            lambda sigma, denoise_mask, extra_options: _diff_diffusion.DifferentialDiffusion.forward(
                sigma, denoise_mask, extra_options, strength=1.0
            )
        )
    else:
        sample_model = base_model

    if cycle_mode == "latent_persistent":
        return _run_latent_persistent(
            sample_model, vae, images, mask, bbox, mask_in_bbox,
            positive, negative, seed,
            steps, cfg, sampler_name, scheduler_name,
            denoise, denoise_decay, cycle,
            noise_mask_feather, blend_feather,
            context_blur_sigma, context_blur_radius,
            latent_noise_intensity, noise_type,
            shadow_enhance, edge_weight, edge_blur_sigma,
        )

    return _run_image_roundtrip(
        sample_model, vae, images, mask, bbox, mask_in_bbox,
        positive, negative, seed,
        steps, cfg, sampler_name, scheduler_name,
        denoise, denoise_decay, cycle,
        noise_mask_feather, blend_feather,
        context_blur_sigma, context_blur_radius,
        latent_noise_intensity, noise_type,
        shadow_enhance, shadow_decay, edge_weight, edge_blur_sigma,
    )


def _run_latent_persistent(
    sample_model, vae, images: torch.Tensor,
    mask: torch.Tensor, bbox: tuple, mask_in_bbox: torch.Tensor,
    positive, negative, seed: int,
    steps: int, cfg: float, sampler_name: str, scheduler_name: str,
    denoise: float, denoise_decay: float, cycle: int,
    noise_mask_feather: int, blend_feather: int,
    context_blur_sigma: float, context_blur_radius: int,
    latent_noise_intensity: float, noise_type: str,
    shadow_enhance: float, edge_weight: float, edge_blur_sigma: float,
) -> torch.Tensor:
    """
    VAE encode/decode を各 1 回に抑え、cycle 間は latent を保持して反復する。

    画像領域の前処理（shadow_enhance / edge_weight / context_blur_sigma）は
    encode 直前に 1 回だけ適用する。shadow_decay はこのモードでは受け取らない。

    cycle 内では `t_noisy = t + latent_noise` のように一時変数を作り、ksampler の
    出力で `t` を更新する。これにより noise が cycle 間で累積しない（独立加算）。
    また latent_noise_intensity は denoise_decay と連動して各 cycle で減衰する。
    """
    cropped_images = crop_bbox(images, bbox)
    initial_shadow = shadow_enhance * _SHADOW_STRENGTH_SCALE
    cropped_images = _apply_image_preprocess(
        cropped_images, mask_in_bbox,
        initial_shadow, edge_weight, edge_blur_sigma,
        context_blur_sigma, context_blur_radius,
        grain_seed=seed + _GRAIN_SEED_OFFSET,
    )

    t = vae.encode(cropped_images[:, :, :, :3])
    noise_mask = _build_noise_mask(
        mask_in_bbox, (t.shape[2], t.shape[3]), t.device, noise_mask_feather
    )

    for i in range(cycle):
        current_seed = seed + i
        decay_factor = max(0.0, 1.0 - i * denoise_decay / cycle)
        current_denoise = denoise * decay_factor
        current_noise_intensity = latent_noise_intensity * decay_factor

        t_noisy = _add_latent_noise(t, current_noise_intensity, noise_type, noise_mask, current_seed)

        sampler = nodes.common_ksampler(
            sample_model, current_seed, steps, cfg, sampler_name, scheduler_name,
            positive, negative, {"samples": t_noisy, "noise_mask": noise_mask},
            denoise=current_denoise,
        )
        t = sampler[0]["samples"]

    decoded_images = vae.decode(t)
    return uncrop_and_blend(images, decoded_images, mask, bbox, feather=blend_feather)


def _run_image_roundtrip(
    sample_model, vae, images: torch.Tensor,
    mask: torch.Tensor, bbox: tuple, mask_in_bbox: torch.Tensor,
    positive, negative, seed: int,
    steps: int, cfg: float, sampler_name: str, scheduler_name: str,
    denoise: float, denoise_decay: float, cycle: int,
    noise_mask_feather: int, blend_feather: int,
    context_blur_sigma: float, context_blur_radius: int,
    latent_noise_intensity: float, noise_type: str,
    shadow_enhance: float, shadow_decay: float,
    edge_weight: float, edge_blur_sigma: float,
) -> torch.Tensor:
    """旧来の挙動: cycle 毎に encode/decode を繰り返す（後方互換用）。

    cycle 毎に latent がリセットされるため、latent_noise_intensity は
    denoise_decay と連動させない（リセットによって発散が自然に防がれる）。
    shadow_decay はこのモードでのみ機能する。
    """
    result_images = images
    for i in range(cycle):
        current_seed = seed + i
        current_denoise = denoise * max(0.0, 1.0 - i * denoise_decay / cycle)
        current_shadow = shadow_enhance * _SHADOW_STRENGTH_SCALE * max(0.0, 1.0 - i * shadow_decay / cycle)

        cropped_images = crop_bbox(result_images, bbox)
        cropped_images = _apply_image_preprocess(
            cropped_images, mask_in_bbox,
            current_shadow, edge_weight, edge_blur_sigma,
            context_blur_sigma, context_blur_radius,
            grain_seed=current_seed + _GRAIN_SEED_OFFSET,
        )

        t = vae.encode(cropped_images[:, :, :, :3])
        noise_mask = _build_noise_mask(
            mask_in_bbox, (t.shape[2], t.shape[3]), t.device, noise_mask_feather
        )
        t = _add_latent_noise(t, latent_noise_intensity, noise_type, noise_mask, current_seed)

        sampler = nodes.common_ksampler(
            sample_model, current_seed, steps, cfg, sampler_name, scheduler_name,
            positive, negative, {"samples": t, "noise_mask": noise_mask},
            denoise=current_denoise,
        )
        samples = sampler[0]["samples"]

        decoded_images = vae.decode(samples)
        result_images = uncrop_and_blend(result_images, decoded_images, mask, bbox, feather=blend_feather)

    return result_images


def _extract_pipe(pipe):
    """パイプから共通フィールドを取り出すヘルパー"""
    loader_settings = pipe.get("loader_settings", {})
    return {
        "model":          pipe.get("model"),
        "clip":           pipe.get("clip"),
        "vae":            pipe.get("vae"),
        "images":         pipe.get("images"),
        "positive":       pipe.get("positive"),
        "negative":       pipe.get("negative"),
        "seed":           pipe.get("seed") or 0,
        "steps":          max(1, loader_settings.get("steps", 20)),
        "cfg":            loader_settings.get("cfg", 8.0),
        "sampler_name":   loader_settings.get("sampler_name", "euler"),
        "scheduler": loader_settings.get("scheduler", "normal"),
    }


def _ensure_negative(p):
    """negative が None の場合、CLIP で空文字列をエンコードして補完する。"""
    if p["negative"] is None:
        if p["clip"] is None:
            raise ValueError(
                "[SAX_Bridge] Pipe does not contain negative conditioning or CLIP model."
            )
        p["negative"] = nodes.CLIPTextEncode().encode(p["clip"], "")[0]


class SAX_Bridge_Detailer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Detailer",
            display_name="SAX Detailer",
            category="SAX/Bridge/Enhance",
            inputs=[
                PipeLine.Input("pipe"),
                io.Float.Input("denoise", default=0.45, min=0.0, max=1.0, step=0.01),
                io.Int.Input("cycle", default=1, min=1, max=10, step=1),
                io.Float.Input("crop_factor", default=3.0, min=1.0, max=10.0, step=0.1),
                io.Int.Input("noise_mask_feather", default=5, min=0, max=100, step=1),
                io.Int.Input("blend_feather", default=5, min=0, max=100, step=1),
                io.Mask.Input("mask", optional=True),
                io.Int.Input("steps_override", default=0, min=0, max=200, optional=True,
                             tooltip="0 = inherit steps from loader_settings. Values ≥1 override it."),
                io.Float.Input("cfg_override", default=0.0, min=0.0, max=100.0, step=0.5, optional=True,
                               tooltip="0.0 = inherit CFG from loader_settings. Values > 0 override it."),
                io.Combo.Input("guidance_mode", options=_ALL_MODES, default="off", optional=True,
                               tooltip="CFG guidance enhancement. agc=spike suppression, fdg=detail emphasis, agc+fdg=both, post_fdg=low CFG."),
                io.Float.Input("guidance_strength", default=0.5, min=0.0, max=1.0, step=0.05, optional=True,
                               tooltip="Guidance effect intensity. 0.0=none, 1.0=maximum."),
                io.Float.Input("pag_strength", default=0.0, min=0.0, max=1.0, step=0.05, optional=True,
                               tooltip="Perturbed Attention Guidance. Works at any CFG. 0.5=standard. Adds one extra forward pass per step."),
                io.Combo.Input("cycle_mode", options=list(CYCLE_MODES), default="latent_persistent", optional=True,
                               tooltip="latent_persistent=keeps latent across cycles (1 VAE round-trip total, recommended). image_roundtrip=legacy behavior with VAE encode/decode per cycle."),
                io.String.Input("positive_prompt", multiline=True, force_input=True, optional=True),
            ],
            outputs=[
                PipeLine.Output(),
                io.Image.Output(),
            ],
        )

    @classmethod
    def execute(cls, pipe, denoise, cycle, crop_factor, noise_mask_feather, blend_feather,
                mask=None, steps_override=0, cfg_override=0.0,
                guidance_mode="off", guidance_strength=0.5, pag_strength=0.0,
                cycle_mode="latent_persistent",
                positive_prompt=None) -> io.NodeOutput:
        p = _extract_pipe(pipe)
        if p["model"] is None or p["images"] is None or p["vae"] is None \
                or p["positive"] is None:
            return io.NodeOutput(pipe, p["images"] if p["images"] is not None else pipe.get("images"))
        _ensure_negative(p)

        steps_eff = steps_override if steps_override > 0 else p["steps"]
        cfg_eff   = cfg_override   if cfg_override   > 0 else p["cfg"]

        positive = p["positive"]
        if positive_prompt and p["clip"] is not None:
            positive = nodes.CLIPTextEncode().encode(p["clip"], positive_prompt)[0]

        result_images = _run_detail_loop(
            p["model"], p["vae"], p["images"], positive, p["negative"], p["seed"],
            steps_eff, cfg_eff, p["sampler_name"], p["scheduler"],
            denoise, 0.0, cycle,
            noise_mask_feather, blend_feather, crop_factor,
            0.0, 48,
            mask=mask,
            guidance_mode=guidance_mode, guidance_strength=guidance_strength, pag_strength=pag_strength,
            cycle_mode=cycle_mode,
        )

        if result_images is None:
            return io.NodeOutput(pipe, p["images"] if p["images"] is not None else pipe.get("images"))

        new_pipe = pipe.copy()
        new_pipe["images"] = result_images
        new_pipe["positive"] = positive
        return io.NodeOutput(new_pipe, result_images)


class SAX_Bridge_Detailer_Enhanced(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Detailer_Enhanced",
            display_name="SAX Enhanced Detailer",
            category="SAX/Bridge/Enhance",
            inputs=[
                PipeLine.Input("pipe"),
                io.Float.Input("denoise", default=0.45, min=0.0, max=1.0, step=0.01),
                io.Float.Input("denoise_decay", default=0.0, min=0.0, max=1.0, step=0.05),
                io.Int.Input("cycle", default=1, min=1, max=10, step=1),
                io.Float.Input("crop_factor", default=3.0, min=1.0, max=10.0, step=0.1),
                io.Int.Input("noise_mask_feather", default=5, min=0, max=100, step=1),
                io.Int.Input("blend_feather", default=5, min=0, max=100, step=1),
                io.Float.Input("shadow_enhance", default=0.0, min=0.0, max=1.0, step=0.01),
                io.Float.Input("shadow_decay", default=0.25, min=0.0, max=1.0, step=0.05,
                               tooltip="Decays shadow grain across cycles. Effective only when cycle_mode=image_roundtrip."),
                io.Float.Input("edge_weight", default=0.0, min=0.0, max=1.0, step=0.05),
                io.Float.Input("edge_blur_sigma", default=1.0, min=0.1, max=10.0, step=0.1),
                io.Float.Input("latent_noise_intensity", default=0.1, min=0.0, max=2.0, step=0.01),
                io.Combo.Input("noise_type", options=["gaussian", "uniform"]),
                io.Float.Input("context_blur_sigma", default=0.0, min=0.0, max=64.0, step=0.5,
                               tooltip="Blurs the context area near the mask boundary to suppress text artifacts. 0=disabled."),
                io.Int.Input("context_blur_radius", default=48, min=0, max=256, step=4,
                             tooltip="Limits the blur target to a ring N px outside the mask boundary. 0=entire context."),
                io.Mask.Input("mask", optional=True),
                io.Int.Input("steps_override", default=0, min=0, max=200, optional=True,
                             tooltip="0 = inherit steps from loader_settings. Values ≥1 override it."),
                io.Float.Input("cfg_override", default=0.0, min=0.0, max=100.0, step=0.5, optional=True,
                               tooltip="0.0 = inherit CFG from loader_settings. Values > 0 override it."),
                io.Combo.Input("guidance_mode", options=_ALL_MODES, default="off", optional=True,
                               tooltip="CFG guidance enhancement. agc=spike suppression, fdg=detail emphasis, agc+fdg=both, post_fdg=low CFG."),
                io.Float.Input("guidance_strength", default=0.5, min=0.0, max=1.0, step=0.05, optional=True,
                               tooltip="Guidance effect intensity. 0.0=none, 1.0=maximum."),
                io.Float.Input("pag_strength", default=0.0, min=0.0, max=1.0, step=0.05, optional=True,
                               tooltip="Perturbed Attention Guidance. Works at any CFG. 0.5=standard. Adds one extra forward pass per step."),
                io.Combo.Input("cycle_mode", options=list(CYCLE_MODES), default="latent_persistent", optional=True,
                               tooltip="latent_persistent=keeps latent across cycles (1 VAE round-trip total, recommended). latent_noise_intensity decays with denoise_decay in this mode. image_roundtrip=legacy behavior with VAE encode/decode per cycle. shadow_decay only effective in image_roundtrip mode."),
                io.String.Input("positive_prompt", multiline=True, force_input=True, optional=True),
            ],
            outputs=[
                PipeLine.Output(),
                io.Image.Output(),
            ],
        )

    @classmethod
    def execute(cls, pipe, denoise, denoise_decay, cycle,
                crop_factor, noise_mask_feather, blend_feather,
                shadow_enhance, shadow_decay, edge_weight, edge_blur_sigma,
                latent_noise_intensity, noise_type,
                context_blur_sigma, context_blur_radius,
                mask=None, steps_override=0, cfg_override=0.0,
                guidance_mode="off", guidance_strength=0.5, pag_strength=0.0,
                cycle_mode="latent_persistent",
                positive_prompt=None) -> io.NodeOutput:
        p = _extract_pipe(pipe)
        if p["model"] is None or p["images"] is None or p["vae"] is None \
                or p["positive"] is None:
            return io.NodeOutput(pipe, p["images"] if p["images"] is not None else pipe.get("images"))
        _ensure_negative(p)

        steps_eff = steps_override if steps_override > 0 else p["steps"]
        cfg_eff   = cfg_override   if cfg_override   > 0 else p["cfg"]

        positive = p["positive"]
        if positive_prompt and p["clip"] is not None:
            positive = nodes.CLIPTextEncode().encode(p["clip"], positive_prompt)[0]

        result_images = _run_detail_loop(
            p["model"], p["vae"], p["images"], positive, p["negative"], p["seed"],
            steps_eff, cfg_eff, p["sampler_name"], p["scheduler"],
            denoise, denoise_decay, cycle,
            noise_mask_feather, blend_feather, crop_factor,
            context_blur_sigma, context_blur_radius,
            mask=mask,
            latent_noise_intensity=latent_noise_intensity,
            noise_type=noise_type,
            shadow_enhance=shadow_enhance,
            shadow_decay=shadow_decay,
            edge_weight=edge_weight,
            edge_blur_sigma=edge_blur_sigma,
            guidance_mode=guidance_mode, guidance_strength=guidance_strength, pag_strength=pag_strength,
            cycle_mode=cycle_mode,
        )

        if result_images is None:
            return io.NodeOutput(pipe, p["images"] if p["images"] is not None else pipe.get("images"))

        new_pipe = pipe.copy()
        new_pipe["images"] = result_images
        new_pipe["positive"] = positive
        return io.NodeOutput(new_pipe, result_images)
