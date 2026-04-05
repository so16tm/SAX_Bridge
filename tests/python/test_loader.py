"""SAX_Bridge_Loader ノードのテスト。"""

import pytest
import torch
from unittest.mock import MagicMock, patch
from nodes.loader import SAX_Bridge_Loader
from nodes.io_types import _APPLIED_LORAS_KEY, _normalize_lora_name


def _default_kwargs(**overrides):
    """execute 用のデフォルト引数セット。"""
    kwargs = {
        "ckpt_name": "model.safetensors",
        "clip_skip": -1,
        "vae_name": "baked_vae",
        "lora_name": "None",
        "lora_model_strength": 1.0,
        "v_pred": False,
        "seed": 123,
        "steps": 20,
        "cfg": 8.0,
        "sampler_name": "euler",
        "scheduler_name": "normal",
        "denoise": 1.0,
        "width": 512,
        "height": 512,
        "batch_size": 1,
    }
    kwargs.update(overrides)
    return kwargs


def _make_checkpoint_mocks():
    """load_checkpoint_guess_config の戻り値用 model/clip/vae モック。"""
    model = MagicMock(name="model")
    clip = MagicMock(name="clip")
    clip.clone = MagicMock(return_value=clip)
    clip.clip_layer = MagicMock()
    vae = MagicMock(name="vae")
    return model, clip, vae


class TestLoaderBasic:
    """基本的な読み込み動作。"""

    def test_returns_pipe_and_seed(self):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)):
            result = SAX_Bridge_Loader.execute(**_default_kwargs(seed=777))
        pipe = result.args[0]
        seed_out = result.args[1]
        assert isinstance(pipe, dict)
        assert pipe["model"] is model
        assert pipe["clip"] is clip
        assert pipe["vae"] is vae
        assert pipe["seed"] == 777
        assert seed_out == 777

    def test_pipe_has_empty_conditioning_placeholders(self):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)):
            result = SAX_Bridge_Loader.execute(**_default_kwargs())
        pipe = result.args[0]
        assert pipe["positive"] is None
        assert pipe["negative"] is None
        assert pipe["images"] is None

    def test_clip_skip_applied(self):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)):
            SAX_Bridge_Loader.execute(**_default_kwargs(clip_skip=-2))
        clip.clone.assert_called_once()
        clip.clip_layer.assert_called_once_with(-2)


class TestLoaderSettings:
    """loader_settings の構築。"""

    def test_loader_settings_values(self):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)):
            result = SAX_Bridge_Loader.execute(**_default_kwargs(
                steps=30, cfg=6.5, sampler_name="dpmpp_2m",
                scheduler_name="karras", denoise=0.7,
                width=768, height=1024, batch_size=2,
            ))
        ls = result.args[0]["loader_settings"]
        assert ls["steps"] == 30
        assert ls["cfg"] == 6.5
        assert ls["sampler_name"] == "dpmpp_2m"
        assert ls["scheduler"] == "karras"
        assert ls["denoise"] == 0.7
        assert ls["clip_width"] == 768
        assert ls["clip_height"] == 1024
        assert ls["batch_size"] == 2


class TestLoaderLatent:
    """空 latent の生成。"""

    @pytest.mark.parametrize("width,height,batch_size", [
        (512, 512, 1),
        (768, 512, 2),
        (1024, 1024, 4),
    ])
    def test_empty_latent_shape(self, width, height, batch_size):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)):
            result = SAX_Bridge_Loader.execute(**_default_kwargs(
                width=width, height=height, batch_size=batch_size,
            ))
        latent = result.args[0]["samples"]["samples"]
        assert isinstance(latent, torch.Tensor)
        assert latent.shape == (batch_size, 4, height // 8, width // 8)
        assert torch.all(latent == 0)


class TestLoaderVae:
    """vae_name 指定時の外部 VAE 読み込み。"""

    def test_baked_vae_uses_checkpoint_vae(self):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)), \
             patch("nodes.loader.comfy.sd.VAE") as mock_vae_class:
            result = SAX_Bridge_Loader.execute(**_default_kwargs(vae_name="baked_vae"))
        mock_vae_class.assert_not_called()
        assert result.args[0]["vae"] is vae

    def test_external_vae_loaded(self):
        model, clip, vae = _make_checkpoint_mocks()
        external_vae = MagicMock(name="external_vae")
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)), \
             patch("nodes.loader.comfy.sd.VAE", return_value=external_vae) as mock_vae_class, \
             patch("nodes.loader.comfy.utils.load_torch_file", return_value={}):
            result = SAX_Bridge_Loader.execute(**_default_kwargs(vae_name="custom.safetensors"))
        mock_vae_class.assert_called_once()
        assert result.args[0]["vae"] is external_vae


class TestLoaderLora:
    """Loader の単一 LoRA 適用。"""

    def test_lora_none_skipped(self):
        model, clip, vae = _make_checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)), \
             patch("nodes.loader.comfy.sd.load_lora_for_models") as mock_load_lora:
            result = SAX_Bridge_Loader.execute(**_default_kwargs(lora_name="None"))
        mock_load_lora.assert_not_called()
        # applied_loras は空
        applied = result.args[0].get(_APPLIED_LORAS_KEY, set())
        assert len(applied) == 0

    def test_lora_applied_and_recorded(self):
        model, clip, vae = _make_checkpoint_mocks()
        new_model = MagicMock(name="new_model")
        new_clip = MagicMock(name="new_clip")
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)), \
             patch("nodes.loader.comfy.utils.load_torch_file", return_value={}), \
             patch("nodes.loader.comfy.sd.load_lora_for_models",
                   return_value=(new_model, new_clip)) as mock_load_lora:
            result = SAX_Bridge_Loader.execute(**_default_kwargs(
                lora_name="my_lora.safetensors", lora_model_strength=0.8,
            ))
        mock_load_lora.assert_called_once()
        args, _ = mock_load_lora.call_args
        assert args[3] == 0.8  # strength_model
        assert args[4] == 0.8  # strength_clip
        pipe = result.args[0]
        assert pipe["model"] is new_model
        assert pipe["clip"] is new_clip
        applied = pipe.get(_APPLIED_LORAS_KEY, set())
        assert _normalize_lora_name("my_lora.safetensors") in applied


class TestLoaderVPred:
    """v_pred オプションの検証。"""

    def test_v_pred_false_no_patch(self):
        model, clip, vae = _make_checkpoint_mocks()
        model.clone = MagicMock(return_value=model)
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)):
            SAX_Bridge_Loader.execute(**_default_kwargs(v_pred=False))
        model.clone.assert_not_called()

    def test_v_pred_true_applies_patch(self):
        model, clip, vae = _make_checkpoint_mocks()
        cloned_model = MagicMock(name="cloned_model")
        cloned_model.model = MagicMock()
        cloned_model.model.model_config = MagicMock()
        cloned_model.add_object_patch = MagicMock()
        model.clone = MagicMock(return_value=cloned_model)
        # ModelSamplingDiscrete / V_PREDICTION は多重継承されるため実 class でパッチする
        class _BaseMSD:
            def __init__(self, *args, **kwargs):
                pass
        class _VPred:
            pass
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)), \
             patch("nodes.loader.comfy.model_sampling.ModelSamplingDiscrete", _BaseMSD), \
             patch("nodes.loader.comfy.model_sampling.V_PREDICTION", _VPred):
            result = SAX_Bridge_Loader.execute(**_default_kwargs(v_pred=True))
        model.clone.assert_called_once()
        cloned_model.add_object_patch.assert_called_once()
        args, _ = cloned_model.add_object_patch.call_args
        assert args[0] == "model_sampling"
        assert result.args[0]["model"] is cloned_model
