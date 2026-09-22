"""nodes/model_cache.py と、ローダー系ノードのキャッシュ挙動のテスト。

中核の回帰: seed だけを変えて同じチェックポイントを 2 回ロードしても、
実際のディスク読み込み（load_checkpoint_guess_config）は 1 回しか呼ばれないこと。
"""

from unittest.mock import MagicMock, patch

import pytest

from nodes import model_cache
from nodes.loader import SAX_Bridge_Loader


# ---------------------------------------------------------------------------
# _LRUCache 単体
# ---------------------------------------------------------------------------
class TestLRUCache:
    def test_loads_once_then_hits(self):
        cache = model_cache._LRUCache("t")
        loader = MagicMock(return_value="value")
        assert cache.get_or_load("k", loader) == "value"
        assert cache.get_or_load("k", loader) == "value"
        loader.assert_called_once()

    def test_distinct_keys_load_separately(self):
        cache = model_cache._LRUCache("t")
        loader_a = MagicMock(return_value="a")
        loader_b = MagicMock(return_value="b")
        assert cache.get_or_load("ka", loader_a) == "a"
        assert cache.get_or_load("kb", loader_b) == "b"
        loader_a.assert_called_once()
        loader_b.assert_called_once()

    def test_evicts_least_recently_used(self):
        cache = model_cache._LRUCache("t", max_entries=2)
        cache.get_or_load("k1", lambda: 1)
        cache.get_or_load("k2", lambda: 2)
        cache.get_or_load("k3", lambda: 3)  # k1 を追い出す
        assert len(cache) == 2
        reload_k1 = MagicMock(return_value=1)
        cache.get_or_load("k1", reload_k1)
        reload_k1.assert_called_once()  # 追い出されたので再ロード

    def test_access_refreshes_recency(self):
        cache = model_cache._LRUCache("t", max_entries=2)
        cache.get_or_load("k1", lambda: 1)
        cache.get_or_load("k2", lambda: 2)
        cache.get_or_load("k1", lambda: 1)  # k1 を最新に
        cache.get_or_load("k3", lambda: 3)  # 最古の k2 を追い出す
        hit_k1 = MagicMock(return_value=1)
        cache.get_or_load("k1", hit_k1)
        hit_k1.assert_not_called()  # k1 は残っている

    def test_clear(self):
        cache = model_cache._LRUCache("t")
        cache.get_or_load("k", lambda: 1)
        cache.clear()
        assert len(cache) == 0

    def test_clear_all(self):
        model_cache.checkpoint_cache.get_or_load("k", lambda: 1)
        model_cache.vae_cache.get_or_load("k", lambda: 1)
        model_cache.clear_all()
        assert len(model_cache.checkpoint_cache) == 0
        assert len(model_cache.vae_cache) == 0


# ---------------------------------------------------------------------------
# file_token
# ---------------------------------------------------------------------------
class TestFileToken:
    def test_none_for_falsy_path(self):
        assert model_cache.file_token(None) is None
        assert model_cache.file_token("") is None

    def test_none_for_missing_file(self):
        assert model_cache.file_token("/nonexistent/path/x.safetensors") is None

    def test_returns_mtime_for_existing_file(self, tmp_path):
        f = tmp_path / "f.bin"
        f.write_bytes(b"x")
        assert model_cache.file_token(str(f)) == pytest.approx(f.stat().st_mtime)

    def test_token_changes_when_file_changes(self, tmp_path):
        import os
        f = tmp_path / "f.bin"
        f.write_bytes(b"x")
        t1 = model_cache.file_token(str(f))
        os.utime(str(f), (t1 + 100, t1 + 100))
        t2 = model_cache.file_token(str(f))
        assert t1 != t2


# ---------------------------------------------------------------------------
# ローダー統合: seed を変えてもディスクロードは 1 回
# ---------------------------------------------------------------------------
def _default_kwargs(**overrides):
    kwargs = {
        "ckpt_name": "model.safetensors",
        "clip_skip": -1,
        "vae_name": "baked_vae",
        "lora_name": "None",
        "lora_model_strength": 1.0,
        "v_pred": False,
        "seed": 1,
        "steps": 20,
        "cfg": 8.0,
        "sampler_name": "euler",
        "scheduler_name": "normal",
        "denoise": 1.0,
        "width": 512,
        "height": 512,
        "batch_size": 1,
    }
    kwargs.update(overrides)
    return kwargs


def _checkpoint_mocks():
    model = MagicMock(name="model")
    clip = MagicMock(name="clip")
    clip.clone = MagicMock(return_value=clip)
    clip.clip_layer = MagicMock()
    vae = MagicMock(name="vae")
    return model, clip, vae


class TestLoaderCacheIntegration:
    def test_same_checkpoint_different_seed_loads_disk_once(self):
        model, clip, vae = _checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)) as mock_load:
            r1 = SAX_Bridge_Loader.execute(**_default_kwargs(seed=1))
            r2 = SAX_Bridge_Loader.execute(**_default_kwargs(seed=2))
        # 中核の回帰: seed が変わってもチェックポイントの実ロードは 1 回だけ
        mock_load.assert_called_once()
        # 返る基底 model は同一オブジェクト（= VRAM 再転送が起きない条件）
        assert r1.args[0]["model"] is r2.args[0]["model"]
        # seed 自体は各実行で正しく反映される
        assert r1.args[0]["seed"] == 1
        assert r2.args[0]["seed"] == 2

    def test_changing_sampling_settings_does_not_reload(self):
        model, clip, vae = _checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)) as mock_load:
            SAX_Bridge_Loader.execute(**_default_kwargs(steps=20, cfg=8.0))
            SAX_Bridge_Loader.execute(**_default_kwargs(steps=8, cfg=2.0, sampler_name="dpmpp_2m"))
        mock_load.assert_called_once()

    def test_different_checkpoint_reloads(self):
        model, clip, vae = _checkpoint_mocks()
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)) as mock_load:
            SAX_Bridge_Loader.execute(**_default_kwargs(ckpt_name="a.safetensors"))
            SAX_Bridge_Loader.execute(**_default_kwargs(ckpt_name="b.safetensors"))
        assert mock_load.call_count == 2

    def test_file_change_invalidates_cache(self, tmp_path):
        model, clip, vae = _checkpoint_mocks()
        f = tmp_path / "model.safetensors"
        f.write_bytes(b"x")

        def _full_path(_folder, _name):
            return str(f)

        with patch("nodes.loader.folder_paths.get_full_path", side_effect=_full_path), \
             patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)) as mock_load:
            SAX_Bridge_Loader.execute(**_default_kwargs(seed=1))
            # 同じファイル・別 seed → キャッシュヒット
            SAX_Bridge_Loader.execute(**_default_kwargs(seed=2))
            assert mock_load.call_count == 1
            # ファイルが更新されたら再ロード
            import os
            t = f.stat().st_mtime
            os.utime(str(f), (t + 100, t + 100))
            SAX_Bridge_Loader.execute(**_default_kwargs(seed=3))
            assert mock_load.call_count == 2

    def test_external_vae_cached(self):
        model, clip, vae = _checkpoint_mocks()
        external_vae = MagicMock(name="external_vae")
        with patch("nodes.loader.comfy.sd.load_checkpoint_guess_config",
                   return_value=(model, clip, vae, None)), \
             patch("nodes.loader.comfy.sd.VAE", return_value=external_vae) as mock_vae_class, \
             patch("nodes.loader.comfy.utils.load_torch_file", return_value={}):
            SAX_Bridge_Loader.execute(**_default_kwargs(vae_name="ext.safetensors", seed=1))
            SAX_Bridge_Loader.execute(**_default_kwargs(vae_name="ext.safetensors", seed=2))
        # 外部 VAE も seed 変更では読み直さない
        mock_vae_class.assert_called_once()
