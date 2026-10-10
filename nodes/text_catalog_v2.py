"""独立した Text Catalog V2。保存した組み合わせと seed 付き候補抽選を解決する。"""

import hashlib
import json
import random

from comfy_api.latest import io


SCHEMA_VERSION = 2
MAX_ITEMS = 10_000
MAX_RECIPES = 32
MAX_GROUPS = 32
MAX_TAGS = 8
MAX_ID_LENGTH = 128
MAX_NAME_LENGTH = 256
MAX_TEXT_LENGTH = 65_536
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_SEED = 9_007_199_254_740_991  # フロントエンドで精度を失わない整数範囲。
DEFAULT_CONFIG = json.dumps({
    "version": SCHEMA_VERSION,
    "catalog": {"items": []},
    "recipes": [{"id": "default", "name": "組み合わせ 1", "groups": []}],
    "active_recipe_id": "default",
}, ensure_ascii=False, separators=(",", ":"))


def _error(path, reason):
    raise ValueError(f"SAX Text Catalog V2 / {path}: {reason}")


def _object(value, path):
    if not isinstance(value, dict):
        _error(path, "オブジェクトが必要です")
    return value


def _array(value, path, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        _error(path, f"{maximum} 件以下の配列が必要です")
    return value


def _string(value, path, maximum, *, nonempty=False):
    if not isinstance(value, str) or len(value) > maximum or (nonempty and not value):
        _error(path, f"{'空ではない' if nonempty else ''}{maximum} 文字以下の文字列が必要です")
    return value


def _identifier(value, path, seen=None):
    value = _string(value, path, MAX_ID_LENGTH, nonempty=True)
    if seen is not None:
        if value in seen:
            _error(path, "ID が重複しています")
        seen.add(value)
    return value


def _integer(value, path, maximum):
    if type(value) is not int or not 0 <= value <= maximum:
        _error(path, f"0 から {maximum} までの整数が必要です")
    return value


def parse_config(config_json):
    """未知の形式や切れた参照を、データを捨てる正規化で隠さず検出する。"""
    if not isinstance(config_json, str) or len(config_json) > MAX_JSON_BYTES:
        _error("config_json", "32 MiB 以下の JSON 文字列が必要です")
    try:
        if len(config_json.encode("utf-8")) > MAX_JSON_BYTES:
            _error("config_json", "32 MiB を超えています")
        config = json.loads(config_json)
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        _error("config_json", "JSON を読み込めません")
    _object(config, "config_json")
    if type(config.get("version")) is not int or config["version"] != SCHEMA_VERSION:
        _error("version", "対応していない保存形式です。既存の Text Catalog は V1 ノードで開いてください")
    catalog = _object(config.get("catalog"), "catalog")
    items = _array(catalog.get("items"), "catalog.items", MAX_ITEMS)
    ids = set()
    for i, raw in enumerate(items):
        path = f"catalog.items[{i}]"
        entry = _object(raw, path)
        _identifier(entry.get("id"), path + ".id", ids)
        _string(entry.get("name"), path + ".name", MAX_NAME_LENGTH)
        _string(entry.get("text"), path + ".text", MAX_TEXT_LENGTH)
        tags = _array(entry.get("tags"), path + ".tags", MAX_TAGS)
        for tag in tags:
            _string(tag, path + ".tags", MAX_NAME_LENGTH, nonempty=True)
        if len(set(tags)) != len(tags):
            _error(path + ".tags", "タグが重複しています")

    recipes = _array(config.get("recipes"), "recipes", MAX_RECIPES)
    if not recipes:
        _error("recipes", "組み合わせが 1 件以上必要です")
    recipe_ids = set()
    for i, raw in enumerate(recipes):
        path = f"recipes[{i}]"
        recipe = _object(raw, path)
        _identifier(recipe.get("id"), path + ".id", recipe_ids)
        _string(recipe.get("name"), path + ".name", MAX_NAME_LENGTH)
        groups = _array(recipe.get("groups"), path + ".groups", MAX_GROUPS)
        group_ids = set()
        for j, raw_group in enumerate(groups):
            gp = f"{path}.groups[{j}]"
            group = _object(raw_group, gp)
            _identifier(group.get("id"), gp + ".id", group_ids)
            _string(group.get("name"), gp + ".name", MAX_NAME_LENGTH)
            if group.get("mode") not in ("all", "random"):
                _error(gp + ".mode", "all または random を指定してください")
            if type(group.get("on")) is not bool:
                _error(gp + ".on", "boolean が必要です")
            _integer(group.get("count"), gp + ".count", MAX_ITEMS)
            candidates = _array(group.get("item_ids"), gp + ".item_ids", MAX_ITEMS)
            candidate_ids = set()
            for candidate in candidates:
                _identifier(candidate, gp + ".item_ids", candidate_ids)
                if candidate not in ids:
                    _error(gp + ".item_ids", "存在しない素材への参照があります")
    active = _identifier(config.get("active_recipe_id"), "active_recipe_id")
    if active not in recipe_ids:
        _error("active_recipe_id", "存在しない組み合わせを指定しています")
    return config


def resolve_catalog(config_json=DEFAULT_CONFIG, seed=0):
    """グループごとに独立して抽選し、候補配列の順番でテキストを返す。"""
    _integer(seed, "seed", MAX_SEED)
    config = parse_config(config_json)
    recipe = next(r for r in config["recipes"] if r["id"] == config["active_recipe_id"])
    items = {entry["id"]: entry for entry in config["catalog"]["items"]}
    texts = []
    total_bytes = 0
    normalized_text = {}
    report = {"version": SCHEMA_VERSION, "seed": seed, "recipe_id": recipe["id"], "groups": []}
    for group in recipe["groups"]:
        candidates = group["item_ids"]
        chosen = []
        if group["on"]:
            if group["mode"] == "random":
                if group["count"] > len(candidates):
                    _error("count", "選択数が候補数を超えています。候補を増やすか選択数を減らしてください")
                # Python の hash() や共有 RNG を使わない。グループの並び替えや ON/OFF
                # が、他グループの抽選結果に影響しないよう安定 ID で分離する。
                material = json.dumps([seed, recipe["id"], group["id"]], ensure_ascii=True, separators=(",", ":"))
                rng = random.Random(int.from_bytes(hashlib.sha256(material.encode("utf-8")).digest(), "big"))
                indexes = sorted(rng.sample(range(len(candidates)), group["count"]))
                chosen = [candidates[index] for index in indexes]
            else:
                chosen = candidates
        report["groups"].append({
            "group_id": group["id"], "mode": group["mode"], "on": group["on"],
            "item_ids": chosen,
        })
        for item_id in chosen:
            if item_id not in normalized_text:
                text = items[item_id]["text"].strip()
                try:
                    size = len(text.encode("utf-8"))
                except UnicodeError:
                    _error("text", "不正な Unicode 文字列です")
                normalized_text[item_id] = (text, size)
            text, size = normalized_text[item_id]
            if text:
                total_bytes += size + bool(texts)
                if total_bytes > MAX_OUTPUT_BYTES:
                    _error("text", "結合出力が 32 MiB を超えています")
                texts.append(text)
    selection_json = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
    if len(selection_json) > MAX_OUTPUT_BYTES:
        _error("selection_json", "選択記録が 32 MiB を超えています")
    return "\n".join(texts), selection_json


class SAX_Bridge_Text_Catalog_V2(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Text_Catalog_V2",
            display_name="SAX Text Catalog V2",
            category="SAX/Bridge/Utility",
            description="素材と組み合わせを編集し、固定選択または seed による重複なし抽選でテキストを結合します。V1 とは独立しています。",
            inputs=[
                io.String.Input("config_json", default=DEFAULT_CONFIG, optional=True),
                io.Int.Input("seed", default=0, min=0, max=MAX_SEED, control_after_generate=True),
            ],
            outputs=[
                io.String.Output(display_name="text"),
                io.String.Output(display_name="selection_json"),
            ],
        )

    @classmethod
    def execute(cls, config_json: str = DEFAULT_CONFIG, seed: int = 0) -> io.NodeOutput:
        text, selection_json = resolve_catalog(config_json, seed)
        return io.NodeOutput(text, selection_json, ui={
            "text": [text], "selection_json": [selection_json],
            "config_json": [config_json], "seed": [seed],
        })
