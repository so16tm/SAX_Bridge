"""Autocomplete++ が読み込めるワイルドカード .txt の読み書き。

探索順は Autocomplete++ modules/api.py の get_wildcard_candidate_dirs() に準拠。
保存先を許可されたルートの相対パスに限定し、競合と誤上書きを防ぐ。
"""
import asyncio
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path

import folder_paths

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_FILES = 10000
_guard = threading.Lock()
_locks = {}
_BAD_PART = re.compile(r'[\x00-\x1f\x7f<>:"|?*]')
_RESERVED = re.compile(r"(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$")


class WildcardConflict(ValueError):
    """他の編集者による変更・既存ファイルの誤上書き。"""


def _roots():
    base = Path(folder_paths.base_path)
    result = [{"id": "comfy", "label": "ComfyUI/wildcards",
               "path": base / "wildcards"}]
    custom = base / "custom_nodes"
    extra = []
    if custom.is_dir():
        for addon in sorted(custom.iterdir(), key=lambda p: p.name):
            if not addon.is_dir():
                continue
            wildcard_dir = addon / "wildcards"
            if wildcard_dir.is_dir():
                result.append({"id": "node:" + addon.name,
                               "label": "custom_nodes/" + addon.name + "/wildcards",
                               "path": wildcard_dir})
            # Autocomplete++ 自身の tags/wildcards は最後に探索される。
            tags_dir = addon / "tags" / "wildcards"
            if "autocomplete" in addon.name.casefold() and tags_dir.is_dir():
                extra.append({"id": "tags:" + addon.name,
                              "label": "custom_nodes/" + addon.name + "/tags/wildcards",
                              "path": tags_dir})
    return result + extra


def _filename(name):
    if not isinstance(name, str) or not name or len(name) > 240:
        raise ValueError("ファイル名は240文字以内で指定してください")
    name = name.replace("\\", "/")
    if name.startswith("/") or name.endswith("/") or "//" in name:
        raise ValueError("ファイル名は保存先からの相対パスで指定してください")
    parts = name.split("/")
    if len(parts) > 16 or any(
        part in ("", ".", "..") or len(part) > 120
        or part.endswith((" ", ".")) or _BAD_PART.search(part)
        or _RESERVED.fullmatch(part) for part in parts
    ):
        raise ValueError("ファイル名またはフォルダー名が不正です")
    if parts[-1].lower().endswith(".txt") and not parts[-1].endswith(".txt"):
        raise ValueError("拡張子は小文字の .txt にしてください")
    if not parts[-1].endswith(".txt"):
        parts[-1] += ".txt"
    value = "/".join(parts)
    if len(value) > 244:
        raise ValueError("ファイル名が長すぎます")
    return value


def _contained(root, path):
    if os.path.commonpath((str(root.resolve()), str(path.resolve()))) != str(root.resolve()):
        raise ValueError("指定された保存先の外にはアクセスできません")
    cursor = path
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError("シンボリックリンクの先は編集できません")
        cursor = cursor.parent


def _target(root_id, name):
    root = next((r["path"] for r in _roots() if r["id"] == root_id), None)
    if root is None:
        raise ValueError("読み込み可能な保存先を選択してください")
    filename = _filename(name)
    path = root.joinpath(*filename.split("/"))
    _contained(root, path)
    return root, path, filename


def _bytes(path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file():
        raise ValueError("通常のファイルのみ読み込めます")
    if stat.st_size > MAX_FILE_BYTES:
        raise ValueError("ファイルが2 MiBを超えています")
    data = path.read_bytes()
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("ファイルが2 MiBを超えています")
    return data


def list_files():
    roots = _roots()
    files, known = [], set()
    for root in roots:
        base = root["path"]
        if not base.is_dir():
            continue
        for directory, dirs, filenames in os.walk(base, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
            for basename in sorted(filenames):
                if not basename.endswith(".txt"):
                    continue
                path = Path(directory) / basename
                try:
                    _contained(base, path)
                    if not path.is_file():
                        continue
                    relative_name = path.relative_to(base).as_posix()[:-4]
                    _filename(relative_name)
                except (OSError, ValueError):
                    continue
                files.append({"root_id": root["id"], "name": relative_name,
                              "shadowed": relative_name in known})
                known.add(relative_name)
                if len(files) >= MAX_FILES:
                    return {"roots": [{"id": r["id"], "label": r["label"]} for r in roots],
                            "files": files, "truncated": True}
    return {"roots": [{"id": r["id"], "label": r["label"]} for r in roots],
            "files": files, "truncated": False}


def read_file(root_id, name):
    _root, path, filename = _target(root_id, name)
    data = _bytes(path)
    if data is None:
        raise ValueError("ファイルが見つかりません")
    try:
        content = data.decode("utf-8")
    except UnicodeError as exc:
        raise ValueError("UTF-8テキストとして読み込めません") from exc
    return {"root_id": root_id, "name": filename[:-4], "content": content,
            "sha": hashlib.sha256(data).hexdigest()}


def _lock(path):
    with _guard:
        return _locks.setdefault(str(path), threading.RLock())


def write_file(root_id, name, content, base_sha):
    root, path, filename = _target(root_id, name)
    if not isinstance(content, str) or "\x00" in content:
        raise ValueError("本文はNUL文字を含まないテキストで指定してください")
    try:
        data = content.encode("utf-8")
    except UnicodeError as exc:
        raise ValueError("本文に不正なUnicode文字があります") from exc
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("ファイルは2 MiB以内にしてください")
    if base_sha is not None and (not isinstance(base_sha, str)
                                 or not re.fullmatch(r"[0-9a-f]{64}", base_sha)):
        raise ValueError("保存時の改訂情報が不正です")
    with _lock(path):
        before = _bytes(path)
        current_sha = hashlib.sha256(before).hexdigest() if before is not None else None
        if base_sha != current_sha:
            raise WildcardConflict("別の編集で変更されたか、同名ファイルが存在します。再読み込みしてください")
        path.parent.mkdir(parents=True, exist_ok=True)
        _contained(root, path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if before is not None:
                os.chmod(temporary, path.stat().st_mode & 0o777)
            _contained(root, path)
            os.replace(temporary, path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)
    # 同名ファイルの優先順位は Autocomplete++ 側の探索順に合わせる。
    duplicate_before = False
    for candidate in _roots():
        other = candidate["path"].joinpath(*filename.split("/"))
        try:
            _contained(candidate["path"], other)
            if candidate["id"] == root_id:
                break
            if other.is_file():
                duplicate_before = True
                break
        except (OSError, ValueError):
            pass
    return {"root_id": root_id, "name": filename[:-4],
            "sha": hashlib.sha256(data).hexdigest(), "shadowed": duplicate_before}


def register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None:
        return
    routes = server.routes
    prefix = "/sax/wildcards"

    @routes.get(prefix)
    async def wildcard_list(_request):
        try:
            return web.json_response(await asyncio.to_thread(list_files))
        except OSError:
            return web.json_response({"error": "一覧を取得できません"}, status=500)

    @routes.get(prefix + "/file")
    async def wildcard_read(request):
        try:
            return web.json_response(await asyncio.to_thread(
                read_file, request.query.get("root_id"), request.query.get("name")))
        except (ValueError, UnicodeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response({"error": "ファイルを読み込めません"}, status=500)

    @routes.put(prefix + "/file")
    async def wildcard_write(request):
        try:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(65536):
                raw.extend(chunk)
                if len(raw) > MAX_FILE_BYTES * 3:
                    raise ValueError("リクエストが大きすぎます")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError("オブジェクトが必要です")
            return web.json_response(await asyncio.to_thread(
                write_file, body.get("root_id"), body.get("name"),
                body.get("content"), body.get("base_sha")))
        except WildcardConflict as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except (ValueError, UnicodeError, RecursionError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response({"error": "ファイルを保存できません"}, status=500)
