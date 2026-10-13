"""
LoRA / Wildcard ピッカー用の選択肢取得ヘルパー。

`SAX_Bridge_Prompt` と `SAX_Bridge_Text_Catalog` の `define_schema` から共通利用する。
ノード本体に hidden combo を持たせ、JS 側のピッカーモーダルが
`combo.options.values` を引いてアイテム一覧として表示する用途。
"""

from __future__ import annotations

import folder_paths


LORA_PLACEHOLDER = "Select the LoRA to add to the text"
WILDCARD_PLACEHOLDER = "Select the Wildcard to add to the text"


def get_lora_options() -> list[str]:
    """LoRA combo の選択肢一覧（先頭にプレースホルダ）を返す。"""
    return [LORA_PLACEHOLDER, *folder_paths.get_filename_list("loras")]


def get_wildcard_options() -> list[str]:
    """一覧はブラウザから Autocomplete++ API へ問い合わせる。"""
    return [WILDCARD_PLACEHOLDER]
