import json
import random
from typing import Any


class _AnyType(str):
    """任意の型と互換性を持つワイルドカード型。"""
    def __eq__(self, other: object) -> bool: return True
    def __ne__(self, other: object) -> bool: return False
    def __hash__(self) -> int: return hash(str(self))


ANY = _AnyType("*")
MAX_ITEMS = 32


class SAX_Bridge_Primitive_Store:
    """
    Primitive Store — ワークフロー内で使用する共通プリミティブ変数を
    一か所で定義・管理するノード。

    アイテムを追加するたびに出力スロットが増え、
    INT / FLOAT / STRING / BOOLEAN 値を下流ノードへ配布する。
    入力スロットはなく、すべての値はノード内で完結する。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # JS 側がアイテムリストを JSON 文字列として書き込む hidden widget
                # 注意: __ プレフィックスは Python 名前マングリングで破壊されるため使用不可
                "items_json": ("STRING", {"default": "[]"}),
            },
        }

    RETURN_TYPES  = (ANY,) * MAX_ITEMS
    RETURN_NAMES  = tuple(f"out_{i}" for i in range(MAX_ITEMS))
    FUNCTION      = "execute"
    CATEGORY      = "SAX/Bridge/Utility"
    OUTPUT_NODE   = False
    DESCRIPTION   = (
        "Define and manage common primitive variables (INT, FLOAT, STRING, BOOLEAN, SEED) "
        "in one place. Each item becomes an output slot for downstream nodes."
    )

    @classmethod
    def IS_CHANGED(cls, items_json="[]", **kwargs):
        """SEED(random) が含まれる場合は毎回再実行する。"""
        try:
            items = json.loads(items_json) if isinstance(items_json, str) else []
        except (json.JSONDecodeError, TypeError):
            return items_json
        for item in items:
            if item.get("type") == "SEED" and item.get("mode") == "random":
                return float("nan")
        return items_json

    def execute(self, items_json="[]", **kwargs):
        try:
            items = json.loads(items_json) if isinstance(items_json, str) else []
        except (json.JSONDecodeError, TypeError):
            items = []

        result: list[Any] = [None] * MAX_ITEMS
        for i, item in enumerate(items[:MAX_ITEMS]):
            t = item.get("type", "INT")
            v = item.get("value", 0)
            try:
                if t == "SEED":
                    if item.get("mode") == "random":
                        v = random.randint(0, 2**53 - 1)
                    result[i] = int(round(float(v)))
                elif t == "INT":
                    result[i] = int(round(float(v)))
                elif t == "FLOAT":
                    result[i] = float(v)
                elif t == "BOOLEAN":
                    result[i] = bool(v)
                else:  # STRING
                    result[i] = str(v) if v is not None else ""
            except (ValueError, TypeError):
                result[i] = None

        return tuple(result)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Primitive_Store": SAX_Bridge_Primitive_Store,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Primitive_Store": "SAX Primitive Store",
}
