"""detailer.py の _run_detail_loop 関数のテスト — mock sampler でのフルループ検証。"""

import pytest
import torch
from unittest.mock import MagicMock, patch

from nodes.detailer import _run_detail_loop


def _make_vae(downscale=8):
    """ダミーの VAE — encode で H,W を 1/downscale に、decode で元に戻す。"""
    vae = MagicMock()

    def encode(images_bhwc):
        # images: (B, H, W, C) -> latent (B, 4, H/8, W/8)
        b, h, w, c = images_bhwc.shape
        return torch.zeros(b, 4, h // downscale, w // downscale, dtype=torch.float32)

    def decode(samples_bchw):
        # latent (B, 4, H/8, W/8) -> images (B, H, W, 3)
        b, _, lh, lw = samples_bchw.shape
        return torch.rand(b, lh * downscale, lw * downscale, 3, dtype=torch.float32)

    vae.encode = MagicMock(side_effect=encode)
    vae.decode = MagicMock(side_effect=decode)
    return vae


def _mock_ksampler(model, seed, steps, cfg, sampler_name, scheduler_name,
                   positive, negative, samples_dict, denoise=1.0):
    """common_ksampler のモック — 入力 samples をそのまま返す。"""
    return ({"samples": samples_dict["samples"].clone()},)


def _make_mask(b, h, w, center_region=True):
    """テスト用のマスク — center_region=True なら中央 1/2 領域を 1.0。"""
    mask = torch.zeros(b, h, w, dtype=torch.float32)
    if center_region:
        mask[:, h // 4: 3 * h // 4, w // 4: 3 * w // 4] = 1.0
    return mask


def _common_kwargs():
    return dict(
        model=MagicMock(),
        positive=MagicMock(),
        negative=MagicMock(),
        seed=42,
        steps=4,
        cfg=7.0,
        sampler_name="euler",
        scheduler_name="normal",
        denoise=0.5,
        denoise_decay=0.0,
        cycle=1,
        noise_mask_feather=0,
        blend_feather=0,
        crop_factor=1.5,
        context_blur_sigma=0.0,
        context_blur_radius=0,
    )


class TestRunDetailLoopBasic:
    def test_empty_mask_returns_none(self):
        # 全 0 mask → get_bbox_from_mask が None を返し、ループは None を返す
        images = torch.rand(1, 64, 64, 3)
        mask = torch.zeros(1, 64, 64)
        vae = _make_vae()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask, **_common_kwargs(),
            )
        assert result is None

    def test_single_cycle_returns_image_with_same_shape(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask, **_common_kwargs(),
            )
        assert result is not None
        assert result.shape == images.shape

    def test_ksampler_called_once_per_cycle(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        ks_mock = MagicMock(side_effect=_mock_ksampler)
        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        with patch("nodes.detailer.nodes.common_ksampler", ks_mock):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert ks_mock.call_count == 3

    def test_vae_encode_decode_called_per_cycle(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["cycle"] = 2
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert vae.encode.call_count == 2
        assert vae.decode.call_count == 2

    def test_none_mask_uses_full_image(self):
        # mask=None → 全面 1 の mask が生成される
        images = torch.rand(1, 64, 64, 3)
        vae = _make_vae()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=None, **_common_kwargs(),
            )
        assert result is not None
        assert result.shape == images.shape


class TestDenoiseDecay:
    def test_denoise_decreases_across_cycles(self):
        """denoise_decay > 0 で各サイクルの current_denoise が単調減少する"""
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured_denoise = []

        def capture_ksampler(model, seed, steps, cfg, s_name, sched,
                             pos, neg, samples_dict, denoise=1.0):
            captured_denoise.append(denoise)
            return ({"samples": samples_dict["samples"].clone()},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["denoise"] = 1.0
        kwargs["denoise_decay"] = 0.9
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture_ksampler):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)

        assert len(captured_denoise) == 3
        # 最初は denoise * 1.0、それ以降は減衰
        assert captured_denoise[0] == pytest.approx(1.0)
        assert captured_denoise[1] < captured_denoise[0]
        assert captured_denoise[2] < captured_denoise[1]

    def test_no_decay_keeps_denoise_constant(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured.append(denoise)
            return ({"samples": sd["samples"].clone()},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["denoise"] = 0.5
        kwargs["denoise_decay"] = 0.0
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert all(d == pytest.approx(0.5) for d in captured)

    def test_seed_increments_per_cycle(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured_seeds = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured_seeds.append(seed)
            return ({"samples": sd["samples"].clone()},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["seed"] = 100
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert captured_seeds == [100, 101, 102]


class TestOptionalFeatures:
    def test_noise_mask_feather_enabled(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["noise_mask_feather"] = 5
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert result is not None
        assert result.shape == images.shape

    def test_context_blur_applied(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["context_blur_sigma"] = 2.0
        kwargs["context_blur_radius"] = 4
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert result is not None
        assert result.shape == images.shape

    def test_shadow_enhance_applied(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask,
                shadow_enhance=0.5, shadow_decay=0.0,
                **kwargs,
            )
        assert result is not None
        assert result.shape == images.shape

    def test_edge_weight_applied(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask,
                edge_weight=0.3, edge_blur_sigma=1.0,
                **kwargs,
            )
        assert result is not None
        assert result.shape == images.shape

    def test_latent_noise_intensity_applied(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask,
                latent_noise_intensity=0.5, noise_type="gaussian",
                **kwargs,
            )
        assert result is not None
        assert result.shape == images.shape

    def test_latent_noise_uniform_type(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask,
                latent_noise_intensity=0.5, noise_type="uniform",
                **kwargs,
            )
        assert result is not None

    def test_mask_resized_when_shape_mismatch(self):
        # mask が image サイズと一致しない場合は interpolate で揃える
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 32, 32)  # 異なるサイズ
        vae = _make_vae()
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask, **_common_kwargs(),
            )
        assert result is not None
        assert result.shape == images.shape


class TestCropFactor:
    def test_larger_crop_factor_larger_bbox(self):
        """crop_factor が大きいほど VAE encode される領域が大きくなる"""
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)

        sizes = []
        for cf in [1.0, 3.0]:
            vae = _make_vae()
            kwargs = _common_kwargs()
            kwargs["crop_factor"] = cf
            with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
                _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
            # encode が受け取った画像のサイズを記録
            encoded_arg = vae.encode.call_args[0][0]
            sizes.append(encoded_arg.shape[1] * encoded_arg.shape[2])

        assert sizes[1] > sizes[0]
