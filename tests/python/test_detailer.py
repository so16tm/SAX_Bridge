"""SAX_Bridge_Detailer / SAX_Bridge_Detailer_Enhanced ノードのテスト。"""

import pytest
import torch
from unittest.mock import MagicMock, patch
from nodes.detailer import (
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
    _extract_pipe,
    _ensure_negative,
    _add_latent_noise,
    get_bbox_from_mask,
    expand_bbox_by_factor,
    crop_bbox,
    uncrop_and_blend,
)
from nodes.structure_control import STRUCTURE_CONTROL_KEY, StructureApplyResult


class TestAddLatentNoiseVideo5D:
    """_add_latent_noise の動画 latent (B, C, T, H, W) 対応。"""

    def test_5d_shape_preserved_and_noised(self):
        b, c, t, h, w = 1, 4, 3, 8, 8
        latent = torch.zeros(b, c, t, h, w)
        noise_mask = torch.ones(b, h, w)
        out = _add_latent_noise(latent, 0.5, "gaussian", noise_mask, seed=42)
        assert out.shape == latent.shape
        assert not torch.allclose(out, latent, atol=1e-6)

    def test_5d_zero_mask_region_unchanged(self):
        b, c, t, h, w = 1, 4, 3, 8, 8
        latent = torch.zeros(b, c, t, h, w)
        noise_mask = torch.zeros(b, h, w)
        noise_mask[:, h // 4:3 * h // 4, w // 4:3 * w // 4] = 1.0
        out = _add_latent_noise(latent, 0.5, "gaussian", noise_mask, seed=42)
        # マスク 0 の四隅は全フレームで不変、中央はノイズが乗る
        assert torch.allclose(out[:, :, :, 0, 0], latent[:, :, :, 0, 0], atol=1e-6)
        assert not torch.allclose(out[:, :, :, h // 2, w // 2], latent[:, :, :, h // 2, w // 2], atol=1e-6)

    def test_4d_still_works(self):
        b, c, h, w = 1, 4, 8, 8
        latent = torch.zeros(b, c, h, w)
        noise_mask = torch.ones(b, h, w)
        out = _add_latent_noise(latent, 0.5, "gaussian", noise_mask, seed=42)
        assert out.shape == latent.shape


class TestExtractPipe:
    def test_extracts_fields(self):
        pipe = {
            "model": "m", "clip": "c", "vae": "v",
            "images": "img", "positive": "pos", "negative": "neg",
            "seed": 123,
            "loader_settings": {"steps": 30, "cfg": 5.0, "sampler_name": "dpm", "scheduler": "karras"},
        }
        p = _extract_pipe(pipe)
        assert p["model"] == "m"
        assert p["seed"] == 123
        assert p["steps"] == 30
        assert p["cfg"] == 5.0
        assert p["sampler_name"] == "dpm"

    def test_defaults_when_missing(self):
        pipe = {}
        p = _extract_pipe(pipe)
        assert p["model"] is None
        assert p["seed"] == 0
        assert p["steps"] == 20
        assert p["cfg"] == 8.0


class TestEnsureNegative:
    def test_existing_negative_unchanged(self):
        p = {"negative": "existing", "clip": MagicMock()}
        _ensure_negative(p)
        assert p["negative"] == "existing"

    def test_no_clip_raises(self):
        p = {"negative": None, "clip": None}
        with pytest.raises(ValueError, match="negative"):
            _ensure_negative(p)


class TestGetBboxFromMask:
    def test_full_mask(self):
        mask = torch.ones(1, 64, 64)
        bbox = get_bbox_from_mask(mask)
        assert bbox is not None
        y_min, x_min, y_max, x_max = bbox
        assert y_min == 0 and x_min == 0
        # bbox is inclusive and 8px-aligned
        assert y_max == 63 and x_max == 63

    def test_empty_mask(self):
        mask = torch.zeros(1, 64, 64)
        bbox = get_bbox_from_mask(mask)
        assert bbox is None

    def test_partial_mask(self):
        mask = torch.zeros(1, 64, 64)
        mask[0, 10:30, 20:50] = 1.0
        bbox = get_bbox_from_mask(mask)
        assert bbox is not None
        y_min, x_min, y_max, x_max = bbox
        # 8px-aligned bbox contains the mask region
        assert y_min <= 10 and x_min <= 20
        assert y_max >= 29 and x_max >= 49


class TestExpandBboxByFactor:
    def test_factor_expands(self):
        bbox = (16, 16, 48, 48)
        result = expand_bbox_by_factor(bbox, 128, 128, 2.0)
        y_min, x_min, y_max, x_max = result
        assert y_min < 16
        assert x_min < 16
        assert y_max > 48
        assert x_max > 48

    def test_8px_alignment(self):
        bbox = (10, 10, 50, 50)
        result = expand_bbox_by_factor(bbox, 128, 128, 1.5)
        y_min, x_min, y_max, x_max = result
        # bbox is inclusive: size = max - min + 1
        assert (y_max - y_min + 1) % 8 == 0
        assert (x_max - x_min + 1) % 8 == 0


class TestCropAndUncrop:
    def test_crop_shape(self):
        img = torch.rand(1, 64, 64, 3)
        # bbox is inclusive: (8, 8, 39, 39) → 32x32
        bbox = (8, 8, 39, 39)
        cropped = crop_bbox(img, bbox)
        assert cropped.shape == (1, 32, 32, 3)

    def test_uncrop_restores_shape(self):
        original = torch.rand(1, 64, 64, 3)
        bbox = (8, 8, 39, 39)
        cropped = crop_bbox(original, bbox)
        mask = torch.ones(1, 64, 64)
        result = uncrop_and_blend(original, cropped, mask, bbox, feather=0)
        assert result.shape == original.shape


class TestDetailerExecute:
    def _make_pipe(self):
        return {
            "model": MagicMock(),
            "clip": MagicMock(),
            "vae": MagicMock(),
            "images": torch.rand(1, 64, 64, 3),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "seed": 42,
            "loader_settings": {"steps": 20, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal"},
        }

    def test_no_model_returns_pipe(self):
        pipe = self._make_pipe()
        pipe["model"] = None
        result = SAX_Bridge_Detailer.execute(
            pipe, denoise=0.45, cycle=1, crop_factor=3.0,
            noise_mask_feather=5, blend_feather=5,
        )
        assert result[0] is pipe

    def test_no_images_returns_pipe(self):
        pipe = self._make_pipe()
        pipe["images"] = None
        result = SAX_Bridge_Detailer.execute(
            pipe, denoise=0.45, cycle=1, crop_factor=3.0,
            noise_mask_feather=5, blend_feather=5,
        )
        assert result[0] is pipe

    @patch("nodes.detailer._run_detail_loop", return_value=None)
    def test_null_result_returns_pipe(self, mock_loop):
        pipe = self._make_pipe()
        result = SAX_Bridge_Detailer.execute(
            pipe, denoise=0.45, cycle=1, crop_factor=3.0,
            noise_mask_feather=5, blend_feather=5,
        )
        assert result[0] is pipe

    @patch("nodes.detailer._run_detail_loop")
    def test_success_returns_new_pipe(self, mock_loop):
        pipe = self._make_pipe()
        fake_images = torch.rand(1, 64, 64, 3)
        mock_loop.return_value = fake_images
        result = SAX_Bridge_Detailer.execute(
            pipe, denoise=0.45, cycle=1, crop_factor=3.0,
            noise_mask_feather=5, blend_feather=5,
        )
        assert result[0] is not pipe
        assert torch.equal(result[0]["images"], fake_images)
        assert torch.equal(result[1], fake_images)

    def test_structure_cfg_wiring_uses_cropped_image_and_keeps_pipe_positive_unpatched(self):
        # Arrange — pipe に structure_control 設定、マスクは 64x64 中の 16x16 領域
        pipe = self._make_pipe()
        cfg = {
            "backend": "standard_cn", "mode": "tile", "strength": 0.6,
            "start_percent": 0.0, "end_percent": 1.0,
            "controlnet_name": "union_cn.safetensors",
        }
        pipe[STRUCTURE_CONTROL_KEY] = cfg
        mask = torch.zeros(1, 64, 64)
        mask[:, 16:32, 16:32] = 1.0

        patched_pos, patched_neg = MagicMock(name="cn_pos"), MagicMock(name="cn_neg")
        seam_model = MagicMock(name="seam_model")
        structure_mock = MagicMock(return_value=StructureApplyResult(
            positive=patched_pos, negative=patched_neg, model=seam_model,
        ))
        pipe["vae"].encode.return_value = torch.rand(1, 4, 2, 2)
        sampler_result = ({"samples": torch.rand(1, 4, 2, 2)},)

        # Act
        with patch("nodes.detailer.apply_structure_control_cfg", structure_mock), \
             patch("nodes.common_ksampler", return_value=sampler_result) as mock_ksampler, \
             patch("nodes.detailer.decode_image", return_value=torch.rand(1, 16, 16, 3)):
            result = SAX_Bridge_Detailer.execute(
                pipe, denoise=0.45, cycle=1, crop_factor=1.0,
                noise_mask_feather=0, blend_feather=0, mask=mask,
            )

        # Assert — pipe の cfg が届き、ヒント元は crop 済み領域（フル画像ではない）
        call = structure_mock.call_args
        assert call.args[0] == cfg
        hint_source = call.args[3]
        assert hint_source.shape[1] < 64 and hint_source.shape[2] < 64
        # ヒント元は VAE encode される crop 領域と同一テンソル（空間整合の不変条件）
        encode_arg = pipe["vae"].encode.call_args.args[0]
        assert hint_source.shape == encode_arg.shape
        assert torch.equal(hint_source, encode_arg)
        # ksampler にはパッチ済み conditioning + seam 経由の model が渡る
        k_args, _ = mock_ksampler.call_args
        assert k_args[0] is seam_model
        assert k_args[6] is patched_pos
        assert k_args[7] is patched_neg
        # pipe へは CN 未パッチの positive のみ伝播（二重適用防止）
        assert result[0]["positive"] is pipe["positive"]
        assert result[0]["positive"] is not patched_pos

    @patch("nodes.detailer._run_detail_loop")
    def test_enhanced_success(self, mock_loop):
        pipe = self._make_pipe()
        fake_images = torch.rand(1, 64, 64, 3)
        mock_loop.return_value = fake_images
        result = SAX_Bridge_Detailer_Enhanced.execute(
            pipe, denoise=0.45, denoise_decay=0.0, cycle=1,
            crop_factor=3.0, noise_mask_feather=5, blend_feather=5,
            shadow_enhance=0.0,
            edge_weight=0.0, edge_blur_sigma=1.0,
            latent_noise_intensity=0.0, noise_type="gaussian",
            context_blur_sigma=0.0, context_blur_radius=48,
        )
        assert result[0] is not pipe
        assert torch.equal(result[1], fake_images)
