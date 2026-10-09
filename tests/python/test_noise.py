"""SAX_Bridge_Noise_Image / SAX_Bridge_Noise_Latent ノードのテスト。"""

import torch
import pytest
from nodes.noise import SAX_Bridge_Noise_Image, SAX_Bridge_Noise_Latent
from nodes.noise import SAXNoiseEngine


@pytest.mark.parametrize("dtype", [torch.float32, torch.float16, torch.bfloat16])
def test_blur_preserves_uniform_input_and_dtype(dtype):
    image = torch.ones((2, 3, 8, 8), dtype=dtype)
    result = SAXNoiseEngine.gaussian_blur(image, 1.0)
    assert result.dtype == dtype
    assert torch.allclose(result, image, atol=0.01)


def test_shared_noise_engine_matches_mask_batch_to_image_batch():
    image = torch.full((3, 8, 8, 3), 0.5)
    mask = torch.stack([torch.zeros(8, 8), torch.ones(8, 8)])
    result = SAXNoiseEngine.apply_noise(image, mask, 0.2, seed=2)
    assert result.shape == image.shape
    assert torch.equal(result[0], image[0])
    assert not torch.equal(result[2], image[2])


def test_video_noise_uses_frame_masks_without_changing_batch():
    samples = {"samples": torch.zeros(1, 4, 3, 2, 2)}
    mask = torch.stack([torch.zeros(2, 2), torch.ones(2, 2)])
    result = SAX_Bridge_Noise_Latent.execute(samples, 0.2, "gaussian", 5, 0, 0, mask)[0]["samples"]
    assert result.shape == samples["samples"].shape
    assert torch.count_nonzero(result[:, :, 0]) == 0
    noise = SAXNoiseEngine.generate_noise(result.shape, "gaussian", 5, result.device, result.dtype)
    assert torch.allclose(result[:, :, 1], noise[:, :, 1] * 0.1)
    assert torch.allclose(result[:, :, 2], noise[:, :, 2] * 0.2)


def _make_image(b=1, h=16, w=16, c=3, seed=0):
    # 再現性のため seed 固定
    g = torch.Generator()
    g.manual_seed(seed)
    return torch.rand((b, h, w, c), generator=g)


def _make_latent(b=1, c=4, h=8, w=8, seed=0):
    g = torch.Generator()
    g.manual_seed(seed)
    return {"samples": torch.randn((b, c, h, w), generator=g)}


def _make_mask(b, h, w, white_region=True):
    # white_region=True: 中央が白、それ以外黒
    mask = torch.zeros((b, h, w))
    if white_region:
        mask[:, h // 4:3 * h // 4, w // 4:3 * w // 4] = 1.0
    return mask


class TestNoiseImageMaskNone:
    """mask=None の場合の挙動。"""

    def test_no_mask_noise_applied_to_whole_image(self):
        img = _make_image(seed=1)
        result = SAX_Bridge_Noise_Image.execute(
            image=img, intensity=0.5, noise_type="gaussian", color_mode="rgb",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out = result.args[0]
        # intensity > 0 なら元画像と異なる
        assert not torch.allclose(out, img, atol=1e-6)

    def test_intensity_zero_preserves_image(self):
        img = _make_image(seed=2)
        result = SAX_Bridge_Noise_Image.execute(
            image=img, intensity=0.0, noise_type="gaussian", color_mode="rgb",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out = result.args[0]
        # intensity=0 なら元と一致（クランプのみ発生、[0,1]範囲内なので不変）
        assert torch.allclose(out, img, atol=1e-6)

    def test_shape_preservation(self):
        img = _make_image(b=2, h=32, w=32, c=3, seed=3)
        result = SAX_Bridge_Noise_Image.execute(
            image=img, intensity=0.1, noise_type="gaussian", color_mode="rgb",
            seed=7, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out = result.args[0]
        assert out.shape == img.shape

    def test_value_clamping(self):
        img = _make_image(seed=4)
        result = SAX_Bridge_Noise_Image.execute(
            image=img, intensity=1.0, noise_type="gaussian", color_mode="rgb",
            seed=123, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out = result.args[0]
        assert out.min().item() >= 0.0
        assert out.max().item() <= 1.0


class TestNoiseImageWithMask:
    """マスク指定時の挙動。"""

    def test_black_mask_region_unchanged(self):
        # マスク黒領域は元画像と一致する
        b, h, w, c = 1, 16, 16, 3
        img = _make_image(b=b, h=h, w=w, c=c, seed=5)
        mask = _make_mask(b, h, w, white_region=True)  # 中央が白
        result = SAX_Bridge_Noise_Image.execute(
            image=img, intensity=0.5, noise_type="gaussian", color_mode="rgb",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=mask,
        )
        out = result.args[0]
        # マスクの黒領域（四隅）は元画像と一致する
        assert torch.allclose(out[:, 0, 0, :], img[:, 0, 0, :], atol=1e-6)
        assert torch.allclose(out[:, 0, w - 1, :], img[:, 0, w - 1, :], atol=1e-6)
        assert torch.allclose(out[:, h - 1, 0, :], img[:, h - 1, 0, :], atol=1e-6)

    def test_white_mask_region_has_noise(self):
        b, h, w, c = 1, 16, 16, 3
        img = _make_image(b=b, h=h, w=w, c=c, seed=6)
        mask = _make_mask(b, h, w, white_region=True)
        result = SAX_Bridge_Noise_Image.execute(
            image=img, intensity=0.5, noise_type="gaussian", color_mode="rgb",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=mask,
        )
        out = result.args[0]
        # 中央の白領域ではノイズが乗っている
        center = (h // 2, w // 2)
        assert not torch.allclose(out[:, center[0], center[1], :], img[:, center[0], center[1], :], atol=1e-6)


class TestNoiseLatentMaskNone:
    """mask=None の場合の挙動。"""

    def test_no_mask_noise_applied_to_whole_latent(self):
        samples = _make_latent(seed=1)
        orig_tensor = samples["samples"].clone()
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.5, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out_tensor = result.args[0]["samples"]
        assert not torch.allclose(out_tensor, orig_tensor, atol=1e-6)

    def test_intensity_zero_preserves_latent(self):
        samples = _make_latent(seed=2)
        orig_tensor = samples["samples"].clone()
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.0, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out_tensor = result.args[0]["samples"]
        assert torch.allclose(out_tensor, orig_tensor, atol=1e-6)

    def test_shape_preservation(self):
        samples = _make_latent(b=2, c=4, h=16, w=16, seed=3)
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.1, noise_type="gaussian",
            seed=7, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out_tensor = result.args[0]["samples"]
        assert out_tensor.shape == samples["samples"].shape


class TestNoiseLatentImmutability:
    """samples dict のイミュータビリティ。"""

    def test_original_samples_dict_not_mutated(self):
        samples = _make_latent(seed=4)
        samples["extra_key"] = "preserved"
        orig_tensor = samples["samples"]
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.3, noise_type="gaussian",
            seed=11, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        new_samples = result.args[0]
        # 新しい dict が返され、元の dict の samples は不変
        assert new_samples is not samples
        assert samples["samples"] is orig_tensor
        # extra_key は引き継がれる（shallow copy のため）
        assert new_samples["extra_key"] == "preserved"


class TestNoiseLatentWithMask:
    """マスク指定時の挙動。"""

    def test_black_mask_region_unchanged(self):
        # latent は (B, C, H, W) で mask は画像空間 (B, H_img, W_img)
        # mask は latent サイズに合わせる
        b, c, h, w = 1, 4, 16, 16
        g = torch.Generator()
        g.manual_seed(10)
        samples = {"samples": torch.randn((b, c, h, w), generator=g)}
        orig = samples["samples"].clone()
        mask = _make_mask(b, h, w, white_region=True)
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.5, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=mask,
        )
        out_tensor = result.args[0]["samples"]
        # マスク黒領域（四隅）は不変
        assert torch.allclose(out_tensor[:, :, 0, 0], orig[:, :, 0, 0], atol=1e-6)
        assert torch.allclose(out_tensor[:, :, 0, w - 1], orig[:, :, 0, w - 1], atol=1e-6)

    def test_white_mask_region_has_noise(self):
        b, c, h, w = 1, 4, 16, 16
        g = torch.Generator()
        g.manual_seed(11)
        samples = {"samples": torch.randn((b, c, h, w), generator=g)}
        orig = samples["samples"].clone()
        mask = _make_mask(b, h, w, white_region=True)
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.5, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=mask,
        )
        out_tensor = result.args[0]["samples"]
        center = (h // 2, w // 2)
        assert not torch.allclose(out_tensor[:, :, center[0], center[1]], orig[:, :, center[0], center[1]], atol=1e-6)


class TestNoiseLatentVideo5D:
    """動画 latent (B, C, T, H, W) の5次元対応。"""

    def _make_video_latent(self, b=1, c=4, t=3, h=8, w=8, seed=0):
        g = torch.Generator()
        g.manual_seed(seed)
        return {"samples": torch.randn((b, c, t, h, w), generator=g)}

    def test_no_mask_5d_shape_preserved_and_noised(self):
        samples = self._make_video_latent(seed=1)
        orig = samples["samples"].clone()
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.5, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out = result.args[0]["samples"]
        assert out.shape == orig.shape
        assert not torch.allclose(out, orig, atol=1e-6)

    def test_mask_5d_black_region_unchanged_white_noised(self):
        b, c, t, h, w = 1, 4, 3, 16, 16
        g = torch.Generator()
        g.manual_seed(10)
        samples = {"samples": torch.randn((b, c, t, h, w), generator=g)}
        orig = samples["samples"].clone()
        mask = _make_mask(b, h, w, white_region=True)
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=0.5, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=mask,
        )
        out = result.args[0]["samples"]
        # 全フレームでマスク黒領域（四隅）は不変、白領域（中央）はノイズが乗る
        assert torch.allclose(out[:, :, :, 0, 0], orig[:, :, :, 0, 0], atol=1e-6)
        cy, cx = h // 2, w // 2
        assert not torch.allclose(out[:, :, :, cy, cx], orig[:, :, :, cy, cx], atol=1e-6)


class TestNoiseLatentNoClamp:
    """latent は値域クランプなし。"""

    def test_output_can_exceed_range(self):
        # latent は元々 randn なので [0,1] ではない、ノイズ加算後も範囲外を許容
        samples = _make_latent(seed=5)
        result = SAX_Bridge_Noise_Latent.execute(
            samples=samples, intensity=2.0, noise_type="gaussian",
            seed=42, mask_shrink=0, mask_blur=0.0, mask=None,
        )
        out_tensor = result.args[0]["samples"]
        # クランプされていなければ十分な絶対値を持つ要素が存在する
        assert out_tensor.abs().max().item() > 1.0
