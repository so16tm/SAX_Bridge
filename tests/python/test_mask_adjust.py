"""SAX_Bridge_Mask_Adjust ノードと nodes/mask_ops のテスト。"""

import pytest
import torch

from nodes.mask_adjust import SAX_Bridge_Mask_Adjust
from nodes.mask_ops import (
    apply_mask_blur,
    apply_mask_grow,
    apply_mask_invert,
    apply_mask_threshold,
)


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

def _make_square_mask(h: int = 16, w: int = 16, b: int = 1) -> torch.Tensor:
    """中央 8x8 が 1、それ以外 0 の (B, H, W) マスクを返す。"""
    mask = torch.zeros((b, h, w), dtype=torch.float32)
    mask[:, h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = 1.0
    return mask


def _execute(mask, invert=False, grow=0, blur=0.0, threshold=0.0) -> torch.Tensor:
    result = SAX_Bridge_Mask_Adjust.execute(
        mask=mask, invert=invert, grow=grow, blur=blur, threshold=threshold,
    )
    return result.args[0]


# ---------------------------------------------------------------------------
# apply_mask_invert
# ---------------------------------------------------------------------------

class TestApplyMaskInvert:
    def test_invert_disabled_returns_input(self):
        mask = _make_square_mask()
        out = apply_mask_invert(mask, False)
        assert torch.equal(out, mask)

    def test_invert_swaps_zero_and_one(self):
        mask = _make_square_mask()
        out = apply_mask_invert(mask, True)
        # 完全反転：元 1 の位置は 0、元 0 の位置は 1
        assert torch.equal(out, 1.0 - mask)

    def test_invert_with_soft_mask(self):
        mask = torch.tensor([[0.0, 0.25, 0.5, 0.75, 1.0]])
        out = apply_mask_invert(mask, True)
        expected = torch.tensor([[1.0, 0.75, 0.5, 0.25, 0.0]])
        assert torch.allclose(out, expected)

    def test_invert_clamps_out_of_range(self):
        # 範囲外の値が来ても [0, 1] にクランプされる
        mask = torch.tensor([[-0.5, 0.5, 1.5]])
        out = apply_mask_invert(mask, True)
        # 1 - (-0.5) = 1.5 → 1.0、1 - 1.5 = -0.5 → 0.0
        expected = torch.tensor([[1.0, 0.5, 0.0]])
        assert torch.allclose(out, expected)


# ---------------------------------------------------------------------------
# apply_mask_grow（ユーティリティ単体）
# ---------------------------------------------------------------------------

class TestApplyMaskGrow:
    def test_grow_zero_returns_input(self):
        mask = _make_square_mask()
        out = apply_mask_grow(mask, 0)
        assert torch.equal(out, mask)

    def test_grow_positive_dilates(self):
        mask = _make_square_mask()
        before = mask.sum().item()
        out = apply_mask_grow(mask, 2)
        after = out.sum().item()
        assert after > before

    def test_grow_negative_erodes(self):
        mask = _make_square_mask()
        before = mask.sum().item()
        out = apply_mask_grow(mask, -2)
        after = out.sum().item()
        assert after < before

    def test_grow_preserves_2d_shape(self):
        mask = _make_square_mask().squeeze(0)  # (H, W)
        out = apply_mask_grow(mask, 1)
        assert out.shape == mask.shape

    def test_grow_preserves_3d_shape(self):
        mask = _make_square_mask()  # (B, H, W)
        out = apply_mask_grow(mask, 1)
        assert out.shape == mask.shape

    def test_grow_preserves_4d_shape(self):
        mask = _make_square_mask().unsqueeze(1)  # (B, 1, H, W)
        out = apply_mask_grow(mask, 1)
        assert out.shape == mask.shape

    def test_grow_all_zero_stays_zero(self):
        mask = torch.zeros((1, 8, 8), dtype=torch.float32)
        out = apply_mask_grow(mask, 4)
        assert torch.equal(out, mask)

    def test_grow_all_one_stays_one(self):
        mask = torch.ones((1, 8, 8), dtype=torch.float32)
        out = apply_mask_grow(mask, -4)
        assert torch.equal(out, mask)

    def test_erode_small_mask_to_empty(self):
        # 1px 幅のマスクに -1 適用で全消滅
        mask = torch.zeros((1, 8, 8), dtype=torch.float32)
        mask[0, 4, 4] = 1.0
        out = apply_mask_grow(mask, -1)
        assert out.sum().item() == 0.0

    def test_invalid_rank_raises(self):
        with pytest.raises(ValueError):
            apply_mask_grow(torch.zeros(8), 1)

    def test_4d_multi_channel_raises(self):
        # MASK は単一チャネル前提。多チャネル画像が誤接続されたら明示的に弾く
        bad = torch.zeros((1, 3, 8, 8), dtype=torch.float32)
        with pytest.raises(ValueError):
            apply_mask_grow(bad, 1)

    def test_grow_2d_value_equivalence_with_3d(self):
        # SAM3 リファクタの回帰防止：(H, W) と (1, H, W) で同一の値が返る
        base = _make_square_mask().squeeze(0)  # (H, W)
        out_2d = apply_mask_grow(base, 3)
        out_3d = apply_mask_grow(base.unsqueeze(0), 3).squeeze(0)
        assert torch.equal(out_2d, out_3d)


# ---------------------------------------------------------------------------
# apply_mask_blur
# ---------------------------------------------------------------------------

class TestApplyMaskBlur:
    def test_blur_zero_returns_input(self):
        mask = _make_square_mask()
        out = apply_mask_blur(mask, 0.0)
        assert torch.equal(out, mask)

    def test_blur_negative_returns_input(self):
        mask = _make_square_mask()
        out = apply_mask_blur(mask, -1.0)
        assert torch.equal(out, mask)

    def test_blur_introduces_intermediate_values(self):
        mask = _make_square_mask()
        out = apply_mask_blur(mask, 2.0)
        # 中間値（0 でも 1 でもない）が現れる
        intermediate = ((out > 0.0) & (out < 1.0)).any().item()
        assert intermediate

    def test_blur_clamps_to_unit_range(self):
        mask = _make_square_mask()
        out = apply_mask_blur(mask, 2.0)
        assert out.min().item() >= 0.0
        assert out.max().item() <= 1.0

    def test_blur_preserves_2d_shape(self):
        mask = _make_square_mask().squeeze(0)
        out = apply_mask_blur(mask, 1.0)
        assert out.shape == mask.shape

    def test_blur_preserves_4d_shape(self):
        mask = _make_square_mask().unsqueeze(1)
        out = apply_mask_blur(mask, 1.0)
        assert out.shape == mask.shape


# ---------------------------------------------------------------------------
# apply_mask_threshold
# ---------------------------------------------------------------------------

class TestApplyMaskThreshold:
    def test_threshold_zero_returns_input(self):
        mask = torch.tensor([[0.1, 0.5, 0.9]])
        out = apply_mask_threshold(mask, 0.0)
        assert torch.equal(out, mask)

    def test_threshold_negative_returns_input(self):
        mask = torch.tensor([[0.1, 0.5, 0.9]])
        out = apply_mask_threshold(mask, -0.5)
        assert torch.equal(out, mask)

    def test_threshold_binarizes(self):
        mask = torch.tensor([[0.1, 0.5, 0.9]])
        out = apply_mask_threshold(mask, 0.5)
        # 0.5 ちょうどは閾値以下なので 0、0.9 のみ 1
        expected = torch.tensor([[0.0, 0.0, 1.0]])
        assert torch.equal(out, expected)

    def test_threshold_output_only_zero_or_one(self):
        # in-place ではなく out-of-place で 0.7 倍したテンソルを作る
        mask = _make_square_mask() * 0.7
        out = apply_mask_threshold(mask, 0.5)
        unique = torch.unique(out).tolist()
        assert all(v in (0.0, 1.0) for v in unique)


# ---------------------------------------------------------------------------
# SAX_Bridge_Mask_Adjust.execute（ノード結合動作）
# ---------------------------------------------------------------------------

class TestMaskAdjustExecute:
    def test_identity_when_all_disabled(self):
        mask = _make_square_mask()
        out = _execute(mask, grow=0, blur=0.0, threshold=0.0)
        assert torch.equal(out, mask)

    def test_grow_only(self):
        mask = _make_square_mask()
        out = _execute(mask, grow=2)
        assert out.sum().item() > mask.sum().item()

    def test_blur_only_creates_soft_mask(self):
        mask = _make_square_mask()
        out = _execute(mask, blur=2.0)
        assert ((out > 0.0) & (out < 1.0)).any().item()

    def test_blur_then_threshold_returns_binary(self):
        mask = _make_square_mask()
        out = _execute(mask, blur=2.0, threshold=0.5)
        unique = torch.unique(out).tolist()
        assert all(v in (0.0, 1.0) for v in unique)

    def test_blur_with_low_threshold_expands_region(self):
        # blur で広がった領域を低 threshold で拾うと元より広い二値マスクになる
        mask = _make_square_mask()
        out = _execute(mask, blur=2.0, threshold=0.1)
        assert out.sum().item() > mask.sum().item()

    def test_blur_with_high_threshold_shrinks_region(self):
        mask = _make_square_mask()
        out = _execute(mask, blur=2.0, threshold=0.9)
        assert out.sum().item() < mask.sum().item()

    def test_pipeline_grow_blur_threshold(self):
        # 全パイプライン適用：エラーなく完走、出力は二値
        mask = _make_square_mask()
        out = _execute(mask, grow=2, blur=1.5, threshold=0.5)
        assert out.shape == mask.shape
        unique = torch.unique(out).tolist()
        assert all(v in (0.0, 1.0) for v in unique)

    def test_preserves_input_shape_3d(self):
        mask = _make_square_mask(b=2)  # (2, H, W)
        out = _execute(mask, grow=1, blur=1.0)
        assert out.shape == mask.shape

    def test_invert_only(self):
        mask = _make_square_mask()
        out = _execute(mask, invert=True)
        assert torch.equal(out, 1.0 - mask)

    def test_invert_then_grow(self):
        # invert を先頭で適用するため、反転後マスクが grow される
        # 元マスク: 中央 8x8 が 1。invert 後: 中央 8x8 が 0、周囲が 1
        # grow=+2 すると「周囲の 1 領域」が中央に 2px 侵食 → 中央の 0 領域は 4x4 に縮小
        mask = _make_square_mask()  # 中央 8x8 (16x16 中)
        inverted = 1.0 - mask
        expected = apply_mask_grow(inverted, 2)
        out = _execute(mask, invert=True, grow=2)
        assert torch.equal(out, expected)

    def test_invert_disabled_in_pipeline(self):
        # invert=False では反転せず通常パイプラインと同じ
        mask = _make_square_mask()
        out_with = _execute(mask, invert=False, grow=2)
        out_without_param = _execute(mask, grow=2)
        assert torch.equal(out_with, out_without_param)
