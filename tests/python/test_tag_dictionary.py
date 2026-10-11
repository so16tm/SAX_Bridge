import asyncio
import hashlib
import io
import json
import sys
import types
from urllib.error import URLError

import pytest

from nodes import tag_dictionary as dictionary


RAW = '1girl,0,100,"girl,女の子"\nartist_name,1,25,\n'.encode()


def manifest(raw=RAW, day="2026-10-01"):
    return {"type": "file", "name": f"danbooru_{day}_pt20-ia-dd.csv", "size": len(raw),
            "sha": hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(),
            "download_url": "http://127.0.0.1/malicious"}


@pytest.fixture
def environment(tmp_path, monkeypatch):
    home = tmp_path / "sax"
    target = tmp_path / "renamed-autocomplete" / "tags"
    target.mkdir(parents=True)
    monkeypatch.setattr(dictionary, "directory", lambda: home)
    monkeypatch.setattr(dictionary, "autocomplete_directory", lambda: target)
    calls = []
    response = {"raw": RAW, "entry": manifest()}

    def fetch(url, limit):
        calls.append(url)
        return json.dumps([response["entry"]]).encode() if url == dictionary.LIST_URL else response["raw"]

    monkeypatch.setattr(dictionary, "_fetch", fetch)
    return home, target, calls, response


def test_update_installs_separate_file_and_same_blob_skips_download(environment):
    home, target, calls, response = environment
    bundled = target / "danbooru.csv"
    bundled.write_text("original", encoding="utf-8")
    result = dictionary.update()
    assert result["available"] and result["installed"] and result["changed"]
    assert result["tags"] == 2 and result["date"] == "2026-10-01"
    assert bundled.read_text() == "original"
    assert (home / dictionary.FILENAME).read_bytes() == (target / dictionary.FILENAME).read_bytes()
    assert calls == [dictionary.LIST_URL, dictionary.RAW_BASE + response["entry"]["name"]]
    calls.clear()
    assert dictionary.update()["changed"] is False
    assert calls == [dictionary.LIST_URL]
    assert list(target.glob("*.tmp")) == []


def test_uninstalled_autocomplete_still_saves_downloadable_csv(environment, monkeypatch):
    home, _, _, _ = environment
    monkeypatch.setattr(dictionary, "autocomplete_directory", lambda: None)
    result = dictionary.update()
    assert result["available"] and not result["installed"]
    assert (home / dictionary.FILENAME).is_file()


@pytest.mark.parametrize("failure", ["network", "csv", "hash", "write"])
def test_failed_update_preserves_current_dictionary(environment, monkeypatch, failure):
    home, target, _, response = environment
    dictionary.update()
    old = (target / dictionary.FILENAME).read_bytes()
    old_cache = (home / dictionary.FILENAME).read_bytes()
    response["raw"] = b"new_tag,0,100,\n"
    response["entry"] = manifest(response["raw"], "2027-01-01")
    if failure == "network":
        monkeypatch.setattr(dictionary, "_fetch", lambda *args: (_ for _ in ()).throw(URLError("offline")))
    elif failure == "csv":
        response["raw"] = b"<html>error</html>"
        response["entry"] = manifest(response["raw"], "2027-01-01")
    elif failure == "hash":
        response["entry"]["sha"] = "0" * 40
    else:
        monkeypatch.setattr(dictionary.os, "replace", lambda *args: (_ for _ in ()).throw(OSError("write failed")))
    with pytest.raises((ValueError, OSError)):
        dictionary.update()
    assert (target / dictionary.FILENAME).read_bytes() == old
    assert (home / dictionary.FILENAME).read_bytes() == old_cache
    assert dictionary.status()["available"]
    assert list(home.glob("*.tmp")) == []


def test_manual_modification_is_protected_and_missing_install_is_restored(environment):
    home, target, _, _ = environment
    dictionary.update()
    installed = target / dictionary.FILENAME
    installed.unlink()
    assert not dictionary.status()["installed"]
    assert dictionary.update()["installed"]
    installed.write_text("user edits", encoding="utf-8")
    old_cache = (home / dictionary.FILENAME).read_bytes()
    with pytest.raises(ValueError, match="手動変更"):
        dictionary.update()
    assert installed.read_text() == "user edits"
    assert (home / dictionary.FILENAME).read_bytes() == old_cache


def test_unknown_existing_large_file_is_not_overwritten(environment):
    _, target, _, _ = environment
    with (target / dictionary.FILENAME).open("wb") as stream:
        stream.seek(dictionary.MAX_CSV_BYTES)
        stream.write(b"x")
    with pytest.raises(ValueError, match="手動変更"):
        dictionary.update()


@pytest.mark.parametrize("failed_target", ["autocomplete", "metadata"])
def test_late_write_failure_rolls_back_all_saved_files(environment, monkeypatch, failed_target):
    home, target, _, response = environment
    dictionary.update()
    paths = [home / dictionary.FILENAME, target / dictionary.FILENAME, home / "metadata.json"]
    previous = {path: path.read_bytes() for path in paths}
    response["raw"] = b"new_tag,0,100,\n"
    response["entry"] = manifest(response["raw"], "2027-01-01")
    failure = target / dictionary.FILENAME if failed_target == "autocomplete" else home / "metadata.json"
    replace = dictionary.os.replace

    def fail_late(source, destination):
        if destination == failure:
            raise OSError("late write failure")
        return replace(source, destination)

    monkeypatch.setattr(dictionary.os, "replace", fail_late)
    with pytest.raises(OSError):
        dictionary.update()
    assert all(path.read_bytes() == previous[path] for path in paths)
    assert dictionary.status()["available"] and dictionary.status()["installed"]
    assert list(home.glob("*.tmp")) == list(target.glob("*.tmp")) == []


def test_first_install_metadata_failure_removes_uncommitted_new_files(environment, monkeypatch):
    home, target, _, _ = environment
    replace = dictionary.os.replace

    def fail_metadata(source, destination):
        if destination.name == "metadata.json":
            raise OSError("metadata failed")
        return replace(source, destination)

    monkeypatch.setattr(dictionary.os, "replace", fail_metadata)
    with pytest.raises(OSError):
        dictionary.update()
    assert not (home / dictionary.FILENAME).exists()
    assert not (target / dictionary.FILENAME).exists()
    assert not dictionary.status()["available"]


def test_rollback_failure_retains_backup_and_restores_other_file(environment, monkeypatch):
    home, target, _, response = environment
    dictionary.update()
    old = (target / dictionary.FILENAME).read_bytes()
    response["raw"] = b"new_tag,0,100,\n"
    response["entry"] = manifest(response["raw"], "2027-01-01")
    replace = dictionary.os.replace
    target_writes = 0

    def fail_recovery(source, destination):
        nonlocal target_writes
        if destination == target / dictionary.FILENAME:
            target_writes += 1
            if target_writes > 1:
                raise OSError("rollback denied")
        if destination.name == "metadata.json":
            raise OSError("metadata denied")
        return replace(source, destination)

    monkeypatch.setattr(dictionary.os, "replace", fail_recovery)
    with pytest.raises(dictionary.RecoveryError, match="回復用"):
        dictionary.update()
    assert (home / dictionary.FILENAME).read_bytes() == old
    backups = list(target.glob("*.tmp"))
    assert len(backups) == 1 and backups[0].read_bytes() == old


def test_latest_selects_matching_date_and_ignores_download_url():
    old = manifest(day="2026-07-01")
    new = manifest(day="2026-10-01")
    ignored = {**manifest(day="2028-01-01"), "name": "../evil.csv"}
    assert dictionary.latest_entry([new, ignored, old])["date"] == "2026-10-01"
    with pytest.raises(ValueError):
        dictionary.latest_entry([{**new, "size": dictionary.MAX_CSV_BYTES + 1}])
    with pytest.raises(ValueError):
        dictionary.latest_entry([{**new, "sha": "invalid"}])
    with pytest.raises(ValueError):
        dictionary.latest_entry([])


@pytest.mark.parametrize("raw", [b"", b"<html>error</html>", b"tag,no,100,\n", b"tag,0,-1,\n", b"tag,2,1,\n", b"a,0,1,\na,0,2,\n", b"tag,0,100,\xff"])
def test_invalid_csv_rejected(raw):
    with pytest.raises((ValueError, UnicodeError)):
        dictionary.validate_csv(raw)


def test_header_and_unicode_aliases_are_preserved():
    raw = b"\xef\xbb\xbftag,category,count,alias\r\n" + RAW
    csv, tags = dictionary.validate_csv(raw)
    assert csv == RAW and tags == 2


def test_hash_prefix_tags_are_quoted_for_autocomplete_comment_parser():
    csv, tags = dictionary.validate_csv(b"#compass,3,100,\n")
    assert csv == b'"#compass","3","100",""\n'
    assert tags == 1


def test_bounded_fetch_without_content_length(monkeypatch):
    class Response(io.BytesIO):
        headers = {}
    monkeypatch.setattr(dictionary, "urlopen", lambda *args, **kwargs: Response(b"x" * 21))
    with pytest.raises(ValueError, match="サイズ"):
        dictionary._fetch(dictionary.LIST_URL, 20)


def test_registered_class_discovers_renamed_extension(tmp_path, monkeypatch):
    package = tmp_path / "renamed"
    (package / "web" / "js").mkdir(parents=True)
    (package / "web" / "js" / "main.js").touch()
    cls = type("AutocompletePlusDictionariesController", (), {"__module__": "renamed"})
    monkeypatch.setitem(sys.modules, "renamed", types.SimpleNamespace(__file__=str(package / "__init__.py")))
    monkeypatch.setitem(dictionary.comfy_nodes.NODE_CLASS_MAPPINGS, "AutocompletePlusDictionariesController", cls)
    assert dictionary.autocomplete_directory() == package / "tags"


def test_queue_execution_never_downloads(monkeypatch):
    monkeypatch.setattr(dictionary, "update", lambda: pytest.fail("Queueでダウンロードしてはいけない"))
    assert dictionary.SAX_Bridge_Tag_Dictionary.execute().args == ()


def test_routes_are_manual_and_registration_is_idempotent(environment, monkeypatch):
    from aiohttp import web
    routes = web.RouteTableDef()
    instance = types.SimpleNamespace(routes=routes)
    monkeypatch.setitem(sys.modules, "server", types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=instance)))
    dictionary.register_routes()
    dictionary.register_routes()
    handlers = {(r.method, r.path): r.handler for r in routes}
    assert len(handlers) == 3

    async def scenario():
        response = await handlers[("GET", "/sax/tag-dictionary/status")](None)
        assert json.loads(response.body)["available"] is False
        response = await handlers[("POST", "/sax/tag-dictionary/update")](None)
        assert json.loads(response.body)["installed"]
        downloaded = await handlers[("GET", "/sax/tag-dictionary/danbooru.csv")](None)
        assert downloaded.status == 200
        dictionary._lock.acquire()
        try:
            response = await handlers[("POST", "/sax/tag-dictionary/update")](None)
            assert response.status == 409
        finally:
            dictionary._lock.release()
    asyncio.run(scenario())
