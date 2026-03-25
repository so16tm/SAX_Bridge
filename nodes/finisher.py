"""
SAX_Bridge_Finisher — イラスト仕上げノード

Detailer / Upscaler の後に配置し、最終画像にポストエフェクトを適用する。
すべての効果は 0 でバイパスされるため、不要な効果は無効化できる。
"""
import torch
import torch.nn.functional as F

from .noise import SAXNoiseEngine
from .io_types import PipeLine


# ---------------------------------------------------------------------------
# Smooth: 帯域選択スムージング（高周波抑制）
# ---------------------------------------------------------------------------
def _apply_smooth(rgb: torch.Tensor, strength: float, sigma: float = 1.0) -> torch.Tensor:
    """高周波（ジャギー・過剰エッジ）を strength 分抑制する。(B, C, H, W)"""
    low = SAXNoiseEngine.gaussian_blur(rgb, sigma)
    high = rgb - low
    return low + high * (1.0 - strength)


# ---------------------------------------------------------------------------
# Bloom: 明部からの光の滲み
# ---------------------------------------------------------------------------
def _apply_bloom(rgb: torch.Tensor, intensity: float, threshold: float = 0.7,
                 radius: float = 8.0) -> torch.Tensor:
    """
    明部を抽出 → 大きくぼかし → 加算合成で光の滲みを表現する。(B, C, H, W)

    intensity  : ブルームの強さ (0=無効)
    threshold  : 抽出する明度の閾値 (0.0-1.0)
    radius     : 光の滲みの広がり（ぼかし sigma）
    """
    # 明部抽出: threshold 以上の輝度を持つ領域
    luminance = 0.299 * rgb[:, 0:1] + 0.587 * rgb[:, 1:2] + 0.114 * rgb[:, 2:3]
    bright_mask = (luminance - threshold).clamp(0.0, 1.0) / (1.0 - threshold + 1e-6)
    bright = rgb * bright_mask

    # 大きくぼかして光の滲みを作る
    glow = SAXNoiseEngine.gaussian_blur(bright, radius)

    # Screen 合成: 1 - (1 - base) * (1 - glow * intensity)
    return 1.0 - (1.0 - rgb) * (1.0 - glow * intensity)


# ---------------------------------------------------------------------------
# Vignette: 画面端の減光
# ---------------------------------------------------------------------------
def _apply_vignette(rgb: torch.Tensor, strength: float) -> torch.Tensor:
    """画面端を暗くして視線を中央に集める。(B, C, H, W)"""
    _, _, h, w = rgb.shape
    # 中心からの距離マップ（正規化）
    y = torch.linspace(-1, 1, h, device=rgb.device, dtype=rgb.dtype)
    x = torch.linspace(-1, 1, w, device=rgb.device, dtype=rgb.dtype)
    yy, xx = torch.meshgrid(y, x, indexing="ij")
    dist = (xx * xx + yy * yy).sqrt()
    # 減光マスク: 中心=1.0, 端=1.0-strength
    vignette = (1.0 - strength * dist.clamp(0.0, 1.0)).unsqueeze(0).unsqueeze(0)
    return rgb * vignette


# ---------------------------------------------------------------------------
# Color Temperature: 色温度シフト
# ---------------------------------------------------------------------------
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


def _apply_color_temp(rgb: torch.Tensor, temperature: float) -> torch.Tensor:
    """
    色温度を暖色(+)/寒色(-)にシフトする。(B, C, H, W)
    temperature: -1.0(寒色)〜+1.0(暖色), 0=無効
    """
    t = temperature * 0.1  # 控えめにスケーリング
    # 暖色: R+, B-  / 寒色: R-, B+
    r = (rgb[:, 0:1] + t).clamp(0.0, 1.0)
    g = rgb[:, 1:2]
    b = (rgb[:, 2:3] - t).clamp(0.0, 1.0)
    return torch.cat([r, g, b], dim=1)


# ---------------------------------------------------------------------------
# SAX_Bridge_Finisher ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Finisher:
    """
    画像にポストエフェクトを適用する仕上げノード。
    Detailer / Upscaler の後、Output の前に配置する。
    すべてのパラメータが 0 の場合は何もせずパススルーする。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                # Smooth
                "smooth": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                     "tooltip": "High-frequency smoothing. Reduces jaggies and harsh edges. 0=off, 0.1-0.3=recommended."}),
                # Bloom
                "bloom": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                    "tooltip": "Soft glow from bright areas. 0=off, 0.1-0.3=subtle, 0.5+=dreamy."}),
                "bloom_threshold": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.05,
                                              "tooltip": "Brightness threshold for bloom extraction. Lower=more glow."}),
                "bloom_radius": ("FLOAT", {"default": 8.0, "min": 1.0, "max": 32.0, "step": 1.0,
                                           "tooltip": "Bloom spread radius (gaussian sigma)."}),
                # Vignette
                "vignette": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                       "tooltip": "Edge darkening to draw focus to center. 0=off, 0.2-0.4=subtle."}),
                # Color Temperature
                "color_temp": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05,
                                         "tooltip": "Color temperature shift. Positive=warm, negative=cool. 0=neutral."}),
                # Color Correction
                "color_correction": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                               "tooltip": "Matches color distribution to reference image. 0=off, 0.7-1.0=recommended."}),
            },
            "optional": {
                "reference_image": ("IMAGE", {"tooltip": "Reference image for color correction. If not connected, uses the pipe's pre-detailer image."}),
            },
        }

    RETURN_TYPES = ("PIPE_LINE", "IMAGE")
    RETURN_NAMES = ("PIPE", "IMAGE")
    FUNCTION = "apply_finish"
    CATEGORY = "SAX/Bridge/Enhance"

    def apply_finish(self, pipe, smooth, bloom, bloom_threshold, bloom_radius,
                     vignette, color_temp, color_correction, reference_image=None):
        images = pipe.get("images")
        if images is None:
            return (pipe, None)

        # すべて無効ならパススルー
        if smooth <= 0 and bloom <= 0 and vignette <= 0 and color_temp == 0 and color_correction <= 0:
            return (pipe, images)

        rgb = images[:, :, :, :3].permute(0, 3, 1, 2)  # (B, C, H, W)

        # Color Correction（他の効果より先に適用して元の色調を基準にする）
        if color_correction > 0 and reference_image is not None:
            ref_rgb = reference_image[:, :, :, :3].permute(0, 3, 1, 2)
            rgb = _apply_color_correction(rgb, ref_rgb, color_correction)

        if smooth > 0:
            rgb = _apply_smooth(rgb, smooth)

        if bloom > 0:
            rgb = _apply_bloom(rgb, bloom, bloom_threshold, bloom_radius)

        if vignette > 0:
            rgb = _apply_vignette(rgb, vignette)

        if color_temp != 0:
            rgb = _apply_color_temp(rgb, color_temp)

        rgb = torch.clamp(rgb, 0.0, 1.0)
        result = torch.cat([rgb.permute(0, 2, 3, 1), images[:, :, :, 3:]], dim=3)

        new_pipe = pipe.copy()
        new_pipe["images"] = result
        return (new_pipe, result)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Finisher": SAX_Bridge_Finisher,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Finisher": "SAX Finisher",
}
