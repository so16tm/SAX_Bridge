"""
SAX_Bridge_Finisher — イラスト仕上げノード

Detailer / Upscaler の後に配置し、最終画像にポストエフェクトと画質調整を適用する。
すべての効果は 0 でバイパスされるため、不要な効果は無効化できる。
"""
import torch
import torch.nn.functional as F

from comfy_api.latest import io

from .noise import SAXNoiseEngine
from .io_types import PipeLine


def _apply_color_correction(rgb: torch.Tensor, reference: torch.Tensor, strength: float) -> torch.Tensor:
    """
    画像の色分布を参照画像に合わせる（チャネルごとの mean/std マッチング）。(B, C, H, W)

    rgb       : 補正対象画像
    reference : 参照画像（同じ解像度でなくてもよい）
    strength  : 0.0〜1.0 (0=無補正, 1=完全マッチ)
    """
    eps = 1e-6
    ref_mean = reference.mean(dim=(2, 3), keepdim=True)
    ref_std = reference.std(dim=(2, 3), keepdim=True).clamp(min=eps)
    src_mean = rgb.mean(dim=(2, 3), keepdim=True)
    src_std = rgb.std(dim=(2, 3), keepdim=True).clamp(min=eps)

    corrected = (rgb - src_mean) * (ref_std / src_std) + ref_mean
    return rgb * (1.0 - strength) + corrected * strength


def _apply_smooth(rgb: torch.Tensor, strength: float, sigma: float = 1.0) -> torch.Tensor:
    """高周波（ジャギー・過剰エッジ）を strength 分抑制する。(B, C, H, W)"""
    low = SAXNoiseEngine.gaussian_blur(rgb, sigma)
    high = rgb - low
    return low + high * (1.0 - strength)


def _apply_sharpen(rgb: torch.Tensor, strength: float, sigma: float) -> torch.Tensor:
    """Unsharp Mask シャープ化。(B, C, H, W) float32"""
    if strength <= 0.0:
        return rgb
    kernel_size = max(3, int(6 * sigma + 1) | 1)
    x = torch.arange(kernel_size, dtype=torch.float32, device=rgb.device) - kernel_size // 2
    g = torch.exp(-0.5 * (x / sigma) ** 2)
    g = g / g.sum()
    kernel = (g.unsqueeze(0) * g.unsqueeze(1)).unsqueeze(0).unsqueeze(0)
    kernel = kernel.expand(rgb.shape[1], 1, kernel_size, kernel_size).contiguous()
    blurred = F.conv2d(rgb, kernel, padding=kernel_size // 2, groups=rgb.shape[1])
    return torch.clamp(rgb + strength * (rgb - blurred), 0.0, 1.0)


def _apply_bloom(rgb: torch.Tensor, intensity: float, threshold: float = 0.7,
                 radius: float = 8.0) -> torch.Tensor:
    """
    明部を抽出 → 大きくぼかし → 加算合成で光の滲みを表現する。(B, C, H, W)

    intensity  : ブルームの強さ (0=無効)
    threshold  : 抽出する明度の閾値 (0.0-1.0)
    radius     : 光の滲みの広がり（ぼかし sigma）
    """
    luminance = 0.299 * rgb[:, 0:1] + 0.587 * rgb[:, 1:2] + 0.114 * rgb[:, 2:3]
    bright_mask = (luminance - threshold).clamp(0.0, 1.0) / (1.0 - threshold + 1e-6)
    bright = rgb * bright_mask

    glow = SAXNoiseEngine.gaussian_blur(bright, radius)
    return 1.0 - (1.0 - rgb) * (1.0 - glow * intensity)  # Screen 合成


def _apply_vignette(rgb: torch.Tensor, strength: float) -> torch.Tensor:
    """画面端を暗くして視線を中央に集める。(B, C, H, W)"""
    _, _, h, w = rgb.shape
    y = torch.linspace(-1, 1, h, device=rgb.device, dtype=rgb.dtype)
    x = torch.linspace(-1, 1, w, device=rgb.device, dtype=rgb.dtype)
    yy, xx = torch.meshgrid(y, x, indexing="ij")
    dist = (xx * xx + yy * yy).sqrt()
    vignette = (1.0 - strength * dist.clamp(0.0, 1.0)).unsqueeze(0).unsqueeze(0)
    return rgb * vignette


def _apply_color_temp(rgb: torch.Tensor, temperature: float) -> torch.Tensor:
    """
    色温度を暖色(+)/寒色(-)にシフトする。(B, C, H, W)
    temperature: -1.0(寒色)〜+1.0(暖色), 0=無効
    """
    t = temperature * 0.1  # 控えめにスケーリング
    r = (rgb[:, 0:1] + t).clamp(0.0, 1.0)  # 暖色: R+, B- / 寒色: R-, B+
    g = rgb[:, 1:2]
    b = (rgb[:, 2:3] - t).clamp(0.0, 1.0)
    return torch.cat([r, g, b], dim=1)


def _apply_grayscale(rgb: torch.Tensor) -> torch.Tensor:
    """ITU-R BT.709 グレースケール変換。3 チャネルのまま輝度値に置換する。(B, C, H, W)"""
    # expand_as はストライド0のビューを返すため、呼び出し側 in-place 操作による破壊を防ぐため clone する
    gray = 0.2126 * rgb[:, 0:1] + 0.7152 * rgb[:, 1:2] + 0.0722 * rgb[:, 2:3]
    return gray.expand_as(rgb).clone()


class SAX_Bridge_Finisher(io.ComfyNode):
    """
    画像にポストエフェクトと画質調整を適用する仕上げノード。
    Detailer / Upscaler の後、Output の前に配置する。
    すべてのパラメータが 0 / False の場合は何もせずパススルーする。

    適用順:
      color_correction → smooth → sharpen → bloom → vignette → color_temp → grayscale
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Finisher",
            display_name="SAX Finisher",
            category="SAX/Bridge/Enhance",
            inputs=[
                PipeLine.Input("pipe"),
                io.Image.Input("reference_image", optional=True,
                               tooltip="Reference image for color correction. If not connected, color correction is skipped."),
                io.Float.Input("color_correction", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="Matches color distribution to reference image. 0=off, 0.7-1.0=recommended."),
                io.Float.Input("smooth", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="High-frequency smoothing. Reduces jaggies and harsh edges. 0=off, 0.1-0.3=recommended."),
                io.Float.Input("sharpen_strength", default=0.0, min=0.0, max=2.0, step=0.05,
                               tooltip="Unsharp Mask sharpening strength. 0=off."),
                io.Float.Input("sharpen_sigma", default=1.0, min=0.1, max=5.0, step=0.1,
                               tooltip="Sharpening kernel width. Smaller values affect finer edges and details."),
                io.Float.Input("bloom", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="Soft glow from bright areas. 0=off, 0.1-0.3=subtle, 0.5+=dreamy."),
                io.Float.Input("bloom_threshold", default=0.7, min=0.0, max=1.0, step=0.05,
                               tooltip="Brightness threshold for bloom extraction. Lower=more glow."),
                io.Float.Input("bloom_radius", default=8.0, min=1.0, max=32.0, step=1.0,
                               tooltip="Bloom spread radius (gaussian sigma)."),
                io.Float.Input("vignette", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="Edge darkening to draw focus to center. 0=off, 0.2-0.4=subtle."),
                io.Float.Input("color_temp", default=0.0, min=-1.0, max=1.0, step=0.05,
                               tooltip="Color temperature shift. Positive=warm, negative=cool. 0=neutral."),
                io.Boolean.Input("grayscale", default=False,
                                 tooltip="Convert to grayscale (ITU-R BT.709). Applied last so it overrides color adjustments."),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
                io.Image.Output("IMAGE"),
            ],
        )

    @classmethod
    def execute(cls, pipe, color_correction, smooth, sharpen_strength, sharpen_sigma,
                bloom, bloom_threshold, bloom_radius, vignette, color_temp, grayscale,
                reference_image=None) -> io.NodeOutput:
        images = pipe.get("images")
        if images is None:
            return io.NodeOutput(pipe, None)

        # color_correction は reference_image が無いとスキップされるため、reference_image=None なら無効扱いとする
        color_correction_active = color_correction > 0 and reference_image is not None
        if (smooth <= 0 and sharpen_strength <= 0 and bloom <= 0 and vignette <= 0
                and color_temp == 0 and not color_correction_active and not grayscale):
            return io.NodeOutput(pipe, images)

        rgb = images[:, :, :, :3].permute(0, 3, 1, 2)  # (B, C, H, W)

        # 他の効果より先に適用して元の色調を基準にする
        if color_correction > 0 and reference_image is not None:
            ref_rgb = reference_image[:, :, :, :3].permute(0, 3, 1, 2)
            rgb = _apply_color_correction(rgb, ref_rgb, color_correction)

        if smooth > 0:
            rgb = _apply_smooth(rgb, smooth)

        # smooth で潰したエッジの中から意図したものを再構築する
        if sharpen_strength > 0:
            rgb = _apply_sharpen(rgb, sharpen_strength, sharpen_sigma)

        if bloom > 0:
            rgb = _apply_bloom(rgb, bloom, bloom_threshold, bloom_radius)

        if vignette > 0:
            rgb = _apply_vignette(rgb, vignette)

        if color_temp != 0:
            rgb = _apply_color_temp(rgb, color_temp)

        # 色補正系の後に置かないと色調整が無駄になる
        if grayscale:
            rgb = _apply_grayscale(rgb)

        rgb = torch.clamp(rgb, 0.0, 1.0)
        result = torch.cat([rgb.permute(0, 2, 3, 1), images[:, :, :, 3:]], dim=3)

        new_pipe = pipe.copy()
        new_pipe["images"] = result
        return io.NodeOutput(new_pipe, result)
