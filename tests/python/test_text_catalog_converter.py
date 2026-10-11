import copy
import json

import pytest

from nodes import text_catalog_converter, text_catalog_v2_store
from nodes.text_catalog_converter import SAX_Bridge_Text_Catalog_Converter, convert_v1
from nodes.text_catalog_v2 import resolve_catalog


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(text_catalog_v2_store, "directory", lambda: tmp_path)
    text_catalog_v2_store._cache.clear()


def source(items=None, relations=None, **extra):
    value = {
        "version": 1,
        "catalog": {"items": [] if items is None else items, "tag_definitions": [{"id": "ignored"}]},
        "relations": [] if relations is None else relations,
    }
    value.update(extra)
    return value


def test_preserves_every_item_and_only_v1_item_fields():
    items = [
        {"id": "a", "name": "A", "text": "alpha", "tags": ["x"], "extra": "ignored"},
        {"id": "unused", "name": "Unused", "text": "beta", "tags": []},
    ]
    result = convert_v1(json.dumps(source(items, [{"item_id": "a"}])), "移行")
    assert result["catalog"]["items"] == [
        {"id": "a", "name": "A", "text": "alpha", "tags": ["x"]},
        {"id": "unused", "name": "Unused", "text": "beta", "tags": []},
    ]
    assert result["name"] == "移行"


def test_relation_rows_preserve_order_duplicates_off_and_empty():
    payload = source(
        [{"id": "a", "name": "Alpha", "text": "x", "tags": []}],
        [{"item_id": "a"}, {"item_id": "a", "on": False}, {"item_id": None, "on": 0}],
    )
    result = convert_v1(json.dumps(payload), "Converted")
    groups = result["recipes"][0]["groups"]
    assert [g["id"] for g in groups] == ["v1_relation_0", "v1_relation_1", "v1_relation_2"]
    assert [g["name"] for g in groups] == ["Alpha/スロット1", "Alpha/スロット2", "未選択/スロット3"]
    assert [g["item_ids"] for g in groups] == [["a"], ["a"], []]
    assert [g["on"] for g in groups] == [True, False, False]
    assert all(g["mode"] == "all" and g["count"] == 0 for g in groups)


def test_empty_catalog_and_relations_convert():
    result = convert_v1(json.dumps(source()), "Empty")
    assert result == {
        "version": 2, "name": "Empty", "catalog": {"items": []},
        "recipes": [{"id": "v1_set", "name": "V1の選択", "groups": []}],
        "active_recipe_id": "v1_set",
    }


def test_long_item_name_is_preserved_and_group_name_obeys_v2_limit():
    long_name = "名" * 256
    result = convert_v1(json.dumps(source(
        [{"id": "a", "name": long_name, "text": "x", "tags": []}],
        [{"item_id": "a"}],
    )), "Converted")
    assert result["catalog"]["items"][0]["name"] == long_name
    assert len(result["recipes"][0]["groups"][0]["name"]) == 256
    with pytest.raises(ValueError):
        convert_v1(json.dumps(source()), "名" * 257)


@pytest.mark.parametrize("raw", [
    '{"version":2,"catalog":{"items":[]},"relations":[]}',
    '{"version":true,"catalog":{"items":[]},"relations":[]}',
    '{"version":1,"catalog":{},"relations":[]}',
    '{"version":1,"catalog":{"items":[]},"relations":{}}',
    '{"version":1,"catalog":{"items":[{"id":"a","name":"A","text":"x","tags":[]}]},"relations":[{"item_id":"missing"}]}',
    '{"version":1,"catalog":{"items":[{"id":"a","name":"A","text":"x","tags":[]},{"id":"a","name":"B","text":"y","tags":[]}]},"relations":[]}',
])
def test_invalid_documents_raise_value_error(raw):
    with pytest.raises(ValueError):
        convert_v1(raw, "Converted")


def test_item_and_relation_limits_and_json_size():
    item = {"id": "a", "name": "A", "text": "x", "tags": []}
    with pytest.raises(ValueError, match="catalog.items"):
        convert_v1(json.dumps(source([item] * 257)), "x")
    with pytest.raises(ValueError, match="relations"):
        convert_v1(json.dumps(source(relations=[{"item_id": None}] * 33)), "x")
    with pytest.raises(ValueError, match="32 MiB"):
        convert_v1(" " * (32 * 1024 * 1024 + 1), "x")


def test_input_is_not_mutated():
    payload = source([{"id": "a", "name": "A", "text": "x", "tags": []}], [{"item_id": "a"}])
    before = copy.deepcopy(payload)
    convert_v1(json.dumps(payload), "x")
    assert payload == before


def test_execute_is_repeatable_and_returns_json_without_storage_side_effects(monkeypatch):
    payload = json.dumps(source([{"id": "a", "name": "A", "text": "x", "tags": []}], [{"item_id": "a"}]))
    def forbidden(*args, **kwargs):
        raise AssertionError("converter must not save")
    monkeypatch.setattr("nodes.text_catalog_v2_store.create", forbidden, raising=False)
    first = SAX_Bridge_Text_Catalog_Converter.execute(payload, "Converted")
    second = SAX_Bridge_Text_Catalog_Converter.execute(payload, "Converted")
    assert first.args == second.args
    assert json.loads(first.args[0])["version"] == 2


def test_converted_recipe_resolves_in_relation_order_with_duplicates_and_off():
    payload = source(
        [
            {"id": "a", "name": "A", "text": "first", "tags": []},
            {"id": "b", "name": "B", "text": "second", "tags": []},
        ],
        [
            {"item_id": "a"},
            {"item_id": "b"},
            {"item_id": "a", "on": False},
            {"item_id": "a"},
        ],
    )
    document = convert_v1(json.dumps(payload), "Converted")
    joined, selection = resolve_catalog(json.dumps(document), 0)
    assert joined == "first\nsecond\nfirst"
    assert [group["item_ids"] for group in json.loads(selection)["groups"]] == [
        ["a"], ["b"], [], ["a"]
    ]


def test_register_v1_creates_new_catalog_and_returns_import_ids():
    payload = {"v1_json": json.dumps(source(
        [{"id": "a", "name": "A", "text": "alpha", "tags": []}],
        [{"item_id": "a"}],
    )), "catalog_name": "Imported"}
    result = text_catalog_converter.register_v1(payload)
    saved = text_catalog_v2_store.get(result["id"])
    assert result["imported_recipe_ids"] == ["v1_set"]
    assert "imported_recipe_ids" not in saved
    assert saved["catalog"]["items"][0]["id"] == "a"


def test_register_v1_imports_with_fresh_ids_and_preserves_existing_content():
    target = text_catalog_v2_store.create({
        "name": "既存カタログ",
        "catalog": {"items": [{"id": "a", "name": "既存", "text": "keep", "tags": []}]},
        "recipes": [{"id": "v1_set", "name": "V1の選択", "groups": [
            {"id": "v1_relation_0", "name": "既存group", "mode": "all", "on": True,
             "count": 0, "item_ids": ["a"]},
        ]}],
    })
    original = copy.deepcopy(target)
    v1 = source(
        [{"id": "a", "name": "移行", "text": "new", "tags": []},
         {"id": "b", "name": "未使用", "text": "unused", "tags": []}],
        [{"item_id": "a"}, {"item_id": "a", "on": False}, {"item_id": "b"}],
    )
    result = text_catalog_converter.register_v1({
        "v1_json": json.dumps(v1), "catalog_name": "無視される名前",
        "target_catalog_id": target["id"], "base_revision": 1,
    })
    saved = text_catalog_v2_store.get(target["id"])
    assert result["name"] == "既存カタログ"
    assert result["revision"] == 2
    assert result["imported_recipe_ids"] == [r["id"] for r in saved["recipes"][1:]]
    assert "imported_recipe_ids" not in saved
    assert saved["catalog"]["items"][0] == original["catalog"]["items"][0]
    imported_items = saved["catalog"]["items"][1:]
    imported_recipe = saved["recipes"][1]
    all_original_ids = {"a", "v1_set", "v1_relation_0"}
    assert not all_original_ids.intersection(
        [item["id"] for item in imported_items]
        + [imported_recipe["id"]]
        + [group["id"] for group in imported_recipe["groups"]]
    )
    assert imported_recipe["name"] == "V1の選択（2）"
    assert [group["on"] for group in imported_recipe["groups"]] == [True, False, True]
    assert [group["item_ids"] for group in imported_recipe["groups"]] == [
        [imported_items[0]["id"]], [imported_items[0]["id"]], [imported_items[1]["id"]]
    ]


def test_register_v1_conflict_and_capacity_failure_leave_existing_document_unchanged():
    target = text_catalog_v2_store.create({
        "name": "Target", "catalog": {"items": []},
        "recipes": [{"id": "r", "name": "Existing", "groups": []}],
    })
    before = text_catalog_v2_store.get(target["id"])
    request = {"v1_json": json.dumps(source()), "catalog_name": "Import",
               "target_catalog_id": target["id"], "base_revision": 99}
    with pytest.raises(text_catalog_v2_store.CatalogConflict):
        text_catalog_converter.register_v1(request)
    assert text_catalog_v2_store.get(target["id"]) == before

    full = {"name": "Full", "catalog": {"items": [
        {"id": f"item-{i}", "name": "I", "text": "", "tags": []} for i in range(10_000)
    ]}, "recipes": [{"id": "r", "name": "Existing", "groups": []}]}
    full_target = text_catalog_v2_store.create(full)
    full_before = text_catalog_v2_store.get(full_target["id"])
    request.update(
        v1_json=json.dumps(source([{"id": "new", "name": "New", "text": "x", "tags": []}])),
        target_catalog_id=full_target["id"], base_revision=1,
    )
    with pytest.raises(ValueError):
        text_catalog_converter.register_v1(request)
    assert text_catalog_v2_store.get(full_target["id"]) == full_before


def test_register_v1_does_not_mutate_payload():
    payload = {"v1_json": json.dumps(source(
        [{"id": "a", "name": "A", "text": "alpha", "tags": []}], [{"item_id": "a"}]
    )), "catalog_name": "Imported"}
    before = copy.deepcopy(payload)
    text_catalog_converter.register_v1(payload)
    assert payload == before


@pytest.mark.parametrize("payload", [
    {"destination": "existing"},
    {"destination": "unknown"},
    {"destination": "new", "target_catalog_id": "existing-id"},
])
def test_register_v1_rejects_invalid_explicit_destination(payload):
    payload.update(v1_json=json.dumps(source()), catalog_name="Import")
    with pytest.raises(ValueError):
        text_catalog_converter.register_v1(payload)


def test_converter_append_preserves_existing_nested_sets():
    nested = {"id": "parent", "name": "親", "kind": "nested", "mode": "all", "count": 0, "on": True,
              "groups": [{"id": "child", "name": "子", "mode": "all", "count": 0, "on": True, "item_ids": ["a"]}]}
    target = text_catalog_v2_store.create({"name": "既存", "catalog": {"items": [
        {"id": "a", "name": "A", "text": "original", "tags": []}]},
        "recipes": [{"id": "r", "name": "Nested", "groups": [nested]}]})
    result = text_catalog_converter.register_v1({"destination": "existing", "target_catalog_id": target["id"],
        "base_revision": 1, "catalog_name": "Import", "v1_json": json.dumps(source(
            [{"id": "a", "name": "A", "text": "added", "tags": []}], [{"item_id": "a"}]))})
    assert result["recipes"][0] == target["recipes"][0]
    imported = result["recipes"][1]
    assert imported["groups"][0]["id"] not in {"parent", "child"}
    assert imported["groups"][0]["item_ids"] != ["a"]
