"""SAX_Bridge_Guidance ノードのテスト。"""

import pytest
from unittest.mock import MagicMock, patch
from nodes.guidance import (
    SAX_Bridge_Guidance,
    apply_guidance_to_model,
    _strength_to_params,
    _apply_agc,
    _apply_fdg,
    _ALL_MODES,
)


class TestStrengthToParams:
    def test_zero_returns_no_effect(self):
        p = _strength_to_params(0.0)
        assert p["agc_tau"] == 4.0
        assert p["fdg_low_gain"] == 1.0
        assert p["fdg_high_gain"] == 1.0
        assert p["pag_scale"] == 0.0

    def test_one_returns_max_effect(self):
        p = _strength_to_params(1.0)
        assert p["agc_tau"] == 1.5
        assert p["pag_scale"] == 6.0

    def test_clamp_above_one(self):
        p = _strength_to_params(2.0)
        assert p == _strength_to_params(1.0)

    def test_clamp_below_zero(self):
        p = _strength_to_params(-1.0)
        assert p == _strength_to_params(0.0)


class TestApplyAgc:
    def test_soft_clip(self):
        import torch
        delta = torch.tensor([10.0, -10.0])
        result = _apply_agc(delta, tau=2.0)
        assert result[0].item() < 2.0
        assert result[1].item() > -2.0


class TestApplyFdg:
    def test_identity_when_gains_are_one(self):
        import torch
        delta = torch.randn(1, 4, 8, 8)
        result = _apply_fdg(delta, low_gain=1.0, high_gain=1.0)
        assert torch.allclose(result, delta, atol=1e-6)


class TestApplyGuidanceToModel:
    def test_off_mode_returns_none(self):
        model = MagicMock()
        assert apply_guidance_to_model(model, "off", 0.5, 0.0) is None

    def test_zero_strength_returns_none(self):
        model = MagicMock()
        assert apply_guidance_to_model(model, "agc", 0.0, 0.0) is None

    def test_agc_mode_patches_model(self):
        model = MagicMock()
        model.clone.return_value = MagicMock()
        result = apply_guidance_to_model(model, "agc", 0.5, 0.0)
        assert result is not None
        model.clone.assert_called_once()
        result.set_model_sampler_cfg_function.assert_called_once()

    def test_pag_only_patches_model(self):
        model = MagicMock()
        clone = MagicMock()
        clone.model_options = {}
        model.clone.return_value = clone
        result = apply_guidance_to_model(model, "off", 0.0, 0.5)
        assert result is not None


class TestGuidanceExecute:
    def _make_pipe(self):
        return {
            "model": MagicMock(),
            "clip": MagicMock(),
            "vae": MagicMock(),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "seed": 42,
        }

    def test_off_mode_returns_same_pipe(self):
        pipe = self._make_pipe()
        result = SAX_Bridge_Guidance.execute(pipe, "off", 0.5, 0.0)
        assert result[0] is pipe

    def test_no_model_returns_same_pipe(self):
        pipe = self._make_pipe()
        pipe["model"] = None
        result = SAX_Bridge_Guidance.execute(pipe, "agc", 0.5, 0.0)
        assert result[0] is pipe

    def test_agc_mode_returns_new_pipe(self):
        pipe = self._make_pipe()
        pipe["model"].clone.return_value = MagicMock()
        result = SAX_Bridge_Guidance.execute(pipe, "agc", 0.5, 0.0)
        assert result[0] is not pipe
        assert result[0]["model"] is not pipe["model"]


class TestAllModes:
    def test_modes_list(self):
        assert _ALL_MODES == ["off", "agc", "fdg", "agc+fdg", "post_fdg"]
