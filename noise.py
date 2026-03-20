import torch
import torch.nn.functional as F


# ---------------------------------------------------------------------------
# SAXNoiseEngine: SAXシリーズ共通ノイズエンジン
# ---------------------------------------------------------------------------
class SAXNoiseEngine:
    """
    SAXシリーズ共通のノイズ生成・注入エンジン。
    MaskedImageNoise のロジックを再利用・一般化したもの。
    """

    @staticmethod
    def gaussian_blur(tensor: torch.Tensor, sigma: float) -> torch.Tensor:
        """
        2Dテンソルに対してガウスぼかしを適用する。
        tensor: (B, C, H, W)
        """
        if sigma <= 0:
            return tensor

        device = tensor.device
        kernel_size = int(sigma * 6) + 1
        if kernel_size % 2 == 0: kernel_size += 1
        if kernel_size < 3: kernel_size = 3

        x = torch.arange(kernel_size, dtype=torch.float32, device=device) - kernel_size // 2
        kernel_1d = torch.exp(-(x**2) / (2 * sigma**2))
        kernel_1d = kernel_1d / kernel_1d.sum()

        kernel_1d_h = kernel_1d.view(1, 1, -1, 1)
        kernel_1d_w = kernel_1d.view(1, 1, 1, -1)

        pad = kernel_size // 2

        # チャンネル数に合わせてカーネルを拡張
        channels = tensor.shape[1]
        kernel_1d_h = kernel_1d_h.repeat(channels, 1, 1, 1)
        kernel_1d_w = kernel_1d_w.repeat(channels, 1, 1, 1)

        result = F.conv2d(tensor, kernel_1d_h, padding=(pad, 0), groups=channels)
        result = F.conv2d(result, kernel_1d_w, padding=(0, pad), groups=channels)
        return result

    @staticmethod
    def process_mask(mask: torch.Tensor, shrink: int, blur: float) -> torch.Tensor:
        """
        マスクの収縮(Erosion)とボカシ(Blur)を行う。
        """
        if len(mask.shape) == 3:
            processed_mask = mask.unsqueeze(1)
        elif len(mask.shape) == 2:
            processed_mask = mask.unsqueeze(0).unsqueeze(0)
        else:
            processed_mask = mask

        # Shrink (Erosion)
        if shrink > 0:
            kernel_size = shrink * 2 + 1
            inverted_mask = 1.0 - processed_mask
            dilated_inverted = F.max_pool2d(
                inverted_mask, kernel_size=kernel_size, stride=1, padding=shrink
            )
            processed_mask = 1.0 - dilated_inverted

        # Blur
        if blur > 0:
            processed_mask = SAXNoiseEngine.gaussian_blur(processed_mask, blur)

        # 元のマスクでクランプ（はみ出し防止）
        original_mask = mask.unsqueeze(1) if len(mask.shape) == 3 else mask
        processed_mask = torch.min(processed_mask, original_mask)
        return torch.clamp(processed_mask, 0.0, 1.0)

    @staticmethod
    def generate_noise(shape, noise_type, seed, device, dtype):
        """
        指定された形状と形式でノイズを生成する。
        """
        b, c, h, w = shape
        generator = torch.Generator(device='cpu')
        generator.manual_seed(seed)

        # カラーモードについては現状RGB固定または入力に合わせる
        if noise_type in ["gaussian", "grain"]:
            noise = torch.randn((b, c, h, w), generator=generator, dtype=torch.float32, device='cpu')
        elif noise_type == "uniform":
            noise = torch.rand((b, c, h, w), generator=generator, dtype=torch.float32, device='cpu') * 2.0 - 1.0
        else:
            noise = torch.zeros((b, c, h, w), dtype=torch.float32, device='cpu')

        return noise.to(device=device, dtype=dtype)

    @classmethod
    def apply_noise(cls, image, mask, intensity, noise_type="gaussian", shrink=0, blur=0, seed=0):
        """
        画像に対してマスクベースでノイズを注入する。
        image: (B, H, W, C)
        mask: (B, H, W)
        """
        b, h, w, c = image.shape
        img_tensor = image.permute(0, 3, 1, 2)  # (B, C, H, W)
        device = img_tensor.device
        dtype = img_tensor.dtype

        # マスク処理
        processed_mask = cls.process_mask(mask, shrink, blur)
        if processed_mask.shape[2] != h or processed_mask.shape[3] != w:
            processed_mask = F.interpolate(processed_mask, size=(h, w), mode="bilinear")

        # デバイスの統一
        processed_mask = processed_mask.to(device=device)
        processed_mask = torch.clamp(processed_mask, 0.0, 1.0)

        # ノイズ生成
        noise = cls.generate_noise(img_tensor.shape, noise_type, seed, device, dtype)
        scaled_noise = noise * intensity

        # Grain (粒子) モード時の輝度感応処理
        if noise_type == "grain":
            if img_tensor.shape[1] >= 3:
                luminance = 0.299 * img_tensor[:,0:1] + 0.587 * img_tensor[:,1:2] + 0.114 * img_tensor[:,2:3]
            else:
                luminance = img_tensor[:,0:1]
            # 暗い部分にノイズが乗りやすく、明るい部分は抑える
            grain_weight = 1.0 - (luminance * 0.8)
            scaled_noise = scaled_noise * grain_weight

        # 適用
        result = img_tensor + (scaled_noise * processed_mask)
        result = torch.clamp(result, 0.0, 1.0)

        return result.permute(0, 2, 3, 1)  # (B, H, W, C)


# ---------------------------------------------------------------------------
# SAX_Bridge_Noise_Image ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Noise_Image:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "intensity": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01}),
                "noise_type": (["gaussian", "grain", "uniform"],),
                "color_mode": (["rgb", "grayscale"],),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "mask_shrink": ("INT", {"default": 2, "min": 0, "max": 64, "step": 1}),
                "mask_blur": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 32.0, "step": 0.5}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    FUNCTION = "apply_noise"
    CATEGORY = "SAX/Bridge/Noise"
    DESCRIPTION = "Add various types of noise to masked areas of an image to improve i2i detail and texture. If no mask is provided, noise is applied to the entire image."

    def process_mask(self, mask: torch.Tensor, shrink: int, blur: float) -> torch.Tensor:
        # (B, H, W) -> (B, 1, H, W)
        if len(mask.shape) == 3:
            original_mask = mask.unsqueeze(1)
        elif len(mask.shape) == 2:
            original_mask = mask.unsqueeze(0).unsqueeze(0)
        else:
            original_mask = mask

        device = original_mask.device
        processed_mask = original_mask.clone()

        # Shrink (Erosion)
        if shrink > 0:
            kernel_size = shrink * 2 + 1
            inverted_mask = 1.0 - processed_mask
            dilated_inverted = F.max_pool2d(
                inverted_mask, kernel_size=kernel_size, stride=1, padding=shrink
            )
            processed_mask = 1.0 - dilated_inverted

        # Blur
        if blur > 0:
            kernel_size = int(blur * 6) + 1
            if kernel_size % 2 == 0: kernel_size += 1
            if kernel_size < 3: kernel_size = 3

            sigma = blur
            x = torch.arange(kernel_size, dtype=torch.float32, device=device) - kernel_size // 2
            kernel_1d = torch.exp(-(x**2) / (2 * sigma**2))
            kernel_1d = kernel_1d / kernel_1d.sum()

            kernel_1d_h = kernel_1d.view(1, 1, -1, 1)
            kernel_1d_w = kernel_1d.view(1, 1, 1, -1)

            pad = kernel_size // 2
            processed_mask = F.conv2d(processed_mask, kernel_1d_h, padding=(pad, 0))
            processed_mask = F.conv2d(processed_mask, kernel_1d_w, padding=(0, pad))

        # Clamp to avoid leaking outside original mask
        processed_mask = torch.min(processed_mask, original_mask)
        processed_mask = torch.clamp(processed_mask, min=0.0, max=1.0)

        return processed_mask

    def generate_noise(self, shape, noise_type, color_mode, seed, device, dtype):
        b, c, h, w = shape
        generator = torch.Generator(device='cpu')
        generator.manual_seed(seed)

        noise_channels = 1 if color_mode == "grayscale" else c
        noise_shape = (b, noise_channels, h, w)

        if noise_type == "gaussian" or noise_type == "grain":
            noise = torch.randn(noise_shape, generator=generator, dtype=torch.float32, device='cpu')
        elif noise_type == "uniform":
            noise = torch.rand(noise_shape, generator=generator, dtype=torch.float32, device='cpu') * 2.0 - 1.0
        else:
            noise = torch.zeros(noise_shape, dtype=torch.float32, device='cpu')

        noise = noise.to(device=device, dtype=dtype)
        if noise_channels == 1 and c > 1:
            noise = noise.expand(-1, c, -1, -1)

        return noise

    def apply_noise(self, image, intensity, noise_type, color_mode, seed, mask_shrink, mask_blur, mask=None):
        b, h, w, c = image.shape
        img_tensor = image.permute(0, 3, 1, 2)  # (B, C, H, W)
        device = img_tensor.device
        dtype = img_tensor.dtype

        if mask is not None:
            processed_mask = self.process_mask(mask, shrink=mask_shrink, blur=mask_blur)
            if processed_mask.shape[2] != h or processed_mask.shape[3] != w:
                processed_mask = F.interpolate(processed_mask, size=(h, w), mode="bilinear")
                processed_mask = torch.clamp(processed_mask, min=0.0, max=1.0)

            if processed_mask.shape[0] < b:
                last_mask = processed_mask[-1:]
                repeats = b - processed_mask.shape[0]
                processed_mask = torch.cat([processed_mask, last_mask.expand(repeats, -1, -1, -1)], dim=0)
            elif processed_mask.shape[0] > b:
                processed_mask = processed_mask[:b]
        else:
            # マスクがない場合は全域（1.0）を適用
            processed_mask = torch.ones((b, 1, h, w), device=device, dtype=dtype)

        noise = self.generate_noise(img_tensor.shape, noise_type, color_mode, seed, device, dtype)
        scaled_noise = noise * intensity

        if noise_type == "grain":
            if img_tensor.shape[1] >= 3:
                luminance = 0.299 * img_tensor[:,0:1] + 0.587 * img_tensor[:,1:2] + 0.114 * img_tensor[:,2:3]
            else:
                luminance = img_tensor[:,0:1]
            grain_weight = 1.0 - (luminance * 0.8)
            scaled_noise = scaled_noise * grain_weight

        result = img_tensor + (scaled_noise * processed_mask)
        result = torch.clamp(result, min=0.0, max=1.0)
        result_out = result.permute(0, 2, 3, 1)

        return (result_out,)


# ---------------------------------------------------------------------------
# SAX_Bridge_Noise_Latent ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Noise_Latent:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "samples": ("LATENT",),
                "intensity": ("FLOAT", {"default": 0.05, "min": 0.0, "max": 2.0, "step": 0.01}),
                "noise_type": (["gaussian", "uniform"],),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "mask_shrink": ("INT", {"default": 1, "min": 0, "max": 16, "step": 1}),
                "mask_blur": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 16.0, "step": 0.5}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("SAMPLES",)
    FUNCTION = "apply_noise"
    CATEGORY = "SAX/Bridge/Noise"
    DESCRIPTION = "Add noise directly to masked areas of a latent to robustly improve i2i detail and texture. If no mask is provided, noise is applied to the entire latent."

    def apply_noise(self, samples, intensity, noise_type, seed, mask_shrink, mask_blur, mask=None):
        latent_tensor = samples["samples"].clone()
        b, c, h, w = latent_tensor.shape
        device = latent_tensor.device
        dtype = latent_tensor.dtype

        if mask is not None:
            img_noise_helper = SAX_Bridge_Noise_Image()
            processed_mask = img_noise_helper.process_mask(mask, shrink=mask_shrink, blur=mask_blur)

            # Latent空間のサイズ (h, w) に合わせてリサイズ
            if processed_mask.shape[2] != h or processed_mask.shape[3] != w:
                processed_mask = F.interpolate(processed_mask, size=(h, w), mode="area")
                processed_mask = torch.clamp(processed_mask, min=0.0, max=1.0)

            if processed_mask.shape[0] < b:
                last_mask = processed_mask[-1:]
                repeats = b - processed_mask.shape[0]
                processed_mask = torch.cat([processed_mask, last_mask.expand(repeats, -1, -1, -1)], dim=0)
            elif processed_mask.shape[0] > b:
                processed_mask = processed_mask[:b]

            processed_mask = processed_mask.to(device=device, dtype=dtype)
        else:
            processed_mask = torch.ones((b, 1, h, w), device=device, dtype=dtype)

        # ノイズ生成 (Latent形状に合わせて生成)
        generator = torch.Generator(device='cpu')
        generator.manual_seed(seed)

        if noise_type == "gaussian":
            noise = torch.randn(latent_tensor.shape, generator=generator, dtype=torch.float32, device='cpu')
        else:  # uniform
            noise = torch.rand(latent_tensor.shape, generator=generator, dtype=torch.float32, device='cpu') * 2.0 - 1.0

        noise = noise.to(device=device, dtype=dtype)

        # 強度とマスクの適用
        result_tensor = latent_tensor + (noise * intensity * processed_mask)

        new_samples = samples.copy()
        new_samples["samples"] = result_tensor
        return (new_samples,)
