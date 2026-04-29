"""SAX_Bridge_Detailer / SAX_Bridge_Detailer_Enhanced ノードのテスト。"""

import pytest
import torch
from unittest.mock import MagicMock, patch
from nodes.detailer import (
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
    _extract_pipe,
    _ensure_negative,
    get_bbox_from_mask,
    expand_bbox_by_factor,
    crop_bbox,
    uncrop_and_blend,
)


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
