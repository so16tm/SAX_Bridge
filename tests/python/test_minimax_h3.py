"""MiniMax H3 の Loader / Sampler ノードのテスト。

ComfyUI 本体のノード（サンプラー一式・VAEDecodeAudio・CreateVideo）はモックし、
このモジュール固有の責務（読み込み分岐、pipe の組み立て、サンプリング設定の受け渡し、
映像／音声の復号経路）だけを検証する。
"""

from unittest.mock import MagicMock, patch

import pytest
import torch

from nodes import minimax_h3 as mod
from nodes.loader_common import pick_default
from nodes.minimax_h3 import SAX_Bridge_Loader_MiniMax_H3, SAX_Bridge_Sampler_MiniMax_H3


# ---------------------------------------------------------------------------
# pick_default
# ---------------------------------------------------------------------------

def test_pick_default_prefers_keyword_match_case_insensitive():
    options = ["a.safetensors", "MiniMax_H3_FL2VA_pruned.safetensors", "minimax_h3_ref2va.safetensors"]
    assert pick_default(options, "fl2va") == "MiniMax_H3_FL2VA_pruned.safetensors"
    assert pick_default(options, "ref2va") == "minimax_h3_ref2va.safetensors"


def test_pick_default_requires_all_keywords_and_falls_back():
    options = ["qwen3vl_8b.safetensors", "qwen3vl_32b_minimax_h3.safetensors"]
    assert pick_default(options, "qwen3vl", "minimax") == "qwen3vl_32b_minimax_h3.safetensors"
    assert pick_default(options, "nothing", fallback="None") == "None"
    assert pick_default(options, "nothing") == "qwen3vl_8b.safetensors"
    assert pick_default([], "x") is None


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def _loader_kwargs(**overrides):
    kwargs = {
        "unet_name": "minimax_h3_fl2va.safetensors",
        "ref_unet_name": "None",
        "clip_name": "qwen3vl_32b_minimax_h3.safetensors",
        "vae_name": "minimax_h3_video_vae.safetensors",
        "audio_vae_name": "minimax_h3_audio_vae.safetensors",
        "seed": 7,
        "steps": 20,
        "sampler_name": "res_multistep",
        "scheduler_name": "simple",
    }
    kwargs.update(overrides)
    return kwargs


@pytest.fixture
def loader_env():
    """ComfyUI のロード関数を差し替える。load_diffusion_model はパスごとに別モデルを返す。"""
    models = {}

    def load_unet(path, **_):
        return models.setdefault(path, MagicMock(name=f"model:{path}"))

    vae_by_path = {}

    def load_vae(path):
        return vae_by_path.setdefault(path, MagicMock(name=f"vae:{path}"))

    clip = MagicMock(name="clip")
    with patch("nodes.minimax_h3.folder_paths.get_full_path", side_effect=lambda f, n: f"/m/{f}/{n}"), \
         patch("nodes.minimax_h3.comfy.sd.load_diffusion_model", side_effect=load_unet) as unet, \
         patch("nodes.minimax_h3.comfy.sd.load_clip", return_value=clip) as load_clip, \
         patch("nodes.minimax_h3.load_vae_file", side_effect=load_vae):
        yield MagicMock(models=models, vaes=vae_by_path, clip=clip, unet=unet, load_clip=load_clip)


def test_loader_fl2va_only(loader_env):
    pipe, model, model_ref, clip, vae, audio_vae = SAX_Bridge_Loader_MiniMax_H3.execute(**_loader_kwargs()).args

    assert model is loader_env.models["/m/diffusion_models/minimax_h3_fl2va.safetensors"]
    assert model_ref is None
    assert loader_env.unet.call_count == 1
    assert clip is loader_env.clip
    assert vae is loader_env.vaes["/m/vae/minimax_h3_video_vae.safetensors"]
    assert audio_vae is loader_env.vaes["/m/vae/minimax_h3_audio_vae.safetensors"]
    assert vae is not audio_vae

    assert pipe["model"] is model
    assert pipe["vae"] is vae
    assert pipe["audio_vae"] is audio_vae
    assert pipe["clip"] is clip
    assert pipe["seed"] == 7
    assert pipe["samples"] is None
    assert pipe["loader_settings"]["steps"] == 20
    assert pipe["loader_settings"]["sampler_name"] == "res_multistep"
    assert pipe["loader_settings"]["scheduler"] == "simple"
    assert pipe["loader_settings"]["cfg"] == 1.0


def test_loader_sets_minimax_clip_type(loader_env):
    SAX_Bridge_Loader_MiniMax_H3.execute(**_loader_kwargs())
    _, kwargs = loader_env.load_clip.call_args
    assert kwargs["clip_type"] is mod.comfy.sd.CLIPType.MINIMAX
    assert kwargs["ckpt_paths"] == ["/m/text_encoders/qwen3vl_32b_minimax_h3.safetensors"]


def test_loader_both_models_loaded_and_pipe_uses_fl2va(loader_env):
    pipe, model, model_ref, *_ = SAX_Bridge_Loader_MiniMax_H3.execute(
        **_loader_kwargs(ref_unet_name="minimax_h3_ref2va.safetensors")
    ).args

    assert loader_env.unet.call_count == 2
    assert model is not model_ref
    assert pipe["model"] is model


def test_loader_ref2va_only_uses_it_as_pipe_model(loader_env):
    pipe, model, model_ref, *_ = SAX_Bridge_Loader_MiniMax_H3.execute(
        **_loader_kwargs(unet_name="None", ref_unet_name="minimax_h3_ref2va.safetensors")
    ).args

    assert model is None
    assert pipe["model"] is model_ref


def test_loader_requires_at_least_one_model(loader_env):
    with pytest.raises(ValueError, match="unet_name"):
        SAX_Bridge_Loader_MiniMax_H3.execute(**_loader_kwargs(unet_name="None"))
    loader_env.unet.assert_not_called()


def test_loader_without_minimax_clip_type_gives_update_hint(loader_env):
    class _OldClipType:
        pass

    with patch("nodes.minimax_h3.comfy.sd.CLIPType", _OldClipType):
        with pytest.raises(ValueError, match="update ComfyUI"):
            SAX_Bridge_Loader_MiniMax_H3.execute(**_loader_kwargs())


def test_loader_missing_file_names_the_file():
    with patch("nodes.minimax_h3.folder_paths.get_full_path", return_value=None):
        with pytest.raises(ValueError, match="fl2va_missing"):
            SAX_Bridge_Loader_MiniMax_H3.execute(**_loader_kwargs(unet_name="fl2va_missing.safetensors"))


# ---------------------------------------------------------------------------
# Sampler
# ---------------------------------------------------------------------------

def _pipe(**overrides):
    pipe = {
        "model": MagicMock(name="pipe_model"),
        "clip": MagicMock(name="clip"),
        "vae": MagicMock(name="vae"),
        "audio_vae": MagicMock(name="audio_vae"),
        "positive": None,
        "negative": None,
        "samples": None,
        "images": None,
        "seed": 42,
        "loader_settings": {
            "steps": 12, "cfg": 1.0, "sampler_name": "euler", "scheduler": "beta",
            "denoise": 1.0, "clip_width": 0, "clip_height": 0, "batch_size": 1,
        },
    }
    pipe.update(overrides)
    return pipe


def _upstream_nodes(sampled):
    """本体ノードの代役。各 execute は NodeOutput 相当（.args）を返す。"""
    def node(name, result):
        cls = MagicMock(name=name)
        cls.execute.return_value = MagicMock(args=(result,))
        return cls

    nodes = {
        "RandomNoise": node("RandomNoise", "NOISE"),
        "KSamplerSelect": node("KSamplerSelect", "SAMPLER"),
        "BasicScheduler": node("BasicScheduler", "SIGMAS"),
        "BasicGuider": node("BasicGuider", "GUIDER"),
        "SamplerCustomAdvanced": node("SamplerCustomAdvanced", sampled),
        "VAEDecodeAudio": node("VAEDecodeAudio", {"waveform": "WAV", "sample_rate": 44100}),
        "CreateVideo": node("CreateVideo", "VIDEO"),
    }

    def fake_upstream(module, *names):
        return tuple(nodes[n] for n in names)

    return nodes, fake_upstream


def _run_sampler(pipe, frames_hw=(64, 96), **kwargs):
    latent = {"samples": MagicMock(name="director_latent")}
    sampled = {"samples": MagicMock(name="sampled_tensor")}
    nodes, fake_upstream = _upstream_nodes(sampled)
    images = torch.zeros(5, *frames_hw, 3)
    with patch("nodes.minimax_h3._upstream", side_effect=fake_upstream), \
         patch("nodes.minimax_h3.decode_image", return_value=images) as decode:
        out = SAX_Bridge_Sampler_MiniMax_H3.execute(
            pipe, model="PATCHED_MODEL", positive="COND", latent=latent, **kwargs
        )
    return out, nodes, decode, latent, sampled, images


def test_sampler_wires_upstream_nodes_with_pipe_settings():
    pipe = _pipe()
    (out_pipe, video, out_images, audio), nodes, decode, latent, sampled, images = _run_sampler(pipe)

    nodes["RandomNoise"].execute.assert_called_once_with(42)
    nodes["KSamplerSelect"].execute.assert_called_once_with("euler")
    # steps / scheduler は Loader の設定、model は Director のパッチ済みモデルを使う。denoise は常に 1
    nodes["BasicScheduler"].execute.assert_called_once_with("PATCHED_MODEL", "beta", 12, 1.0)
    nodes["BasicGuider"].execute.assert_called_once_with("PATCHED_MODEL", "COND")
    nodes["SamplerCustomAdvanced"].execute.assert_called_once_with("NOISE", "GUIDER", "SAMPLER", "SIGMAS", latent)


def test_sampler_decodes_video_and_audio_from_the_same_latent_with_separate_vaes():
    pipe = _pipe()
    (out_pipe, video, out_images, audio), nodes, decode, latent, sampled, images = _run_sampler(pipe)

    decode.assert_called_once_with(pipe["vae"], sampled["samples"])
    nodes["VAEDecodeAudio"].execute.assert_called_once_with(sampled, pipe["audio_vae"])
    # 動画は 24fps 既定で、映像と音声を mux して作る
    args, kwargs = nodes["CreateVideo"].execute.call_args
    assert args == (images, 24.0)
    assert kwargs["audio"] == {"waveform": "WAV", "sample_rate": 44100}
    assert video == "VIDEO"
    assert out_images is images
    assert audio == {"waveform": "WAV", "sample_rate": 44100}


def test_sampler_passes_custom_fps():
    _, nodes, *_ = _run_sampler(_pipe(), fps=30.0)
    assert nodes["CreateVideo"].execute.call_args.args[1] == 30.0


def test_sampler_updates_pipe_without_mutating_input():
    pipe = _pipe()
    (out_pipe, *_), _, _, _, sampled, images = _run_sampler(pipe, frames_hw=(64, 96))

    assert out_pipe["samples"] is sampled
    assert out_pipe["images"] is images
    assert (out_pipe["loader_settings"]["clip_width"], out_pipe["loader_settings"]["clip_height"]) == (96, 64)
    assert out_pipe["audio_vae"] is pipe["audio_vae"]
    # 入力 pipe は変更しない
    assert pipe["samples"] is None and pipe["images"] is None
    assert pipe["loader_settings"]["clip_width"] == 0


def test_sampler_empty_pipe_gives_wiring_hint():
    with pytest.raises(ValueError, match="pipe input is empty"):
        SAX_Bridge_Sampler_MiniMax_H3.execute(None, model="m", positive="p", latent={})


def test_sampler_pipe_without_audio_vae_points_to_h3_loader():
    with pytest.raises(ValueError, match="MiniMax H3 Loader"):
        SAX_Bridge_Sampler_MiniMax_H3.execute(_pipe(audio_vae=None), model="m", positive="p", latent={})


def test_upstream_missing_gives_update_hint():
    with patch("importlib.import_module", side_effect=ImportError("nope")):
        with pytest.raises(ValueError, match="update ComfyUI"):
            mod._upstream("comfy_extras.nodes_custom_sampler", "RandomNoise")
