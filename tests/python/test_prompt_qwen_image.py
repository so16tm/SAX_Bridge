"""SAX_Bridge_Prompt_Qwen_Image ノードのテスト。

エンコード本体 (ComfyUI の TextEncodeQwenImage21) はモックし、
このノード固有の責務（t2i / i2i の切替、latent の差し替え、Pipe の組み立て）だけを検証する。
"""

from unittest.mock import MagicMock, patch

import pytest
import torch

from nodes.prompt_qwen_image import SAX_Bridge_Prompt_Qwen_Image


def _pipe(batch_size=1):
    return {
        "model": MagicMock(name="model"),
        "clip": MagicMock(name="clip"),
        "vae": MagicMock(name="vae"),
        "positive": None,
        "negative": None,
        "samples": {"samples": torch.zeros(batch_size, 4, 128, 128), "downscale_ratio_spacial": 8},
        "seed": 1,
        "loader_settings": {"batch_size": batch_size, "clip_width": 1024, "clip_height": 1024},
    }


def _encoder(latent_hw=(96, 64)):
    """TextEncodeQwenImage21 の代役。呼び出し引数を記録し、固定の出力を返す。"""
    encoder = MagicMock(name="TextEncodeQwenImage21")
    latent = {"samples": torch.zeros(1, 64, *latent_hw)}
    encoder.execute.return_value = MagicMock(args=("POS", "NEG", latent))
    return encoder


def _run(pipe, encoder, **kwargs):
    with patch("nodes.prompt_qwen_image._get_upstream_encoder", return_value=encoder):
        return SAX_Bridge_Prompt_Qwen_Image.execute(pipe, **kwargs)


def test_t2i_keeps_loader_latent_and_skips_vae():
    pipe = _pipe()
    encoder = _encoder()
    out_pipe, populated = _run(pipe, encoder, wildcard_text="a cat", images={}).args

    _, kwargs = encoder.execute.call_args
    assert kwargs["vae"] is None
    assert kwargs["images"] == {}
    assert out_pipe["positive"] == "POS"
    assert out_pipe["negative"] == "NEG"
    assert out_pipe["samples"] is pipe["samples"]
    assert populated == "a cat"


def test_i2i_image_1_size_replaces_latent_with_reference_size():
    pipe = _pipe(batch_size=3)
    encoder = _encoder(latent_hw=(96, 64))
    img1, img2, img10 = (torch.rand(1, 32, 32, 3) for _ in range(3))
    images = {"image_10": img10, "image_2": img2, "image_1": img1, "image_3": None}

    out_pipe, _ = _run(
        pipe, encoder, wildcard_text="<image1> wears <image2>", images=images, output_size="image_1"
    ).args

    _, kwargs = encoder.execute.call_args
    assert kwargs["vae"] is pipe["vae"]
    assert list(kwargs["images"]) == ["image_1", "image_2", "image_10"]
    assert out_pipe["samples"]["samples"].shape == (3, 64, 96, 64)
    assert "downscale_ratio_spacial" not in out_pipe["samples"]
    assert (out_pipe["loader_settings"]["clip_width"], out_pipe["loader_settings"]["clip_height"]) == (1024, 1536)
    # 入力 pipe は変更しない
    assert pipe["samples"]["samples"].shape == (3, 4, 128, 128)


def test_i2i_default_output_size_keeps_loader_latent():
    """既定 (loader) では参照画像があっても Loader の width / height の latent のまま。"""
    pipe = _pipe(batch_size=2)
    encoder = _encoder(latent_hw=(96, 64))
    imgs = {"image_1": torch.rand(1, 32, 32, 3), "image_2": torch.rand(1, 64, 16, 3)}

    out_pipe, _ = _run(pipe, encoder, wildcard_text="<image1> and <image2>", images=imgs).args

    _, kwargs = encoder.execute.call_args
    assert kwargs["vae"] is pipe["vae"]
    assert list(kwargs["images"]) == ["image_1", "image_2"]
    assert out_pipe["samples"] is pipe["samples"]
    assert out_pipe["loader_settings"]["clip_width"] == 1024


def test_i2i_without_vae_raises():
    pipe = _pipe()
    pipe["vae"] = None
    with pytest.raises(ValueError, match="VAE"):
        _run(pipe, _encoder(), wildcard_text="x", images={"image_1": torch.rand(1, 8, 8, 3)})


def test_empty_pipe_raises_clear_error():
    """上流 Loader のバイパス等で pipe が None のとき、配線を指すエラーにする。"""
    with pytest.raises(ValueError, match="pipe input is empty"):
        _run(None, _encoder(), wildcard_text="x", images={})


# --- kv_cache / attention（ComfyUI 本体ノードの橋渡し）---------------------------


class _V3Node:
    """V3 形式の本体ノード（GET_SCHEMA を持ち execute を classmethod で呼ぶ）の代役。"""

    calls: list = []
    GET_SCHEMA = object()

    @classmethod
    def execute(cls, model, **kwargs):
        cls.calls.append(kwargs)
        patched = MagicMock(name="patched_model")
        patched.source = model
        return MagicMock(args=(patched,))


def _core_nodes(**nodes_by_id):
    return patch("nodes.NODE_CLASS_MAPPINGS", nodes_by_id, create=True)


def _fresh_core_node():
    return type("CoreNode", (_V3Node,), {"calls": []})


def test_default_options_do_not_touch_model_even_if_core_nodes_missing():
    pipe = _pipe()
    with _core_nodes():  # 本体ノード無し（旧版 ComfyUI 相当）
        out_pipe, _ = _run(pipe, _encoder(), wildcard_text="a cat", images={}).args
    assert out_pipe["model"] is pipe["model"]


def test_kv_cache_and_attention_are_applied_to_pipe_model():
    pipe = _pipe()
    cache, attn = _fresh_core_node(), _fresh_core_node()
    with _core_nodes(QwenImage21Cache=cache, ModelAttentionBackend=attn):
        out_pipe, _ = _run(
            pipe, _encoder(), wildcard_text="a cat", images={},
            kv_cache_device="cpu", kv_cache_dtype="int8", attention="pytorch attention",
        ).args

    assert cache.calls == [{"device": "cpu", "dtype": "int8"}]
    assert attn.calls == [{"attention": "pytorch attention"}]
    # キャッシュ → アテンションの順にかかり、最終的な model が Pipe に入る
    assert out_pipe["model"].source.source is pipe["model"]


def test_only_non_default_option_calls_its_core_node():
    cache, attn = _fresh_core_node(), _fresh_core_node()
    with _core_nodes(QwenImage21Cache=cache, ModelAttentionBackend=attn):
        _run(_pipe(), _encoder(), wildcard_text="x", images={}, kv_cache_device="off")
    assert cache.calls == [{"device": "off", "dtype": "default"}]
    assert attn.calls == []


def test_v1_core_node_is_supported():
    class V1Node:
        FUNCTION = "apply"

        def apply(self, model, attention):
            return (("patched", model, attention),)

    pipe = _pipe()
    with _core_nodes(ModelAttentionBackend=V1Node):
        out_pipe, _ = _run(
            pipe, _encoder(), wildcard_text="x", images={}, attention="comfy kitchen attention"
        ).args
    assert out_pipe["model"] == ("patched", pipe["model"], "comfy kitchen attention")


def test_non_default_option_without_core_node_raises_clear_error():
    with _core_nodes():
        with pytest.raises(ValueError, match="QwenImage21Cache.*Please update ComfyUI"):
            _run(_pipe(), _encoder(), wildcard_text="x", images={}, kv_cache_dtype="int4")
        with pytest.raises(ValueError, match="ModelAttentionBackend.*Please update ComfyUI"):
            _run(_pipe(), _encoder(), wildcard_text="x", images={}, attention="pytorch attention")


def test_lora_applies_only_positive_and_keeps_unexpanded_dynamic_text():
    pipe = _pipe()
    encoder = _encoder()
    with patch("nodes.prompt_qwen_image._apply_loras", return_value=("model", "clip", ["positive.safetensors"])) as apply:
        out, populated = _run(
            pipe, encoder,
            wildcard_text="__colors__ <lora:positive:.7>",
            negative_text="{red|blue} <lora:negative:.2>",
        ).args
    assert populated == "__colors__ <lora:positive:.7>"
    assert apply.call_args.args[2] == [("positive", .7, .7, None, None, None, None)]
    assert encoder.execute.call_args.args[:3] == ("clip", "__colors__ ", "{red|blue} ")
    assert out["_applied_loras"] == {"positive"}


def test_lora_and_core_model_options_compose_without_losing_the_applied_model():
    pipe = _pipe()
    cache = _fresh_core_node()
    with _core_nodes(QwenImage21Cache=cache), patch(
        "nodes.prompt_qwen_image._apply_loras", return_value=("lora-model", "lora-clip", ["positive"])
    ):
        out, _ = _run(
            pipe, _encoder(), wildcard_text="a cat <lora:positive:.7>", kv_cache_device="cpu"
        ).args
    assert out["model"].source == "lora-model"
    assert out["clip"] == "lora-clip"
    assert out["_applied_loras"] == {"positive"}
