"""vae_utils.decode_image のテスト。"""

import torch
from unittest.mock import MagicMock
from nodes.vae_utils import decode_image


def _make_vae(return_value):
    vae = MagicMock(name="vae")
    vae.decode = MagicMock(return_value=return_value)
    return vae


def _make_latent(is_nested=False):
    latent = MagicMock(name="latent_tensor")
    latent.is_nested = is_nested
    return latent


class TestDecodeImage:
    """5次元正規化・nested 展開の検証。"""

    def test_5d_reshaped_to_4d(self):
        # 動画系 VAE の (B, T, H, W, C) は (B*T, H, W, C) へ畳み込む
        B, T, H, W, C = 1, 5, 64, 48, 3
        vae = _make_vae(torch.zeros(B, T, H, W, C))
        result = decode_image(vae, _make_latent())
        assert tuple(result.shape) == (B * T, H, W, C)

    def test_5d_batched_reshaped(self):
        # B>1 の動画出力も正しく畳み込まれる
        B, T, H, W, C = 2, 3, 32, 32, 3
        vae = _make_vae(torch.zeros(B, T, H, W, C))
        result = decode_image(vae, _make_latent())
        assert tuple(result.shape) == (B * T, H, W, C)

    def test_4d_left_unchanged(self):
        # 通常の画像 VAE の (B, H, W, C) はそのまま返す
        B, H, W, C = 2, 64, 48, 3
        image = torch.zeros(B, H, W, C)
        vae = _make_vae(image)
        result = decode_image(vae, _make_latent())
        assert result is image
        assert tuple(result.shape) == (B, H, W, C)

    def test_nested_latent_unbound_before_decode(self):
        # nested latent は unbind()[0] を decode に渡す（標準 VAEDecode と同一）
        image = torch.zeros(1, 64, 48, 3)
        vae = _make_vae(image)
        unbound = MagicMock(name="unbound_latent")
        nested = _make_latent(is_nested=True)
        nested.unbind = MagicMock(return_value=[unbound])
        decode_image(vae, nested)
        nested.unbind.assert_called_once()
        # unbind()[0] が decode に渡ることを decode の引数で間接検証する
        vae.decode.assert_called_once_with(unbound)

    def test_non_nested_latent_passed_directly(self):
        # 通常 latent は unbind せずそのまま decode に渡す
        image = torch.zeros(1, 64, 48, 3)
        vae = _make_vae(image)
        latent = _make_latent(is_nested=False)
        decode_image(vae, latent)
        vae.decode.assert_called_once_with(latent)
