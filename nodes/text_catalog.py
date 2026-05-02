"""
SAX Text Catalog ノード

名前付きテキスト（プロンプト等）のカタログ管理と、
Relation 経由での出力スロットへの割り当てを行う。

データモデル（4要素）:
  - Catalog: Item の保管庫
  - Item: 名前付きテキスト1件 {id, name, text, tags}
  - Relation: Catalog.Item と Slot の紐づけ {item_id, on}
  - Slot: ComfyUI 出力ピン（Relation 配列から自動生成される派生物）

シリアライズ形式（items_json）:
  {
    "version": 1,
    "catalog": {
      "items": [{"id", "name", "text", "tags": [...]}],
      "tag_definitions": [...]
    },
    "relations": [{"item_id": "..." | null, "on": true}]
  }

Relation の `on` フィールドが false の場合、参照する Item の状態に依らず空文字を出力する。
旧ワークフロー（`on` 欠損）は ON 扱いで読み込む（後方互換）。
"""

import json
import logging
from typing import Any

from comfy_api.latest import io

from .picker_options import get_lora_options, get_wildcard_options


logger = logging.getLogger("SAX_Bridge")


MAX_RELATIONS = 32
MAX_ITEMS = 32
MAX_TAGS_PER_ITEM = 8
MAX_ID_LENGTH = 128  # 信頼できないワークフローからの DoS 防止
SCHEMA_VERSION = 1


def _safe_id_for_log(value: Any) -> str:
    """ログ出力用に id 値を安全な短い文字列に変換する（ログインジェクション防止）。"""
    s = str(value) if isinstance(value, str) else repr(value)
    return s[:64]


def _resolve_relations(items_json: str) -> list[str]:
    """
    items_json を解釈して Relation 数分の出力テキストを返す。

    異常時は全 Slot を空文字で返す（None にしない）。
    下流ノードが空文字をスキップする契約（SAX_Bridge_Prompt_Concat 等）と整合させるため。
    """
    fallback = [""] * MAX_RELATIONS

    if not isinstance(items_json, str) or not items_json.strip():
        return fallback

    try:
        payload = json.loads(items_json)
    except (json.JSONDecodeError, TypeError):
        logger.warning("[SAX_Text_Catalog] failed to parse items_json")
        return fallback

    if not isinstance(payload, dict):
        logger.warning("[SAX_Text_Catalog] items_json root is not an object")
        return fallback

    version = payload.get("version")
    if version != SCHEMA_VERSION:
        logger.warning(
            "[SAX_Text_Catalog] unsupported schema version: %s (expected %d)",
            _safe_id_for_log(version),
            SCHEMA_VERSION,
        )
        return fallback

    # `or {}` ではなく明示的に型チェックする（False や 0 を空扱いにしない）
    catalog_raw = payload.get("catalog")
    catalog = catalog_raw if isinstance(catalog_raw, dict) else {}
    items_raw = catalog.get("items")
    items = items_raw if isinstance(items_raw, list) else []
    relations_raw = payload.get("relations")
    relations = relations_raw if isinstance(relations_raw, list) else []

    items_by_id: dict[str, dict[str, Any]] = {}
    # MAX_ITEMS で上限を打ち切ることで、巨大ワークフローによるメモリ消費を防ぐ
    for it in items[:MAX_ITEMS]:
        if not isinstance(it, dict):
            continue
        it_id = it.get("id")
        if isinstance(it_id, str) and it_id and len(it_id) <= MAX_ID_LENGTH:
            items_by_id[it_id] = it

    result = [""] * MAX_RELATIONS
    for i, rel in enumerate(relations[:MAX_RELATIONS]):
        if not isinstance(rel, dict):
            continue
        # `on` 欠損時は True 扱い（旧ワークフローとの後方互換）。
        # 非 boolean 値は bool() で正規化して許容する。
        on_raw = rel.get("on", True)
        on = on_raw if isinstance(on_raw, bool) else bool(on_raw)
        item_id = rel.get("item_id")
        # 参照切れの警告は OFF 状態でも維持する（ON 復帰時の予期しない空文字を防ぐため）。
        # 非文字列の item_id（dict/int 等）は形式不正であり「削除済み」ではないため警告対象外。
        item = items_by_id.get(item_id) if isinstance(item_id, str) else None
        if isinstance(item_id, str) and item is None:
            logger.warning(
                "[SAX_Text_Catalog] relation %d references missing item: %s",
                i,
                _safe_id_for_log(item_id),
            )
        if not on:
            continue
        if item_id is None or item is None:
            continue
        text = item.get("text", "")
        result[i] = text if isinstance(text, str) else ""

    return result


class SAX_Bridge_Text_Catalog(io.ComfyNode):
    """
    名前付きテキストのカタログをノード内に保持し、
    Relation で割り当てられた Slot から出力する。
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Text_Catalog",
            display_name="SAX Text Catalog",
            category="SAX/Bridge/Utility",
            description=(
                "Manage a catalog of named texts and assign them to output slots "
                "via relations. Useful for organizing prompt variations."
            ),
            inputs=[
                io.String.Input("items_json", default="{}", optional=True),
                # JS 側の Manager Editor で LoRA / Wildcard ピッカーが
                # `combo.options.values` を引いてアイテム一覧を取得するための hidden combo。
                # execute では参照しないが、UI 用の選択肢ソースとして必要。
                io.Combo.Input(
                    "select_to_add_lora",
                    options=get_lora_options(),
                    optional=True,
                ),
                io.Combo.Input(
                    "select_to_add_wildcard",
                    options=get_wildcard_options(),
                    optional=True,
                ),
            ],
            outputs=[
                io.String.Output(display_name=f"out_{i}")
                for i in range(MAX_RELATIONS)
            ],
        )

    @classmethod
    def IS_CHANGED(cls, items_json: str = "{}", **kwargs) -> str:
        return items_json

    @classmethod
    def execute(cls, items_json: str = "{}", **kwargs) -> io.NodeOutput:
        result = _resolve_relations(items_json)
        return io.NodeOutput(*result)
