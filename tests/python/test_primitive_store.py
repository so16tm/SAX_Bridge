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
