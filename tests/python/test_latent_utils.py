"""latent_utils の形状契約テスト（4D/5D）。実モデル非依存。"""

import torch
from nodes.latent_utils import (
    apply_spatial_4d,
    insert_temporal_if_5d,
    broadcast_mask_to_latent,
)


class TestApplySpatial4d:
    """apply_spatial_4d の 4D/5D 対応。"""

    def test_4d_passes_through_fn(self):
        # 4D はそのまま fn に渡る（畳み込みなし）
        x = torch.randn(2, 3, 8, 8)
        out = apply_spatial_4d(x, lambda t: t * 2.0 + 1.0)
        assert out.shape == (2, 3, 8, 8)
        assert torch.allclose(out, x * 2.0 + 1.0)

    def test_5d_identity_round_trip(self):
        # 5D で恒等関数を通すと完全に元へ戻る（permute/reshape の往復が正しい）
        x = torch.randn(2, 3, 4, 8, 6)
        out = apply_spatial_4d(x, lambda t: t)
        assert out.shape == (2, 3, 4, 8, 6)
        assert torch.equal(out, x)

    def test_5d_matches_per_frame_application(self):
        # 5D は各フレームへ独立に fn を適用した結果と一致する
        x = torch.randn(2, 3, 4, 8, 6)

        def fn(t4: torch.Tensor) -> torch.Tensor:
            return t4 * 3.0 - 0.5

        out = apply_spatial_4d(x, fn)
        expected = torch.empty_like(x)
        for b in range(x.shape[0]):
            for t in range(x.shape[2]):
                expected[b, :, t] = fn(x[b, :, t].unsqueeze(0)).squeeze(0)
        assert torch.allclose(out, expected)

    def test_5d_channel_changing_fn_shape(self):
        # fn がチャンネル数を変える場合も次元復元が正しい
        x = torch.randn(2, 3, 4, 8, 6)
        out = apply_spatial_4d(x, lambda t: t[:, :1])
        assert out.shape == (2, 1, 4, 8, 6)

    def test_preserves_dtype_and_device(self):
        x = torch.randn(1, 3, 2, 8, 8, dtype=torch.float64)
        out = apply_spatial_4d(x, lambda t: t + 1)
        assert out.dtype == torch.float64
        assert out.device == x.device


class TestInsertTemporalIf5d:
    def test_4d_latent_unchanged(self):
        mask = torch.ones(2, 1, 8, 8)
        latent = torch.zeros(2, 4, 8, 8)
        assert insert_temporal_if_5d(mask, latent) is mask

    def test_5d_latent_inserts_temporal_axis(self):
        mask = torch.ones(2, 1, 8, 8)
        latent = torch.zeros(2, 4, 3, 8, 8)
        out = insert_temporal_if_5d(mask, latent)
        assert out.shape == (2, 1, 1, 8, 8)


class TestBroadcastMaskToLatent:
    def test_4d_latent(self):
        mask = torch.ones(2, 8, 8)
        latent = torch.randn(2, 4, 8, 8)
        out = broadcast_mask_to_latent(mask, latent)
        assert out.shape == (2, 1, 8, 8)
        # ブロードキャスト乗算が成立する
        assert (latent * out).shape == latent.shape

    def test_5d_latent(self):
        mask = torch.ones(2, 8, 8)
        latent = torch.randn(2, 4, 3, 8, 8)
        out = broadcast_mask_to_latent(mask, latent)
        assert out.shape == (2, 1, 1, 8, 8)
        assert (latent * out).shape == latent.shape
