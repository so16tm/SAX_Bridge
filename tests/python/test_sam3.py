"""SAM3 推論を置換し、V3 出力契約とマスク合成を検証する。"""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch
from comfy_api.latest import io
from nodes import sam3


@pytest.fixture
def segmentation(monkeypatch):
    monkeypatch.setattr(sam3, "_SAM3_AVAILABLE", True)
    monkeypatch.setattr(sam3.comfy.model_management, "load_models_gpu", MagicMock())
    return SimpleNamespace(processor=MagicMock(), current_device=torch.device("cpu"), _dtype=torch.float32)


@pytest.mark.parametrize("entries", [[], [None, 1, "entry"], [{"on": False}]])
def test_disabled_entries_return_v3_output(segmentation, entries):
    images = torch.rand(2, 8, 8, 3)
    result = sam3.SAX_Bridge_Segmenter_Multi.execute(segmentation, images, json.dumps(entries))
    assert isinstance(result, io.NodeOutput)
    assert result[0].shape == (2, 8, 8)
    assert not result[0].any()
    assert result[1] is images


def test_positive_minus_negative_and_roi(segmentation, monkeypatch):
    images = torch.rand(2, 8, 8, 4)
    def segment(processor, image, prompt, *args):
        mask = torch.ones(8, 8)
        if prompt == "exclude":
            mask[:, 4:] = 0
        return mask, mask * 0.8
    monkeypatch.setattr(sam3, "_segment_single", segment)
    entries = [{"prompt": "include"}, {"prompt": "exclude", "mode": "negative"}]
    roi = torch.ones(1, 8, 8)
    roi[:, :4] = 0
    result = sam3.SAX_Bridge_Segmenter_Multi.execute(segmentation, images, json.dumps(entries), roi)
    expected = torch.zeros(2, 8, 8)
    expected[:, 4:, 4:] = 1
    assert torch.equal(result[0], expected)
    assert torch.equal(result[1][..., 3], images[..., 3])



def test_roi_batch_cannot_expand_image_batch(segmentation, monkeypatch):
    images = torch.rand(1, 8, 8, 3)
    monkeypatch.setattr(sam3, "_segment_single", lambda *args: (torch.ones(8, 8), torch.ones(8, 8)))
    with pytest.raises(ValueError, match="ROI mask batch"):
        sam3.SAX_Bridge_Segmenter_Multi.execute(
            segmentation, images, '[{"prompt": "person"}]', torch.ones(2, 8, 8),
        )



@pytest.mark.parametrize("invalid", [
    {"prompt": None}, {"prompt": "person", "threshold": None},
    {"prompt": "person", "threshold": float("nan")},
    {"prompt": "person", "presence_weight": 2},
    {"prompt": "person", "mask_grow": 1000000},
    {"prompt": "person", "mode": "unknown"},
])
def test_invalid_entry_does_not_abort_valid_segmentation(segmentation, monkeypatch, invalid):
    segment = MagicMock(return_value=(torch.ones(8, 8), torch.ones(8, 8)))
    monkeypatch.setattr(sam3, "_segment_single", segment)
    result = sam3.SAX_Bridge_Segmenter_Multi.execute(
        segmentation, torch.rand(1, 8, 8, 3), json.dumps([invalid, {"prompt": "valid"}]),
    )
    assert result[0].all()
    segment.assert_called_once()
    assert segment.call_args.args[2] == "valid"
