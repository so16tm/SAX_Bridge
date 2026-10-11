"""共有保存の競合・参照実行・スナップショットの契約。"""

import copy
import json
import sys
import time
import types
from concurrent.futures import ThreadPoolExecutor

import pytest

from nodes import text_catalog_v2 as node
from nodes import text_catalog_v2_store as store


@pytest.fixture(autouse=True)
def storage(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "directory", lambda: tmp_path)
    store._cache.clear()


def source(count=6):
    return {"name": "共通", "catalog": {"items": [
        {"id": f"i{i}", "name": f"項目{i}", "text": f" text{i} ", "tags": []} for i in range(count)
    ]}, "recipes": [{"id": "r", "name": "セット", "groups": [
        {"id": "g", "name": "背景", "mode": "random", "on": True,
         "count": 2, "item_ids": [f"i{i}" for i in range(count)]}
    ]}]}


def workflow(document, rows=None):
    return json.dumps({"version": 3, "catalog_id": document["id"], "rows": rows or [
        {"id": "row", "recipe_id": "r", "on": True}
    ]})


def test_create_import_and_get_are_independent():
    first = store.create(source())
    second = store.create({"document": first})
    assert first["id"] != second["id"]
    assert second["revision"] == 1
    first["catalog"]["items"][0]["text"] = "outside"
    assert store.get(first["id"])["catalog"]["items"][0]["text"] == " text0 "
    assert len(store.list_catalogs()) == 2


@pytest.mark.parametrize("document", [{"version": 999}, {"version": 3}, {"catalog": {"items": []}, "recipes": []}])
def test_invalid_import_does_not_create_empty_replacement(document):
    with pytest.raises(ValueError):
        store.create({"document": document})
    assert store.list_catalogs() == []


def test_update_conflict_retains_saved_revision():
    document = store.create(source())
    result = store.update(document["id"], 1, [{"type": "catalog.rename", "name": "新版"}])
    assert result["revision"] == 2
    with pytest.raises(store.CatalogConflict) as error:
        store.update(document["id"], 1, [{"type": "catalog.rename", "name": "古い編集"}])
    assert error.value.current["name"] == "新版"


def test_simultaneous_updates_have_one_winner():
    document = store.create(source())
    def change(index):
        try:
            store.update(document["id"], 1, [{"type": "catalog.rename", "name": str(index)}])
            return True
        except store.CatalogConflict:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(change, range(2))) == 1


def test_atomic_failure_preserves_previous_document(monkeypatch):
    document = store.create(source())
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(store.os, "replace", fail)
    with pytest.raises(OSError):
        store.update(document["id"], 1, [{"type": "catalog.rename", "name": "失敗"}])
    assert store.get(document["id"]) == document
    assert not list(store.directory().glob("*.tmp"))


def test_delete_item_removes_all_references():
    document = store.create(source())
    result = store.update(document["id"], 1, [{"type": "item.delete", "id": "i0"}])
    assert "i0" not in result["recipes"][0]["groups"][0]["item_ids"]


def test_delete_last_set_and_execute_empty_rows():
    document = store.create(source())
    result = store.update(document["id"], 1, [{"type": "recipe.delete", "id": "r"}])
    assert result["recipes"] == []
    config = json.dumps({"version": 3, "catalog_id": result["id"], "rows": []})
    assert node.resolve_catalog(config)[0] == ""


def test_shared_catalog_supports_more_than_legacy_set_limit():
    data = source()
    data["recipes"] = [{"id": f"r{i}", "name": str(i), "groups": []} for i in range(33)]
    assert len(store.create(data)["recipes"]) == 33


def test_invalid_patch_preserves_document():
    document = store.create(source())
    with pytest.raises(ValueError):
        store.update(document["id"], 1, [{"type": "item.put", "item": {"id": "bad"}}])
    assert store.get(document["id"]) == document


@pytest.mark.parametrize("identifier", ["../secret", "a/b", "a\\b", "", None])
def test_path_traversal_rejected(identifier):
    with pytest.raises(ValueError):
        store.get(identifier)


def test_shared_execution_and_snapshot_revision():
    document = store.create(source())
    config = workflow(document)
    text, raw = node.resolve_catalog(config, 123)
    report = json.loads(raw)
    assert report["revision"] == 1
    assert report["rows"][0]["groups"][0]["candidate_ids"] == [f"i{i}" for i in range(6)]
    chosen = report["rows"][0]["groups"][0]["items"]
    assert len(chosen) == 2
    assert [item["output_position"] for item in chosen] == [1, 2]
    assert text == "\n".join(item["text"].strip() for item in chosen)
    old = store.snapshot(document["id"])
    item = copy.deepcopy(chosen[0])
    item.pop("output_position")
    item["text"] = "修正済み"
    store.update(document["id"], 1, [{"type": "item.put", "item": item}])
    assert old["revision"] == 1
    assert chosen[0]["text"] != "修正済み"
    assert "修正済み" in node.resolve_catalog(config, 123)[0]
    assert set(node.SAX_Bridge_Text_Catalog_V2.execute(config, 123).ui) == {"text", "selection_json"}


def test_rows_order_and_random_reproducibility():
    document = store.create(source())
    rows = [{"id": "a", "recipe_id": "r", "on": True}, {"id": "b", "recipe_id": "r", "on": True}]
    text, raw = node.resolve_catalog(workflow(document, rows), 13)
    report = json.loads(raw)
    assert report["rows"][0]["groups"][0]["item_ids"] == report["rows"][1]["groups"][0]["item_ids"]
    reverse = json.loads(node.resolve_catalog(workflow(document, rows[::-1]), 13)[1])
    assert reverse["rows"][0]["id"] == "b"
    assert len(text.splitlines()) == 4


def test_fingerprint_updates_and_cache_is_shared():
    document = store.create(source())
    config = workflow(document)
    first = node.SAX_Bridge_Text_Catalog_V2.fingerprint_inputs(config)
    assert store.snapshot(document["id"]) is store.snapshot(document["id"])
    store.update(document["id"], 1, [{"type": "catalog.rename", "name": "更新"}])
    assert node.SAX_Bridge_Text_Catalog_V2.fingerprint_inputs(config) != first


def test_cache_eviction_keeps_catalog_readable(monkeypatch):
    monkeypatch.setattr(store, "_CACHE_BYTES", 100)
    document = store.create(source())
    assert not store._cache
    assert store.get(document["id"]) == document
    assert isinstance(store.fingerprint(document["id"]), str)


def test_missing_catalog_or_set_is_explicit_error():
    document = store.create(source())
    with pytest.raises(ValueError, match="テキストセット"):
        node.resolve_catalog(workflow(document, [{"id": "x", "recipe_id": "missing", "on": True}]))
    store._path(document["id"]).unlink()
    with pytest.raises(ValueError, match="見つかりません"):
        node.resolve_catalog(workflow(document))


def test_empty_shared_node():
    text, raw = node.resolve_catalog(node.SHARED_DEFAULT_CONFIG)
    assert text == ""
    assert json.loads(raw)["rows"] == []


def test_external_corruption_does_not_reuse_cached_data():
    document = store.create(source())
    store._path(document["id"]).write_text("broken", encoding="utf-8")
    with pytest.raises(ValueError):
        store.snapshot(document["id"])


def test_http_routes_create_patch_conflict_import(monkeypatch):
    import asyncio
    from aiohttp import web
    routes = web.RouteTableDef()
    monkeypatch.setitem(sys.modules, "server", types.SimpleNamespace(
        PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))))
    store.register_routes()

    async def scenario():
        handlers = {(route.method, route.path): route.handler for route in routes}
        prefix = "/sax/text-catalog/v2/catalogs"

        async def call(method, payload=None, identifier=None, raw=None):
            data = raw if raw is not None else json.dumps(payload).encode()
            async def chunks(size):
                yield data
            request = types.SimpleNamespace(content_length=len(data), content=types.SimpleNamespace(iter_chunked=chunks),
                                            match_info={"catalog_id": identifier})
            handler = handlers[(method, prefix + ("/{catalog_id}" if identifier else ""))]
            response = await handler(request)
            return response.status, json.loads(response.body)

        status, doc = await call("POST", source())
        assert status == 200
        status, saved = await call("PATCH", {"base_revision": 1, "operations": [
            {"type": "catalog.rename", "name": "改訂"}]}, doc["id"])
        assert status == 200
        assert saved == {"id": doc["id"], "revision": 2}
        status, conflict = await call("PATCH", {"base_revision": 1, "operations": []}, doc["id"])
        assert status == 409
        assert conflict["current"]["revision"] == 2
        status, current = await call("GET", identifier=doc["id"])
        assert current["name"] == "改訂"
        status, imported = await call("POST", {"document": doc})
        assert imported["id"] != doc["id"]
        status, listing = await call("GET")
        assert len(listing["catalogs"]) == 2
        status, _ = await call("PATCH", identifier=doc["id"], raw=b"not json")
        assert status == 400

    asyncio.run(scenario())


def test_catalog_loading_measurements(capsys):
    for count, length in [(1000, 100), (10000, 100), (10000, 2000)]:
        data = source(count)
        for item in data["catalog"]["items"]:
            item["text"] = "x" * length
        document = store.create(data)
        store._cache.clear()
        start = time.perf_counter()
        store.snapshot(document["id"])
        cold = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        for _ in range(100):
            store.fingerprint(document["id"])
        warm = (time.perf_counter() - start) * 10
        with capsys.disabled():
            print(f"\nshared catalog count={count} text_chars={length}: cold={cold:.2f}ms warm={warm:.3f}ms")
