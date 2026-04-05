"""SAX_Bridge_Cache ノードのテスト。"""

import pytest
from unittest.mock import MagicMock, patch
from nodes.cache import SAX_Bridge_Cache


class TestCacheExecute:
    def _make_pipe(self, model=None):
        return {
            "model": model if model is not None else MagicMock(name="model"),
            "positive": MagicMock(),
            "negative": MagicMock(),
            "loader_settings": {},
        }

    def test_disabled_returns_pipe_as_is(self):
        # enabled=False の場合、pipe をそのまま返す（パススルー）
        pipe = self._make_pipe()
        result = SAX_Bridge_Cache.execute(
            pipe=pipe, enabled=False,
            deepcache_interval=3, deepcache_start_percent=0.2,
        )
        assert result.args[0] is pipe

    def test_no_model_raises(self):
        # pipe に model が無ければ ValueError
        pipe = self._make_pipe()
        pipe["model"] = None
        with pytest.raises(ValueError, match="does not contain a model"):
            SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )

    def test_interval_1_skips_apply_deepcache(self):
        # deepcache_interval=1 の場合、apply_deepcache は呼ばれない
        pipe = self._make_pipe()
        with patch("nodes.cache.apply_deepcache") as mock_apply:
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=1, deepcache_start_percent=0.2,
            )
        mock_apply.assert_not_called()
        # model は pipe から取り出されてそのまま new_pipe に入る
        assert result.args[0]["model"] is pipe["model"]

    def test_interval_3_calls_apply_deepcache(self):
        # deepcache_interval=3 の場合、apply_deepcache が呼ばれる
        pipe = self._make_pipe()
        patched_model = MagicMock(name="patched_model")
        with patch("nodes.cache.apply_deepcache", return_value=patched_model) as mock_apply:
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.25,
            )
        mock_apply.assert_called_once()
        # 引数確認
        call_kwargs = mock_apply.call_args.kwargs
        assert call_kwargs["model"] is pipe["model"]
        assert call_kwargs["deepcache_interval"] == 3
        assert call_kwargs["deepcache_start_ratio"] == 0.25
        # 返された model が new_pipe に入る
        assert result.args[0]["model"] is patched_model

    def test_pipe_immutability(self):
        # 元の pipe dict は変更されず new_pipe は新規 dict
        pipe = self._make_pipe()
        orig_model = pipe["model"]
        patched_model = MagicMock(name="patched_model")
        with patch("nodes.cache.apply_deepcache", return_value=patched_model):
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )
        new_pipe = result.args[0]
        assert new_pipe is not pipe
        assert pipe["model"] is orig_model  # 元の pipe は不変

    def test_new_pipe_preserves_other_keys(self):
        # 元の pipe の他のキーは new_pipe に引き継がれる
        pipe = self._make_pipe()
        with patch("nodes.cache.apply_deepcache", return_value=MagicMock()):
            result = SAX_Bridge_Cache.execute(
                pipe=pipe, enabled=True,
                deepcache_interval=3, deepcache_start_percent=0.2,
            )
        new_pipe = result.args[0]
        assert new_pipe["positive"] is pipe["positive"]
        assert new_pipe["negative"] is pipe["negative"]
        assert "loader_settings" in new_pipe
