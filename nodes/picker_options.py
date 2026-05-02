"""
LoRA / Wildcard ピッカー用の選択肢取得ヘルパー。

`SAX_Bridge_Prompt` と `SAX_Bridge_Text_Catalog` の `define_schema` から共通利用する。
ノード本体に hidden combo を持たせ、JS 側のピッカーモーダルが
`combo.options.values` を引いてアイテム一覧として表示する用途。
"""

from __future__ import annotations

import logging

import folder_paths


logger = logging.getLogger(__name__)


LORA_PLACEHOLDER = "Select the LoRA to add to the text"
WILDCARD_PLACEHOLDER = "Select the Wildcard to add to the text"


def get_lora_options() -> list[str]:
    """LoRA combo の選択肢一覧（先頭にプレースホルダ）を返す。"""
    return [LORA_PLACEHOLDER, *folder_paths.get_filename_list("loras")]


def get_wildcard_options() -> list[str]:
    """
    Wildcard combo の選択肢一覧（先頭にプレースホルダ）を返す。

    Impact Pack 未導入時はプレースホルダのみ。JS 側は遅延ロードで
    `/impact/wildcards/list` API からも補完を試みる。
    """
    options = [WILDCARD_PLACEHOLDER]
    try:
        import impact.wildcards
        wl = impact.wildcards.get_wildcard_list()
        if wl:
            options.extend(wl)
    except ImportError:
        # Impact-Pack 未導入は想定内のフォールバック。サイレント継続する。
        pass
    except Exception:
        # Impact-Pack 内部の予期せぬ失敗。詳細は debug ログで残す。
        logger.debug("[SAX_Bridge] get_wildcard_options failed", exc_info=True)
    return options
