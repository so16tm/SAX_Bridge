"""DeepCache の UNet 構造ガードのテスト。

DeepCache のラッパーは openaimodel.UNetModel 固有の属性 (input_blocks 等) を
直接参照するため、FLUX / SD3.5 / Qwen-Image のような DiT 系モデルに適用すると
AttributeError で落ちる。適用前に構造を判定して素通しすることを検証する。
"""

from unittest.mock import MagicMock

from nodes.cache_impl import (
    REQUIRED_UNET_ATTRS,
    apply_deepcache,
    is_unet_like,
    missing_unet_attrs,
)
from nodes.cache_impl import deepcache as deepcache_mod


class FakeUNet:
    """DeepCache が要求する属性を全て備えた UNetModel 相当のスタブ。"""

    def __init__(self):
        for name in REQUIRED_UNET_ATTRS:
            setattr(self, name, MagicMock(name=name))


class FakeDiT:
    """FLUX / SD3.5 系 DiT の構造を模したスタブ (UNet 属性を持たない)。"""

    def __init__(self):
        self.double_blocks = MagicMock()
        self.single_blocks = MagicMock()
        self.img_in = MagicMock()
        self.time_in = MagicMock()


def make_patcher(diffusion_model):
    """ModelPatcher 相当。clone() は別オブジェクトを返す。"""
    patcher = MagicMock(name="ModelPatcher")
    patcher.model = MagicMock(name="BaseModel")
    patcher.model.diffusion_model = diffusion_model
    clone = MagicMock(name="ClonedModelPatcher")
    clone.model_options = {}
    patcher.clone.return_value = clone
    return patcher, clone


class TestStructureDetection:
    def test_unet_is_recognized(self):
        assert is_unet_like(FakeUNet())
        assert missing_unet_attrs(FakeUNet()) == ()

    def test_dit_is_rejected(self):
        dit = FakeDiT()
        assert not is_unet_like(dit)
        # DiT に無い UNet 固有の属性が列挙される
        assert "input_blocks" in missing_unet_attrs(dit)
        assert "model_channels" in missing_unet_attrs(dit)

    def test_none_is_rejected(self):
        assert not is_unet_like(None)
        assert missing_unet_attrs(None) == REQUIRED_UNET_ATTRS

    def test_partial_unet_is_rejected(self):
        # 属性が 1 つでも欠ければ適用不可 (ラッパーが無条件に参照するため)
        for name in REQUIRED_UNET_ATTRS:
            partial = FakeUNet()
            delattr(partial, name)
            assert not is_unet_like(partial), f"{name} が欠けても UNet 扱いされている"
            assert missing_unet_attrs(partial) == (name,)


class TestApplyDeepcacheGuard:
    def test_dit_model_returns_same_object_without_wrappers(self):
        patcher, clone = make_patcher(FakeDiT())
        result = apply_deepcache(
            model=patcher, deepcache_interval=3, deepcache_start_ratio=0.2,
        )
        # 同一オブジェクトがそのまま返り、clone もラッパー登録も起きない
        assert result is patcher
        patcher.clone.assert_not_called()
        clone.add_wrapper_with_key.assert_not_called()

    def test_unet_model_gets_wrappers(self):
        patcher, clone = make_patcher(FakeUNet())
        result = apply_deepcache(
            model=patcher, deepcache_interval=3, deepcache_start_ratio=0.2,
        )
        assert result is clone
        # DIFFUSION_MODEL と OUTER_SAMPLE の 2 本が登録される
        assert clone.add_wrapper_with_key.call_count == 2
        state = clone.model_options["transformer_options"]["deepcache_state"]
        assert state.deepcache_interval == 3
        assert state.deepcache_start_ratio == 0.2

    def test_missing_diffusion_model_returns_same_object(self):
        patcher = MagicMock(name="ModelPatcher")
        patcher.model = object()  # diffusion_model 属性なし
        result = apply_deepcache(
            model=patcher, deepcache_interval=3, deepcache_start_ratio=0.2,
        )
        assert result is patcher
        patcher.clone.assert_not_called()

    def test_guard_warns_with_model_name(self, caplog):
        patcher, _ = make_patcher(FakeDiT())
        with caplog.at_level("WARNING", logger="SAX_Bridge"):
            apply_deepcache(
                model=patcher, deepcache_interval=3, deepcache_start_ratio=0.2,
            )
        assert "FakeDiT" in caplog.text
        assert "UNet" in caplog.text


class TestWrapperFallback:
    """apply_deepcache を通り抜けても、実行時に UNet でなければ素通しする保険。"""

    def _call_wrapper(self, class_obj, state):
        executor = MagicMock(name="executor")
        executor.class_obj = class_obj
        sentinel = object()
        executor.return_value = sentinel
        result = deepcache_mod.deepcache_diffusion_model_wrapper(
            executor,
            x=MagicMock(),
            timesteps=MagicMock(),
            context=MagicMock(),
            transformer_options={"deepcache_state": state},
        )
        return executor, result, sentinel

    def test_non_unet_falls_through_to_executor(self):
        state = deepcache_mod.DeepCacheState()
        executor, result, sentinel = self._call_wrapper(FakeDiT(), state)
        executor.assert_called_once()
        assert result is sentinel

    def test_fallback_warns_only_once(self, caplog):
        state = deepcache_mod.DeepCacheState()
        with caplog.at_level("WARNING", logger="SAX_Bridge"):
            self._call_wrapper(FakeDiT(), state)
            self._call_wrapper(FakeDiT(), state)
        assert caplog.text.count("not a UNet") == 1
        assert state.structure_warned is True
