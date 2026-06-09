"""SAX_Bridge_Loader_Diffusion ノードのテスト。"""

import pytest
import torch
from unittest.mock import MagicMock, patch
from nodes.loader_diffusion import SAX_Bridge_Loader_Diffusion, _unet_model_options
from nodes.io_types import _APPLIED_LORAS_KEY, _normalize_lora_name


def _get_full_path(folder, name):
    """folder 別に区別可能なパスを返す side_effect。

    None ガード（ファイル未配置時の ValueError）を通過させつつ、
    どのフォルダから取得したかをテストで検証可能にする。
    """
    return "/models/%s/%s" % (folder, name)


@pytest.fixture(autouse=True)
def _stub_get_full_path():
    """全テストで folder_paths.get_full_path を folder 別 side_effect に固定する。"""
    with patch("nodes.loader_diffusion.folder_paths.get_full_path", side_effect=_get_full_path):
        yield


def _default_kwargs(**overrides):
    """execute 用のデフォルト引数セット。"""
    kwargs = {
        "unet_name": "anima-base-v1.0.safetensors",
        "weight_dtype": "default",
        "clip_name": "qwen_3_06b_base.safetensors",
        "vae_name": "qwen_image_vae.safetensors",
        "lora_name": "None",
        "lora_model_strength": 1.0,
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


def _make_mocks():
    """load_diffusion_model / load_clip / VAE の戻り値モック。"""
    model = MagicMock(name="model")
    clip = MagicMock(name="clip")
    vae = MagicMock(name="vae")
    return model, clip, vae


def _patch_loads(model, clip, vae):
    """3 種のロード関数 + load_torch_file をまとめて patch するコンテキスト群。"""
    return (
        patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model),
        patch("nodes.loader_diffusion.comfy.sd.load_clip", return_value=clip),
        patch("nodes.loader_diffusion.comfy.sd.VAE", return_value=vae),
        patch("nodes.loader_diffusion.comfy.utils.load_torch_file", return_value={}),
    )


class TestUnetModelOptions:
    """weight_dtype → model_options マッピング（UNETLoader 完全踏襲）。"""

    def test_default_is_empty(self):
        assert _unet_model_options("default") == {}

    def test_fp8_e4m3fn(self):
        assert _unet_model_options("fp8_e4m3fn") == {"dtype": torch.float8_e4m3fn}

    def test_fp8_e4m3fn_fast_adds_optimizations(self):
        opts = _unet_model_options("fp8_e4m3fn_fast")
        assert opts["dtype"] == torch.float8_e4m3fn
        assert opts["fp8_optimizations"] is True

    def test_fp8_e5m2(self):
        assert _unet_model_options("fp8_e5m2") == {"dtype": torch.float8_e5m2}

    def test_unknown_is_empty(self):
        assert _unet_model_options("something_else") == {}


class TestLoaderDiffusionBasic:
    """基本的な読み込み動作。"""

    def test_returns_pipe_and_seed(self):
        model, clip, vae = _make_mocks()
        p1, p2, p3, p4 = _patch_loads(model, clip, vae)
        with p1, p2, p3, p4:
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs(seed=777))
        pipe = result.args[0]
        seed_out = result.args[1]
        assert isinstance(pipe, dict)
        assert pipe["model"] is model
        assert pipe["clip"] is clip
        assert pipe["vae"] is vae
        assert pipe["seed"] == 777
        assert seed_out == 777

    def test_pipe_has_empty_conditioning_placeholders(self):
        model, clip, vae = _make_mocks()
        p1, p2, p3, p4 = _patch_loads(model, clip, vae)
        with p1, p2, p3, p4:
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs())
        pipe = result.args[0]
        assert pipe["positive"] is None
        assert pipe["negative"] is None
        assert pipe["images"] is None

    def test_clip_loaded_from_text_encoders(self):
        model, clip, vae = _make_mocks()
        with patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model), \
             patch("nodes.loader_diffusion.comfy.sd.load_clip", return_value=clip) as mock_load_clip, \
             patch("nodes.loader_diffusion.comfy.sd.VAE", return_value=vae):
            SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs())
        mock_load_clip.assert_called_once()
        _, kwargs = mock_load_clip.call_args
        # side_effect により text_encoders フォルダ由来のパスであることを検証
        assert kwargs["ckpt_paths"] == ["/models/text_encoders/qwen_3_06b_base.safetensors"]


class TestLoaderDiffusionMissingFiles:
    """ファイル未配置時の明示的エラー（get_full_path が None を返すケース）。"""

    def test_missing_unet_raises(self):
        with patch("nodes.loader_diffusion.folder_paths.get_full_path", return_value=None):
            with pytest.raises(ValueError, match="diffusion model not found"):
                SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs())

    def test_missing_clip_raises(self):
        def _side_effect(folder, name):
            return None if folder == "text_encoders" else "/models/%s/%s" % (folder, name)

        model, _, _ = _make_mocks()
        with patch("nodes.loader_diffusion.folder_paths.get_full_path", side_effect=_side_effect), \
             patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model):
            with pytest.raises(ValueError, match="text encoder not found"):
                SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs())


class TestLoaderDiffusionWeightDtype:
    """weight_dtype が load_diffusion_model へ渡る。"""

    def test_weight_dtype_passed_to_load(self):
        model, clip, vae = _make_mocks()
        with patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model) as mock_unet, \
             patch("nodes.loader_diffusion.comfy.sd.load_clip", return_value=clip), \
             patch("nodes.loader_diffusion.comfy.sd.VAE", return_value=vae):
            SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs(weight_dtype="fp8_e4m3fn_fast"))
        mock_unet.assert_called_once()
        _, kwargs = mock_unet.call_args
        assert kwargs["model_options"]["dtype"] == torch.float8_e4m3fn
        assert kwargs["model_options"]["fp8_optimizations"] is True


class TestLoaderDiffusionSettings:
    """loader_settings の構築。"""

    def test_loader_settings_values(self):
        model, clip, vae = _make_mocks()
        p1, p2, p3, p4 = _patch_loads(model, clip, vae)
        with p1, p2, p3, p4:
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs(
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


class TestLoaderDiffusionLatent:
    """空 latent の生成（4ch 固定。チャネル/次元適応は KSampler 側）。"""

    @pytest.mark.parametrize("width,height,batch_size", [
        (512, 512, 1),
        (768, 512, 2),
        (1024, 1024, 4),
    ])
    def test_empty_latent_shape(self, width, height, batch_size):
        model, clip, vae = _make_mocks()
        p1, p2, p3, p4 = _patch_loads(model, clip, vae)
        with p1, p2, p3, p4:
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs(
                width=width, height=height, batch_size=batch_size,
            ))
        latent = result.args[0]["samples"]["samples"]
        assert isinstance(latent, torch.Tensor)
        assert latent.shape == (batch_size, 4, height // 8, width // 8)
        assert torch.all(latent == 0)


class TestLoaderDiffusionVae:
    """vae の外部ロード（baked_vae 概念なし・常に外部）。"""

    def test_external_vae_loaded(self):
        model, clip, vae = _make_mocks()
        external_vae = MagicMock(name="external_vae")
        with patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model), \
             patch("nodes.loader_diffusion.comfy.sd.load_clip", return_value=clip), \
             patch("nodes.loader_diffusion.comfy.sd.VAE", return_value=external_vae) as mock_vae_class, \
             patch("nodes.loader_diffusion.comfy.utils.load_torch_file", return_value={}):
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs())
        mock_vae_class.assert_called_once()
        assert result.args[0]["vae"] is external_vae


class TestLoaderDiffusionLora:
    """単一 LoRA 適用。"""

    def test_lora_none_skipped(self):
        model, clip, vae = _make_mocks()
        with patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model), \
             patch("nodes.loader_diffusion.comfy.sd.load_clip", return_value=clip), \
             patch("nodes.loader_diffusion.comfy.sd.VAE", return_value=vae), \
             patch("nodes.loader_diffusion.comfy.sd.load_lora_for_models") as mock_load_lora:
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs(lora_name="None"))
        mock_load_lora.assert_not_called()
        applied = result.args[0].get(_APPLIED_LORAS_KEY, set())
        assert len(applied) == 0

    def test_lora_applied_and_recorded(self):
        model, clip, vae = _make_mocks()
        new_model = MagicMock(name="new_model")
        new_clip = MagicMock(name="new_clip")
        with patch("nodes.loader_diffusion.comfy.sd.load_diffusion_model", return_value=model), \
             patch("nodes.loader_diffusion.comfy.sd.load_clip", return_value=clip), \
             patch("nodes.loader_diffusion.comfy.sd.VAE", return_value=vae), \
             patch("nodes.loader_diffusion.comfy.utils.load_torch_file", return_value={}), \
             patch("nodes.loader_diffusion.comfy.sd.load_lora_for_models",
                   return_value=(new_model, new_clip)) as mock_load_lora:
            result = SAX_Bridge_Loader_Diffusion.execute(**_default_kwargs(
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
