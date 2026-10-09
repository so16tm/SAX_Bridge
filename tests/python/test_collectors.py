"""Collector の空入力、画像サイズ、転送上限、スロット位置を検証する。"""

import pytest
import torch

from nodes.image_collector import MAX_OUTPUT_IMAGES, SAX_Bridge_Image_Collector
from nodes.node_collector import SAX_Bridge_Node_Collector
from nodes.pipe_collector import SAX_Bridge_Pipe_Collector


def test_node_collector_preserves_unconnected_slots():
    value = object()
    result = SAX_Bridge_Node_Collector.execute(slot_2=value).args
    assert len(result) == 32
    assert result[:2] == (None, None)
    assert result[2] is value


def test_pipe_collector_selects_first_non_none_even_when_empty():
    pipe = {}
    assert SAX_Bridge_Pipe_Collector.execute(slot_1=pipe, slot_2={"seed": 5}).args[0] is pipe


@pytest.mark.parametrize("shape", [(0, 4, 6, 3), (1, 0, 6, 3), (1, 4, 0, 3)])
def test_empty_image_does_not_set_reference_dimensions(shape):
    result = SAX_Bridge_Image_Collector.execute(
        slot_0=torch.zeros(shape), slot_1=torch.ones(1, 2, 3, 1)
    ).args[0]
    assert result.shape == (1, 2, 3, 3)
    assert torch.all(result == 1)


def test_image_transfer_is_capped_before_cpu_copy(monkeypatch):
    original_cpu = torch.Tensor.cpu
    transfers = []

    def record_cpu(tensor, *args, **kwargs):
        transfers.append(tensor.shape)
        return original_cpu(tensor, *args, **kwargs)

    monkeypatch.setattr(torch.Tensor, "cpu", record_cpu)
    result = SAX_Bridge_Image_Collector.execute(
        slot_0=torch.ones(MAX_OUTPUT_IMAGES + 2, 2, 3, 3),
        slot_1=torch.zeros(2, 2, 3, 3),
    ).args[0]
    assert result.shape[0] == MAX_OUTPUT_IMAGES
    assert len(transfers) == MAX_OUTPUT_IMAGES
    assert torch.all(result == 1)


def test_image_letterbox_and_rgba_normalization():
    result = SAX_Bridge_Image_Collector.execute(
        slot_0=torch.ones(1, 4, 4, 3), slot_1=torch.ones(1, 2, 4, 4)
    ).args[0]
    assert result.shape == (2, 4, 4, 3)
    assert torch.all(result[1, (0, 3)] == 0)
    assert torch.all(result[1, 1:3] == 1)
