"""
SAX_Bridge_Guidance — CFG ガイダンス強化ノード

信号処理の基本手法（帯域分離ゲイン制御・ソフトクリッピング）と
Attention ベースのガイダンス（PAG）を ComfyUI のサンプラーフックに適用する。

参考文献:
  - 帯域分離: 古典的ハイパス/ローパスフィルタ分解
  - ソフトクリッピング: tanh 圧縮（信号処理の標準手法）
  - PAG: arXiv:2403.17377 (Ahn et al. 2024)
"""
import torch
import torch.nn.functional as F

import comfy.model_patcher
import comfy.samplers

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
_POST_FDG_LOW_GAIN_RANGE = (1.0, 0.85)
_POST_FDG_HIGH_GAIN_RANGE = (1.0, 1.15)
# PAG スケール: ComfyUI デフォルト 3.0、strength=0.5 で 3.0 になるよう設定
_PAG_SCALE_RANGE = (0.0, 6.0)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _strength_to_params(strength: float):
    """0.0〜1.0 の strength を各パラメータに変換する。"""
    t = max(0.0, min(1.0, strength))
    return {
        "agc_tau": _lerp(*_AGC_TAU_RANGE, t),
        "fdg_low_gain": _lerp(*_FDG_LOW_GAIN_RANGE, t),
        "fdg_high_gain": _lerp(*_FDG_HIGH_GAIN_RANGE, t),
        "post_fdg_low_gain": _lerp(*_POST_FDG_LOW_GAIN_RANGE, t),
        "post_fdg_high_gain": _lerp(*_POST_FDG_HIGH_GAIN_RANGE, t),
        "pag_scale": _lerp(*_PAG_SCALE_RANGE, t),
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
# PAG: Perturbed Attention Guidance (post-CFG)
# ---------------------------------------------------------------------------
def _build_pag_post_cfg_function(pag_scale: float):
    """
    Self-Attention を劣化させた推論結果との差分をガイダンスとして加算する。
    CFG スケールに依存せず、CFG=1 でも構造・ディテールを強化できる。

    参考: arXiv:2403.17377, ComfyUI comfy_extras/nodes_pag.py
    """

    def perturbed_attention(q, k, v, extra_options, mask=None):
        return v

    def post_cfg_func(args):
        if pag_scale == 0:
            return args["denoised"]

        model = args["model"]
        cond_pred = args["cond_denoised"]
        cond = args["cond"]
        cfg_result = args["denoised"]
        sigma = args["sigma"]
        model_options = args["model_options"].copy()
        x = args["input"]

        model_options = comfy.model_patcher.set_model_options_patch_replace(
            model_options, perturbed_attention, "attn1", "middle", 0
        )
        (pag,) = comfy.samplers.calc_cond_batch(model, [cond], x, sigma, model_options)

        return cfg_result + (cond_pred - pag) * pag_scale

    return post_cfg_func


# ---------------------------------------------------------------------------
# モデルパッチ適用（detailer.py / SAX_Bridge_Guidance 共通）
# ---------------------------------------------------------------------------
def apply_guidance_to_model(model, guidance_mode: str, guidance_strength: float,
                            pag_strength: float = 0.0):
    """
    guidance_mode / strength / pag_strength に基づいてモデルをパッチする。
    パッチ不要なら None を返す。パッチ済みモデルを返す。

    guidance_mode:
      - off:      何もしない（PAG のみ適用可能）
      - agc:      高 CFG スパイク抑制（sampler_cfg_function）
      - fdg:      帯域分離（高 CFG: sampler_cfg_function）
      - agc+fdg:  上記両方
      - post_fdg: 帯域分離（低 CFG 対応: sampler_post_cfg_function）

    pag_strength:
      - 0.0: PAG 無効
      - > 0: PAG 有効（post_cfg_function として追加、他モードと併用可能）
    """
    has_guidance = guidance_mode != "off" and guidance_strength > 0.0
    has_pag = pag_strength > 0.0

    if not has_guidance and not has_pag:
        return None

    params = _strength_to_params(guidance_strength)
    pag_params = _strength_to_params(pag_strength)
    patched = model.clone()

    # --- CFG / FDG / AGC ---
    if has_guidance:
        if guidance_mode == "post_fdg":
            patched.model_options = comfy.model_patcher.set_model_options_post_cfg_function(
                patched.model_options.copy(),
                _build_post_cfg_function(
                    fdg_low_gain=params["post_fdg_low_gain"],
                    fdg_high_gain=params["post_fdg_high_gain"],
                ),
                disable_cfg1_optimization=True,
            )
        else:
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

    # --- PAG（post-CFG として追加、他モードと併用可能）---
    if has_pag:
        patched.model_options = comfy.model_patcher.set_model_options_post_cfg_function(
            patched.model_options.copy(),
            _build_pag_post_cfg_function(pag_scale=pag_params["pag_scale"]),
            disable_cfg1_optimization=True,
        )

    return patched


# ---------------------------------------------------------------------------
# SAX_Bridge_Guidance ノード
# ---------------------------------------------------------------------------
_ALL_MODES = ["off", "agc", "fdg", "agc+fdg", "post_fdg"]


class SAX_Bridge_Guidance:
    """
    パイプラインのモデルに AGC / FDG / PAG ガイダンス強化を適用する。
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
                    "tooltip": "Effect intensity for AGC/FDG modes. 0.0=no effect, 0.5=moderate, 1.0=maximum."}),
                "pag_strength": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Perturbed Attention Guidance intensity. Works at any CFG. "
                               "0.0=disabled, 0.5=standard (scale=3.0). Can combine with other modes. "
                               "Note: adds one extra forward pass per step."}),
            },
        }

    RETURN_TYPES = ("PIPE_LINE",)
    RETURN_NAMES = ("PIPE",)
    FUNCTION = "apply_guidance"
    CATEGORY = "SAX/Bridge/Enhance"

    def apply_guidance(self, pipe, mode, strength, pag_strength):
        if (mode == "off" or strength <= 0.0) and pag_strength <= 0.0:
            return (pipe,)

        model = pipe.get("model")
        if model is None:
            return (pipe,)

        patched = apply_guidance_to_model(model, mode, strength, pag_strength)
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
