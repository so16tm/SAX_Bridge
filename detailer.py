import torch
import torch.nn.functional as F
import nodes

from .io_types import PipeLine
from .noise import SAXNoiseEngine

try:
    import comfy_extras.nodes_differential_diffusion as _diff_diffusion
    _HAS_DIFF_DIFFUSION = True
except ImportError:
    _HAS_DIFF_DIFFUSION = False



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

    # ぼかし対象のコンテキストマスクを決定
    # max_pool2d(kernel=2r+1) は O(H×W×r²) で高コストなため、
    # 分離可能なガウスぼかし O(H×W×r) によるソフト膨張に置換する。
    if dilation_radius > 0:
        # マスクをガウスぼかし → 境界外に滲み出た領域がリングになる
        dilation_sigma = dilation_radius / 2.5
        dilated_soft = SAXNoiseEngine.gaussian_blur(mask_b1hw, dilation_sigma).clamp(0.0, 1.0)
        context_zone = (dilated_soft - mask_b1hw).clamp(0.0, 1.0)
        # [0, 1] に正規化（ガウスの裾野で値が小さくなるため）
        zone_max = context_zone.amax(dim=(2, 3), keepdim=True).clamp(min=1e-6)
        context_zone = context_zone / zone_max
    else:
        # 全コンテキスト（マスク外すべて）
        context_zone = (1.0 - mask_b1hw).clamp(0.0, 1.0)

    blurred = SAXNoiseEngine.gaussian_blur(image_bchw, sigma)
    # コンテキストゾーンだけぼかした版を使用、マスク内は元のまま
    return image_bchw * (1.0 - context_zone) + blurred * context_zone


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

    # 8ピクセルアライメント
    h_c = y_max_new - y_min_new + 1
    w_c = x_max_new - x_min_new + 1
    h_aligned = ((h_c + 7) // 8) * 8
    w_aligned = ((w_c + 7) // 8) * 8
    dh = h_aligned - h_c
    dw = w_aligned - w_c

    y_min_new = max(0, y_min_new - dh // 2)
    y_max_new = y_min_new + h_aligned - 1
    if y_max_new >= image_h:
        y_max_new = image_h - 1
        y_min_new = max(0, image_h - h_aligned)

    x_min_new = max(0, x_min_new - dw // 2)
    x_max_new = x_min_new + w_aligned - 1
    if x_max_new >= image_w:
        x_max_new = image_w - 1
        x_min_new = max(0, image_w - w_aligned)

    return (y_min_new, x_min_new, y_max_new, x_max_new)


def get_bbox_from_mask(mask: torch.Tensor, padding: int = 0):
    """
    mask: (B, H, W) float32
    returns: (y_min, x_min, y_max, x_max) or None
    バッチ内の全てのマスクを包含するBBOXを返し、さらに8ピクセルアライメントを行う。
    """
    if len(mask.shape) == 4:
        mask = mask.squeeze(1)

    # バッチ全体の全マスク箇所を取得
    ys, xs = torch.where(mask > 0.5)[-2:]
    if len(ys) == 0:
        return None

    y_min, x_min = int(ys.min().item()), int(xs.min().item())
    y_max, x_max = int(ys.max().item()), int(xs.max().item())

    # パディングの適用
    h, w = mask.shape[1], mask.shape[2]
    y_min = max(0, y_min - padding)
    x_min = max(0, x_min - padding)
    y_max = min(h - 1, y_max + padding)
    x_max = min(w - 1, x_max + padding)

    # 8ピクセルアライメント (VAEのダウンサンプリングに合わせる)
    h_c = y_max - y_min + 1
    w_c = x_max - x_min + 1

    h_aligned = ((h_c + 7) // 8) * 8
    w_aligned = ((w_c + 7) // 8) * 8

    dh = h_aligned - h_c
    dw = w_aligned - w_c

    y_min = max(0, y_min - dh // 2)
    y_max = y_min + h_aligned - 1
    if y_max >= h:
        y_max = h - 1
        y_min = max(0, h - h_aligned)

    x_min = max(0, x_min - dw // 2)
    x_max = x_min + w_aligned - 1
    if x_max >= w:
        x_max = w - 1
        x_min = max(0, w - w_aligned)

    return (y_min, x_min, y_max, x_max)


def crop_with_padding(image: torch.Tensor, bbox: tuple):
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

    # デバイスの統一 (基準はオリジナル画像)
    device = result.device

    # 対象領域のマスクを抽出
    crop_mask = mask[:, y_min:y_max+1, x_min:x_max+1].to(device)
    if len(crop_mask.shape) == 3:
        crop_mask = crop_mask.unsqueeze(-1)  # (B, H_c, W_c, 1)

    target_h = y_max - y_min + 1
    target_w = x_max - x_min + 1

    # 処理済みクロップ画像のサイズが対象領域と異なる場合、リサイズする
    if cropped.shape[1] != target_h or cropped.shape[2] != target_w:
        cropped = F.interpolate(cropped.permute(0, 3, 1, 2), size=(target_h, target_w), mode="bilinear").permute(0, 2, 3, 1)

    # クロップ画像のデバイスを合わせる
    cropped = cropped.to(device)

    # フェザリング（簡易的な境界ぼかし）をマスクに適用
    if feather > 0:
        feathered_mask = SAXNoiseEngine.gaussian_blur(crop_mask.permute(0, 3, 1, 2), float(feather) / 3.0)
        crop_mask = feathered_mask.permute(0, 2, 3, 1)

    # ブレンド実行
    target_area = result[:, y_min:y_max+1, x_min:x_max+1, :]
    blended_area = target_area * (1.0 - crop_mask) + cropped * crop_mask
    result[:, y_min:y_max+1, x_min:x_max+1, :] = torch.clamp(blended_area, 0.0, 1.0)

    return result


# ---------------------------------------------------------------------------
# SAX_Bridge_Detailer ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Detailer:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "denoise": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 1.0, "step": 0.01}),
                "denoise_decay": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "cycle": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
                "noise_mask_feather": ("INT", {"default": 5, "min": 0, "max": 100, "step": 1}),
                "blend_feather": ("INT", {"default": 5, "min": 0, "max": 100, "step": 1}),
                "crop_factor": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 10.0, "step": 0.1}),
                "context_blur_sigma": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 64.0, "step": 0.5,
                                                  "tooltip": "マスク境界付近のコンテキスト領域をぼかしてテキスト崩れを抑制する。0=無効"}),
                "context_blur_radius": ("INT", {"default": 48, "min": 0, "max": 256, "step": 4,
                                                "tooltip": "ぼかし対象をマスク境界から何px外側のリングに限定するか。0=全コンテキスト"}),
            },
            "optional": {
                "mask": ("MASK",),
                "positive_prompt": ("STRING", {"multiline": True}),
            }
        }

    RETURN_TYPES = ("PIPE_LINE", "IMAGE")
    RETURN_NAMES = ("PIPE", "IMAGE")
    FUNCTION = "do_detail_core"
    CATEGORY = "SAX/Bridge/Detailer"

    def do_detail_core(self, pipe, denoise, denoise_decay, cycle, noise_mask_feather, blend_feather, crop_factor,
                       context_blur_sigma, context_blur_radius, mask=None, positive_prompt=None):
        # 1. パイプからの抽出
        model = pipe.get("model")
        clip = pipe.get("clip")
        vae = pipe.get("vae")
        images = pipe.get("images")
        seed = pipe.get("seed", 0)

        loader_settings = pipe.get("loader_settings", {})
        steps = max(1, loader_settings.get("steps", 20))
        cfg = loader_settings.get("cfg", 8.0)
        sampler_name = loader_settings.get("sampler_name", "euler")
        scheduler_name = loader_settings.get("scheduler", "normal")

        positive = pipe.get("positive")
        negative = pipe.get("negative")

        if model is None or images is None or vae is None or positive is None or negative is None:
            return (pipe, images)

        # 2. プロンプトの上書き対応
        if positive_prompt and clip is not None:
            encode_node = nodes.CLIPTextEncode()
            positive = encode_node.encode(clip, positive_prompt)[0]

        # 3. マスク準備
        if mask is None:
            b, h, w, c = images.shape
            mask = torch.ones((b, h, w), dtype=torch.float32, device=images.device)
        elif mask.shape[1] != images.shape[1] or mask.shape[2] != images.shape[2]:
            # マスクを画像サイズに合わせてリサイズ（座標系ずれを防ぐ）
            mask = F.interpolate(
                mask.unsqueeze(1).float(),
                size=(images.shape[1], images.shape[2]),
                mode="bilinear",
                align_corners=False,
            ).squeeze(1)

        # 4. バウンディングボックスの算出
        # tight_bbox: マスクの最小外接矩形、context_bbox: crop_factorで拡張したコンテキスト領域
        tight_bbox = get_bbox_from_mask(mask, padding=0)
        if tight_bbox is None:
            return (pipe, images)

        _, image_h, image_w, _ = images.shape
        bbox = expand_bbox_by_factor(tight_bbox, image_h, image_w, crop_factor)

        y_min, x_min, y_max, x_max = bbox
        mask_in_bbox = mask[:, y_min:y_max+1, x_min:x_max+1]

        # DifferentialDiffusion: ループ前に1回だけ clone して設定
        sample_model = model
        if noise_mask_feather > 0 and _HAS_DIFF_DIFFUSION:
            sample_model = model.clone()
            sample_model.set_model_denoise_mask_function(
                lambda sigma, denoise_mask, extra_options: _diff_diffusion.DifferentialDiffusion.forward(
                    sigma, denoise_mask, extra_options, strength=1.0
                )
            )

        # 繰り返し処理
        result_images = images
        for i in range(cycle):
            # 5. クロップ (更新された result_images から切り出す)
            cropped_images = crop_with_padding(result_images, bbox)

            # 5.5. コンテキスト境界ぼかし（マスク近傍のテキスト崩れ抑制）
            if context_blur_sigma > 0:
                crop_rgb = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
                crop_rgb = blur_context_boundary(crop_rgb, mask_in_bbox, context_blur_sigma, context_blur_radius)
                cropped_images = torch.cat([crop_rgb.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3)

            # 6. VAE Encode
            t = vae.encode(cropped_images[:,:,:,:3])

            # 7. KSampler 実行
            current_seed = seed + i
            current_denoise = denoise * max(0.0, 1.0 - i * denoise_decay / cycle)

            # noise_mask: マスク外ピクセルをlatent空間で保護し周囲コンテキストとして使わせる
            # mask_in_bbox (B, h_c, w_c) → latent解像度 (B, h_c/8, w_c/8) に変換
            h_lat, w_lat = t.shape[2], t.shape[3]
            noise_mask = F.interpolate(
                mask_in_bbox.unsqueeze(1).float().to(t.device),
                size=(h_lat, w_lat),
                mode="bilinear",
                align_corners=False,
            ).squeeze(1)

            # noise_maskをfeathering: マスク境界を滑らかにして境界崩壊を防ぐ
            if noise_mask_feather > 0:
                noise_mask = SAXNoiseEngine.gaussian_blur(
                    noise_mask.unsqueeze(1), float(noise_mask_feather) / 3.0
                ).squeeze(1).clamp(0.0, 1.0)

            samples_dict = {"samples": t, "noise_mask": noise_mask}

            sampler = nodes.common_ksampler(
                sample_model, current_seed, steps, cfg, sampler_name, scheduler_name,
                positive, negative, samples_dict,
                denoise=current_denoise
            )
            samples = sampler[0]["samples"]

            # 8. VAE Decode
            decoded_images = vae.decode(samples)

            # 9. Uncrop and Blend
            result_images = uncrop_and_blend(result_images, decoded_images, mask, bbox, feather=blend_feather)

        # 10. パイプ更新
        new_pipe = pipe.copy()
        new_pipe["images"] = result_images
        new_pipe["positive"] = positive

        return (new_pipe, result_images)


# ---------------------------------------------------------------------------
# SAX_Bridge_Detailer_Enhanced ノード
# ---------------------------------------------------------------------------

class SAX_Bridge_Detailer_Enhanced:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "denoise": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 1.0, "step": 0.01}),
                "denoise_decay": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "cycle": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
                "noise_mask_feather": ("INT", {"default": 5, "min": 0, "max": 100, "step": 1}),
                "blend_feather": ("INT", {"default": 5, "min": 0, "max": 100, "step": 1}),
                "crop_factor": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 10.0, "step": 0.1}),
                # Latent Enhancement
                "latent_noise_intensity": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 2.0, "step": 0.01}),
                "noise_type": (["gaussian", "uniform"],),
                # Shadow Enhancement
                "shadow_enhance": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "shadow_decay": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.05}),
                # Edge Enhancement
                "edge_weight": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "edge_blur_sigma": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1}),
                # Context Blur
                "context_blur_sigma": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 64.0, "step": 0.5,
                                                  "tooltip": "マスク境界付近のコンテキスト領域をぼかしてテキスト崩れを抑制する。0=無効"}),
                "context_blur_radius": ("INT", {"default": 48, "min": 0, "max": 256, "step": 4,
                                                "tooltip": "ぼかし対象をマスク境界から何px外側のリングに限定するか。0=全コンテキスト"}),
            },
            "optional": {
                "mask": ("MASK",),
                "positive_prompt": ("STRING", {"multiline": True}),
            }
        }

    RETURN_TYPES = ("PIPE_LINE", "IMAGE")
    RETURN_NAMES = ("PIPE", "IMAGE")
    FUNCTION = "do_enhanced_detail"
    CATEGORY = "SAX/Bridge/Detailer"

    def do_enhanced_detail(self, pipe, denoise, denoise_decay, cycle, noise_mask_feather, blend_feather, crop_factor,
                           latent_noise_intensity, noise_type,
                           shadow_enhance, shadow_decay, edge_weight, edge_blur_sigma,
                           context_blur_sigma, context_blur_radius,
                           mask=None, positive_prompt=None):
        model = pipe.get("model")
        clip = pipe.get("clip")
        vae = pipe.get("vae")
        images = pipe.get("images")
        seed = pipe.get("seed", 0)
        loader_settings = pipe.get("loader_settings", {})
        steps = max(1, loader_settings.get("steps", 20))
        cfg = loader_settings.get("cfg", 8.0)
        sampler_name = loader_settings.get("sampler_name", "euler")
        scheduler_name = loader_settings.get("scheduler", "normal")
        positive = pipe.get("positive")
        negative = pipe.get("negative")

        if model is None or images is None or vae is None or positive is None or negative is None:
            return (pipe, images)

        if positive_prompt and clip is not None:
            encode_node = nodes.CLIPTextEncode()
            positive = encode_node.encode(clip, positive_prompt)[0]

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
            return (pipe, images)

        _, image_h, image_w, _ = images.shape
        bbox = expand_bbox_by_factor(tight_bbox, image_h, image_w, crop_factor)

        y_min, x_min, y_max, x_max = bbox
        mask_in_bbox = mask[:, y_min:y_max+1, x_min:x_max+1]

        # DifferentialDiffusion: ループ前に1回だけ clone して設定
        sample_model = model
        if noise_mask_feather > 0 and _HAS_DIFF_DIFFUSION:
            sample_model = model.clone()
            sample_model.set_model_denoise_mask_function(
                lambda sigma, denoise_mask, extra_options: _diff_diffusion.DifferentialDiffusion.forward(
                    sigma, denoise_mask, extra_options, strength=1.0
                )
            )

        # 繰り返し処理
        result_images = images
        for i in range(cycle):
            current_seed = seed + i
            current_denoise = denoise * max(0.0, 1.0 - i * denoise_decay / cycle)

            # クロップ
            cropped_images = crop_with_padding(result_images, bbox)

            # 暗部ディテール強調（輝度感応grain、VAE Encode前に適用）
            if shadow_enhance > 0:
                current_shadow = shadow_enhance * max(0.0, 1.0 - i * shadow_decay / cycle)
                if current_shadow > 0:
                    crop_rgb = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
                    luminance = 0.299 * crop_rgb[:, 0:1] + 0.587 * crop_rgb[:, 1:2] + 0.114 * crop_rgb[:, 2:3]
                    grain_weight = 1.0 - (luminance * 0.8)
                    generator = torch.Generator(device='cpu')
                    generator.manual_seed(current_seed + 10000)
                    grain = torch.randn(crop_rgb.shape, generator=generator, dtype=crop_rgb.dtype, device='cpu').to(crop_rgb.device)
                    crop_mask_2d = mask_in_bbox.unsqueeze(1).float().to(crop_rgb.device)
                    crop_rgb = torch.clamp(crop_rgb + grain * current_shadow * grain_weight * crop_mask_2d, 0.0, 1.0)
                    cropped_images = torch.cat([crop_rgb.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3)

            # エッジ強調（アンシャープマスク、VAE Encode前に適用）
            if edge_weight > 0:
                rgb_bchw = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
                rgb_bchw = unsharp_mask(rgb_bchw, edge_weight, edge_blur_sigma)
                cropped_images = torch.cat([rgb_bchw.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3)

            # コンテキスト境界ぼかし（マスク近傍のテキスト崩れ抑制）
            if context_blur_sigma > 0:
                crop_rgb = cropped_images[:, :, :, :3].permute(0, 3, 1, 2)
                crop_rgb = blur_context_boundary(crop_rgb, mask_in_bbox, context_blur_sigma, context_blur_radius)
                cropped_images = torch.cat([crop_rgb.permute(0, 2, 3, 1), cropped_images[:, :, :, 3:]], dim=3)

            # VAE Encode
            t = vae.encode(cropped_images[:, :, :, :3])

            # latent解像度でのマスク準備
            h_lat, w_lat = t.shape[2], t.shape[3]
            noise_mask = F.interpolate(
                mask_in_bbox.unsqueeze(1).float().to(t.device),
                size=(h_lat, w_lat),
                mode="bilinear",
                align_corners=False,
            ).squeeze(1)

            # Latent Noise Injection（マスク領域のみに注入）
            if latent_noise_intensity > 0:
                generator = torch.Generator(device='cpu')
                generator.manual_seed(current_seed)
                if noise_type == "gaussian":
                    lat_noise = torch.randn(t.shape, generator=generator, dtype=t.dtype, device='cpu')
                else:
                    lat_noise = (torch.rand(t.shape, generator=generator, dtype=t.dtype, device='cpu') * 2.0 - 1.0)
                lat_noise = lat_noise.to(device=t.device)
                t = t + (lat_noise * latent_noise_intensity * noise_mask.unsqueeze(1))

            # noise_maskをfeathering: マスク境界を滑らかにして境界崩壊を防ぐ
            if noise_mask_feather > 0:
                noise_mask = SAXNoiseEngine.gaussian_blur(
                    noise_mask.unsqueeze(1), float(noise_mask_feather) / 3.0
                ).squeeze(1).clamp(0.0, 1.0)

            samples_dict = {"samples": t, "noise_mask": noise_mask}

            # KSampler 実行
            sampler = nodes.common_ksampler(
                sample_model, current_seed, steps, cfg, sampler_name, scheduler_name,
                positive, negative, samples_dict,
                denoise=current_denoise
            )
            samples = sampler[0]["samples"]

            # VAE Decode → Uncrop and Blend
            decoded_images = vae.decode(samples)
            result_images = uncrop_and_blend(result_images, decoded_images, mask, bbox, feather=blend_feather)

        new_pipe = pipe.copy()
        new_pipe["images"] = result_images
        new_pipe["positive"] = positive
        return (new_pipe, result_images)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Detailer": SAX_Bridge_Detailer,
    "SAX_Bridge_Detailer_Enhanced": SAX_Bridge_Detailer_Enhanced,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Detailer": "SAX Detailer",
    "SAX_Bridge_Detailer_Enhanced": "SAX Enhanced Detailer",
}
