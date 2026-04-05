"""SAX_Bridge_Upscaler ノードのテスト。"""

import pytest
import torch
from unittest.mock import MagicMock, patch

from nodes.upscaler import (
    SAX_Bridge_Upscaler,
    _pixel_upscale,
    _esrgan_upscale,
)


def _make_images(b: int = 1, h: int = 16, w: int = 16, c: int = 3) -> torch.Tensor:
    """(B, H, W, C) 形式のランダム画像を生成する。"""
    return torch.rand(b, h, w, c)


class TestPixelUpscale:
    def test_shape_after_upscale(self):
        images = _make_images(1, 16, 16, 3)
        with patch("comfy.utils.common_upscale") as mock_upscale:
            # common_upscale は (B, C, H, W) を返す想定
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = _pixel_upscale(images, 32, 32, "lanczos")
        assert result.shape == (1, 32, 32, 3)

    def test_passes_method_and_size(self):
        images = _make_images(1, 16, 16, 3)
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 48)
            _pixel_upscale(images, 32, 48, "bicubic")
        args, _ = mock_upscale.call_args
        # args: (bchw, target_w, target_h, method, "disabled")
        assert args[1] == 48
        assert args[2] == 32
        assert args[3] == "bicubic"
        assert args[4] == "disabled"


class TestEsrganUpscale:
    def test_no_resize_when_target_matches(self):
        images = _make_images(1, 16, 16, 3)
        upscaled_fake = torch.rand(1, 32, 32, 3)
        mock_node = MagicMock()
        mock_node.upscale.return_value = (upscaled_fake,)
        with patch("comfy_extras.nodes_upscale_model.ImageUpscaleWithModel", return_value=mock_node):
            result = _esrgan_upscale(MagicMock(), images, 32, 32, "lanczos")
        assert result.shape == (1, 32, 32, 3)

    def test_resize_when_target_mismatches(self):
        images = _make_images(1, 16, 16, 3)
        upscaled_fake = torch.rand(1, 64, 64, 3)  # モデル出力 4x
        mock_node = MagicMock()
        mock_node.upscale.return_value = (upscaled_fake,)
        with patch("comfy_extras.nodes_upscale_model.ImageUpscaleWithModel", return_value=mock_node), \
             patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = _esrgan_upscale(MagicMock(), images, 32, 32, "bilinear")
        assert result.shape == (1, 32, 32, 3)
        mock_upscale.assert_called_once()


class TestUpscalerExecute:
    def _make_pipe(self, h: int = 16, w: int = 16) -> dict:
        return {
            "model": MagicMock(),
            "clip": MagicMock(),
            "vae": MagicMock(),
            "images": _make_images(1, h, w, 3),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "seed": 42,
            "loader_settings": {"steps": 20, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal"},
        }

    def test_missing_images_raises(self):
        pipe = self._make_pipe()
        pipe["images"] = None
        with pytest.raises(ValueError, match="does not contain images"):
            SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.0,
            )

    def test_pixel_upscale_no_model(self):
        pipe = self._make_pipe(16, 16)
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.0,
            )
        # (B, H, W, C) = (1, 32, 32, 3)
        assert result[1].shape == (1, 32, 32, 3)
        assert result[0] is not pipe
        assert torch.equal(result[0]["images"], result[1])

    def test_scale_alignment_to_8px(self):
        pipe = self._make_pipe(16, 16)
        # scale_by=1.1 → 17.6 → 17 → 16 (8px アライン)
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 16, 16)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=1.1, denoise=0.0,
            )
        # 16 → 17 → align 16 == 元サイズなので no-op ブランチ（upscale は呼ばれない）
        assert result[1].shape == (1, 16, 16, 3)
        mock_upscale.assert_not_called()

    def test_no_size_change_skips_upscale(self):
        pipe = self._make_pipe(16, 16)
        original_images = pipe["images"]
        with patch("comfy.utils.common_upscale") as mock_upscale:
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=1.0, denoise=0.0,
            )
        # サイズ変更なしならそのまま（ただし clamp は通る）。upscale は呼ばれない
        assert result[1].shape == (1, 16, 16, 3)
        assert torch.allclose(result[1], torch.clamp(original_images, 0.0, 1.0))
        mock_upscale.assert_not_called()

    def test_output_clamped_to_valid_range(self):
        pipe = self._make_pipe(16, 16)
        pipe["images"] = torch.rand(1, 16, 16, 3) * 2.0 - 0.5  # -0.5〜1.5
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32) * 2.0 - 0.5
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.0,
            )
        assert result[1].min() >= 0.0
        assert result[1].max() <= 1.0

    def test_esrgan_mode_used_when_model_set(self):
        pipe = self._make_pipe(16, 16)
        fake_model = MagicMock()
        fake_upscaled = torch.rand(1, 64, 64, 3)
        mock_loader = MagicMock()
        mock_loader.load_model.return_value = (fake_model,)
        mock_node = MagicMock()
        mock_node.upscale.return_value = (fake_upscaled,)
        with patch("comfy_extras.nodes_upscale_model.UpscaleModelLoader", return_value=mock_loader), \
             patch("comfy_extras.nodes_upscale_model.ImageUpscaleWithModel", return_value=mock_node), \
             patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="my_esrgan.pth", method="bilinear",
                scale_by=2.0, denoise=0.0,
            )
        mock_loader.load_model.assert_called_once_with("my_esrgan.pth")
        assert result[1].shape == (1, 32, 32, 3)

    def test_denoise_triggers_i2i(self):
        pipe = self._make_pipe(16, 16)
        # VAE encode / decode は i2i 経路でのみ呼ばれる
        latent_tensor = torch.rand(1, 4, 4, 4)
        decoded = torch.rand(1, 32, 32, 3)
        pipe["vae"].encode.return_value = latent_tensor
        pipe["vae"].decode.return_value = decoded

        sampler_result = ({"samples": torch.rand(1, 4, 4, 4)},)
        with patch("comfy.utils.common_upscale") as mock_upscale, \
             patch("nodes.common_ksampler", return_value=sampler_result) as mock_ksampler:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.5, steps_override=0, cfg_override=0.0,
            )
        mock_ksampler.assert_called_once()
        pipe["vae"].encode.assert_called_once()
        pipe["vae"].decode.assert_called_once()
        # i2i 経路で decoded が最終結果
        assert result[1].shape == decoded.shape
        # clamp 処理後の値域を厳密に検証
        assert result[1].min() >= 0.0 and result[1].max() <= 1.0

    def test_denoise_zero_skips_i2i(self):
        pipe = self._make_pipe(16, 16)
        with patch("comfy.utils.common_upscale") as mock_upscale, \
             patch("nodes.common_ksampler") as mock_ksampler:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.0,
            )
        mock_ksampler.assert_not_called()
        pipe["vae"].encode.assert_not_called()

    def test_missing_model_skips_i2i(self):
        pipe = self._make_pipe(16, 16)
        pipe["model"] = None  # i2i に必要な要素が欠落
        with patch("comfy.utils.common_upscale") as mock_upscale, \
             patch("nodes.common_ksampler") as mock_ksampler:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.5,
            )
        mock_ksampler.assert_not_called()
        assert result[1].shape == (1, 32, 32, 3)

    def test_steps_override_used(self):
        pipe = self._make_pipe(16, 16)
        pipe["vae"].encode.return_value = torch.rand(1, 4, 4, 4)
        pipe["vae"].decode.return_value = torch.rand(1, 32, 32, 3)
        sampler_result = ({"samples": torch.rand(1, 4, 4, 4)},)
        with patch("comfy.utils.common_upscale") as mock_upscale, \
             patch("nodes.common_ksampler", return_value=sampler_result) as mock_ksampler:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.5, steps_override=15, cfg_override=0.0,
            )
        # common_ksampler 呼び出し引数: (model, seed, steps, cfg, sampler_name, scheduler, positive, negative, samples, denoise=...)
        args, kwargs = mock_ksampler.call_args
        assert args[2] == 15  # steps
        assert args[3] == 7.0  # cfg (loader_settings から継承)

    def test_cfg_override_used(self):
        pipe = self._make_pipe(16, 16)
        pipe["vae"].encode.return_value = torch.rand(1, 4, 4, 4)
        pipe["vae"].decode.return_value = torch.rand(1, 32, 32, 3)
        sampler_result = ({"samples": torch.rand(1, 4, 4, 4)},)
        with patch("comfy.utils.common_upscale") as mock_upscale, \
             patch("nodes.common_ksampler", return_value=sampler_result) as mock_ksampler:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.5, steps_override=0, cfg_override=3.5,
            )
        args, _ = mock_ksampler.call_args
        assert args[2] == 20  # steps (loader_settings から継承)
        assert args[3] == 3.5  # cfg override

    def test_denoise_passed_to_ksampler(self):
        pipe = self._make_pipe(16, 16)
        pipe["vae"].encode.return_value = torch.rand(1, 4, 4, 4)
        pipe["vae"].decode.return_value = torch.rand(1, 32, 32, 3)
        sampler_result = ({"samples": torch.rand(1, 4, 4, 4)},)
        with patch("comfy.utils.common_upscale") as mock_upscale, \
             patch("nodes.common_ksampler", return_value=sampler_result) as mock_ksampler:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.35,
            )
        _, kwargs = mock_ksampler.call_args
        assert kwargs.get("denoise") == 0.35

    def test_preserves_other_pipe_fields(self):
        pipe = self._make_pipe(16, 16)
        pipe["seed"] = 999
        pipe["loader_settings"] = {"steps": 25, "cfg": 5.0, "sampler_name": "dpm", "scheduler": "karras"}
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.0,
            )
        assert result[0]["seed"] == 999
        assert result[0]["loader_settings"]["steps"] == 25

    def test_original_pipe_images_unchanged(self):
        pipe = self._make_pipe(16, 16)
        original_images = pipe["images"].clone()
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, 32, 32)
            SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=2.0, denoise=0.0,
            )
        assert torch.equal(pipe["images"], original_images)

    @pytest.mark.parametrize("scale_by,expected_size", [
        (2.0, 32),
        (3.0, 48),
        (0.5, 8),
        (1.5, 24),
    ])
    def test_parametrized_scale(self, scale_by, expected_size):
        pipe = self._make_pipe(16, 16)
        with patch("comfy.utils.common_upscale") as mock_upscale:
            mock_upscale.return_value = torch.rand(1, 3, expected_size, expected_size)
            result = SAX_Bridge_Upscaler.execute(
                pipe, upscale_model_name="None", method="lanczos",
                scale_by=scale_by, denoise=0.0,
            )
        assert result[1].shape == (1, expected_size, expected_size, 3)
        # common_upscale に渡された target_w / target_h がサイズ計算ロジックから導かれることを検証
        # _pixel_upscale 呼び出し引数: (bchw, target_w, target_h, method, "disabled")
        mock_upscale.assert_called_once()
        args, _ = mock_upscale.call_args
        assert args[1] == expected_size  # target_w
        assert args[2] == expected_size  # target_h
