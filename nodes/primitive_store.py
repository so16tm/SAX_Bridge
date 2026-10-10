import json
import random
from typing import Any

from comfy_api.latest import io

from .io_types import AnyType

MAX_ITEMS = 32


def _parse_items(items_json):
    try:
        items = json.loads(items_json) if isinstance(items_json, str) else []
    except (json.JSONDecodeError, TypeError):
        return []
    return items[:MAX_ITEMS] if isinstance(items, list) else []


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

    @classmethod
    def IS_CHANGED(cls, items_json="[]", **kwargs):
        """SEED(random) が含まれる場合は毎回再実行する。"""
        for item in _parse_items(items_json):
            if isinstance(item, dict) and item.get("type") == "SEED" and item.get("mode") == "random":
                return float("nan")
        return items_json

    @classmethod
    def execute(cls, items_json="[]", **kwargs) -> io.NodeOutput:
        items = _parse_items(items_json)

        result: list[Any] = [None] * MAX_ITEMS
        for i, item in enumerate(items[:MAX_ITEMS]):
            if not isinstance(item, dict):
                continue
            t = item.get("type", "INT")
            v = item.get("value", 0)
            try:
                if t == "SEED":
                    # 登録済みキューは UI 更新前の value を共有することがある。
                    # random は実行ごとに抽選し、固定値の再現には fixed を使う。
                    if item.get("mode") == "random":
                        maximum = min(2**53 - 1, max(0, int(item.get("max", 2**53 - 1))))
                        v = random.randint(0, maximum)
                    result[i] = int(round(float(v)))
                elif t == "INT":
                    result[i] = int(round(float(v)))
                elif t == "FLOAT":
                    result[i] = float(v)
                elif t == "BOOLEAN":
                    result[i] = bool(v)
                else:  # STRING
                    result[i] = str(v) if v is not None else ""
            except (ValueError, TypeError, OverflowError):
                result[i] = None

        return io.NodeOutput(*result)
