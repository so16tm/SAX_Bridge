"""SAX_Bridge_Text_Catalog ノードのテスト。"""

import json
import logging

from nodes.text_catalog import (
    MAX_ID_LENGTH,
    MAX_ITEMS,
    MAX_RELATIONS,
    SAX_Bridge_Text_Catalog,
    SCHEMA_VERSION,
    _resolve_relations,
)


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

def _make_payload(items=None, relations=None, version=SCHEMA_VERSION):
    return json.dumps({
        "version": version,
        "catalog": {
            "items": items or [],
            "tag_definitions": [],
        },
        "relations": relations or [],
    })


# ---------------------------------------------------------------------------
# 正常系
# ---------------------------------------------------------------------------

class TestNormal:
    def test_resolves_single_relation(self):
        payload = _make_payload(
            items=[{"id": "a", "name": "scene_A", "text": "hello", "tags": []}],
            relations=[{"item_id": "a"}],
        )
        result = _resolve_relations(payload)
        assert result[0] == "hello"
        assert all(r == "" for r in result[1:])

    def test_resolves_multiple_relations(self):
        payload = _make_payload(
            items=[
                {"id": "a", "name": "x", "text": "AAA", "tags": []},
                {"id": "b", "name": "y", "text": "BBB", "tags": []},
            ],
            relations=[
                {"item_id": "a"},
                {"item_id": "b"},
                {"item_id": "a"},
            ],
        )
        result = _resolve_relations(payload)
        assert result[0] == "AAA"
        assert result[1] == "BBB"
        assert result[2] == "AAA"  # 同じ Item を複数 Relation から参照可能

    def test_returns_max_relations_length(self):
        payload = _make_payload()
        result = _resolve_relations(payload)
        assert len(result) == MAX_RELATIONS


# ---------------------------------------------------------------------------
# 未割当 Relation
# ---------------------------------------------------------------------------

class TestUnsetRelation:
    def test_null_item_id_returns_empty_string(self):
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "text": "hello", "tags": []}],
            relations=[{"item_id": None}],
        )
        result = _resolve_relations(payload)
        assert result[0] == ""

    def test_missing_item_id_key_returns_empty_string(self):
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "text": "hello", "tags": []}],
            relations=[{}],  # item_id キーがない
        )
        result = _resolve_relations(payload)
        assert result[0] == ""


# ---------------------------------------------------------------------------
# 削除済み Item を参照する Relation
# ---------------------------------------------------------------------------

class TestOrphanRelation:
    def test_missing_item_returns_empty_and_logs_warning(self, caplog):
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "text": "hello", "tags": []}],
            relations=[{"item_id": "ghost"}],
        )
        with caplog.at_level(logging.WARNING):
            result = _resolve_relations(payload)
        assert result[0] == ""
        assert any("missing item" in m for m in caplog.messages)


# ---------------------------------------------------------------------------
# JSON パース異常
# ---------------------------------------------------------------------------

class TestJsonParseFailure:
    def test_invalid_json_returns_all_empty(self, caplog):
        with caplog.at_level(logging.WARNING):
            result = _resolve_relations("{invalid json")
        assert result == [""] * MAX_RELATIONS
        assert any("failed to parse" in m for m in caplog.messages)

    def test_empty_string_returns_all_empty(self):
        result = _resolve_relations("")
        assert result == [""] * MAX_RELATIONS

    def test_whitespace_only_returns_all_empty(self):
        result = _resolve_relations("   ")
        assert result == [""] * MAX_RELATIONS

    def test_non_string_input_returns_all_empty(self):
        result = _resolve_relations(None)  # type: ignore[arg-type]
        assert result == [""] * MAX_RELATIONS

    def test_array_root_returns_all_empty(self, caplog):
        with caplog.at_level(logging.WARNING):
            result = _resolve_relations("[]")
        assert result == [""] * MAX_RELATIONS
        assert any("not an object" in m for m in caplog.messages)


# ---------------------------------------------------------------------------
# version チェック
# ---------------------------------------------------------------------------

class TestVersionMismatch:
    def test_unsupported_version_returns_all_empty(self, caplog):
        payload = json.dumps({
            "version": 99,
            "catalog": {"items": [], "tag_definitions": []},
            "relations": [],
        })
        with caplog.at_level(logging.WARNING):
            result = _resolve_relations(payload)
        assert result == [""] * MAX_RELATIONS
        assert any("unsupported schema version" in m for m in caplog.messages)

    def test_missing_version_returns_all_empty(self, caplog):
        payload = json.dumps({
            "catalog": {"items": [], "tag_definitions": []},
            "relations": [],
        })
        with caplog.at_level(logging.WARNING):
            result = _resolve_relations(payload)
        assert result == [""] * MAX_RELATIONS
        assert any("unsupported schema version" in m for m in caplog.messages)


# ---------------------------------------------------------------------------
# 上限・境界
# ---------------------------------------------------------------------------

class TestBoundary:
    def test_excess_relations_are_clipped(self):
        items = [{"id": f"i{i}", "name": f"n{i}", "text": f"t{i}", "tags": []}
                 for i in range(MAX_RELATIONS + 5)]
        relations = [{"item_id": f"i{i}"} for i in range(MAX_RELATIONS + 5)]
        payload = _make_payload(items=items, relations=relations)
        result = _resolve_relations(payload)
        assert len(result) == MAX_RELATIONS
        for i in range(MAX_RELATIONS):
            assert result[i] == f"t{i}"

    def test_empty_items_and_relations(self):
        payload = _make_payload()
        result = _resolve_relations(payload)
        assert result == [""] * MAX_RELATIONS

    def test_relations_shorter_than_max(self):
        items = [{"id": "a", "name": "x", "text": "hello", "tags": []}]
        relations = [{"item_id": "a"}]
        payload = _make_payload(items=items, relations=relations)
        result = _resolve_relations(payload)
        assert result[0] == "hello"
        # 残りは空文字でパディング
        assert all(r == "" for r in result[1:])
        assert len(result) == MAX_RELATIONS

    def test_excess_items_are_clipped_at_max_items(self, caplog):
        """MAX_ITEMS を超える items は登録されない（DoS 対策）"""
        items = [{"id": f"i{i}", "name": f"n{i}", "text": f"t{i}", "tags": []}
                 for i in range(MAX_ITEMS + 5)]
        # 上限を超えた item を参照する relation は orphan 扱いになる
        relations = [{"item_id": f"i{MAX_ITEMS + 2}"}]
        payload = _make_payload(items=items, relations=relations)
        with caplog.at_level(logging.WARNING):
            result = _resolve_relations(payload)
        assert result[0] == ""
        assert any("missing item" in m for m in caplog.messages)

    def test_excessively_long_id_is_rejected(self):
        """MAX_ID_LENGTH を超える id は登録されず、参照は orphan になる"""
        long_id = "x" * (MAX_ID_LENGTH + 1)
        items = [{"id": long_id, "name": "x", "text": "hello", "tags": []}]
        relations = [{"item_id": long_id}]
        payload = _make_payload(items=items, relations=relations)
        result = _resolve_relations(payload)
        assert result[0] == ""


# ---------------------------------------------------------------------------
# 異常データ
# ---------------------------------------------------------------------------

class TestMalformedData:
    def test_non_dict_item_is_skipped(self):
        payload = json.dumps({
            "version": SCHEMA_VERSION,
            "catalog": {
                "items": [
                    "not a dict",
                    {"id": "a", "name": "x", "text": "hello", "tags": []},
                ],
                "tag_definitions": [],
            },
            "relations": [{"item_id": "a"}],
        })
        result = _resolve_relations(payload)
        assert result[0] == "hello"

    def test_non_dict_relation_is_skipped(self):
        payload = json.dumps({
            "version": SCHEMA_VERSION,
            "catalog": {
                "items": [{"id": "a", "name": "x", "text": "hello", "tags": []}],
                "tag_definitions": [],
            },
            "relations": ["not a dict", {"item_id": "a"}],
        })
        result = _resolve_relations(payload)
        # Index 0 はスキップ → "" のまま、Index 1 が "hello"
        assert result[0] == ""
        assert result[1] == "hello"

    def test_item_text_not_string_returns_empty(self):
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "text": 123, "tags": []}],
            relations=[{"item_id": "a"}],
        )
        result = _resolve_relations(payload)
        assert result[0] == ""

    def test_item_missing_text_returns_empty(self):
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "tags": []}],  # text なし
            relations=[{"item_id": "a"}],
        )
        result = _resolve_relations(payload)
        assert result[0] == ""

    def test_item_with_empty_id_is_skipped(self):
        payload = json.dumps({
            "version": SCHEMA_VERSION,
            "catalog": {
                "items": [{"id": "", "name": "x", "text": "hello", "tags": []}],
                "tag_definitions": [],
            },
            "relations": [{"item_id": ""}],
        })
        result = _resolve_relations(payload)
        # 空 id は登録されないので missing item として扱われる
        assert result[0] == ""

    def test_special_characters_in_text(self):
        special = "改行\n絵文字😀<lora:test:1.0>BREAK\t"
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "text": special, "tags": []}],
            relations=[{"item_id": "a"}],
        )
        result = _resolve_relations(payload)
        assert result[0] == special


# ---------------------------------------------------------------------------
# ノードクラスの統合
# ---------------------------------------------------------------------------

class TestNodeIntegration:
    def test_schema_basic_attributes(self):
        schema = SAX_Bridge_Text_Catalog.GET_SCHEMA()
        assert schema.node_id == "SAX_Bridge_Text_Catalog"
        assert schema.display_name == "SAX Text Catalog"
        assert schema.category == "SAX/Bridge/Utility"

    def test_outputs_count_matches_max_relations(self):
        schema = SAX_Bridge_Text_Catalog.GET_SCHEMA()
        assert len(schema.outputs) == MAX_RELATIONS

    def test_is_changed_returns_input_json(self):
        result = SAX_Bridge_Text_Catalog.IS_CHANGED(items_json="{}")
        assert result == "{}"

        payload = _make_payload()
        result = SAX_Bridge_Text_Catalog.IS_CHANGED(items_json=payload)
        assert result == payload

    def test_execute_returns_node_output(self):
        payload = _make_payload(
            items=[{"id": "a", "name": "x", "text": "hello", "tags": []}],
            relations=[{"item_id": "a"}],
        )
        output = SAX_Bridge_Text_Catalog.execute(items_json=payload)
        assert output.args[0] == "hello"
        assert len(output.args) == MAX_RELATIONS

    def test_execute_with_default_input(self):
        output = SAX_Bridge_Text_Catalog.execute()
        assert output.args == tuple([""] * MAX_RELATIONS)
