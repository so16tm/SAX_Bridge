"""
SAX_Bridge_Guidance — CFG ガイダンス強化ノード

信号処理の基本手法（帯域分離ゲイン制御・ソフトクリッピング）を
ComfyUI の sampler_cfg_function / sampler_post_cfg_function に適用し、
高 CFG 時の色飽和・スパイク抑制、および低 CFG 時のディテール強調を行う。

参考文献:
  - 帯域分離: 古典的ハイパス/ローパスフィルタ分解
  - ソフトクリッピング: tanh 圧縮（信号処理の標準手法）
"""
import torch
import torch.nn.functional as F

from .io_types import PipeLine


# ---------------------------------------------------------------------------
# ガウシアンカーネル生成（depthwise conv2d 用）
# ---------------------------------------------------------------------------
def _make_gaussian_kernel(radius: int, sigma: float, device, dtype) -> torch.Tensor:
    """(2*radius+1) x (2*radius+1) の正規化済みガウシアンカーネルを生成する。"""
    size = 2 * radius + 1
    coords = torch.arange(size, device=device, dtype=dtype) - radius
    g1d = torch.exp(-coords * coords / (2.0 * sigma * sigma))
    kernel = g1d.unsqueeze(1) * g1d.unsqueeze(0)
    return kernel / kernel.sum()


def _gaussian_blur_latent(x: torch.Tensor, sigma: float, radius: int = 1) -> torch.Tensor:
    """(B, C, H, W) latent テンソルに depthwise ガウシアンぼかしを適用する。"""
    if radius <= 0 or sigma <= 0:
        return x
    kernel = _make_gaussian_kernel(radius, sigma, x.device, x.dtype)
    c = x.shape[1]
    weight = kernel.unsqueeze(0).unsqueeze(0).expand(c, 1, -1, -1)
    return F.conv2d(
        F.pad(x, (radius, radius, radius, radius), mode="reflect"),
        weight,
        padding=0,
        groups=c,
    )


# ---------------------------------------------------------------------------
# AGC: Adaptive Guidance Clipping（tanh ソフトクリッピング）
# ---------------------------------------------------------------------------
def _apply_agc(delta: torch.Tensor, tau: float) -> torch.Tensor:
    """delta を tanh で [-tau, +tau] にソフトクリップする。"""
    return tau * torch.tanh(delta / tau)


# ---------------------------------------------------------------------------
# FDG: Frequency-Decoupled Guidance（帯域分離ゲイン制御）
# ---------------------------------------------------------------------------
def _apply_fdg(
    delta: torch.Tensor,
    low_gain: float,
    high_gain: float,
    sigma: float = 1.0,
    radius: int = 1,
) -> torch.Tensor:
    """delta を低周波/高周波に分離し、独立にゲイン制御する。"""
    low = _gaussian_blur_latent(delta, sigma=sigma, radius=radius)
    high = delta - low
    return low * low_gain + high * high_gain


# ---------------------------------------------------------------------------
# strength → 内部パラメータ自動マッピング
# ---------------------------------------------------------------------------
_AGC_TAU_RANGE = (4.0, 1.5)        # 弱→強: tau が大きいほど緩い
_FDG_LOW_GAIN_RANGE = (1.0, 0.4)   # 弱→強: 1.0=無効、0.4=最大抑制
_FDG_HIGH_GAIN_RANGE = (1.0, 1.6)  # 弱→強: 1.0=無効、1.6=最大強調
# post-CFG 用（denoised 空間）: 毎ステップ累積するため控えめに設定
# strength=0.2 が実用中央値になるよう調整
_POST_FDG_LOW_GAIN_RANGE = (1.0, 0.85)
_POST_FDG_HIGH_GAIN_RANGE = (1.0, 1.15)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _strength_to_params(strength: float):
    """0.0〜1.0 の strength を AGC tau / FDG gain に変換する。"""
    t = max(0.0, min(1.0, strength))
    return {
        "agc_tau": _lerp(*_AGC_TAU_RANGE, t),
        "fdg_low_gain": _lerp(*_FDG_LOW_GAIN_RANGE, t),
        "fdg_high_gain": _lerp(*_FDG_HIGH_GAIN_RANGE, t),
        "post_fdg_low_gain": _lerp(*_POST_FDG_LOW_GAIN_RANGE, t),
        "post_fdg_high_gain": _lerp(*_POST_FDG_HIGH_GAIN_RANGE, t),
    }


# ---------------------------------------------------------------------------
# cfg_function ファクトリ（高 CFG 向け: sampler_cfg_function）
# ---------------------------------------------------------------------------
def _build_cfg_function(
    agc_enable: bool,
    agc_tau: float,
    fdg_enable: bool,
    fdg_low_gain: float,
    fdg_high_gain: float,
    fdg_sigma: float = 1.0,
    fdg_radius: int = 1,
):
    """ComfyUI の sampler_cfg_function に渡すクロージャを生成する。"""

    def cfg_func(args):
        cond = args["cond"]
        uncond = args["uncond"]
        cond_scale = args["cond_scale"]

        delta = cond - uncond

        if agc_enable:
            delta = _apply_agc(delta, agc_tau)

        if fdg_enable:
            delta = _apply_fdg(delta, fdg_low_gain, fdg_high_gain, fdg_sigma, fdg_radius)

        return uncond + cond_scale * delta

    return cfg_func


# ---------------------------------------------------------------------------
# post_cfg_function ファクトリ（低 CFG 向け: sampler_post_cfg_function）
# ---------------------------------------------------------------------------
def _build_post_cfg_function(
    fdg_low_gain: float,
    fdg_high_gain: float,
    fdg_sigma: float = 1.0,
    fdg_radius: int = 1,
):
    """
    CFG 計算後の denoised テンソルに帯域分離を適用する。
    CFG スケールに依存しないため、低 CFG 環境でも効果を発揮する。
    """

    def post_cfg_func(args):
        denoised = args["denoised"]
        low = _gaussian_blur_latent(denoised, sigma=fdg_sigma, radius=fdg_radius)
        high = denoised - low
        return low * fdg_low_gain + high * fdg_high_gain

    return post_cfg_func


# ---------------------------------------------------------------------------
# モデルパッチ適用（detailer.py / SAX_Bridge_Guidance 共通）
# ---------------------------------------------------------------------------
def apply_guidance_to_model(model, guidance_mode: str, guidance_strength: float):
    """
    guidance_mode と strength に基づいてモデルをパッチする。
    パッチ不要なら None を返す。パッチ済みモデルを返す。

    モード:
      - off:      何もしない
      - agc:      高 CFG スパイク抑制（sampler_cfg_function）
      - fdg:      帯域分離（高 CFG: sampler_cfg_function）
      - agc+fdg:  上記両方
      - post_fdg: 帯域分離（低 CFG 対応: sampler_post_cfg_function）
    """
    if guidance_mode == "off" or guidance_strength <= 0.0:
        return None

    params = _strength_to_params(guidance_strength)
    patched = model.clone()

    if guidance_mode == "post_fdg":
        # post-CFG: denoised テンソルに直接適用（CFG スケール非依存）
        import comfy.model_patcher
        patched.model_options = comfy.model_patcher.set_model_options_post_cfg_function(
            patched.model_options.copy(),
            _build_post_cfg_function(
                fdg_low_gain=params["post_fdg_low_gain"],
                fdg_high_gain=params["post_fdg_high_gain"],
            ),
            disable_cfg1_optimization=True,
        )
    else:
        # pre-CFG: delta に適用（従来方式）
        agc_on = guidance_mode in ("agc", "agc+fdg")
        fdg_on = guidance_mode in ("fdg", "agc+fdg")
        patched.set_model_sampler_cfg_function(
            _build_cfg_function(
                agc_enable=agc_on, agc_tau=params["agc_tau"],
                fdg_enable=fdg_on,
                fdg_low_gain=params["fdg_low_gain"],
                fdg_high_gain=params["fdg_high_gain"],
            ),
            disable_cfg1_optimization=True,
        )

    return patched


# ---------------------------------------------------------------------------
# SAX_Bridge_Guidance ノード
# ---------------------------------------------------------------------------
_ALL_MODES = ["off", "agc", "fdg", "agc+fdg", "post_fdg"]


class SAX_Bridge_Guidance:
    """
    パイプラインのモデルに AGC / FDG ガイダンス強化を適用する。
    Detailer・KSampler・Upscaler の前に配置して使う。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "mode": (_ALL_MODES, {
                    "default": "agc+fdg",
                    "tooltip": "off=bypass, agc=spike suppression, fdg=detail emphasis (high CFG), "
                               "agc+fdg=both, post_fdg=detail emphasis (low CFG / low-step LoRA)"}),
                "strength": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Effect intensity. 0.0=no effect, 0.5=moderate, 1.0=maximum."}),
            },
        }

    RETURN_TYPES = ("PIPE_LINE",)
    RETURN_NAMES = ("PIPE",)
    FUNCTION = "apply_guidance"
    CATEGORY = "SAX/Bridge/Enhance"

    def apply_guidance(self, pipe, mode, strength):
        if mode == "off" or strength <= 0.0:
            return (pipe,)

        model = pipe.get("model")
        if model is None:
            return (pipe,)

        patched = apply_guidance_to_model(model, mode, strength)
        if patched is None:
            return (pipe,)

        new_pipe = pipe.copy()
        new_pipe["model"] = patched
        return (new_pipe,)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Guidance": SAX_Bridge_Guidance,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Guidance": "SAX Guidance",
}
