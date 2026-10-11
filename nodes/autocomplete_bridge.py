"""送信時だけ使う Autocomplete++ の本文入力を、検証・実行前に復元する。"""

import json
import logging


TRANSFER = "_sax_ac_transfer"
logger = logging.getLogger("SAX_Bridge")


def restore_autocomplete_prompt(payload):
    for node in payload.get("prompt", {}).values():
        if not isinstance(node, dict) or not str(node.get("class_type", "")).startswith("SAX_Bridge_"):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict) or TRANSFER not in inputs:
            continue
        try:
            packet = inputs[TRANSFER]
            if not isinstance(packet, dict) or packet.get("version") != 1:
                raise ValueError("補完連携データの形式が不正です")
            protected = packet["inputs"]
            if not isinstance(protected, dict) or len(protected) > 128:
                raise ValueError("補完連携入力が不正です")
            for ref in packet["texts"]:
                value = inputs[ref["key"]]
                if not isinstance(value, str) or not ref["key"].startswith("_sax_ac_text_"):
                    raise ValueError("展開結果が文字列ではありません")
                entry = protected[ref["input"]]
                data = entry["data"]
                if ref["shared"]:
                    data = data["_sax_queued_catalog"]
                item = data["catalog"]["items"][ref["index"]]
                if item["text"] != value:
                    item["text"] = value
                    entry["changed"] = True
            restored = {}
            for name, entry in protected.items():
                if name == TRANSFER or name.startswith("_sax_ac_text_") or not isinstance(entry["raw"], str):
                    raise ValueError("復元先が不正です")
                restored[name] = json.dumps(entry["data"], ensure_ascii=False, separators=(",", ":")) if entry.get("changed") else entry["raw"]
            for ref in packet["texts"]:
                inputs.pop(ref["key"])
            inputs.pop(TRANSFER)
            inputs.update(restored)
        except (KeyError, TypeError, ValueError, IndexError, AttributeError, OverflowError, RecursionError):
            # ComfyUI は handler の例外を握りつぶす。入力が欠けたまま default で
            # 実行しないよう、形式不正の prompt はノード検証で必ず拒否させる。
            logger.exception("[SAX_Bridge] Autocomplete++ の送信データを復元できません")
            node["class_type"] = "SAX_Invalid_Autocomplete_Transfer"
    return payload


def register_prompt_handler():
    try:
        from server import PromptServer
    except ImportError:
        # サーバーを起動しない schema 読み込み・単体テストでもノードを利用する。
        return
    instance = getattr(PromptServer, "instance", None)
    if instance is not None and not getattr(instance, "_sax_autocomplete_handler", False):
        instance.add_on_prompt_handler(restore_autocomplete_prompt)
        instance._sax_autocomplete_handler = True
