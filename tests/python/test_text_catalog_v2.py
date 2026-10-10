"""Text Catalog V2 の選択契約、大規模入力、V1 との独立性。"""

import copy
import json
import random

import pytest

from nodes import text_catalog_v2 as catalog
from nodes.text_catalog import SAX_Bridge_Text_Catalog


def config(items=6, count=2):
    return {
        "version": 2,
        "catalog": {"items": [
            {"id": f"i{i}", "name": f"素材 {i}", "text": f" text {i} ", "tags": ["背景"]}
            for i in range(items)
        ]},
        "recipes": [{"id": "r", "name": "組み合わせ", "groups": [
            {"id": "g", "name": "背景", "mode": "random", "on": True,
             "item_ids": [f"i{i}" for i in range(items)], "count": count},
        ]}],
        "active_recipe_id": "r",
    }


def resolve(data, seed=123):
    text, report = catalog.resolve_catalog(json.dumps(data), seed)
    return text, json.loads(report)


def group(data):
    return data["recipes"][0]["groups"][0]


def test_empty_initial_node_is_valid():
    output = catalog.SAX_Bridge_Text_Catalog_V2.execute()
    assert output[0] == ""
    assert json.loads(output[1])["groups"] == []
    assert output.ui["config_json"] == [catalog.DEFAULT_CONFIG]
    assert output.ui["seed"] == [0]


def test_random_selects_exact_distinct_count_in_candidate_order():
    data = config()
    text, report = resolve(data)
    chosen = report["groups"][0]["item_ids"]
    assert len(chosen) == len(set(chosen)) == 2
    assert set(chosen) <= set(group(data)["item_ids"])
    assert chosen == sorted(chosen, key=group(data)["item_ids"].index)
    assert text == "\n".join(f"text {x[1:]}" for x in chosen)
    assert report["seed"] == 123
    assert report["recipe_id"] == "r"


def test_seed_reproduces_and_changing_seed_can_change_selection():
    data = config(items=30, count=7)
    first = resolve(data, 1337)
    assert resolve(data, 1337) == first
    assert len({resolve(data, n)[0] for n in range(10)}) > 1


def test_queued_primitive_random_seed_changes_v2_selection(monkeypatch):
    from nodes.primitive_store import SAX_Bridge_Primitive_Store

    payload = json.dumps([{"type": "SEED", "mode": "random", "value": 37}])
    draws = iter([101, 202, 303])
    monkeypatch.setattr("nodes.primitive_store.random.randint", lambda *args: next(draws))
    data = config(items=30, count=7)
    results = [resolve(data, SAX_Bridge_Primitive_Store.execute(payload)[0]) for _ in range(3)]
    assert [report["seed"] for _, report in results] == [101, 202, 303]
    assert len({text for text, _ in results}) == 3


def test_does_not_consume_global_rng():
    before = random.getstate()
    resolve(config())
    assert random.getstate() == before


def test_group_reorder_and_unrelated_on_off_do_not_change_draw():
    data = config()
    other = copy.deepcopy(group(data))
    other["id"] = "other"
    data["recipes"][0]["groups"].append(other)
    initial = {g["group_id"]: g["item_ids"] for g in resolve(data)[1]["groups"]}
    data["recipes"][0]["groups"].reverse()
    changed = {g["group_id"]: g["item_ids"] for g in resolve(data)[1]["groups"]}
    assert changed == initial
    other["on"] = False
    after = resolve(data)[1]["groups"]
    assert after[0]["item_ids"] == []
    assert after[1]["item_ids"] == initial["g"]


def test_fixed_random_mix_and_cross_group_duplicates_are_kept():
    data = config(items=3, count=3)
    fixed = {"id": "fixed", "name": "固定", "mode": "all", "on": True,
             "item_ids": ["i2", "i0"], "count": 0}
    data["recipes"][0]["groups"].insert(0, fixed)
    assert resolve(data)[0] == "text 2\ntext 0\ntext 0\ntext 1\ntext 2"


@pytest.mark.parametrize("mode", ["all", "random"])
def test_blank_text_is_selected_but_omitted_from_output(mode):
    data = config(items=3, count=3)
    group(data)["mode"] = mode
    data["catalog"]["items"][1]["text"] = " \r\n\t "
    text, report = resolve(data)
    assert text == "text 0\ntext 2"
    assert report["groups"][0]["item_ids"] == ["i0", "i1", "i2"]


@pytest.mark.parametrize("count", [0, 6])
def test_zero_and_all_candidates(count):
    text, report = resolve(config(count=count))
    assert len(report["groups"][0]["item_ids"]) == count
    assert bool(text) == bool(count)


def test_empty_candidates_can_select_zero():
    assert resolve(config(items=0, count=0))[0] == ""


def test_insufficient_candidates_is_explicit_error_only_when_enabled():
    data = config(items=2, count=3)
    with pytest.raises(ValueError, match="count"):
        resolve(data)
    group(data)["on"] = False
    assert resolve(data)[0] == ""


def test_active_recipe_only_and_edits_keep_same_choice():
    data = config()
    second = copy.deepcopy(data["recipes"][0])
    second["id"] = "second"
    second["groups"][0]["mode"] = "all"
    second["groups"][0]["item_ids"] = ["i5"]
    data["recipes"].append(second)
    data["active_recipe_id"] = "second"
    assert resolve(data)[0] == "text 5"
    data["active_recipe_id"] = "r"
    _, report = resolve(data)
    for it in data["catalog"]["items"]:
        it["name"] = "改名"
        it["text"] += "edited"
        it["tags"] = ["更新"]
    assert resolve(data)[1] == report


def test_ten_thousand_items_are_not_truncated():
    data = config(items=10_000, count=1200)
    text, report = resolve(data)
    chosen = report["groups"][0]["item_ids"]
    assert len(chosen) == len(set(chosen)) == 1200
    assert len(text.splitlines()) == 1200
    assert any(int(i[1:]) > 1000 for i in chosen)
    group(data)["mode"] = "all"
    group(data)["item_ids"] = ["i9999"]
    assert resolve(data)[0] == "text 9999"
    group(data)["mode"] = "random"
    group(data)["item_ids"] = [f"i{i}" for i in range(10_000)]
    group(data)["count"] = 10_000
    assert len(resolve(data)[1]["groups"][0]["item_ids"]) == 10_000


@pytest.mark.parametrize("raw", [None, "", "{", "[]", "null", "{}", '{"version":1}'])
def test_invalid_json_and_v1_never_silently_become_empty(raw):
    with pytest.raises(ValueError, match="SAX Text Catalog V2"):
        catalog.resolve_catalog(raw)


@pytest.mark.parametrize("seed", [-1, True, 1.5, "1", catalog.MAX_SEED + 1])
def test_seed_must_be_exact_supported_integer(seed):
    with pytest.raises(ValueError, match="seed"):
        resolve(config(), seed)


def test_max_safe_seed_is_supported():
    assert resolve(config(), catalog.MAX_SEED) == resolve(config(), catalog.MAX_SEED)


@pytest.mark.parametrize(("field", "value"), [
    ("mode", "weighted"), ("on", "false"), ("count", True), ("count", 2.5),
    ("count", -1), ("count", 10_001), ("item_ids", ["missing"]),
    ("item_ids", ["i0", "i0"]), ("item_ids", [{}]), ("item_ids", "i0"),
])
def test_invalid_group_fields_fail_with_field_path(field, value):
    data = config()
    group(data)[field] = value
    with pytest.raises(ValueError, match=field):
        resolve(data)


@pytest.mark.parametrize(("field", "value"), [
    ("id", ""), ("id", "x" * 129), ("name", None), ("name", "x" * 257),
    ("text", 1), ("text", "x" * 65537), ("tags", ["x"] * 9),
    ("tags", [""]), ("tags", [None]), ("tags", ["duplicate", "duplicate"]),
], ids=["empty-id", "long-id", "null-name", "long-name", "numeric-text",
        "long-text", "too-many-tags", "empty-tag", "null-tag", "duplicate-tag"])
def test_invalid_item_fields_fail_with_field_path(field, value):
    data = config()
    data["catalog"]["items"][0][field] = value
    with pytest.raises(ValueError, match=field):
        resolve(data)


@pytest.mark.parametrize("area", ["items", "recipes", "groups"])
def test_duplicate_ids_fail(area):
    data = config()
    target = {"items": data["catalog"]["items"], "recipes": data["recipes"],
              "groups": data["recipes"][0]["groups"]}[area]
    target.append(copy.deepcopy(target[0]))
    with pytest.raises(ValueError, match="ID"):
        resolve(data)


def test_missing_active_recipe_fails():
    data = config()
    data["active_recipe_id"] = "missing"
    with pytest.raises(ValueError, match="active_recipe_id"):
        resolve(data)


def test_item_and_recipe_limits_are_enforced():
    with pytest.raises(ValueError, match="catalog.items"):
        resolve(config(items=10_001))
    data = config()
    data["recipes"] *= 33
    with pytest.raises(ValueError, match="recipes"):
        resolve(data)


def test_json_limit_counts_utf8_bytes(monkeypatch):
    raw = json.dumps(config(), ensure_ascii=False)
    assert len(raw.encode("utf-8")) > len(raw)
    monkeypatch.setattr(catalog, "MAX_JSON_BYTES", len(raw))
    with pytest.raises(ValueError, match="config_json"):
        catalog.resolve_catalog(raw)


def test_output_limit_includes_repeated_groups_and_newlines(monkeypatch):
    data = config(items=1, count=1)
    second = copy.deepcopy(group(data))
    second["id"] = "second"
    data["recipes"][0]["groups"].append(second)
    monkeypatch.setattr(catalog, "MAX_OUTPUT_BYTES", 12)
    # 6 bytes + newline + 6 bytes は 12 bytes を超える。
    with pytest.raises(ValueError, match="結合出力"):
        resolve(data)


def test_node_schema_and_execution_keep_v1_separate():
    v1 = SAX_Bridge_Text_Catalog.define_schema()
    v2 = catalog.SAX_Bridge_Text_Catalog_V2.define_schema()
    assert v1.node_id == "SAX_Bridge_Text_Catalog"
    assert len(v1.outputs) == 32
    assert v2.node_id == "SAX_Bridge_Text_Catalog_V2"
    assert len(v2.outputs) == 2
    assert {x.id for x in v2.inputs} == {"config_json", "seed"}
    raw = json.dumps(config())
    result = catalog.SAX_Bridge_Text_Catalog_V2.execute(raw, 123)
    assert (result[0], result[1]) == catalog.resolve_catalog(raw, 123)
    assert result.ui["text"] == [result[0]]
    assert result.ui["selection_json"] == [result[1]]
    assert result.ui["config_json"] == [raw]
