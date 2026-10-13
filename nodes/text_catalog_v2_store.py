"""共有カタログの検証・原子的保存・改訂管理。"""

import copy
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
import asyncio
from collections import OrderedDict
from pathlib import Path

import folder_paths

_locks = {}
_guard = threading.Lock()
_cache = OrderedDict()
_CACHE_BYTES = 64 * 1024 * 1024


def _cached(catalog_id):
    with _guard:
        value = _cache.get(catalog_id)
        if value:
            _cache.move_to_end(catalog_id)
        return value


def _remember(catalog_id, signature, document, data):
    with _guard:
        _cache[catalog_id] = (signature, document, hashlib.sha256(data).hexdigest(), len(data))
        _cache.move_to_end(catalog_id)
        # 多数のワークフローで別々のカタログを使っても、キャッシュを無制限に積まない。
        while sum(value[3] for value in _cache.values()) > _CACHE_BYTES:
            _cache.popitem(last=False)


class CatalogConflict(ValueError):
    def __init__(self, current):
        super().__init__("カタログが別の画面で更新されました")
        self.current = current


def directory():
    return Path(folder_paths.get_system_user_directory("sax_text_catalog"))


def _path(catalog_id):
    if not isinstance(catalog_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", catalog_id):
        raise ValueError("カタログIDが不正です")
    return directory() / (catalog_id + ".json")


def _lock(catalog_id):
    with _guard:
        return _locks.setdefault(catalog_id, threading.RLock())


def validate(document):
    from .text_catalog_v2 import MAX_JSON_BYTES, MAX_NAME_LENGTH, parse_config
    if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] != 3:
        raise ValueError("対応していないカタログ形式です")
    _path(document.get("id"))
    if not isinstance(document.get("name"), str) or len(document["name"]) > MAX_NAME_LENGTH:
        raise ValueError("カタログ名が不正です")
    if type(document.get("revision")) is not int or document["revision"] < 1:
        raise ValueError("改訂番号が不正です")
    recipes = document.get("recipes")
    validation_recipes = [{"id": "empty", "name": "", "groups": []}] if recipes == [] else recipes
    parse_config(json.dumps({"version": 2, "catalog": document.get("catalog"),
                             "recipes": validation_recipes,
                             "active_recipe_id": validation_recipes[0].get("id") if isinstance(validation_recipes, list) and validation_recipes and isinstance(validation_recipes[0], dict) else ""}, ensure_ascii=False),
                 max_recipes=1024)
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_JSON_BYTES:
        raise ValueError("カタログが32 MiBを超えています")
    return encoded


def _signature(path):
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns, stat.st_ino


def _load(catalog_id):
    from .text_catalog_v2 import MAX_JSON_BYTES
    path = _path(catalog_id)
    try:
        signature = _signature(path)
        cached = _cached(catalog_id)
        if cached and cached[0] == signature:
            return cached[1]
        with path.open("rb") as stream:
            raw = stream.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("カタログが32 MiBを超えています")
        document = json.loads(raw)
        validate(document)
        if document["id"] != catalog_id:
            raise ValueError("カタログIDと保存ファイルが一致しません")
        # 読み込み途中に外部置換された場合は、次回必ず再取得する。
        if _signature(path) == signature:
            _remember(catalog_id, signature, document, raw)
        return document
    except FileNotFoundError as exc:
        raise ValueError("参照先の共有カタログが見つかりません") from exc
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("共有カタログを読み込めません") from exc


def snapshot(catalog_id):
    """内部専用。取得後の辞書は変更せず、実行中の改訂を固定する。"""
    with _lock(catalog_id):
        return _load(catalog_id)


def get(catalog_id):
    return copy.deepcopy(snapshot(catalog_id))


def fingerprint(catalog_id):
    with _lock(catalog_id):
        document = _load(catalog_id)
        cached = _cached(catalog_id)
        if cached and cached[1] is document:
            return cached[2]
        return hashlib.sha256(validate(document)).hexdigest()


def _write(document):
    data = validate(document)
    path = _path(document["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _remember(document["id"], _signature(path), document, data)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def create(payload):
    if not isinstance(payload, dict):
        raise ValueError("オブジェクトが必要です")
    source = payload.get("document", payload)
    if not isinstance(source, dict):
        raise ValueError("カタログが不正です")
    if "document" in payload:
        if type(source.get("version")) is not int or source["version"] not in (2, 3):
            raise ValueError("対応していないインポート形式です")
        if "catalog" not in source or "recipes" not in source:
            raise ValueError("インポートするアイテムとテキストセットが必要です")
    if "document" in payload and source.get("version") not in (2, 3):
        raise ValueError("対応していないカタログ形式です")
    document = {"version": 3, "id": uuid.uuid4().hex, "name": source.get("name", "新しいカタログ"),
                "revision": 1, "catalog": copy.deepcopy(source.get("catalog", {"items": []})),
                "recipes": copy.deepcopy(source.get("recipes", [{"id": "default", "name": "テキストセット 1", "groups": []}]))}
    with _lock(document["id"]):
        _write(document)
    return copy.deepcopy(document)


def list_catalogs():
    results = []
    for path in sorted(directory().glob("*.json")):
        try:
            doc = snapshot(path.stem)
            results.append({key: doc[key] for key in ("id", "name", "revision")})
        except (ValueError, OSError) as exc:
            # 壊れたファイルを隠して、新規作成を促さない。
            results.append({"id": path.stem, "name": path.stem, "error": str(exc)})
    return results


def update(catalog_id, base_revision, operations):
    if type(base_revision) is not int or not isinstance(operations, list) or len(operations) > 20_000:
        raise ValueError("改訂番号または変更操作が不正です")
    with _lock(catalog_id):
        current = _load(catalog_id)
        if current["revision"] != base_revision:
            raise CatalogConflict(copy.deepcopy(current))
        document = copy.deepcopy(current)
        for op in operations:
            if not isinstance(op, dict):
                raise ValueError("変更操作が不正です")
            kind = op.get("type")
            if kind == "catalog.rename":
                document["name"] = op.get("name")
                continue
            if kind not in ("item.put", "item.delete", "recipe.put", "recipe.delete"):
                raise ValueError("未知の変更操作です")
            is_item = kind.startswith("item.")
            target = document["catalog"]["items"] if is_item else document["recipes"]
            entry = op.get("item" if is_item else "recipe") if kind.endswith("put") else None
            identifier = entry.get("id") if isinstance(entry, dict) else op.get("id")
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("変更対象IDが不正です")
            index = next((i for i, value in enumerate(target) if value["id"] == identifier), None)
            if kind.endswith("put"):
                if not isinstance(entry, dict):
                    raise ValueError("変更対象が不正です")
                if index is None:
                    target.append(copy.deepcopy(entry))
                else:
                    target[index] = copy.deepcopy(entry)
            elif index is not None:
                target.pop(index)
                if is_item:
                    from .text_catalog_v2 import iter_groups
                    for recipe in document["recipes"]:
                        for group in iter_groups(recipe["groups"]):
                            if group.get("kind") != "nested":
                                group["item_ids"] = [value for value in group["item_ids"] if value != identifier]
                                if "item_weights" in group:
                                    group["item_weights"].pop(identifier, None)
        if not operations:
            return copy.deepcopy(current)
        document["revision"] += 1
        _write(document)
        return copy.deepcopy(document)


def register_routes():
    """ComfyUI起動時のみ登録。CLIの検証環境ではserverがなくても使える。"""
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return
    routes = instance.routes
    prefix = "/sax/text-catalog/v2/catalogs"

    async def handle(request, action):
        try:
            if action == "list":
                result = await asyncio.to_thread(list_catalogs)
                return web.json_response({"catalogs": result})
            if action == "get":
                result = await asyncio.to_thread(get, request.match_info["catalog_id"])
            else:
                if request.content_length and request.content_length > 32 * 1024 * 1024:
                    raise ValueError("要求が32 MiBを超えています")
                raw = bytearray()
                async for chunk in request.content.iter_chunked(65536):
                    raw.extend(chunk)
                    if len(raw) > 32 * 1024 * 1024:
                        raise ValueError("要求が32 MiBを超えています")
                payload = json.loads(raw)
                if action == "convert_v1":
                    from .text_catalog_converter import register_v1
                    result = await asyncio.to_thread(register_v1, payload)
                elif action == "create":
                    result = await asyncio.to_thread(create, payload)
                else:
                    if not isinstance(payload, dict):
                        raise ValueError("オブジェクトが必要です")
                    saved = await asyncio.to_thread(update, request.match_info["catalog_id"],
                                                    payload.get("base_revision"), payload.get("operations"))
                    result = {"id": saved["id"], "revision": saved["revision"]}
            return web.json_response(result)
        except CatalogConflict as exc:
            return web.json_response({"error": str(exc), "current": exc.current}, status=409)
        except (ValueError, UnicodeError, RecursionError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response({"error": "共有カタログを読み込み・保存できません"}, status=500)

    @routes.get(prefix)
    async def catalog_list(request):
        return await handle(request, "list")

    @routes.post(prefix)
    async def catalog_create(request):
        return await handle(request, "create")

    @routes.post(prefix + "/convert-v1")
    async def catalog_convert_v1(request):
        return await handle(request, "convert_v1")

    @routes.get(prefix + "/{catalog_id}")
    async def catalog_get(request):
        return await handle(request, "get")

    @routes.patch(prefix + "/{catalog_id}")
    async def catalog_update(request):
        return await handle(request, "update")
