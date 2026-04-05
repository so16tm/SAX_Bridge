"""SAX_Bridge_KSampler ノードのテスト。"""

import pytest
from unittest.mock import MagicMock, patch
from nodes.sampler import SAX_Bridge_KSampler


def _make_pipe(**overrides):
    """標準的な pipe を生成するヘルパー。"""
    pipe = {
        "model": MagicMock(name="model"),
        "positive": MagicMock(name="positive"),
        "negative": MagicMock(name="negative"),
        "samples": {"samples": MagicMock(name="latent_tensor")},
        "vae": MagicMock(name="vae"),
        "clip": MagicMock(name="clip"),
        "seed": 42,
        "loader_settings": {
            "steps": 20,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    pipe.update(overrides)
    return pipe


class TestKSamplerBasic:
    """基本的なサンプリング動作の検証。"""

    def test_returns_new_pipe_with_samples(self):
        pipe = _make_pipe()
        fake_latent = {"samples": MagicMock(name="new_latent")}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)) as mock_ks:
            result = SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        new_pipe = result.args[0]
        assert new_pipe["samples"] is fake_latent
        mock_ks.assert_called_once()

    def test_original_pipe_not_mutated(self):
        pipe = _make_pipe()
        orig_samples = pipe["samples"]
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)):
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        assert pipe["samples"] is orig_samples

    def test_passes_loader_settings_to_ksampler(self):
        pipe = _make_pipe()
        pipe["loader_settings"] = {
            "steps": 30,
            "cfg": 5.5,
            "sampler_name": "dpmpp_2m",
            "scheduler": "karras",
            "denoise": 0.8,
        }
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)) as mock_ks:
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        args, kwargs = mock_ks.call_args
        # 位置引数: model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent
        assert args[1] == 42         # seed
        assert args[2] == 30         # steps
        assert args[3] == 5.5        # cfg
        assert args[4] == "dpmpp_2m"
        assert args[5] == "karras"
        assert kwargs["denoise"] == 0.8

    def test_uses_default_loader_settings(self):
        # loader_settings が空の場合はデフォルト値が使われる
        pipe = _make_pipe()
        pipe["loader_settings"] = {}
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)) as mock_ks:
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        args, kwargs = mock_ks.call_args
        assert args[2] == 20         # steps default
        assert args[3] == 7.0        # cfg default
        assert args[4] == "euler"
        assert args[5] == "normal"
        assert kwargs["denoise"] == 1.0

    def test_default_seed_is_zero(self):
        # seed が pipe に無い場合は 0
        pipe = _make_pipe()
        del pipe["seed"]
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)) as mock_ks:
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        args, _ = mock_ks.call_args
        assert args[1] == 0


class TestKSamplerDecodeVae:
    """decode_vae オプションの検証。"""

    def test_decode_vae_true_calls_vae_decode(self):
        pipe = _make_pipe()
        fake_image = MagicMock(name="image")
        pipe["vae"].decode = MagicMock(return_value=fake_image)
        fake_latent = {"samples": MagicMock(name="new_samples")}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)):
            result = SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=True)
        pipe["vae"].decode.assert_called_once_with(fake_latent["samples"])
        assert result.args[0]["images"] is fake_image
        assert result.args[1] is fake_image

    def test_decode_vae_false_returns_none_image(self):
        pipe = _make_pipe()
        pipe["vae"].decode = MagicMock()
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)):
            result = SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        pipe["vae"].decode.assert_not_called()
        assert result.args[0]["images"] is None
        assert result.args[1] is None

    def test_decode_vae_true_without_vae_raises(self):
        pipe = _make_pipe(vae=None)
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)):
            with pytest.raises(ValueError, match="VAE"):
                SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=True)


class TestKSamplerNegativeAutoEncode:
    """negative=None 時の自動エンコード。"""

    def test_negative_none_encodes_empty_string(self):
        pipe = _make_pipe(negative=None)
        fake_neg_cond = MagicMock(name="empty_cond")
        fake_encoder = MagicMock()
        fake_encoder.encode = MagicMock(return_value=(fake_neg_cond,))
        fake_latent = {"samples": MagicMock()}
        with patch("nodes.sampler.nodes.CLIPTextEncode", return_value=fake_encoder), \
             patch("nodes.sampler.nodes.common_ksampler", return_value=(fake_latent,)) as mock_ks:
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
        fake_encoder.encode.assert_called_once_with(pipe["clip"], "")
        args, _ = mock_ks.call_args
        assert args[7] is fake_neg_cond  # negative は 8 番目

    def test_negative_none_without_clip_raises(self):
        pipe = _make_pipe(negative=None, clip=None)
        with pytest.raises(ValueError, match="negative conditioning or CLIP"):
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)


class TestKSamplerValidation:
    """必須要素欠落時のバリデーション。"""

    @pytest.mark.parametrize("missing_key,error_fragment", [
        ("model", "model"),
        ("positive", "positive"),
        ("samples", "latent"),
    ])
    def test_missing_required_raises(self, missing_key, error_fragment):
        pipe = _make_pipe(**{missing_key: None})
        with pytest.raises(ValueError, match=error_fragment):
            SAX_Bridge_KSampler.execute(pipe=pipe, decode_vae=False)
