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
    with patch("nodes.prompt_qwen_image._get_upstream_encoder", return_value=encoder), \
         patch("nodes.prompt_qwen_image._get_impact_wildcards", return_value=None):
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


def test_i2i_passes_images_in_order_and_uses_reference_size():
    pipe = _pipe(batch_size=3)
    encoder = _encoder(latent_hw=(96, 64))
    img1, img2, img10 = (torch.rand(1, 32, 32, 3) for _ in range(3))
    images = {"image_10": img10, "image_2": img2, "image_1": img1, "image_3": None}

    out_pipe, _ = _run(pipe, encoder, wildcard_text="<image1> wears <image2>", images=images).args

    _, kwargs = encoder.execute.call_args
    assert kwargs["vae"] is pipe["vae"]
    assert list(kwargs["images"]) == ["image_1", "image_2", "image_10"]
    assert out_pipe["samples"]["samples"].shape == (3, 64, 96, 64)
    assert "downscale_ratio_spacial" not in out_pipe["samples"]
    assert (out_pipe["loader_settings"]["clip_width"], out_pipe["loader_settings"]["clip_height"]) == (1024, 1536)
    # 入力 pipe は変更しない
    assert pipe["samples"]["samples"].shape == (3, 4, 128, 128)


def test_i2i_without_vae_raises():
    pipe = _pipe()
    pipe["vae"] = None
    with pytest.raises(ValueError, match="VAE"):
        _run(pipe, _encoder(), wildcard_text="x", images={"image_1": torch.rand(1, 8, 8, 3)})


def test_empty_pipe_raises_clear_error():
    """上流 Loader のバイパス等で pipe が None のとき、配線を指すエラーにする。"""
    with pytest.raises(ValueError, match="pipe input is empty"):
        _run(None, _encoder(), wildcard_text="x", images={})
