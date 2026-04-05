"""SAX_Bridge_Loader_Lora ノードのテスト。"""

import json
import pytest
from unittest.mock import MagicMock, patch
from nodes.loader import SAX_Bridge_Loader_Lora
from nodes.io_types import _APPLIED_LORAS_KEY, _normalize_lora_name


def _make_pipe(model=None, clip=None, applied=None):
    pipe = {
        "model": model or MagicMock(name="model"),
        "clip": clip or MagicMock(name="clip"),
    }
    if applied is not None:
        pipe[_APPLIED_LORAS_KEY] = set(applied)
    return pipe


def _patch_lora_loader(return_models=None):
    """nodes.LoraLoader().load_lora をモックするコンテキスト。"""
    fake_loader = MagicMock()
    if return_models is None:
        def _side(model, clip, name, sm, sc):
            return (MagicMock(name=f"model_after_{name}"), MagicMock(name=f"clip_after_{name}"))
        fake_loader.load_lora = MagicMock(side_effect=_side)
    else:
        fake_loader.load_lora = MagicMock(return_value=return_models)
    return patch("nodes.loader.nodes.LoraLoader", return_value=fake_loader), fake_loader


class TestLoaderLoraDisabled:
    """enabled=False の場合は pipe をそのまま返す。"""

    def test_disabled_returns_original_pipe(self):
        pipe = _make_pipe()
        p, _ = _patch_lora_loader()
        with p as mock_cls:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=False, loras_json='[{"on": true, "lora": "x.safetensors", "strength": 1.0}]',
            )
        assert result.args[0] is pipe
        mock_cls.assert_not_called()


class TestLoaderLoraJsonParsing:
    """loras_json のパース失敗時の挙動。"""

    def test_invalid_json_returns_pipe(self):
        pipe = _make_pipe()
        p, _ = _patch_lora_loader()
        with p as mock_cls:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json="not valid json",
            )
        assert result.args[0] is pipe
        mock_cls.assert_not_called()

    def test_non_list_json_returns_pipe(self):
        pipe = _make_pipe()
        p, _ = _patch_lora_loader()
        with p as mock_cls:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json='{"not": "a list"}',
            )
        assert result.args[0] is pipe
        mock_cls.assert_not_called()

    def test_empty_array(self):
        pipe = _make_pipe()
        p, _ = _patch_lora_loader()
        with p as mock_cls:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json="[]",
            )
        assert result.args[0]["model"] is pipe["model"]
        mock_cls().load_lora.assert_not_called()


class TestLoaderLoraValidation:
    """pipe に model が無い場合のバリデーション。"""

    def test_missing_model_raises(self):
        pipe = {"model": None, "clip": MagicMock()}
        with pytest.raises(ValueError, match="model"):
            SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json='[]',
            )


class TestLoaderLoraApplication:
    """LoRA 適用動作。"""

    def test_single_lora_applied(self):
        pipe = _make_pipe()
        loras_json = json.dumps([
            {"on": True, "lora": "foo.safetensors", "strength": 0.8},
        ])
        p, fake_loader = _patch_lora_loader()
        with p:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        fake_loader.load_lora.assert_called_once()
        args, _ = fake_loader.load_lora.call_args
        assert args[2] == "foo.safetensors"
        assert args[3] == 0.8
        assert args[4] == 0.8
        applied = result.args[0].get(_APPLIED_LORAS_KEY, set())
        assert _normalize_lora_name("foo.safetensors") in applied

    def test_multiple_loras_stacked(self):
        pipe = _make_pipe()
        loras_json = json.dumps([
            {"on": True, "lora": "a.safetensors", "strength": 0.5},
            {"on": True, "lora": "b.safetensors", "strength": 1.0},
            {"on": True, "lora": "c.safetensors", "strength": 0.7},
        ])
        p, fake_loader = _patch_lora_loader()
        with p:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        assert fake_loader.load_lora.call_count == 3
        applied = result.args[0].get(_APPLIED_LORAS_KEY, set())
        assert _normalize_lora_name("a.safetensors") in applied
        assert _normalize_lora_name("b.safetensors") in applied
        assert _normalize_lora_name("c.safetensors") in applied

    def test_off_entry_skipped(self):
        pipe = _make_pipe()
        loras_json = json.dumps([
            {"on": False, "lora": "disabled.safetensors", "strength": 1.0},
            {"on": True, "lora": "enabled.safetensors", "strength": 1.0},
        ])
        p, fake_loader = _patch_lora_loader()
        with p:
            SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        assert fake_loader.load_lora.call_count == 1
        args, _ = fake_loader.load_lora.call_args
        assert args[2] == "enabled.safetensors"

    def test_on_defaults_to_true_when_missing(self):
        # on キーが無い場合は True 扱い
        pipe = _make_pipe()
        loras_json = json.dumps([
            {"lora": "implicit_on.safetensors", "strength": 1.0},
        ])
        p, fake_loader = _patch_lora_loader()
        with p:
            SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        fake_loader.load_lora.assert_called_once()

    @pytest.mark.parametrize("lora_name,strength", [
        ("", 1.0),       # 空のファイル名はスキップ
        ("   ", 1.0),    # 空白のみもスキップ
        ("x.safetensors", 0.0),  # 強度 0 もスキップ
    ])
    def test_invalid_entry_skipped(self, lora_name, strength):
        pipe = _make_pipe()
        loras_json = json.dumps([
            {"on": True, "lora": lora_name, "strength": strength},
        ])
        p, fake_loader = _patch_lora_loader()
        with p:
            SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        fake_loader.load_lora.assert_not_called()

    def test_already_applied_lora_skipped(self):
        # pipe 内の _applied_loras に含まれる LoRA は再適用されない
        pipe = _make_pipe(applied=[_normalize_lora_name("already.safetensors")])
        loras_json = json.dumps([
            {"on": True, "lora": "already.safetensors", "strength": 1.0},
            {"on": True, "lora": "fresh.safetensors", "strength": 1.0},
        ])
        p, fake_loader = _patch_lora_loader()
        with p:
            SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        assert fake_loader.load_lora.call_count == 1
        args, _ = fake_loader.load_lora.call_args
        assert args[2] == "fresh.safetensors"

    def test_load_failure_continues(self):
        # load_lora 内で例外が出ても継続する
        pipe = _make_pipe()
        loras_json = json.dumps([
            {"on": True, "lora": "bad.safetensors", "strength": 1.0},
            {"on": True, "lora": "good.safetensors", "strength": 1.0},
        ])
        fake_loader = MagicMock()
        call_count = {"n": 0}

        def _side(model, clip, name, sm, sc):
            call_count["n"] += 1
            if name == "bad.safetensors":
                raise RuntimeError("boom")
            return (MagicMock(), MagicMock())

        fake_loader.load_lora = MagicMock(side_effect=_side)
        with patch("nodes.loader.nodes.LoraLoader", return_value=fake_loader):
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        assert call_count["n"] == 2
        applied = result.args[0].get(_APPLIED_LORAS_KEY, set())
        assert _normalize_lora_name("good.safetensors") in applied
        assert _normalize_lora_name("bad.safetensors") not in applied


class TestLoaderLoraImmutability:
    """元の pipe が変更されないこと。"""

    def test_original_pipe_not_mutated(self):
        pipe = _make_pipe()
        orig_model = pipe["model"]
        loras_json = json.dumps([
            {"on": True, "lora": "foo.safetensors", "strength": 1.0},
        ])
        p, _ = _patch_lora_loader()
        with p:
            result = SAX_Bridge_Loader_Lora.execute(
                pipe=pipe, enabled=True, loras_json=loras_json,
            )
        assert pipe["model"] is orig_model
        assert result.args[0] is not pipe
