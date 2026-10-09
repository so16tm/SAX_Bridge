"""Primitive Store の入力境界と出力位置を検証する。"""

import json
import math

import pytest

from nodes.primitive_store import MAX_ITEMS, SAX_Bridge_Primitive_Store


@pytest.mark.parametrize("payload", ["null", "{}", "42", '"text"', "invalid"])
def test_invalid_root_returns_empty_outputs(payload):
    assert SAX_Bridge_Primitive_Store.execute(payload).args == (None,) * MAX_ITEMS
    assert SAX_Bridge_Primitive_Store.IS_CHANGED(payload) == payload


def test_invalid_entries_preserve_later_output_positions():
    payload = json.dumps([None, 3, {"type": "INT", "value": 12}])
    assert SAX_Bridge_Primitive_Store.execute(payload).args[:3] == (None, None, 12)
    assert SAX_Bridge_Primitive_Store.IS_CHANGED(payload) == payload


@pytest.mark.parametrize("value", ["Infinity", "NaN", "1e999"])
def test_invalid_integer_does_not_stop_valid_outputs(value):
    payload = json.dumps([{"type": "INT", "value": value}, {"type": "STRING", "value": "ok"}])
    assert SAX_Bridge_Primitive_Store.execute(payload).args[:2] == (None, "ok")


def test_random_seed_outside_output_limit_does_not_invalidate_cache():
    payload = json.dumps([{}] * MAX_ITEMS + [{"type": "SEED", "mode": "random"}])
    assert SAX_Bridge_Primitive_Store.IS_CHANGED(payload) == payload


def test_random_seed_invalidates_cache():
    payload = json.dumps([{"type": "SEED", "mode": "random"}])
    assert math.isnan(SAX_Bridge_Primitive_Store.IS_CHANGED(payload))


def test_ui_random_seed_is_used_without_redrawing():
    payload = json.dumps([{"type": "SEED", "mode": "random", "value": 37, "max": 100}])
    assert SAX_Bridge_Primitive_Store.execute(payload).args[0] == 37


Store = SAX_Bridge_Primitive_Store

def _outputs(items_json):
    return Store.execute(items_json=items_json).args


class TestValidItems:
    def test_types_are_converted(self):
        out = _outputs(
            '[{"type":"INT","value":"3.7"},'
            ' {"type":"FLOAT","value":"2.5"},'
            ' {"type":"BOOLEAN","value":1},'
            ' {"type":"STRING","value":"hi"}]'
        )
        assert out[:4] == (4, 2.5, True, "hi")

    def test_output_count_is_fixed(self):
        assert len(_outputs("[]")) == MAX_ITEMS

    def test_items_beyond_max_are_dropped(self):
        items = ",".join('{"type":"INT","value":1}' for _ in range(MAX_ITEMS + 5))
        out = _outputs(f"[{items}]")
        assert len(out) == MAX_ITEMS
        assert all(v == 1 for v in out)

    def test_unconvertible_value_becomes_none(self):
        assert _outputs('[{"type":"INT","value":"abc"}]')[0] is None


@pytest.mark.parametrize("items_json", [
    "[1, 2]",              # 要素が dict でない
    '["x"]',               # 要素が文字列
    "5",                   # 配列ですらない
    '{"a": 1}',            # dict
    "not json",            # パース不能
    "",                    # 空文字
    None,                  # 文字列ですらない
])
class TestMalformedItemsJson:
    def test_execute_does_not_raise(self, items_json):
        assert _outputs(items_json) == (None,) * MAX_ITEMS

    def test_is_changed_does_not_raise(self, items_json):
        # 例外を投げると実行前のグラフ検証段階でワークフロー全体が失敗する
        assert Store.IS_CHANGED(items_json=items_json) == items_json


class TestMixedItems:
    def test_non_dict_entries_are_skipped_not_fatal(self):
        out = _outputs('[{"type":"INT","value":7}, 42, {"type":"STRING","value":"ok"}]')
        assert out[0] == 7
        assert out[1] is None
        assert out[2] == "ok"


class TestSeedRerun:
    def test_random_seed_marks_changed(self):
        assert math.isnan(Store.IS_CHANGED(items_json='[{"type":"SEED","mode":"random"}]'))

    def test_fixed_seed_does_not_mark_changed(self):
        js = '[{"type":"SEED","mode":"fixed","value":5}]'
        assert Store.IS_CHANGED(items_json=js) == js

    def test_random_seed_produces_int_in_range(self):
        v = _outputs('[{"type":"SEED","mode":"random"}]')[0]
        assert isinstance(v, int)
        assert 0 <= v < 2 ** 53
