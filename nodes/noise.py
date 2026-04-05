import torch
import torch.nn.functional as F

from comfy_api.latest import io


class SAXNoiseEngine:
    """
    SAXシリーズ共通のノイズ生成・注入エンジン。
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
        戻り値: (B, 1, H, W)
        """
        if len(mask.shape) == 3:
            processed_mask = mask.unsqueeze(1)
        elif len(mask.shape) == 2:
            processed_mask = mask.unsqueeze(0).unsqueeze(0)
        else:
            processed_mask = mask

        original_mask = processed_mask

        # Shrink (Erosion) — separable 1D 分解で O(r) に高速化
        if shrink > 0:
            inverted_mask = 1.0 - processed_mask
            dilated_h = F.max_pool2d(
                inverted_mask, kernel_size=(1, shrink * 2 + 1), stride=1, padding=(0, shrink)
            )
            dilated_inverted = F.max_pool2d(
                dilated_h, kernel_size=(shrink * 2 + 1, 1), stride=1, padding=(shrink, 0)
            )
            processed_mask = 1.0 - dilated_inverted

        # Blur
        if blur > 0:
            processed_mask = SAXNoiseEngine.gaussian_blur(processed_mask, blur)

        # 元のマスクでクランプ（はみ出し防止）
        processed_mask = torch.min(processed_mask, original_mask)
        return torch.clamp(processed_mask, 0.0, 1.0)

    @staticmethod
    def generate_noise(shape, noise_type, seed, device, dtype, color_mode="rgb"):
        """
        指定された形状と形式でノイズを生成する。
        color_mode: "rgb"（チャンネルごと独立）/ "grayscale"（全チャンネル同一）
        """
        b, c, h, w = shape
        generator = torch.Generator(device='cpu')
        generator.manual_seed(seed)

        noise_channels = 1 if color_mode == "grayscale" else c
        noise_shape = (b, noise_channels, h, w)

        if noise_type in ["gaussian", "grain"]:
            noise = torch.randn(noise_shape, generator=generator, dtype=torch.float32, device='cpu')
        elif noise_type == "uniform":
            noise = torch.rand(noise_shape, generator=generator, dtype=torch.float32, device='cpu') * 2.0 - 1.0
        else:
            noise = torch.zeros(noise_shape, dtype=torch.float32, device='cpu')

        noise = noise.to(device=device, dtype=dtype)
        if noise_channels == 1 and c > 1:
            noise = noise.expand(-1, c, -1, -1)

        return noise

    @staticmethod
    def _adjust_mask_batch(processed_mask: torch.Tensor, b: int) -> torch.Tensor:
        """マスクのバッチ数を画像/Latentのバッチ数に合わせる"""
        if processed_mask.shape[0] < b:
            repeats = b - processed_mask.shape[0]
            processed_mask = torch.cat(
                [processed_mask, processed_mask[-1:].expand(repeats, -1, -1, -1)], dim=0
            )
        elif processed_mask.shape[0] > b:
            processed_mask = processed_mask[:b]
        return processed_mask

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

        processed_mask = cls.process_mask(mask, shrink, blur)
        if processed_mask.shape[2] != h or processed_mask.shape[3] != w:
            processed_mask = F.interpolate(
                processed_mask, size=(h, w), mode="bilinear", align_corners=False
            )
        processed_mask = processed_mask.to(device=device)
        processed_mask = torch.clamp(processed_mask, 0.0, 1.0)

        noise = cls.generate_noise(img_tensor.shape, noise_type, seed, device, dtype)
        scaled_noise = noise * intensity

        if noise_type == "grain":
            if img_tensor.shape[1] >= 3:
                luminance = 0.299 * img_tensor[:,0:1] + 0.587 * img_tensor[:,1:2] + 0.114 * img_tensor[:,2:3]
            else:
                luminance = img_tensor[:,0:1]
            grain_weight = 1.0 - (luminance * 0.8)
            scaled_noise = scaled_noise * grain_weight

        result = img_tensor + (scaled_noise * processed_mask)
        result = torch.clamp(result, 0.0, 1.0)

        return result.permute(0, 2, 3, 1)  # (B, H, W, C)


class SAX_Bridge_Noise_Image(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Noise_Image",
            display_name="SAX Image Noise",
            category="SAX/Bridge/Option",
            description="Standalone utility: adds various types of noise to masked areas of an image. Designed to be combined with other custom nodes or a plain KSampler for i2i workflows. For noise injection within SAX Detailer, use SAX Enhanced Detailer's latent_noise_intensity instead. If no mask is provided, noise is applied to the entire image.",
            inputs=[
                io.Image.Input("image"),
                io.Float.Input("intensity", default=0.15, min=0.0, max=1.0, step=0.01),
                io.Combo.Input("noise_type", options=["gaussian", "grain", "uniform"]),
                io.Combo.Input("color_mode", options=["rgb", "grayscale"]),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff),
                io.Int.Input("mask_shrink", default=2, min=0, max=64, step=1),
                io.Float.Input("mask_blur", default=0.0, min=0.0, max=32.0, step=0.5),
                io.Mask.Input("mask", optional=True),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
            ],
        )

    @classmethod
    def execute(cls, image, intensity, noise_type, color_mode, seed, mask_shrink, mask_blur, mask=None) -> io.NodeOutput:
        b, h, w, c = image.shape
        img_tensor = image.permute(0, 3, 1, 2)  # (B, C, H, W)
        device = img_tensor.device
        dtype = img_tensor.dtype

        if mask is not None:
            processed_mask = SAXNoiseEngine.process_mask(mask, shrink=mask_shrink, blur=mask_blur)
            if processed_mask.shape[2] != h or processed_mask.shape[3] != w:
                processed_mask = F.interpolate(
                    processed_mask, size=(h, w), mode="bilinear", align_corners=False
                )
                processed_mask = torch.clamp(processed_mask, min=0.0, max=1.0)
            processed_mask = SAXNoiseEngine._adjust_mask_batch(processed_mask, b)
        else:
            processed_mask = torch.ones((b, 1, h, w), device=device, dtype=dtype)

        processed_mask = processed_mask.to(device=device)

        noise = SAXNoiseEngine.generate_noise(
            img_tensor.shape, noise_type, seed, device, dtype, color_mode=color_mode
        )
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

        return io.NodeOutput(result.permute(0, 2, 3, 1))


class SAX_Bridge_Noise_Latent(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Noise_Latent",
            display_name="SAX Latent Noise",
            category="SAX/Bridge/Option",
            description="Standalone utility: adds noise directly to masked areas of a latent. Designed to be combined with other custom nodes or a plain KSampler for i2i workflows. For noise injection within SAX Detailer, use SAX Enhanced Detailer's latent_noise_intensity instead. If no mask is provided, noise is applied to the entire latent.",
            inputs=[
                io.Latent.Input("samples"),
                io.Float.Input("intensity", default=0.05, min=0.0, max=2.0, step=0.01),
                io.Combo.Input("noise_type", options=["gaussian", "uniform"]),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff),
                io.Int.Input("mask_shrink", default=1, min=0, max=16, step=1),
                io.Float.Input("mask_blur", default=1.0, min=0.0, max=16.0, step=0.5),
                io.Mask.Input("mask", optional=True),
            ],
            outputs=[
                io.Latent.Output("SAMPLES"),
            ],
        )

    @classmethod
    def execute(cls, samples, intensity, noise_type, seed, mask_shrink, mask_blur, mask=None) -> io.NodeOutput:
        latent_tensor = samples["samples"].clone()
        b, c, h, w = latent_tensor.shape
        device = latent_tensor.device
        dtype = latent_tensor.dtype

        if mask is not None:
            processed_mask = SAXNoiseEngine.process_mask(mask, shrink=mask_shrink, blur=mask_blur)
            if processed_mask.shape[2] != h or processed_mask.shape[3] != w:
                processed_mask = F.interpolate(processed_mask, size=(h, w), mode="area")
                processed_mask = torch.clamp(processed_mask, min=0.0, max=1.0)
            processed_mask = SAXNoiseEngine._adjust_mask_batch(processed_mask, b)
            processed_mask = processed_mask.to(device=device, dtype=dtype)
        else:
            processed_mask = torch.ones((b, 1, h, w), device=device, dtype=dtype)

        noise = SAXNoiseEngine.generate_noise(latent_tensor.shape, noise_type, seed, device, dtype)
        result_tensor = latent_tensor + (noise * intensity * processed_mask)

        new_samples = samples.copy()
        new_samples["samples"] = result_tensor
        return io.NodeOutput(new_samples)
