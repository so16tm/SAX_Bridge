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


def test_random_count_range_is_seeded_and_reports_selected_count():
    data = config(items=8, count=5)
    group(data)["count_min"] = 0
    outputs = [resolve(data, seed) for seed in range(12)]
    assert outputs == [resolve(data, seed) for seed in range(12)]
    for _, report in outputs:
        selected = report["groups"][0]["item_ids"]
        assert 0 <= len(selected) <= 5
        assert report["groups"][0]["chosen_count"] == len(selected)
        assert report["groups"][0]["count_min"] == 0
    assert {len(report["groups"][0]["item_ids"]) for _, report in outputs} >= {0, 1, 2}


def test_fixed_count_preserves_existing_seed_selection():
    data = config(items=30, count=7)
    candidates = group(data)["item_ids"]
    material = json.dumps([123, "r", "g"], ensure_ascii=True, separators=(",", ":"))
    seed_value = int.from_bytes(catalog.hashlib.sha256(material.encode("utf-8")).digest(), "big")
    expected = [candidates[index] for index in sorted(random.Random(seed_value).sample(range(30), 7))]
    assert resolve(data, 123)[1]["groups"][0]["item_ids"] == expected
    group(data)["count_min"] = 7
    assert resolve(data, 123)[1]["groups"][0]["item_ids"] == expected


def test_uniform_explicit_weights_preserve_existing_seed_selection():
    data = config(items=30, count=7)
    group(data)["item_weights"] = {identifier: 4 for identifier in group(data)["item_ids"]}
    candidates = group(data)["item_ids"]
    material = json.dumps([123, "r", "g"], ensure_ascii=True, separators=(",", ":"))
    seed_value = int.from_bytes(catalog.hashlib.sha256(material.encode("utf-8")).digest(), "big")
    expected = [candidates[index] for index in sorted(random.Random(seed_value).sample(range(30), 7))]
    assert resolve(data, 123)[1]["groups"][0]["item_ids"] == expected


def test_weighted_selection_biases_toward_heavier_items_without_replacement():
    data = config(items=4, count=2)
    group(data)["item_weights"] = {"i0": 1, "i1": 1000, "i2": 3, "i3": 0}
    selections = [resolve(data, seed)[1]["groups"][0]["item_ids"] for seed in range(200)]
    assert all(len(selected) == len(set(selected)) == 2 for selected in selections)
    assert all("i3" not in selected for selected in selections)
    assert sum("i1" in selected for selected in selections) > 190


def test_random_upper_count_uses_positive_weight_candidate_count():
    data = config(items=3, count=2)
    group(data)["item_weights"] = {"i0": 1, "i1": 0, "i2": 0}
    with pytest.raises(ValueError, match="count"):
        resolve(data)
    group(data)["count"] = 1
    assert resolve(data)[1]["groups"][0]["item_ids"] == ["i0"]


def test_random_count_min_cannot_hide_an_invalid_weighted_upper_bound():
    data = config(items=3, count=2)
    group(data)["count_min"] = 0
    group(data)["item_weights"] = {"i0": 1, "i1": 0, "i2": 0}
    for seed in range(10):
        with pytest.raises(ValueError, match="count"):
            resolve(data, seed)


def test_nested_weighted_candidates_report_configured_child_weights():
    data = config(items=2, count=1)
    leaf = group(data)
    second = {**copy.deepcopy(leaf), "id": "second"}
    leaf["weight"] = 0
    second["weight"] = 10
    data["recipes"][0]["groups"] = [nested("outer", [leaf, second], "random", 1)]
    _, report = resolve(data)
    outer = report["groups"][0]
    assert outer["selected_group_ids"] == ["second"]
    assert outer["groups"][0]["weight"] == 0
    assert outer["groups"][1]["weight"] == 10


@pytest.mark.parametrize(("field", "value"), [
    ("weight", True), ("weight", -1), ("weight", 1_000_001), ("weight", float("nan")),
    ("weight", float("inf")), ("item_weights", []),
    ("item_weights", {"missing": 1}), ("item_weights", {"i0": True}),
    ("item_weights", {"i0": -0.1}), ("item_weights", {"i0": 1_000_001}),
    ("item_weights", {"i0": float("nan")}), ("item_weights", {"i0": float("inf")}),
])
def test_invalid_weights_fail_with_field_path(field, value):
    data = config()
    group(data)[field] = value
    with pytest.raises(ValueError, match=field):
        resolve(data)


def test_nested_range_and_disabled_report_counts():
    data = config(items=8, count=5)
    leaf = group(data)
    leaf["count_min"] = 0
    data["recipes"][0]["groups"] = [nested("outer", [leaf], "random", 1)]
    _, report = resolve(data)
    outer = report["groups"][0]
    child = outer["groups"][0]
    assert outer["chosen_count"] == 1
    assert child["count_min"] == 0
    assert child["chosen_count"] == len(child["item_ids"])
    outer_config = data["recipes"][0]["groups"][0]
    outer_config["on"] = False
    _, report = resolve(data)
    assert report["groups"][0]["chosen_count"] == 0
    assert report["groups"][0]["groups"][0]["chosen_count"] == 0


def test_nested_component_can_randomly_choose_zero_to_two_children():
    data = config(items=4, count=2)
    first = group(data)
    second = {**copy.deepcopy(first), "id": "second", "item_ids": ["i2", "i3"]}
    outer = nested("outer", [first, second], "random", 2)
    outer["count_min"] = 0
    data["recipes"][0]["groups"] = [outer]
    selected_counts = set()
    for seed in range(20):
        _, report = resolve(data, seed)
        result = report["groups"][0]
        selected_counts.add(result["chosen_count"])
        assert result["chosen_count"] == len(result["selected_group_ids"])
        assert result["count_min"] == 0
        assert report == resolve(data, seed)[1]
    assert selected_counts == {0, 1, 2}


@pytest.mark.parametrize(("mode", "value"), [("all", -1), ("all", 6), ("random", True), ("random", 1.5)])
def test_invalid_count_min_fails_for_every_mode(mode, value):
    data = config()
    group(data)["mode"] = mode
    group(data)["count_min"] = value
    with pytest.raises(ValueError, match="count_min"):
        resolve(data)


def test_count_min_cannot_exceed_count_and_random_upper_bound_stays_enforced():
    data = config(items=2, count=1)
    group(data)["count_min"] = 2
    with pytest.raises(ValueError, match="count_min"):
        resolve(data)
    group(data)["count_min"] = 0
    group(data)["count"] = 3
    with pytest.raises(ValueError, match="count"):
        resolve(data)


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


def nested(identifier, children, mode="all", count=0, on=True):
    return {"id": identifier, "name": identifier, "kind": "nested", "groups": children,
            "mode": mode, "count": count, "on": on}


def test_nested_all_and_random_resolve_whole_children_in_order():
    data = config(items=4, count=2)
    leaf = copy.deepcopy(group(data))
    leaf.update(id="a", mode="all", item_ids=["i1", "i0"])
    other = copy.deepcopy(leaf)
    other.update(id="b", item_ids=["i2", "i3"])
    data["recipes"][0]["groups"] = [nested("outer", [leaf, nested("inner", [other])])]
    assert resolve(data)[0] == "text 1\ntext 0\ntext 2\ntext 3"
    outer = data["recipes"][0]["groups"][0]
    outer.update(mode="random", count=1)
    text, report = resolve(data)
    selected = report["groups"][0]["selected_group_ids"]
    assert len(selected) == 1
    assert text == ("text 1\ntext 0" if selected == ["a"] else "text 2\ntext 3")
    disabled = next(g for g in report["groups"][0]["groups"] if g["group_id"] not in selected)
    assert disabled["on"] is False


def test_nested_disabled_children_remain_random_candidates():
    data = config(items=1, count=1)
    leaf = group(data)
    leaf["on"] = False
    data["recipes"][0]["groups"] = [nested("outer", [leaf], "random", 1)]
    text, report = resolve(data)
    assert text == ""
    outer = report["groups"][0]
    assert outer["candidate_group_ids"] == outer["selected_group_ids"] == ["g"]
    assert outer["groups"][0]["item_ids"] == []


def test_leaf_random_draw_is_stable_after_hierarchy_move():
    data = config(items=20, count=5)
    initial = resolve(data)[1]["groups"][0]["item_ids"]
    data["recipes"][0]["groups"] = [nested("outer", [group(data)])]
    assert resolve(data)[1]["groups"][0]["groups"][0]["item_ids"] == initial


def test_nested_validation_depth_total_and_ids():
    data = config()
    chain = group(data)
    for level in range(7):
        chain = nested(f"n{level}", [chain])
    data["recipes"][0]["groups"] = [chain]
    resolve(data)
    data["recipes"][0]["groups"] = [nested("n8", [chain])]
    with pytest.raises(ValueError, match="深さ"):
        resolve(data)
    duplicate = config()
    duplicate["recipes"][0]["groups"] = [nested("outer", [group(duplicate)]), copy.deepcopy(group(duplicate))]
    with pytest.raises(ValueError, match="重複"):
        resolve(duplicate)
    big = config()
    leaf = group(big)
    big["recipes"][0]["groups"] = [nested(f"n{i}", [{**leaf, "id": f"g{i}_{j}"} for j in range(32)]) for i in range(8)]
    with pytest.raises(ValueError, match="合計"):
        resolve(big)


@pytest.mark.parametrize("mutation", [lambda g: g.update(item_ids=[]), lambda g: g.update(groups="bad")])
def test_nested_rejects_ambiguous_or_invalid_shape(mutation):
    data = config()
    outer = nested("outer", [group(data)])
    mutation(outer)
    data["recipes"][0]["groups"] = [outer]
    with pytest.raises(ValueError):
        resolve(data)


def test_leaf_rejects_explicit_null_kind_like_browser_validator():
    data = config()
    group(data)["kind"] = None
    with pytest.raises(ValueError, match="アイテム型"):
        resolve(data)
