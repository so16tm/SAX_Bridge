"""V1 Text Catalog を V2 の独立した設定へ変換する。"""

import json
import uuid

from comfy_api.latest import io

from . import text_catalog, text_catalog_v2


def _invalid(path: str, detail: str) -> None:
    raise ValueError(f"V1 Text Catalog / {path}: {detail}")


def convert_v1(items_json: str, catalog_name: str) -> dict:
    """V1 JSON をデータを失わずに V2 ドキュメントへ変換する。"""
    if not isinstance(items_json, str):
        _invalid("items_json", "JSON 文字列が必要です")
    if len(items_json) > text_catalog_v2.MAX_JSON_BYTES:
        _invalid("items_json", "32 MiB を超えています")
    try:
        if len(items_json.encode("utf-8")) > text_catalog_v2.MAX_JSON_BYTES:
            _invalid("items_json", "32 MiB を超えています")
        source = json.loads(items_json)
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        _invalid("items_json", "JSON を読み込めません")
    if not isinstance(source, dict):
        _invalid("items_json", "オブジェクトが必要です")
    if type(source.get("version")) is not int or source["version"] != text_catalog.SCHEMA_VERSION:
        _invalid("version", "V1 (version 1) のみ変換できます")

    catalog = source.get("catalog")
    if not isinstance(catalog, dict):
        _invalid("catalog", "オブジェクトが必要です")
    items = catalog.get("items")
    if not isinstance(items, list) or len(items) > text_catalog.MAX_ITEMS:
        _invalid("catalog.items", f"{text_catalog.MAX_ITEMS} 件以下の配列が必要です")
    relations = source.get("relations")
    if not isinstance(relations, list) or len(relations) > text_catalog.MAX_RELATIONS:
        _invalid("relations", f"{text_catalog.MAX_RELATIONS} 件以下の配列が必要です")

    # Copy only the V1 item fields. V1's auxiliary tag dictionary is intentionally
    # excluded; item tags themselves are part of the catalog data.
    converted_items = []
    by_id = {}
    for index, item in enumerate(items):
        path = f"catalog.items[{index}]"
        if not isinstance(item, dict):
            _invalid(path, "オブジェクトが必要です")
        for field in ("id", "name", "text", "tags"):
            if field not in item:
                _invalid(path + "." + field, "フィールドがありません")
        copied = {field: item[field] for field in ("id", "name", "text", "tags")}
        converted_items.append(copied)
        if isinstance(copied["id"], str):
            by_id.setdefault(copied["id"], copied)

    groups = []
    for index, relation in enumerate(relations):
        path = f"relations[{index}]"
        if not isinstance(relation, dict):
            _invalid(path, "オブジェクトが必要です")
        item_id = relation.get("item_id")
        if item_id is not None and not isinstance(item_id, str):
            _invalid(path + ".item_id", "文字列または null が必要です")
        if isinstance(item_id, str) and item_id not in by_id:
            _invalid(path + ".item_id", f"存在しないアイテム ID です: {item_id!r}")
        raw_on = relation.get("on", True)
        on = raw_on if isinstance(raw_on, bool) else bool(raw_on)
        item_name = by_id[item_id]["name"] if isinstance(item_id, str) else "未選択"
        group_name = f"{item_name}/スロット{index + 1}"
        groups.append({
            "id": f"v1_relation_{index}",
            "name": group_name[:text_catalog_v2.MAX_NAME_LENGTH],
            "mode": "all",
            "on": on,
            "count": 0,
            "item_ids": [item_id] if isinstance(item_id, str) else [],
        })

    text_catalog_v2._string(catalog_name, "name", text_catalog_v2.MAX_NAME_LENGTH)
    document = {
        "version": 2,
        "name": catalog_name,
        "catalog": {"items": converted_items},
        "recipes": [{"id": "v1_set", "name": "V1の選択", "groups": groups}],
        "active_recipe_id": "v1_set",
    }
    text_catalog_v2.parse_config(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
    return document


def _fresh_id(used_ids: set[str]) -> str:
    identifier = uuid.uuid4().hex
    while identifier in used_ids:
        identifier = uuid.uuid4().hex
    used_ids.add(identifier)
    return identifier


def _unique_recipe_name(name: str, used_names: set[str]) -> str:
    if name not in used_names:
        used_names.add(name)
        return name
    suffix_number = 2
    while True:
        suffix = f"（{suffix_number}）"
        candidate = name[:text_catalog_v2.MAX_NAME_LENGTH - len(suffix)] + suffix
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
        suffix_number += 1


def register_v1(payload: dict) -> dict:
    """V1を新規登録するか、既存カタログへ原子的に取り込む。"""
    if not isinstance(payload, dict):
        _invalid("payload", "オブジェクトが必要です")
    converted = convert_v1(payload.get("v1_json"), payload.get("catalog_name"))
    destination = payload.get("destination")
    if "destination" in payload and destination not in ("new", "existing"):
        _invalid("destination", "new または existing を指定してください")
    target_id = payload.get("target_catalog_id", "")
    has_target = target_id not in (None, "")
    if destination == "new" and has_target:
        _invalid("target_catalog_id", "新規登録では既存カタログIDを指定できません")
    if destination == "existing" and not has_target:
        _invalid("target_catalog_id", "既存カタログへの取り込みにはIDが必要です")
    if not has_target:
        from . import text_catalog_v2_store as store

        saved = store.create({"document": converted})
        return {**saved, "imported_recipe_ids": [recipe["id"] for recipe in saved["recipes"]]}
    if not isinstance(target_id, str):
        _invalid("target_catalog_id", "文字列が必要です")
    base_revision = payload.get("base_revision")
    if type(base_revision) is not int:
        _invalid("base_revision", "整数が必要です")

    from . import text_catalog_v2_store as store

    current = store.snapshot(target_id)
    if current["revision"] != base_revision:
        raise store.CatalogConflict(current)

    used_ids = set()
    used_names = set()
    for item in current["catalog"]["items"]:
        used_ids.add(item["id"])
    for recipe in current["recipes"]:
        used_ids.add(recipe["id"])
        used_names.add(recipe["name"])
        used_ids.update(group["id"] for group in text_catalog_v2.iter_groups(recipe["groups"]))

    item_ids = {item["id"]: _fresh_id(used_ids) for item in converted["catalog"]["items"]}
    items = []
    for item in converted["catalog"]["items"]:
        copied = dict(item)
        copied["id"] = item_ids[item["id"]]
        items.append(copied)

    recipe_ids = []
    recipes = []
    for recipe in converted["recipes"]:
        imported = dict(recipe)
        imported["id"] = _fresh_id(used_ids)
        imported["name"] = _unique_recipe_name(recipe["name"], used_names)
        def remap_group(group):
            copied_group = dict(group)
            copied_group["id"] = _fresh_id(used_ids)
            if group.get("kind") == "nested":
                copied_group["groups"] = [remap_group(child) for child in group["groups"]]
            else:
                copied_group["item_ids"] = [item_ids[identifier] for identifier in group["item_ids"]]
                if "item_weights" in group:
                    copied_group["item_weights"] = {
                        item_ids[identifier]: weight
                        for identifier, weight in group["item_weights"].items()
                    }
            return copied_group
        imported["groups"] = [remap_group(group) for group in recipe["groups"]]
        recipe_ids.append(imported["id"])
        recipes.append(imported)

    operations = ([{"type": "item.put", "item": item} for item in items]
                  + [{"type": "recipe.put", "recipe": recipe} for recipe in recipes])
    saved = store.update(target_id, base_revision, operations)
    return {**saved, "imported_recipe_ids": recipe_ids}


class SAX_Bridge_Text_Catalog_Converter(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Text_Catalog_Converter",
            display_name="SAX Text Catalog Converter",
            category="SAX/Bridge/Utility",
            description="V1のデータを読み込み、ボタンでV2共有カタログへ登録します。実行時は移行用JSONのみを出力します。",
            inputs=[
                io.String.Input("v1_json", default="{}", optional=True),
                io.String.Input("catalog_name", default="V1から変換"),
            ],
            outputs=[io.String.Output(display_name="catalog_json")],
        )

    @classmethod
    def execute(cls, v1_json: str = "{}", catalog_name: str = "V1から変換") -> io.NodeOutput:
        document = convert_v1(v1_json, catalog_name)
        return io.NodeOutput(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
