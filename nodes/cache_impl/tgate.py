"""
TGATE方式: Attention KVキャッシュによる高速化実装

原理:
  デノイジングプロセスの前半でcross-attention (attn2) のK/V射影が収束する性質を利用。
  前半ステップでアテンション出力をキャッシュし、後半ステップではキャッシュを再利用して
  K/V計算をスキップする。
"""

import logging
import torch
from typing import Optional
import comfy.model_patcher
import comfy.patcher_extension

logger = logging.getLogger("SAX_Bridge")


class TGateState:
    """デノイジングステップ間のアテンションキャッシュ状態を管理する"""

    def __init__(self, gate_step_percent, start_percent, end_percent, cache_self_attn=False):
        self.gate_step_percent = gate_step_percent
        self.start_percent = start_percent
        self.end_percent = end_percent
        self.cache_self_attn = cache_self_attn

        # タイムステップ値（sigma に変換後）
        self.start_sigma = 0.0
        self.end_sigma = 0.0
        self.gate_sigma = 0.0

        # キャッシュ
        self.cached_attn2_outputs = {}
        self.cached_attn1_outputs = {}

        # ステップ追跡
        self.current_sigma: Optional[float] = None
        self.is_gated = False
        self.is_active = False
        self.cache_ready = False

        # 統計
        self.steps_computed = 0
        self.steps_cached = 0

    def prepare_sigmas(self, model_sampling):
        """パーセンテージをsigma値に変換"""
        self.start_sigma = float(model_sampling.percent_to_sigma(self.start_percent))
        self.end_sigma = float(model_sampling.percent_to_sigma(self.end_percent))
        self.gate_sigma = float(model_sampling.percent_to_sigma(self.gate_step_percent))
        return self

    def update_step(self, sigma):
        """現在のタイムステップを更新し、キャッシュ使用判定を行う"""
        sigma_val = float(sigma)

        self.current_sigma = sigma_val

        self.is_active = self.end_sigma <= sigma_val <= self.start_sigma

        if self.is_active and sigma_val <= self.gate_sigma and self.cache_ready:
            self.is_gated = True
        else:
            self.is_gated = False

    def get_block_key(self, extra_options):
        """ブロックの一意キーを生成"""
        block = extra_options.get("block", None)
        block_index = extra_options.get("block_index", 0)
        if block is not None:
            return (block[0], block[1], block_index)
        return ("unknown", 0, block_index)

    def cache_attn2_output(self, block_key, output):
        """attn2の出力をキャッシュ"""
        self.cached_attn2_outputs[block_key] = output.detach().clone()

    def get_cached_attn2_output(self, block_key):
        """キャッシュされたattn2出力を取得"""
        cached = self.cached_attn2_outputs.get(block_key, None)
        return cached

    def cache_attn1_output(self, block_key, output):
        """attn1の出力をキャッシュ"""
        self.cached_attn1_outputs[block_key] = output.detach().clone()

    def get_cached_attn1_output(self, block_key):
        """キャッシュされたattn1出力を取得"""
        return self.cached_attn1_outputs.get(block_key, None)

    def mark_cache_ready(self):
        """キャッシュが充填されたことをマーク"""
        self.cache_ready = True

    def reset_cache(self):
        """キャッシュと状態を完全リセット"""
        self.cached_attn2_outputs.clear()
        self.cached_attn1_outputs.clear()
        self.is_gated = False
        self.cache_ready = False
        self.current_sigma = None
        self.steps_computed = 0
        self.steps_cached = 0

    def clone(self):
        """新しいサンプリング用にクローンを作成"""
        new_state = TGateState(
            self.gate_step_percent,
            self.start_percent,
            self.end_percent,
            self.cache_self_attn,
        )
        return new_state


def tgate_outer_sample_wrapper(executor, *args, **kwargs):
    """
    OUTER_SAMPLE wrapper: サンプリング開始時に TGateState を初期化し、
    完了時にキャッシュをクリーンアップする。
    """
    guider = executor.class_obj
    orig_model_options = guider.model_options
    try:
        guider.model_options = comfy.model_patcher.create_model_options_clone(orig_model_options)

        state = guider.model_options["transformer_options"]["tgate_state"]
        state = state.clone().prepare_sigmas(guider.model_patcher.model.model_sampling)
        guider.model_options["transformer_options"]["tgate_state"] = state

        logger.info(
            f"[SAX_Bridge] TGate enabled - gate_step: {state.gate_step_percent:.0%}, "
            f"start: {state.start_percent:.0%}, end: {state.end_percent:.0%}"
        )

        result = executor(*args, **kwargs)

        total = state.steps_computed + state.steps_cached
        if total > 0:
            try:
                speedup = total / max(state.steps_computed, 1)
            except ZeroDivisionError:
                speedup = 1.0
            logger.info(
                f"[SAX_Bridge] TGate - computed: {state.steps_computed}, cached: {state.steps_cached}, "
                f"total: {total} ({speedup:.2f}x theoretical speedup)"
            )

        return result
    finally:
        # try 内で例外発生時に state 変数が未定義になるのを防ぐ
        final_state = guider.model_options.get("transformer_options", {}).get("tgate_state")
        if final_state:
            final_state.reset_cache()
        guider.model_options = orig_model_options


def tgate_diffusion_model_wrapper(executor, *args, **kwargs):
    """
    DIFFUSION_MODEL wrapper: 各ステップの前にsigmaからステップ状態を更新する。
    """
    transformer_options = kwargs.get("transformer_options")
    if not isinstance(transformer_options, dict):
        transformer_options = next(
            (a for a in reversed(args) if isinstance(a, dict)), {}
        )

    state = transformer_options.get("tgate_state")

    if state is None:
        return executor(*args, **kwargs)

    sigmas = transformer_options.get("sigmas")
    if sigmas is not None:
        sigma_val = sigmas[0].item()
        state.update_step(sigma_val)

        if state.is_gated:
            state.steps_cached += 1
        elif state.is_active:
            state.steps_computed += 1

    result = executor(*args, **kwargs)

    return result


def _fit_cached_to_shape(cached: torch.Tensor, target: torch.Tensor, patch_name: str):
    """キャッシュテンソルを target のシェイプに合わせる。失敗時は None を返す。"""
    if cached.shape == target.shape:
        return cached
    try:
        if cached.shape[0] == 1 and target.shape[0] > 1:
            repeat_dims = [target.shape[0]] + [1] * (len(cached.shape) - 1)
            return cached.repeat(*repeat_dims)
        elif cached.shape[0] < target.shape[0] and (target.shape[0] % cached.shape[0]) == 0:
            repeat_factor = target.shape[0] // cached.shape[0]
            repeat_dims = [repeat_factor] + [1] * (len(cached.shape) - 1)
            return cached.repeat(*repeat_dims)
        elif cached.shape[0] > target.shape[0]:
            return cached[:target.shape[0]]
        else:
            return cached.expand(target.shape)
    except Exception as e:
        logger.warning(f"[SAX_Bridge] TGate {patch_name} shape mismatch fallback: expected {target.shape}, got {cached.shape}. error: {e}")
        return None


def tgate_attn2_output_patch(n, extra_options):
    """
    attn2_output_patch.
    ゲート前は出力をキャッシュし、ゲート後はキャッシュで差し替える。
    """
    state = extra_options.get("tgate_state")
    if state is None:
        return n

    block_key = state.get_block_key(extra_options)

    if state.is_gated:
        cached = state.get_cached_attn2_output(block_key)
        if cached is not None:
            out = cached if (cached.device == n.device and cached.dtype == n.dtype) else cached.to(n.device, dtype=n.dtype)
            out = _fit_cached_to_shape(out, n, "Attn2")
            return out if out is not None else n
        return n
    elif state.is_active:
        state.cache_attn2_output(block_key, n)
        state.mark_cache_ready()

    return n


def tgate_attn1_output_patch(n, extra_options):
    """
    attn1_output_patch (self-attention キャッシュ用).
    """
    state = extra_options.get("tgate_state")
    if state is None or not state.cache_self_attn:
        return n

    block_key = state.get_block_key(extra_options)

    if state.is_gated:
        cached = state.get_cached_attn1_output(block_key)
        if cached is not None:
            out = cached if (cached.device == n.device and cached.dtype == n.dtype) else cached.to(n.device, dtype=n.dtype)
            out = _fit_cached_to_shape(out, n, "Attn1")
            return out if out is not None else n
        return n
    elif state.is_active:
        state.cache_attn1_output(block_key, n)
        return n
    else:
        return n


def apply_tgate(
    model: "comfy.model_patcher.ModelPatcher",
    gate_step_percent: float,
    start_percent: float = 0.0,
    end_percent: float = 1.0,
    cache_self_attn: bool = False,
) -> "comfy.model_patcher.ModelPatcher":
    """model に TGate を適用して返す。gate_step_percent >= end_percent の場合は model をそのまま返す。"""
    if gate_step_percent >= end_percent:
        logger.info("[SAX_Bridge] TGate - gate_step >= end_percent, no effect")
        return model

    model = model.clone()

    state = TGateState(
        gate_step_percent=gate_step_percent,
        start_percent=start_percent,
        end_percent=end_percent,
        cache_self_attn=cache_self_attn,
    )

    model.model_options.setdefault("transformer_options", {})["tgate_state"] = state

    model.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
        "tgate",
        tgate_outer_sample_wrapper,
    )

    model.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
        "tgate",
        tgate_diffusion_model_wrapper,
    )

    model.set_model_attn1_output_patch(tgate_attn1_output_patch)
    model.set_model_attn2_output_patch(tgate_attn2_output_patch)

    return model
