"""SAX_Bridge_Cache ノードのテスト。"""

import pytest
from unittest.mock import MagicMock, patch
from nodes.cache import SAX_Bridge_Cache
import torch
from types import SimpleNamespace
from nodes.cache_impl import deepcache as dc


def _fake_unet_executor(monkeypatch):
    model = SimpleNamespace(
        input_blocks=["input"] * 3, output_blocks=["output"] * 3,
        middle_block=None, model_channels=1, time_embed=lambda x: x,
        num_classes=None, default_num_video_frames=None, predict_codebook_ids=False,
        out=lambda x: x,
    )
    monkeypatch.setattr(dc, "timestep_embedding", lambda t, *a, **k: t)
    monkeypatch.setattr(dc, "apply_control", lambda h, *a: h)
    monkeypatch.setattr(dc, "forward_timestep_embed", lambda block, h, *a, **k: h if block == "input" else h.sum(dim=1, keepdim=True))
    executor = MagicMock(return_value="native")
    executor.class_obj = model
    state = dc.DeepCacheState(3, 0.0, 0.0, 1)
    state.prepare_sampling(5)
    return executor, state


def test_negative_first_cfg_uses_positive_hidden_cache(monkeypatch):
    executor, state = _fake_unet_executor(monkeypatch)
    opts = {"deepcache_state": state, "cond_or_uncond": [1, 0]}
    context = torch.zeros(2, 1, 1)
    dc.deepcache_diffusion_model_wrapper(executor, torch.tensor([10., 1.]).view(2, 1, 1, 1), torch.tensor([5., 5.]), context, transformer_options=opts)
    result = dc.deepcache_diffusion_model_wrapper(executor, torch.tensor([9., 2.]).view(2, 1, 1, 1), torch.tensor([4., 4.]), context, transformer_options=opts)
    assert result.flatten().tolist() == [40., 5.]
    assert state.cfg_skipped == 1


@pytest.mark.parametrize("change", ["conditioning", "batch", "order"])
def test_changed_evaluation_does_not_reuse_hidden_cache(monkeypatch, change):
    executor, state = _fake_unet_executor(monkeypatch)
    opts = {"deepcache_state": state, "cond_or_uncond": [0]}
    x = torch.ones(1, 1, 1, 1)
    context = torch.ones(1, 1, 1)
    dc.deepcache_diffusion_model_wrapper(executor, x, torch.tensor([5.]), context, transformer_options=opts)
    if change == "conditioning":
        context = context * 2
    elif change == "batch":
        x, context = x.repeat(2, 1, 1, 1), context.repeat(2, 1, 1)
    else:
        opts["cond_or_uncond"] = [1]
    dc.deepcache_diffusion_model_wrapper(executor, x * 2, torch.full((x.shape[0],), 4.), context, transformer_options=opts)
    assert state.steps_cached == 0
    assert state.steps_computed == 2
    assert state.cached_negative is None


@pytest.mark.parametrize("incompatible", ["dit", "controlnet", "patch", "pag"])
def test_unsupported_forward_delegates_to_native(monkeypatch, incompatible):
    executor, state = _fake_unet_executor(monkeypatch)
    opts = {"deepcache_state": state}
    control = None
    if incompatible == "dit":
        del executor.class_obj.input_blocks
    elif incompatible == "controlnet":
        control = {"input": []}
    elif incompatible == "patch":
        opts["patches"] = {"middle_block_after_patch": [lambda x: x]}
    else:
        opts["patches_replace"] = {"attn1": {("middle", 0): lambda x: x}}
    assert dc.deepcache_diffusion_model_wrapper(executor, torch.ones(1, 1, 1, 1), torch.ones(1), torch.ones(1, 1, 1), control=control, transformer_options=opts) == "native"
    executor.assert_called_once()


class TestCacheExecute:
    def _make_pipe(self, model=None):
        return {
            "model": model if model is not None else MagicMock(name="model"),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "loader_settings": {},
        }

    def test_disabled_returns_pipe_as_is(self):
        # enabled=False の場合、pipe をそのまま返す（パススルー）
        pipe = self._make_pipe()
        result = SAX_Bridge_Cache.execute(
            pipe=pipe, enabled=False,
            deepcache_interval=3, deepcache_start_percent=0.2,
        )
        assert result.args[0] is pipe

    def test_no_model_raises(self):
        # pipe に model が無ければ ValueError
        pipe = self._make_pipe()
        pipe["model"] = None
        with pytest.raises(ValueError, match="does not contain a model"):
            SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )

    def test_interval_1_skips_apply_deepcache(self):
        # deepcache_interval=1 の場合、apply_deepcache は呼ばれない
        pipe = self._make_pipe()
        with patch("nodes.cache.apply_deepcache") as mock_apply:
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=1, deepcache_start_percent=0.2,
            )
        mock_apply.assert_not_called()
        # model は pipe から取り出されてそのまま new_pipe に入る
        assert result.args[0]["model"] is pipe["model"]

    def test_interval_3_calls_apply_deepcache(self):
        # deepcache_interval=3 の場合、apply_deepcache が呼ばれる
        pipe = self._make_pipe()
        patched_model = MagicMock(name="patched_model")
        with patch("nodes.cache.apply_deepcache", return_value=patched_model) as mock_apply:
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.25,
            )
        mock_apply.assert_called_once()
        # 引数確認
        call_kwargs = mock_apply.call_args.kwargs
        assert call_kwargs["model"] is pipe["model"]
        assert call_kwargs["deepcache_interval"] == 3
        assert call_kwargs["deepcache_start_ratio"] == 0.25
        # 返された model が new_pipe に入る
        assert result.args[0]["model"] is patched_model

    def test_unapplied_cache_passes_model_through(self):
        # apply_deepcache が適用不可で同じ model を返した場合 (DiT 系など)、
        # pipe の model はそのまま引き継がれ、例外にはならない
        pipe = self._make_pipe()
        orig_model = pipe["model"]
        with patch("nodes.cache.apply_deepcache", side_effect=lambda model, **kw: model):
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )
        assert result.args[0]["model"] is orig_model

    def test_pipe_immutability(self):
        # 元の pipe dict は変更されず new_pipe は新規 dict
        pipe = self._make_pipe()
        orig_model = pipe["model"]
        patched_model = MagicMock(name="patched_model")
        with patch("nodes.cache.apply_deepcache", return_value=patched_model):
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )
        new_pipe = result.args[0]
        assert new_pipe is not pipe
        assert pipe["model"] is orig_model  # 元の pipe は不変

    def test_new_pipe_preserves_other_keys(self):
        # 元の pipe の他のキーは new_pipe に引き継がれる
        pipe = self._make_pipe()
        with patch("nodes.cache.apply_deepcache", return_value=MagicMock()):
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )
        new_pipe = result.args[0]
        assert new_pipe["positive"] is pipe["positive"]
        assert new_pipe["negative"] is pipe["negative"]
        assert "loader_settings" in new_pipe
