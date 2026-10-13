import copy
import json

import pytest

from nodes.autocomplete_bridge import TRANSFER, restore_autocomplete_prompt
from nodes.text_catalog import SAX_Bridge_Text_Catalog
from nodes import text_catalog_v2 as v2, text_catalog_v2_store as store


def packet_node(data, text=None, shared=False):
    name = "config_json" if shared else "items_json"
    packet = {"version": 1, "inputs": {name: {"raw": json.dumps(data), "data": copy.deepcopy(data), "changed": shared}},
              "texts": [{"key": "_sax_ac_text_0", "input": name, "index": 0, "shared": shared}]}
    return {"class_type": "SAX_Bridge_Text_Catalog_V2" if shared else "SAX_Bridge_Text_Catalog",
            "inputs": {TRANSFER: packet, "_sax_ac_text_0": text or "blue_eyes"}}


def test_v1_restore_expanded_text_preserves_metadata_and_off_slots():
    data = {"version": 1, "catalog": {"items": [{"id": "i", "name": "{keep|metadata}", "text": "{red|blue}"}]},
            "relations": [{"item_id": "i", "on": True}, {"item_id": "i", "on": False}]}
    node = packet_node(data)
    payload = {"prompt": {"1": node}}
    assert restore_autocomplete_prompt(payload) is payload
    restored = json.loads(node["inputs"]["items_json"])
    assert restored["catalog"]["items"][0]["name"] == "{keep|metadata}"
    assert data["catalog"]["items"][0]["text"] == "{red|blue}"
    assert set(node["inputs"]) == {"items_json"}
    assert SAX_Bridge_Text_Catalog.execute(**node["inputs"]).args[:2] == ("blue_eyes", "")
    assert restore_autocomplete_prompt(payload) is payload  # 複数hookの再処理でも不変。


def test_engine_absent_preserves_original_json_exactly():
    data = {"catalog": {"items": [{"text": "__colors__"}]}}
    node = packet_node(data, "__colors__")
    raw = node["inputs"][TRANSFER]["inputs"]["items_json"]["raw"]
    restore_autocomplete_prompt({"prompt": {"1": node}})
    assert node["inputs"]["items_json"] == raw


def test_shared_snapshot_is_used_after_saved_catalog_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "directory", lambda: tmp_path)
    document = store.create({"name": "保存", "catalog": {"items": [{"id": "i", "name": "名前", "text": "{red|blue}", "tags": []}]},
                             "recipes": [{"id": "r", "name": "セット", "groups": [{"id": "g", "name": "グループ", "on": True, "mode": "random", "count": 1, "item_ids": ["i"]}]}]})
    data = {"version": 3, "catalog_id": document["id"], "rows": [{"id": "row", "recipe_id": "r", "on": True}], "_sax_queued_catalog": document}
    node = packet_node(data, "blue_eyes", shared=True)
    restore_autocomplete_prompt({"prompt": {"1": node}})
    store.update(document["id"], 1, [{"type": "item.put", "item": {"id": "i", "name": "名前", "text": "later", "tags": []}}])
    text, report = v2.resolve_catalog(node["inputs"]["config_json"], 123)
    assert text == "blue_eyes"
    assert json.loads(report)["revision"] == 1
    assert json.loads(report)["seed"] == 123
    assert store.snapshot(document["id"])["catalog"]["items"][0]["text"] == "later"
    assert v2.SAX_Bridge_Text_Catalog_V2.fingerprint_inputs(node["inputs"]["config_json"]) == node["inputs"]["config_json"]
    data["_sax_queued_catalog"]["id"] = "other"
    with pytest.raises(ValueError, match="ID"):
        v2.parse_workflow(json.dumps(data))


@pytest.mark.parametrize("change", [lambda p: p.update(version=2), lambda p: p.update(inputs=None),
                                   lambda p: p["texts"][0].update(index=999), lambda p: p["texts"][0].update(key="missing")])
def test_invalid_transfer_is_rejected_instead_of_default_execution(change):
    node = packet_node({"catalog": {"items": [{"text": "x"}]}})
    change(node["inputs"][TRANSFER])
    restore_autocomplete_prompt({"prompt": {"1": node}})
    assert node["class_type"] == "SAX_Invalid_Autocomplete_Transfer"


def test_regular_api_prompt_is_untouched():
    payload = {"prompt": {"1": {"class_type": "SAX_Bridge_Prompt", "inputs": {"wildcard_text": "blue"}}}}
    before = copy.deepcopy(payload)
    restore_autocomplete_prompt(payload)
    assert payload == before


def test_prompt_handler_registration_is_idempotent(monkeypatch):
    import sys
    import types
    from nodes.autocomplete_bridge import register_prompt_handler
    handlers = []
    instance = types.SimpleNamespace(add_on_prompt_handler=handlers.append)
    monkeypatch.setitem(sys.modules, "server", types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=instance)))
    register_prompt_handler()
    register_prompt_handler()
    assert handlers == [restore_autocomplete_prompt]
