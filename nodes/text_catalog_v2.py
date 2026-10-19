"""独立した Text Catalog V2。保存した組み合わせと seed 付き候補抽選を解決する。"""

import hashlib
import heapq
import json
import math
import random

from comfy_api.latest import io


SCHEMA_VERSION = 2
MAX_ITEMS = 10_000
MAX_RECIPES = 32
MAX_GROUPS = 32
MAX_GROUP_DEPTH = 8
MAX_TOTAL_GROUPS = 256
MAX_TAGS = 8
MAX_ID_LENGTH = 128
MAX_NAME_LENGTH = 256
MAX_TEXT_LENGTH = 65_536
MAX_AFFIX_LENGTH = 4_096
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_SEED = 9_007_199_254_740_991  # フロントエンドで精度を失わない整数範囲。
DEFAULT_CONFIG = json.dumps({
    "version": SCHEMA_VERSION,
    "catalog": {"items": []},
    "recipes": [{"id": "default", "name": "組み合わせ 1", "groups": []}],
    "active_recipe_id": "default",
}, ensure_ascii=False, separators=(",", ":"))
SHARED_DEFAULT_CONFIG = '{"version":3,"catalog_id":"","rows":[]}'


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


def _weight(value, path):
    if type(value) not in (int, float) or not 0 <= value <= 1_000_000 or not math.isfinite(value):
        _error(path, "0 から 1000000 までの有限数が必要です")
    return value


def iter_groups(groups):
    """保存順で全階層の構成要素を辿る。"""
    for group in groups:
        yield group
        if group.get("kind") == "nested":
            yield from iter_groups(group["groups"])


def _validate_groups(groups, path, item_ids, seen, depth=1):
    _array(groups, path, MAX_GROUPS)
    if depth > MAX_GROUP_DEPTH:
        _error(path, f"構成要素の深さは {MAX_GROUP_DEPTH} 階層までです")
    for index, raw in enumerate(groups):
        gp = f"{path}[{index}]"
        group = _object(raw, gp)
        _identifier(group.get("id"), gp + ".id", seen)
        if len(seen) > MAX_TOTAL_GROUPS:
            _error(path, f"セット内の構成要素は合計 {MAX_TOTAL_GROUPS} 件までです")
        _string(group.get("name"), gp + ".name", MAX_NAME_LENGTH)
        if group.get("mode") not in ("all", "random"):
            _error(gp + ".mode", "all または random を指定してください")
        if type(group.get("on")) is not bool:
            _error(gp + ".on", "boolean が必要です")
        if "weight" in group:
            _weight(group["weight"], gp + ".weight")
        for field in ("prefix", "suffix"):
            if field in group:
                _string(group[field], gp + "." + field, MAX_AFFIX_LENGTH)
        _integer(group.get("count"), gp + ".count", MAX_ITEMS)
        if "count_min" in group:
            count_min = _integer(group["count_min"], gp + ".count_min", MAX_ITEMS)
            if count_min > group["count"]:
                _error(gp + ".count_min", "count 以下の整数が必要です")
        if group.get("kind") == "nested":
            if "item_ids" in group:
                _error(gp, "ネスト型には item_ids を指定できません")
            if "item_weights" in group:
                _error(gp, "item_weights はアイテム型にのみ指定できます")
            children = _array(group.get("groups"), gp + ".groups", MAX_GROUPS)
            if children:
                _validate_groups(children, gp + ".groups", item_ids, seen, depth + 1)
        else:
            if ("kind" in group and group["kind"] != "items") or "groups" in group:
                _error(gp, "アイテム型または nested を指定してください")
            candidates = _array(group.get("item_ids"), gp + ".item_ids", MAX_ITEMS)
            candidate_ids = set()
            for candidate in candidates:
                _identifier(candidate, gp + ".item_ids", candidate_ids)
                if candidate not in item_ids:
                    _error(gp + ".item_ids", "存在しない素材への参照があります")
            if "item_weights" in group:
                weights = _object(group["item_weights"], gp + ".item_weights")
                for identifier, weight in weights.items():
                    if identifier not in candidate_ids:
                        _error(gp + ".item_weights", "候補に存在しない素材 ID があります")
                    _weight(weight, gp + ".item_weights." + identifier)


def _weighted_sample(rng, candidates, weights, count):
    """Efraimidis weighted sampling without replacement, retaining only the best k keys."""
    heap = []
    for index, (candidate, weight) in enumerate(zip(candidates, weights)):
        if weight <= 0:
            continue
        uniform = rng.random()
        while uniform == 0:
            uniform = rng.random()
        # Log-transform the equivalent exponential-race key to avoid division
        # overflow for valid subnormal weights.
        key = math.log(weight) - math.log(-math.log(uniform))
        entry = (key, -index, index, candidate)
        if len(heap) < count:
            heapq.heappush(heap, entry)
        elif entry > heap[0]:
            heapq.heapreplace(heap, entry)
    return sorted((entry[2], entry[3]) for entry in heap)


def parse_config(config_json, *, max_recipes=MAX_RECIPES):
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

    recipes = _array(config.get("recipes"), "recipes", max_recipes)
    if not recipes:
        _error("recipes", "組み合わせが 1 件以上必要です")
    recipe_ids = set()
    for i, raw in enumerate(recipes):
        path = f"recipes[{i}]"
        recipe = _object(raw, path)
        _identifier(recipe.get("id"), path + ".id", recipe_ids)
        _string(recipe.get("name"), path + ".name", MAX_NAME_LENGTH)
        _validate_groups(recipe.get("groups"), path + ".groups", ids, set())
    active = _identifier(config.get("active_recipe_id"), "active_recipe_id")
    if active not in recipe_ids:
        _error("active_recipe_id", "存在しない組み合わせを指定しています")
    return config


class _OutputCollector:
    def __init__(self, *, snapshot_items=False):
        self.texts = []
        self.total_bytes = 0
        self.normalized_text = {}
        self.output_items = [] if snapshot_items else None

    @staticmethod
    def _size(text):
        try:
            return len(text.encode("utf-8"))
        except UnicodeError:
            _error("text", "不正な Unicode 文字列です")

    def _add_bytes(self, size):
        self.total_bytes += size
        if self.total_bytes > MAX_OUTPUT_BYTES:
            _error("text", "結合出力が 32 MiB を超えています")

    def append_item(self, item, group_report, prefix, suffix):
        item_id = item["id"]
        if item_id not in self.normalized_text:
            text = item["text"].strip()
            self.normalized_text[item_id] = (text, self._size(text))
        text, size = self.normalized_text[item_id]
        if self.output_items is not None:
            item["output_position"] = len(self.texts) + 1 if text else None
            group_report["items"].append(item)
        if not text:
            return
        output_text = prefix + text + suffix
        output_size = self._size(output_text) if prefix or suffix else size
        self._add_bytes(output_size + bool(self.texts))
        self.texts.append(output_text)
        if self.output_items is not None:
            self.output_items.append(item)
            if prefix or suffix:
                item["output_text"] = output_text

    def mark(self):
        return len(self.texts)

    def _set_text(self, index, text):
        self.texts[index] = text
        if self.output_items is not None:
            self.output_items[index]["output_text"] = text

    def wrap_block(self, start, prefix, suffix):
        if start == len(self.texts) or not (prefix or suffix):
            return
        # 下位ツリーを連結し直さず、直属の子の出力境界にだけ装飾を付ける。
        self._add_bytes(self._size(prefix) + self._size(suffix))
        end = len(self.texts) - 1
        if start == end:
            self._set_text(start, prefix + self.texts[start] + suffix)
        else:
            if prefix:
                self._set_text(start, prefix + self.texts[start])
            if suffix:
                self._set_text(end, self.texts[end] + suffix)


def _resolve_groups(groups, recipe_id, seed, parent_on, items, output):
    reports = []
    for group in groups:
        nested = group.get("kind") == "nested"
        candidates = [child["id"] for child in group["groups"]] if nested else group["item_ids"]
        effective_on = parent_on and group["on"]
        chosen = []
        if effective_on:
            if group["mode"] == "random":
                # 親IDや位置を含めず、階層移動しても同じ構成要素の抽選を保つ。
                material = json.dumps([seed, recipe_id, group["id"]], ensure_ascii=True, separators=(",", ":"))
                rng = random.Random(int.from_bytes(hashlib.sha256(material.encode("utf-8")).digest(), "big"))
                if nested:
                    weights = [child.get("weight", 1) if child["on"] else 0 for child in group["groups"]]
                else:
                    item_weights = group.get("item_weights", {})
                    weights = [item_weights.get(identifier, 1) for identifier in candidates]
                positive_count = sum(weight > 0 for weight in weights)
                if group["count"] > positive_count:
                    _error("count", "選択数が有効かつ正の重みを持つ候補数を超えています")
                chosen_count = group["count"]
                if "count_min" in group and group["count_min"] < group["count"]:
                    chosen_count = rng.randint(group["count_min"], group["count"])
                if chosen_count:
                    if weights and all(weight == weights[0] and weight > 0 for weight in weights):
                        chosen = [candidates[index] for index in sorted(rng.sample(range(len(candidates)), chosen_count))]
                    else:
                        chosen = [candidate for _, candidate in _weighted_sample(rng, candidates, weights, chosen_count)]
            else:
                chosen = candidates
        chosen_count = len(chosen)
        report = {"group_id": group["id"], "name": group["name"], "mode": group["mode"],
                  "on": effective_on, "count": group["count"], "chosen_count": chosen_count}
        if "count_min" in group:
            report["count_min"] = group["count_min"]
        if "weight" in group:
            report["weight"] = group["weight"]
        if "item_weights" in group:
            report["item_weights"] = group["item_weights"]
        for field in ("prefix", "suffix"):
            if field in group:
                report[field] = group[field]
        prefix = group.get("prefix", "")
        suffix = group.get("suffix", "")
        if nested:
            report.update({"kind": "nested", "candidate_group_ids": candidates, "selected_group_ids": chosen, "groups": []})
            chosen_ids = set(chosen)
            for child in group["groups"]:
                start = output.mark()
                report["groups"].extend(_resolve_groups([child], recipe_id, seed, effective_on and child["id"] in chosen_ids, items, output))
                output.wrap_block(start, prefix, suffix)
        else:
            report.update({"candidate_ids": candidates, "item_ids": chosen, "items": []})
            for identifier in chosen:
                output.append_item(dict(items[identifier]), report, prefix, suffix)
        reports.append(report)
    return reports


def _resolve_legacy(config_json=DEFAULT_CONFIG, seed=0):
    """グループごとに独立して抽選し、候補配列の順番でテキストを返す。"""
    _integer(seed, "seed", MAX_SEED)
    config = parse_config(config_json)
    recipe = next(r for r in config["recipes"] if r["id"] == config["active_recipe_id"])
    items = {entry["id"]: entry for entry in config["catalog"]["items"]}
    output = _OutputCollector()
    report = {"version": SCHEMA_VERSION, "seed": seed, "recipe_id": recipe["id"], "groups": []}
    report["groups"] = _resolve_groups(recipe["groups"], recipe["id"], seed, True, items, output)
    selection_json = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
    if len(selection_json.encode("utf-8")) > MAX_OUTPUT_BYTES:
        _error("selection_json", "選択記録が 32 MiB を超えています")
    return "\n".join(output.texts), selection_json


def parse_workflow(config_json):
    """共有参照は本文を含まず、行順と安定IDだけを保存する。"""
    if not isinstance(config_json, str) or len(config_json.encode("utf-8")) > MAX_JSON_BYTES:
        _error("config_json", "32 MiB 以下の JSON 文字列が必要です")
    try:
        config = json.loads(config_json)
    except (ValueError, RecursionError):
        _error("config_json", "JSON を読み込めません")
    _object(config, "config_json")
    if config.get("version") == 2:
        return parse_config(config_json)
    if type(config.get("version")) is not int or config["version"] != 3:
        _error("version", "対応していない保存形式です")
    _string(config.get("catalog_id"), "catalog_id", MAX_ID_LENGTH)
    rows = _array(config.get("rows"), "rows", MAX_ITEMS)
    seen = set()
    for i, row in enumerate(rows):
        path = f"rows[{i}]"
        _object(row, path)
        _identifier(row.get("id"), path + ".id", seen)
        _identifier(row.get("recipe_id"), path + ".recipe_id")
        if type(row.get("on")) is not bool:
            _error(path + ".on", "boolean が必要です")
    if rows and not config["catalog_id"]:
        _error("catalog_id", "共有カタログを選択してください")
    if "_sax_queued_catalog" in config:
        from .text_catalog_v2_store import validate
        document = config["_sax_queued_catalog"]
        validate(document)
        if document["id"] != config["catalog_id"]:
            _error("catalog_id", "送信時カタログのIDが一致しません")
    return config


def resolve_catalog(config_json=DEFAULT_CONFIG, seed=0):
    _integer(seed, "seed", MAX_SEED)
    config = parse_workflow(config_json)
    if config["version"] == 2:
        return _resolve_legacy(config_json, seed)
    report = {"version": 3, "catalog_id": config["catalog_id"], "revision": None,
              "seed": seed, "rows": []}
    if not config["catalog_id"]:
        return "", json.dumps(report, separators=(",", ":"))
    from .text_catalog_v2_store import snapshot
    document = config.get("_sax_queued_catalog")
    if document is None:
        document = snapshot(config["catalog_id"])
    report["revision"] = document["revision"]
    recipes = {recipe["id"]: recipe for recipe in document["recipes"]}
    items = {item["id"]: item for item in document["catalog"]["items"]}
    output = _OutputCollector(snapshot_items=True)
    for row in config["rows"]:
        recipe = recipes.get(row["recipe_id"])
        if recipe is None:
            _error("rows.recipe_id", "参照するテキストセットが見つかりません")
        row_report = {"id": row["id"], "recipe_id": recipe["id"], "name": recipe["name"],
                      "on": row["on"], "groups": []}
        report["rows"].append(row_report)
        row_report["groups"] = _resolve_groups(recipe["groups"], recipe["id"], seed, row["on"], items, output)
    selection_json = json.dumps(report, ensure_ascii=False, separators=(",", ":"))
    if len(selection_json.encode("utf-8")) > MAX_OUTPUT_BYTES:
        _error("selection_json", "選択記録が32 MiBを超えています")
    return "\n".join(output.texts), selection_json


def preview_recipe(catalog_id, recipe_id, seed=0):
    """編集画面のプレビュー用。1 セットだけを実行と同じ resolve_catalog で解決する。

    抽選は実行時と同じ関数に任せ、ここでは行を 1 つ組み立てるだけにする。抽選は seed・セット ID・構成要素 ID から決まり、
    行 ID には依存しないため、同じ seed なら実行結果のそのセット分と一致する。保存・キャッシュ・Queue には触れない。
    """
    _string(catalog_id, "catalog_id", MAX_ID_LENGTH, nonempty=True)
    _string(recipe_id, "recipe_id", MAX_ID_LENGTH, nonempty=True)
    config = {"version": 3, "catalog_id": catalog_id, "rows": [{"id": "preview", "recipe_id": recipe_id, "on": True}]}
    text, selection_json = resolve_catalog(json.dumps(config), seed)
    return {"text": text, "revision": json.loads(selection_json)["revision"], "seed": seed}


class SAX_Bridge_Text_Catalog_V2(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Text_Catalog_V2",
            display_name="SAX Text Catalog V2",
            category="SAX/Bridge/Utility",
            description="共有カタログのアイテムとテキストセットを編集し、複数セットを順に結合します。V1とは独立しています。",
            inputs=[
                io.String.Input("config_json", default=SHARED_DEFAULT_CONFIG, optional=True),
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
        ui = {"text": [text], "selection_json": [selection_json]}
        # 移行前の旧V2だけ、既存の結果閲覧との互換性を維持する。
        if parse_workflow(config_json)["version"] == 2:
            ui.update({"config_json": [config_json], "seed": [seed]})
        return io.NodeOutput(text, selection_json, ui=ui)

    @classmethod
    def fingerprint_inputs(cls, config_json: str = DEFAULT_CONFIG, seed: int = 0):
        config = parse_workflow(config_json)
        if config["version"] == 2 or not config["catalog_id"] or "_sax_queued_catalog" in config:
            return config_json
        from .text_catalog_v2_store import fingerprint
        return fingerprint(config["catalog_id"])
