"""SAX_Bridge_Finisher ノードのテスト。"""

import pytest
import torch

from nodes.finisher import (
    SAX_Bridge_Finisher,
    _apply_smooth,
    _apply_bloom,
    _apply_vignette,
    _apply_color_correction,
    _apply_color_temp,
)


def _make_rgb(b: int = 1, h: int = 16, w: int = 16) -> torch.Tensor:
    """(B, C, H, W) 形式のランダム画像を生成する。"""
    return torch.rand(b, 3, h, w)


def _make_images(b: int = 1, h: int = 16, w: int = 16, c: int = 3) -> torch.Tensor:
    """(B, H, W, C) 形式のランダム画像を生成する。"""
    return torch.rand(b, h, w, c)


class TestApplySmooth:
    def test_zero_strength_passthrough(self):
        rgb = _make_rgb()
        result = _apply_smooth(rgb, 0.0)
        # strength=0 は high を維持するため入力と一致
        assert torch.allclose(result, rgb, atol=1e-5)

    def test_shape_preserved(self):
        rgb = _make_rgb(1, 32, 32)
        result = _apply_smooth(rgb, 0.5)
        assert result.shape == rgb.shape

    def test_strength_changes_output(self):
        rgb = _make_rgb()
        result = _apply_smooth(rgb, 0.8)
        assert not torch.allclose(result, rgb)


class TestApplyBloom:
    def test_shape_preserved(self):
        rgb = _make_rgb(1, 32, 32)
        result = _apply_bloom(rgb, 0.5, threshold=0.7, radius=4.0)
        assert result.shape == rgb.shape

    def test_bloom_brightens(self):
        # 明部を持つ画像でブルームは輝度を厳密に増加させる
        rgb = torch.full((1, 3, 16, 16), 0.9)
        result = _apply_bloom(rgb, 1.0, threshold=0.5, radius=2.0)
        assert result.mean() > rgb.mean()


class TestApplyVignette:
    def test_corners_darker_than_center(self):
        rgb = torch.ones(1, 3, 32, 32)
        result = _apply_vignette(rgb, 0.8)
        center = result[0, 0, 16, 16].item()
        corner = result[0, 0, 0, 0].item()
        assert corner < center

    def test_zero_strength_identity(self):
        rgb = _make_rgb()
        result = _apply_vignette(rgb, 0.0)
        # GPU 演算誤差を吸収する tolerance で恒等性を検証
        assert torch.allclose(result, rgb, atol=1e-5)

    def test_shape_preserved(self):
        rgb = _make_rgb(2, 16, 24)
        result = _apply_vignette(rgb, 0.5)
        assert result.shape == rgb.shape


class TestApplyColorCorrection:
    def test_full_strength_matches_stats(self):
        rgb = torch.rand(1, 3, 16, 16)
        reference = torch.rand(1, 3, 16, 16) * 0.5 + 0.2
        result = _apply_color_correction(rgb, reference, 1.0)
        # shape を明示的に揃えて broadcasting 依存を除去
        ref_mean = reference.mean(dim=(2, 3))  # (B, C)
        res_mean = result.mean(dim=(2, 3))  # (B, C)
        assert ref_mean.shape == res_mean.shape
        assert torch.allclose(ref_mean, res_mean, atol=1e-4)

    def test_zero_strength_identity(self):
        rgb = _make_rgb()
        reference = _make_rgb()
        result = _apply_color_correction(rgb, reference, 0.0)
        assert torch.allclose(result, rgb)

    def test_shape_preserved(self):
        rgb = _make_rgb(1, 16, 16)
        reference = _make_rgb(1, 32, 32)  # 異なる解像度
        result = _apply_color_correction(rgb, reference, 0.5)
        assert result.shape == rgb.shape


class TestApplyColorTemp:
    def test_warm_increases_red(self):
        rgb = torch.full((1, 3, 8, 8), 0.5)
        result = _apply_color_temp(rgb, 1.0)  # 暖色
        assert result[:, 0].mean() > rgb[:, 0].mean()
        assert result[:, 2].mean() < rgb[:, 2].mean()

    def test_cool_decreases_red(self):
        rgb = torch.full((1, 3, 8, 8), 0.5)
        result = _apply_color_temp(rgb, -1.0)  # 寒色
        assert result[:, 0].mean() < rgb[:, 0].mean()
        assert result[:, 2].mean() > rgb[:, 2].mean()

    def test_zero_identity(self):
        rgb = _make_rgb()
        result = _apply_color_temp(rgb, 0.0)
        assert torch.allclose(result, rgb)

    def test_clamped_to_valid_range(self):
        rgb = torch.full((1, 3, 8, 8), 0.98)
        result = _apply_color_temp(rgb, 1.0)
        assert result.max() <= 1.0
        assert result.min() >= 0.0


class TestFinisherExecute:
    def _make_pipe(self, h: int = 16, w: int = 16, c: int = 3) -> dict:
        return {
            "images": _make_images(1, h, w, c),
            "seed": 42,
            "loader_settings": {"steps": 20, "cfg": 7.0},
        }

    def test_no_images_returns_pipe(self):
        pipe = {"images": None}
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.5, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        assert result[0] is pipe
        assert result[1] is None

    def test_all_zero_passthrough(self):
        pipe = self._make_pipe()
        original_images = pipe["images"]
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.0, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        # パラメータすべて 0 なら元の pipe / images を返す
        assert result[0] is pipe
        assert torch.equal(result[1], original_images)

    def test_smooth_only(self):
        pipe = self._make_pipe()
        original_images = pipe["images"]
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.5, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        # 新しい pipe が返る
        assert result[0] is not pipe
        assert result[1].shape == original_images.shape

    def test_output_within_range(self):
        pipe = self._make_pipe()
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.3, bloom=0.5, bloom_threshold=0.5, bloom_radius=4.0,
            vignette=0.4, color_temp=0.5, color_correction=0.0,
        )
        # clamp により 0.0-1.0 に収まる
        assert result[1].min() >= 0.0
        assert result[1].max() <= 1.0

    def test_preserves_other_pipe_fields(self):
        pipe = self._make_pipe()
        pipe["seed"] = 999
        pipe["loader_settings"] = {"steps": 25}
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.5, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        assert result[0]["seed"] == 999
        assert result[0]["loader_settings"]["steps"] == 25

    def test_updates_pipe_images(self):
        pipe = self._make_pipe()
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.5, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        # pipe["images"] と出力 images は同一
        assert torch.equal(result[0]["images"], result[1])

    def test_original_pipe_unchanged(self):
        pipe = self._make_pipe()
        original_images = pipe["images"].clone()
        SAX_Bridge_Finisher.execute(
            pipe, smooth=0.5, bloom=0.3, bloom_threshold=0.7, bloom_radius=4.0,
            vignette=0.2, color_temp=0.1, color_correction=0.0,
        )
        # 元 pipe の images は変更されていない
        assert torch.equal(pipe["images"], original_images)

    def test_output_shape_matches_input(self):
        pipe = self._make_pipe(h=24, w=32)
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.3, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        assert result[1].shape == (1, 24, 32, 3)

    def test_alpha_channel_preserved(self):
        # 4ch（RGBA）入力時、アルファチャネルはそのまま維持される
        pipe = self._make_pipe(c=4)
        original_alpha = pipe["images"][:, :, :, 3:].clone()
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.5, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.0,
        )
        assert result[1].shape[-1] == 4
        assert torch.equal(result[1][:, :, :, 3:], original_alpha)

    def test_color_correction_with_reference(self):
        pipe = self._make_pipe()
        reference = _make_images(1, 16, 16, 3)
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.0, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.8,
            reference_image=reference,
        )
        assert result[0] is not pipe
        assert result[1].shape == pipe["images"].shape

    def test_color_correction_without_reference_skipped(self):
        # color_correction > 0 でも reference_image=None なら補正はスキップ
        pipe = self._make_pipe()
        original_images = pipe["images"]
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=0.0, bloom=0.0, bloom_threshold=0.7, bloom_radius=8.0,
            vignette=0.0, color_temp=0.0, color_correction=0.8,
            reference_image=None,
        )
        # color_correction のみ指定かつ reference なしなら all-zero チェックは通らないため
        # 新 pipe は返るが、内容は clamp 後の元画像と等価
        assert result[0] is not pipe
        assert torch.allclose(result[1][:, :, :, :3], original_images[:, :, :, :3], atol=1e-5)

    @pytest.mark.parametrize("smooth,bloom,vignette,color_temp", [
        (0.5, 0.0, 0.0, 0.0),
        (0.0, 0.5, 0.0, 0.0),
        (0.0, 0.0, 0.5, 0.0),
        (0.0, 0.0, 0.0, 0.5),
        (0.0, 0.0, 0.0, -0.5),
        (0.2, 0.3, 0.2, 0.1),
    ])
    def test_parametrized_effects(self, smooth, bloom, vignette, color_temp):
        pipe = self._make_pipe()
        result = SAX_Bridge_Finisher.execute(
            pipe, smooth=smooth, bloom=bloom, bloom_threshold=0.7, bloom_radius=4.0,
            vignette=vignette, color_temp=color_temp, color_correction=0.0,
        )
        assert result[1].shape == pipe["images"].shape
        assert result[1].min() >= 0.0
        assert result[1].max() <= 1.0
