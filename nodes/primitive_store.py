import json
import random
from typing import Any

from comfy_api.latest import io

from .io_types import AnyType

MAX_ITEMS = 32


class SAX_Bridge_Primitive_Store(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Primitive_Store",
            display_name="SAX Primitive Store",
            category="SAX/Bridge/Utility",
            description=(
                "Define and manage common primitive variables (INT, FLOAT, STRING, BOOLEAN, SEED) "
                "in one place. Each item becomes an output slot for downstream nodes."
            ),
            inputs=[
                io.String.Input("items_json", default="[]", optional=True),
            ],
            outputs=[
                AnyType.Output(f"out_{i}")
                for i in range(MAX_ITEMS)
            ],
        )

    @staticmethod
    def _parse_items(items_json) -> list[dict]:
        """items_json を dict のリストへ正規化する。

        items_json は JS UI が書く hidden 文字列だが、手編集や旧形式の
        ワークフローでは配列でない・要素が dict でない値が入り得る。そのまま
        `item.get(...)` すると AttributeError / TypeError でワークフロー全体が
        止まるため、text_catalog.py と同じく静かに読み飛ばす。
        """
        try:
            items = json.loads(items_json) if isinstance(items_json, str) else []
        except (json.JSONDecodeError, TypeError):
            return []
        if not isinstance(items, list):
            return []
        return [item for item in items if isinstance(item, dict)]

    @classmethod
    def IS_CHANGED(cls, items_json="[]", **kwargs):
        """SEED(random) が含まれる場合は毎回再実行する。"""
        for item in cls._parse_items(items_json):
            if item.get("type") == "SEED" and item.get("mode") == "random":
                return float("nan")
        return items_json

    @classmethod
    def execute(cls, items_json="[]", **kwargs) -> io.NodeOutput:
        items = cls._parse_items(items_json)

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

        return io.NodeOutput(*result)
