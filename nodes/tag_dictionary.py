"""明示的な操作で、公開されている最新の Danbooru 互換CSVを取得する。"""

import asyncio
import csv
import hashlib
import io as text_io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
from datetime import date, datetime, timezone
from urllib.request import Request, urlopen

import folder_paths
import nodes as comfy_nodes
from comfy_api.latest import io


SOURCE = "https://github.com/DraconicDragon/dbr-e621-lists-archive"
LIST_URL = "https://api.github.com/repos/DraconicDragon/dbr-e621-lists-archive/contents/tag-lists/danbooru"
RAW_BASE = "https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/main/tag-lists/danbooru/"
FILENAME = "sax_danbooru.csv"
MAX_CSV_BYTES = 32 * 1024 * 1024
_NAME = re.compile(r"danbooru_(\d{4}-\d{2}-\d{2})_pt20-ia-dd\.csv")
_lock = threading.Lock()


class UpdateBusy(ValueError):
    pass


class RecoveryError(OSError):
    pass


def directory():
    return Path(folder_paths.get_system_user_directory("sax_tag_dictionary"))


def autocomplete_directory():
    # 登録済みクラスから実際の設置先を得る。フォルダ名の変更にも対応する。
    cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("AutocompletePlusDictionariesController")
    module = sys.modules.get(getattr(cls, "__module__", ""))
    if module is None or not getattr(module, "__file__", None):
        return None
    root = Path(module.__file__).resolve().parent
    if not (root / "web" / "js" / "main.js").is_file():
        return None
    return root / "tags"


def _fetch(url, limit):
    request = Request(url, headers={"User-Agent": "SAX-Bridge-TagDictionary", "Accept": "application/vnd.github+json" if url == LIST_URL else "text/csv"})
    with urlopen(request, timeout=30) as response:
        length = response.headers.get("Content-Length")
        if length is not None and int(length) > limit:
            raise ValueError("配布ファイルがサイズ上限を超えています")
        data = bytearray()
        while chunk := response.read(min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError("配布ファイルがサイズ上限を超えています")
        return bytes(data)


def latest_entry(entries):
    if not isinstance(entries, list) or len(entries) >= 1000:
        raise ValueError("配布元のファイル一覧から最新版を決定できません")
    candidates = []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") != "file":
            continue
        name = entry.get("name")
        match = _NAME.fullmatch(name) if isinstance(name, str) else None
        if not match:
            continue
        try:
            published = date.fromisoformat(match[1])
        except ValueError:
            continue
        if not isinstance(entry.get("sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", entry["sha"]):
            raise ValueError("配布CSVのハッシュが不正です")
        if type(entry.get("size")) is not int or not 0 < entry["size"] <= MAX_CSV_BYTES:
            raise ValueError("配布CSVがサイズ上限を超えています")
        candidates.append((published, entry))
    if not candidates:
        raise ValueError("対応する Danbooru 互換CSVが見つかりません")
    published, entry = max(candidates, key=lambda pair: pair[0])
    return {**entry, "date": published.isoformat()}


def validate_csv(data):
    if not data or len(data) > MAX_CSV_BYTES:
        raise ValueError("CSVは空でない32 MiB以下のファイルが必要です")
    text = data.decode("utf-8-sig")
    output = text_io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    quoted_writer = csv.writer(output, lineterminator="\n", quoting=csv.QUOTE_ALL)
    names = set()
    for index, row in enumerate(csv.reader(text_io.StringIO(text, newline=""), strict=True)):
        if index == 0 and row in (["tag", "category", "count", "alias"], ["tag", "category", "count", "aliases"]):
            continue
        if len(row) != 4 or not row[0].strip() or row[0] in names or any(ord(c) < 32 for c in row[0] + row[3]):
            raise ValueError("タグCSVの行形式が不正です")
        try:
            category, count = int(row[1]), int(row[2])
        except ValueError as exc:
            raise ValueError("タグCSVのカテゴリ・投稿数が不正です") from exc
        if category not in {0, 1, 3, 4, 5} or count < 0:
            raise ValueError("タグCSVのカテゴリ・投稿数が不正です")
        names.add(row[0])
        # Autocomplete++ は # で始まる行をコメントとして除外する。
        # 実在する #compass 等のタグは引用して、補完候補から消えないようにする。
        row_writer = quoted_writer if row[0].startswith("#") else writer
        row_writer.writerow([row[0], category, count, row[3]])
    if not names:
        raise ValueError("CSVにタグがありません")
    normalized = output.getvalue().encode("utf-8")
    if len(normalized) > MAX_CSV_BYTES:
        raise ValueError("変換後のCSVが32 MiBを超えています")
    return normalized, len(names)


def _digest(path):
    if not path.is_file() or path.stat().st_size > MAX_CSV_BYTES:
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _metadata():
    try:
        path = directory() / "metadata.json"
        if path.stat().st_size > 16384:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or type(data.get("tags")) is not int or data["tags"] <= 0:
            return {}
        for key, length in (("sha256", 64), ("blob_sha", 40)):
            if not isinstance(data.get(key), str) or not re.fullmatch(r"[0-9a-f]{" + str(length) + "}", data[key]):
                return {}
        if not isinstance(data.get("date"), str) or not isinstance(data.get("checked_at"), str):
            return {}
        return {key: data[key] for key in ("date", "tags", "sha256", "blob_sha", "checked_at", "source_file") if key in data}
    except (OSError, ValueError, UnicodeError):
        return {}


def status():
    metadata = _metadata()
    available = bool(metadata.get("sha256")) and _digest(directory() / FILENAME) == metadata.get("sha256")
    target = autocomplete_directory()
    installed = bool(available and target and _digest(target / FILENAME) == metadata["sha256"])
    return {**metadata, "filename": FILENAME, "available": available, "installed": installed,
            "autocomplete_available": target is not None, "source": SOURCE}


def _stage_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return temporary
    except BaseException:
        if temporary and temporary.exists():
            temporary.unlink()
        raise


def _commit_files(updates):
    staged = []
    committed = []
    retained = set()
    try:
        # 保存先ごとの新旧ファイルを先に準備し、準備段階の失敗では何も置換しない。
        for path, data in updates:
            if path.is_symlink():
                raise ValueError("辞書の保存先がシンボリックリンクのため更新を停止しました")
            if path.exists() and (not path.is_file() or path.stat().st_size > MAX_CSV_BYTES):
                raise ValueError("辞書の保存先が通常のサイズ制限内ファイルではありません")
            old = path.read_bytes() if path.exists() else None
            new_file = _stage_file(path, data)
            staged.append((path, new_file, None))
            backup = _stage_file(path, old) if old is not None else None
            staged[-1] = (path, new_file, backup)
        try:
            for path, new_file, backup in staged:
                os.replace(new_file, path)
                committed.append((path, backup))
        except OSError:
            failures = []
            for path, backup in reversed(committed):
                try:
                    if backup:
                        os.replace(backup, path)
                    else:
                        path.unlink()
                except OSError:
                    if backup:
                        retained.add(backup)
                    failures.append(str(backup or path))
            if failures:
                raise RecoveryError("更新の復元にも失敗しました。回復用ファイルを保持しています: " + ", ".join(failures)) from None
            raise
    finally:
        for _, new_file, backup in staged:
            for temporary in (new_file, backup):
                if temporary and temporary not in retained and temporary.exists():
                    temporary.unlink()


def update():
    if not _lock.acquire(blocking=False):
        raise UpdateBusy("別の画面で辞書を更新中です")
    try:
        previous = status()
        entry = latest_entry(json.loads(_fetch(LIST_URL, 2 * 1024 * 1024)))
        cached = directory() / FILENAME
        if previous["available"] and previous.get("blob_sha") == entry["sha"]:
            data = cached.read_bytes()
            tags = previous["tags"]
        else:
            raw = _fetch(RAW_BASE + entry["name"], MAX_CSV_BYTES)
            # 一覧取得後に main が更新されても、異なる内容を同じ版として保存しない。
            blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            if blob != entry["sha"]:
                raise ValueError("配布CSVが取得中に変更されました。再度取得してください")
            data, tags = validate_csv(raw)
        digest = hashlib.sha256(data).hexdigest()
        target = autocomplete_directory()
        if target:
            existing = _digest(target / FILENAME)
            allowed = {digest}
            if previous.get("sha256"):
                allowed.add(previous["sha256"])
            if (target / FILENAME).exists() and existing not in allowed:
                raise ValueError("Autocomplete++の sax_danbooru.csv が手動変更されています。保護のため更新を停止しました")
        changed = not previous["available"] or previous.get("sha256") != digest
        updates = []
        if changed:
            updates.append((cached, data))
        if target and _digest(target / FILENAME) != digest:
            updates.append((target / FILENAME, data))
        metadata = {"date": entry["date"], "tags": tags, "sha256": digest, "blob_sha": entry["sha"],
                    "checked_at": datetime.now(timezone.utc).isoformat(), "source": SOURCE,
                    "source_file": entry["name"]}
        updates.append((directory() / "metadata.json", json.dumps(metadata, ensure_ascii=False).encode("utf-8")))
        _commit_files(updates)
        return {**status(), "changed": changed}
    finally:
        _lock.release()


def register_routes():
    try:
        from server import PromptServer
    except ImportError:
        return
    instance = getattr(PromptServer, "instance", None)
    if instance is None or getattr(instance, "_sax_tag_dictionary_routes", False):
        return
    from aiohttp import web

    @instance.routes.get("/sax/tag-dictionary/status")
    async def dictionary_status(request):
        return web.json_response(await asyncio.to_thread(status))

    @instance.routes.post("/sax/tag-dictionary/update")
    async def dictionary_update(request):
        try:
            return web.json_response(await asyncio.to_thread(update))
        except UpdateBusy as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except (ValueError, UnicodeError, csv.Error) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except RecoveryError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        except OSError:
            return web.json_response({"error": "辞書の取得・保存に失敗しました。現在の辞書は引き続き使用できます"}, status=502)

    @instance.routes.get("/sax/tag-dictionary/danbooru.csv")
    async def dictionary_download(request):
        if not (await asyncio.to_thread(status))["available"]:
            raise web.HTTPNotFound(text="取得済みの辞書がありません")
        return web.FileResponse(directory() / FILENAME, headers={"Content-Disposition": f'attachment; filename="{FILENAME}"'})

    instance._sax_tag_dictionary_routes = True


class SAX_Bridge_Tag_Dictionary(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="SAX_Bridge_Tag_Dictionary", display_name="SAX Tag Dictionary",
                         category="SAX/Bridge/Utility", is_output_node=True,
                         description="ボタン操作で公開されている最新のDanbooru互換CSVを取得します。接続不要・Queue実行では取得しません。",
                         inputs=[], outputs=[])

    @classmethod
    def execute(cls):
        return io.NodeOutput()
