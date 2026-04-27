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

    def test_vae_encode_decode_called_per_cycle_in_image_roundtrip(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["cycle"] = 2
        kwargs["cycle_mode"] = "image_roundtrip"
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


class TestCycleModeLatentPersistent:
    """cycle_mode='latent_persistent' は VAE encode/decode を各 1 回に削減する。"""

    def test_vae_called_once_regardless_of_cycle(self):
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["cycle_mode"] = "latent_persistent"
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert vae.encode.call_count == 1
        assert vae.decode.call_count == 1

    def test_default_mode_is_latent_persistent(self):
        # cycle_mode を渡さない場合のデフォルトが latent_persistent であることを保証する
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert vae.encode.call_count == 1
        assert vae.decode.call_count == 1

    def test_ksampler_still_called_per_cycle(self):
        # latent_persistent でも ksampler は cycle 回呼ばれる
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        ks_mock = MagicMock(side_effect=_mock_ksampler)
        kwargs = _common_kwargs()
        kwargs["cycle"] = 4
        kwargs["cycle_mode"] = "latent_persistent"
        with patch("nodes.detailer.nodes.common_ksampler", ks_mock):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert ks_mock.call_count == 4

    def test_cycle_one_equivalent_vae_count_between_modes(self):
        # cycle=1 では両モードで VAE 呼び出し回数が等しい
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)

        vae_lp = _make_vae()
        kwargs_lp = _common_kwargs()
        kwargs_lp["cycle_mode"] = "latent_persistent"
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            _run_detail_loop(vae=vae_lp, images=images, mask=mask, **kwargs_lp)

        vae_ir = _make_vae()
        kwargs_ir = _common_kwargs()
        kwargs_ir["cycle_mode"] = "image_roundtrip"
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            _run_detail_loop(vae=vae_ir, images=images, mask=mask, **kwargs_ir)

        assert vae_lp.encode.call_count == vae_ir.encode.call_count == 1
        assert vae_lp.decode.call_count == vae_ir.decode.call_count == 1

    def test_denoise_decay_still_applies_in_latent_persistent(self):
        # latent_persistent でも denoise_decay は cycle 毎に効く
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured.append(denoise)
            return ({"samples": sd["samples"].clone()},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["denoise"] = 1.0
        kwargs["denoise_decay"] = 0.9
        kwargs["cycle_mode"] = "latent_persistent"
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)

        assert len(captured) == 3
        assert captured[0] > captured[1] > captured[2]

    def test_shadow_decay_ignored_in_latent_persistent(self):
        # latent_persistent では shadow grain は初回のみ注入される
        # → encode は 1 回しか呼ばれないため、grain の影響はその 1 回の入力にしか乗らない
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["cycle_mode"] = "latent_persistent"
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
            result = _run_detail_loop(
                vae=vae, images=images, mask=mask,
                shadow_enhance=0.5, shadow_decay=1.0,
                **kwargs,
            )
        # encode は 1 回のみ → cycle 毎の grain 再注入がない
        assert vae.encode.call_count == 1
        assert result is not None

    def test_latent_persistent_chains_latent_across_cycles(self):
        # 直前 cycle の ksampler 出力が次 cycle の入力になることを確認
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured_inputs = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured_inputs.append(sd["samples"].clone())
            # 出力は入力に微小ノイズを加えたものとして区別可能にする
            output = sd["samples"] + 0.01 * seed
            return ({"samples": output},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["cycle_mode"] = "latent_persistent"
        kwargs["seed"] = 1
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)

        # i=0 は encode 直後の latent
        # i=1 は i=0 の出力（+0.01）が入力
        # i=2 は i=1 の出力（+0.02）が入力
        assert len(captured_inputs) == 3
        diff_01 = (captured_inputs[1] - captured_inputs[0]).abs().mean().item()
        diff_12 = (captured_inputs[2] - captured_inputs[1]).abs().mean().item()
        assert diff_01 > 0
        assert diff_12 > 0

    def test_invalid_cycle_mode_logs_warning_and_falls_back(self, caplog):
        # 想定外の値が渡されたときの挙動: 警告ログを出して image_roundtrip にフォールバック
        import logging
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        kwargs = _common_kwargs()
        kwargs["cycle"] = 2
        kwargs["cycle_mode"] = "unknown_mode"
        with caplog.at_level(logging.WARNING, logger="nodes.detailer"):
            with patch("nodes.detailer.nodes.common_ksampler", side_effect=_mock_ksampler):
                result = _run_detail_loop(vae=vae, images=images, mask=mask, **kwargs)
        assert any("unknown_mode" in rec.getMessage() for rec in caplog.records)
        assert vae.encode.call_count == 2
        assert vae.decode.call_count == 2
        assert result is not None

    def test_latent_noise_does_not_accumulate_across_cycles(self):
        # latent_noise は cycle 毎に独立加算され、t に直接累積されない
        # ksampler 出力を 0 に戻すことで、各 cycle の入力 = その cycle の noise 寄与のみとなる
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured_inputs = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured_inputs.append(sd["samples"].clone())
            # ksampler 出力を 0 に固定 → 次 cycle の入力 = encode 結果(0) + 当該 cycle の noise
            return ({"samples": torch.zeros_like(sd["samples"])},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["cycle_mode"] = "latent_persistent"
        kwargs["denoise_decay"] = 0.0  # 連動なし → 各 cycle で同強度の noise が乗るはず
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(
                vae=vae, images=images, mask=mask,
                latent_noise_intensity=0.5, noise_type="gaussian",
                **kwargs,
            )

        # 各 cycle の入力ノルムは noise 寄与のみで、cycle 間で同程度の強度
        norms = [x.abs().mean().item() for x in captured_inputs]
        assert len(norms) == 3
        # 累積なし → 全 cycle で同オーダー（最大/最小比が小さい）
        assert max(norms) / max(min(norms), 1e-6) < 1.5

    def test_latent_noise_decays_with_denoise_decay(self):
        # latent_persistent では latent_noise_intensity が denoise_decay と連動して減衰する
        # ksampler 出力を 0 に固定 → 各 cycle 入力 = その cycle の noise 寄与のみ
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured_inputs = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured_inputs.append(sd["samples"].clone())
            return ({"samples": torch.zeros_like(sd["samples"])},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["cycle_mode"] = "latent_persistent"
        kwargs["denoise"] = 1.0
        kwargs["denoise_decay"] = 0.9
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(
                vae=vae, images=images, mask=mask,
                latent_noise_intensity=0.5, noise_type="gaussian",
                **kwargs,
            )

        # i=0 では強く、i=2 ではほぼ 0 になるはず
        norms = [x.abs().mean().item() for x in captured_inputs]
        assert norms[0] > norms[1] > norms[2]

    def test_latent_noise_no_decay_when_denoise_decay_zero(self):
        # denoise_decay=0 のとき、latent_noise_intensity は cycle 毎に同強度
        images = torch.rand(1, 64, 64, 3)
        mask = _make_mask(1, 64, 64)
        vae = _make_vae()
        captured_inputs = []

        def capture(model, seed, steps, cfg, s, sc, p, n, sd, denoise=1.0):
            captured_inputs.append(sd["samples"].clone())
            return ({"samples": torch.zeros_like(sd["samples"])},)

        kwargs = _common_kwargs()
        kwargs["cycle"] = 3
        kwargs["cycle_mode"] = "latent_persistent"
        kwargs["denoise_decay"] = 0.0
        with patch("nodes.detailer.nodes.common_ksampler", side_effect=capture):
            _run_detail_loop(
                vae=vae, images=images, mask=mask,
                latent_noise_intensity=0.5, noise_type="gaussian",
                **kwargs,
            )

        norms = [x.abs().mean().item() for x in captured_inputs]
        assert len(norms) == 3
        max_n = max(norms)
        min_n = min(norms)
        assert (max_n - min_n) / max_n < 0.3  # 各 cycle で noise 強度がほぼ一定
