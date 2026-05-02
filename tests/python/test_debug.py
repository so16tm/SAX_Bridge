"""SAX_Bridge Debug ノードのテスト。"""

import pytest
from unittest.mock import MagicMock

from nodes.debug import (
    SAX_Bridge_Assert,
    SAX_Bridge_Assert_Pipe,
    SAX_Bridge_Debug_Inspector,
    SAX_Bridge_Debug_Text,
    _evaluate_assertion,
    _format_pipe_summary,
    _get_dtype_device_info,
    _get_inner_type_name,
    _parse_expected,
    _resolve_path,
    _to_display_string,
)


# ---------------------------------------------------------------------------
# _parse_expected
# ---------------------------------------------------------------------------

class TestParseExpected:
    def test_int(self):
        assert _parse_expected("42") == 42
        assert _parse_expected("-5") == -5

    def test_float(self):
        assert _parse_expected("3.14") == 3.14
        assert _parse_expected("-0.5") == -0.5

    def test_bool_true(self):
        assert _parse_expected("true") is True
        assert _parse_expected("True") is True

    def test_bool_false(self):
        assert _parse_expected("false") is False
        assert _parse_expected("FALSE") is False

    def test_none(self):
        assert _parse_expected("null") is None
        assert _parse_expected("none") is None
        assert _parse_expected("None") is None

    def test_list(self):
        assert _parse_expected("1,2,3") == [1, 2, 3]
        assert _parse_expected("a,b,c") == ["a", "b", "c"]

    def test_string_fallback(self):
        assert _parse_expected("hello") == "hello"

    def test_empty(self):
        assert _parse_expected("") == ""

    def test_passthrough_non_str(self):
        assert _parse_expected(42) == 42


# ---------------------------------------------------------------------------
# _resolve_path
# ---------------------------------------------------------------------------

class TestResolvePath:
    def test_empty_path_returns_value(self):
        v = {"a": 1}
        assert _resolve_path(v, "") is v

    def test_dict_access(self):
        v = {"a": {"b": 42}}
        assert _resolve_path(v, "a.b") == 42

    def test_attribute_access(self):
        obj = MagicMock()
        obj.foo = "bar"
        assert _resolve_path(obj, "foo") == "bar"

    def test_index_access(self):
        v = {"items": ["x", "y", "z"]}
        assert _resolve_path(v, "items.1") == "y"

    def test_unknown_key_raises(self):
        v = {"a": 1}
        with pytest.raises(RuntimeError, match="path resolution error"):
            _resolve_path(v, "missing")

    def test_mixed_access(self):
        v = {"outer": {"inner": [10, 20, 30]}}
        assert _resolve_path(v, "outer.inner.2") == 30


# ---------------------------------------------------------------------------
# _evaluate_assertion
# ---------------------------------------------------------------------------

class TestEvaluateAssertion:
    def test_not_none_pass(self):
        passed, _ = _evaluate_assertion(42, "not_none", "")
        assert passed

    def test_not_none_fail(self):
        passed, _ = _evaluate_assertion(None, "not_none", "")
        assert not passed

    def test_is_none_pass(self):
        passed, _ = _evaluate_assertion(None, "is_none", "")
        assert passed

    def test_is_none_fail(self):
        passed, _ = _evaluate_assertion(0, "is_none", "")
        assert not passed

    def test_equals_int(self):
        passed, _ = _evaluate_assertion(42, "equals", "42")
        assert passed

    def test_equals_float(self):
        passed, _ = _evaluate_assertion(3.14, "equals", "3.14")
        assert passed

    def test_equals_bool(self):
        passed, _ = _evaluate_assertion(True, "equals", "true")
        assert passed

    def test_not_equals(self):
        passed, _ = _evaluate_assertion(5, "not_equals", "3")
        assert passed

    def test_contains(self):
        passed, _ = _evaluate_assertion("hello world", "contains", "world")
        assert passed

    def test_not_contains(self):
        passed, _ = _evaluate_assertion("hello", "not_contains", "world")
        assert passed

    def test_matches(self):
        passed, _ = _evaluate_assertion("abc123", "matches", r"\d+")
        assert passed

    def test_matches_fail(self):
        passed, _ = _evaluate_assertion("abc", "matches", r"\d+")
        assert not passed

    def test_startswith(self):
        passed, _ = _evaluate_assertion("hello", "startswith", "hel")
        assert passed

    def test_endswith(self):
        passed, _ = _evaluate_assertion("hello", "endswith", "llo")
        assert passed

    def test_greater_than(self):
        passed, _ = _evaluate_assertion(10, "greater_than", "5")
        assert passed

    def test_less_than(self):
        passed, _ = _evaluate_assertion(3, "less_than", "5")
        assert passed

    def test_in_range_pass(self):
        passed, _ = _evaluate_assertion(5, "in_range", "1,10")
        assert passed

    def test_in_range_fail(self):
        passed, _ = _evaluate_assertion(15, "in_range", "1,10")
        assert not passed

    def test_in_range_bad_format(self):
        with pytest.raises(ValueError, match="in_range requires"):
            _evaluate_assertion(5, "in_range", "1")

    def test_shape_equals_torch(self):
        torch = pytest.importorskip("torch")
        t = torch.zeros(1, 4, 64, 64)
        passed, _ = _evaluate_assertion(t, "shape_equals", "1,4,64,64")
        assert passed

    def test_shape_equals_fail(self):
        torch = pytest.importorskip("torch")
        t = torch.zeros(1, 3, 32, 32)
        passed, _ = _evaluate_assertion(t, "shape_equals", "1,4,64,64")
        assert not passed

    def test_shape_equals_no_shape(self):
        passed, _ = _evaluate_assertion([1, 2, 3], "shape_equals", "3")
        assert not passed

    def test_length_equals(self):
        passed, _ = _evaluate_assertion([1, 2, 3], "length_equals", "3")
        assert passed

    def test_has_key(self):
        passed, _ = _evaluate_assertion({"a": 1, "b": 2}, "has_key", "a")
        assert passed

    def test_has_key_fail(self):
        passed, _ = _evaluate_assertion({"a": 1}, "has_key", "z")
        assert not passed

    def test_has_item(self):
        passed, _ = _evaluate_assertion([1, 2, 3], "has_item", "2")
        assert passed

    def test_unknown_mode(self):
        with pytest.raises(ValueError, match="unknown assertion mode"):
            _evaluate_assertion(1, "bogus", "")


# ---------------------------------------------------------------------------
# _to_display_string
# ---------------------------------------------------------------------------

class TestToDisplayString:
    def test_none(self):
        assert _to_display_string(None) == "None"

    def test_str(self):
        assert _to_display_string("hello") == "hello"

    def test_int(self):
        assert _to_display_string(42) == "42"

    def test_float(self):
        assert _to_display_string(3.14) == "3.14"

    def test_bool(self):
        assert _to_display_string(True) == "True"

    def test_dict(self):
        s = _to_display_string({"a": 1, "b": 2})
        assert "dict" in s
        assert "a" in s and "b" in s

    def test_list(self):
        s = _to_display_string([1, 2, 3])
        assert "list" in s
        assert "len=3" in s

    def test_tuple(self):
        s = _to_display_string((1, 2))
        assert "tuple" in s
        assert "len=2" in s

    def test_tensor(self):
        torch = pytest.importorskip("torch")
        t = torch.zeros(1, 3, 64, 64)
        s = _to_display_string(t)
        assert "Tensor" in s
        assert "shape=(1, 3, 64, 64)" in s
        assert "dtype=" in s

    def test_comfyui_like_object(self):
        class Inner:
            pass
        class Outer:
            def __init__(self):
                self.model = Inner()
        s = _to_display_string(Outer())
        assert "Outer" in s
        assert "inner: Inner" in s

    def test_plain_object(self):
        class Foo:
            pass
        s = _to_display_string(Foo())
        assert "Foo" in s


# ---------------------------------------------------------------------------
# _get_inner_type_name / _get_dtype_device_info
# ---------------------------------------------------------------------------

class TestGetInnerTypeName:
    def test_model_attr(self):
        class Inner:
            pass
        class Outer:
            def __init__(self):
                self.model = Inner()
        assert _get_inner_type_name(Outer()) == "Inner"

    def test_cond_stage_model(self):
        class Inner:
            pass
        class Outer:
            def __init__(self):
                self.cond_stage_model = Inner()
        assert _get_inner_type_name(Outer()) == "Inner"

    def test_first_stage_model(self):
        class Inner:
            pass
        class Outer:
            def __init__(self):
                self.first_stage_model = Inner()
        assert _get_inner_type_name(Outer()) == "Inner"

    def test_none(self):
        class Plain:
            pass
        assert _get_inner_type_name(Plain()) is None


class TestGetDtypeDeviceInfo:
    def test_dtype_from_model(self):
        class Inner:
            dtype = "torch.float16"
        class Outer:
            def __init__(self):
                self.model = Inner()
        info = _get_dtype_device_info(Outer())
        assert info.get("dtype") == "torch.float16"

    def test_device_from_load_device(self):
        class Outer:
            load_device = "cuda:0"
        info = _get_dtype_device_info(Outer())
        assert info.get("device") == "cuda:0"

    def test_empty(self):
        class Plain:
            pass
        assert _get_dtype_device_info(Plain()) == {}

    def test_manual_cast_dtype_fallback(self):
        class Inner:
            manual_cast_dtype = "torch.bfloat16"
        class Outer:
            def __init__(self):
                self.model = Inner()
        info = _get_dtype_device_info(Outer())
        assert info.get("dtype") == "torch.bfloat16"


# ---------------------------------------------------------------------------
# _format_pipe_summary
# ---------------------------------------------------------------------------

class TestFormatPipeSummary:
    def test_none(self):
        assert _format_pipe_summary(None) == "pipe: None"

    def test_not_dict(self):
        assert "not a dict" in _format_pipe_summary("str")

    def test_empty_dict(self):
        s = _format_pipe_summary({})
        assert "model: None" in s
        assert "clip: None" in s
        assert "vae: None" in s

    def test_with_model(self):
        pipe = {"model": MagicMock(), "clip": None, "vae": None, "seed": 42}
        s = _format_pipe_summary(pipe)
        assert "model: MagicMock" in s
        assert "seed: 42" in s

    def test_with_settings(self):
        pipe = {
            "loader_settings": {"steps": 20, "cfg": 8.0, "sampler_name": "euler"}
        }
        s = _format_pipe_summary(pipe)
        assert "loader_settings.steps: 20" in s
        assert "loader_settings.cfg: 8.0" in s
        assert "loader_settings.sampler_name: euler" in s

    def test_with_images_shape(self):
        torch = pytest.importorskip("torch")
        pipe = {"images": torch.zeros(1, 512, 512, 3)}
        s = _format_pipe_summary(pipe)
        assert "images: shape=(1, 512, 512, 3)" in s

    def test_with_samples(self):
        torch = pytest.importorskip("torch")
        pipe = {"samples": {"samples": torch.zeros(1, 4, 64, 64)}}
        s = _format_pipe_summary(pipe)
        assert "samples.samples: shape=(1, 4, 64, 64)" in s

    def test_with_applied_loras(self):
        pipe = {"_applied_loras": {"lora_a", "lora_b"}}
        s = _format_pipe_summary(pipe)
        assert "applied_loras:" in s
        assert "2 entries" in s

    def test_model_with_dtype_device(self):
        class Inner:
            dtype = "torch.float16"
        class ModelPatcher:
            load_device = "cuda:0"
            def __init__(self):
                self.model = Inner()
        pipe = {"model": ModelPatcher()}
        s = _format_pipe_summary(pipe)
        assert "inner: Inner" in s
        assert "dtype=torch.float16" in s
        assert "device=cuda:0" in s

    def test_clip_with_inner(self):
        class Inner:
            pass
        class Clip:
            def __init__(self):
                self.cond_stage_model = Inner()
        pipe = {"clip": Clip()}
        s = _format_pipe_summary(pipe)
        assert "clip: Clip" in s
        assert "inner: Inner" in s

    def test_vae_with_inner(self):
        class Inner:
            pass
        class Vae:
            def __init__(self):
                self.first_stage_model = Inner()
        pipe = {"vae": Vae()}
        s = _format_pipe_summary(pipe)
        assert "vae: Vae" in s
        assert "inner: Inner" in s


# ---------------------------------------------------------------------------
# SAX_Bridge_Debug_Inspector
# ---------------------------------------------------------------------------

class TestDebugInspector:
    def test_execute_with_pipe(self):
        pipe = {"model": MagicMock(), "seed": 42}
        result = SAX_Bridge_Debug_Inspector.execute(pipe)
        assert result.ui is not None
        assert "text" in result.ui
        text = result.ui["text"][0]
        assert "model: MagicMock" in text
        assert "seed: 42" in text

    def test_execute_with_none(self):
        result = SAX_Bridge_Debug_Inspector.execute(None)
        assert "pipe: None" in result.ui["text"][0]


# ---------------------------------------------------------------------------
# SAX_Bridge_Debug_Text
# ---------------------------------------------------------------------------

class TestDebugText:
    def test_execute_str(self):
        result = SAX_Bridge_Debug_Text.execute("hello")
        assert result.ui["text"][0] == "hello"

    def test_execute_int(self):
        result = SAX_Bridge_Debug_Text.execute(42)
        assert result.ui["text"][0] == "42"

    def test_execute_float(self):
        result = SAX_Bridge_Debug_Text.execute(3.14)
        assert result.ui["text"][0] == "3.14"

    def test_execute_none(self):
        result = SAX_Bridge_Debug_Text.execute(None)
        assert result.ui["text"][0] == "None"

    def test_execute_empty_str(self):
        result = SAX_Bridge_Debug_Text.execute("")
        assert result.ui["text"][0] == ""

    def test_execute_dict(self):
        result = SAX_Bridge_Debug_Text.execute({"a": 1})
        assert "dict" in result.ui["text"][0]

    def test_execute_list(self):
        result = SAX_Bridge_Debug_Text.execute([1, 2, 3])
        assert "list" in result.ui["text"][0]
        assert "len=3" in result.ui["text"][0]

    def test_execute_tensor(self):
        torch = pytest.importorskip("torch")
        result = SAX_Bridge_Debug_Text.execute(torch.zeros(2, 3))
        text = result.ui["text"][0]
        assert "Tensor" in text
        assert "shape=(2, 3)" in text


# ---------------------------------------------------------------------------
# SAX_Bridge_Assert
# ---------------------------------------------------------------------------

class TestAssert:
    def test_pass(self):
        result = SAX_Bridge_Assert.execute(42, "not_none", "", "test")
        assert "PASS" in result.ui["text"][0]

    def test_fail(self):
        result = SAX_Bridge_Assert.execute(None, "not_none", "", "test")
        assert "FAIL" in result.ui["text"][0]

    def test_equals_pass(self):
        result = SAX_Bridge_Assert.execute(10, "equals", "10", "eq")
        assert "PASS" in result.ui["text"][0]

    def test_equals_fail(self):
        result = SAX_Bridge_Assert.execute(10, "equals", "20", "eq")
        assert "FAIL" in result.ui["text"][0]

    def test_in_range_pass(self):
        result = SAX_Bridge_Assert.execute(5, "in_range", "1,10", "r")
        assert "PASS" in result.ui["text"][0]

    def test_error_mode(self):
        # in_range で不正なフォーマット → ValueError、UI テキストに ERROR
        result = SAX_Bridge_Assert.execute(5, "in_range", "bad", "r")
        assert "ERROR" in result.ui["text"][0]


# ---------------------------------------------------------------------------
# SAX_Bridge_Assert_Pipe
# ---------------------------------------------------------------------------

class TestAssertPipe:
    def test_path_resolution_pass(self):
        pipe = {"loader_settings": {"steps": 20}}
        result = SAX_Bridge_Assert_Pipe.execute(
            pipe, "loader_settings.steps", "equals", "20", "steps"
        )
        assert "PASS" in result.ui["text"][0]

    def test_path_resolution_fail(self):
        pipe = {"loader_settings": {"steps": 20}}
        result = SAX_Bridge_Assert_Pipe.execute(
            pipe, "loader_settings.steps", "equals", "99", "steps"
        )
        assert "FAIL" in result.ui["text"][0]

    def test_path_not_found(self):
        pipe = {"a": 1}
        result = SAX_Bridge_Assert_Pipe.execute(
            pipe, "nonexistent", "not_none", "", "x"
        )
        assert "ERROR" in result.ui["text"][0]
        assert "path resolution failed" in result.ui["text"][0]

    def test_empty_path_uses_value_directly(self):
        result = SAX_Bridge_Assert_Pipe.execute(
            42, "", "equals", "42", "direct"
        )
        assert "PASS" in result.ui["text"][0]

    def test_shape_via_path(self):
        torch = pytest.importorskip("torch")
        pipe = {"images": torch.zeros(1, 512, 512, 3)}
        result = SAX_Bridge_Assert_Pipe.execute(
            pipe, "images", "shape_equals", "1,512,512,3", "shape"
        )
        assert "PASS" in result.ui["text"][0]
