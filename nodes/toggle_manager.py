import logging

logger = logging.getLogger("SAX_Bridge")

_DEFAULT_CONFIG = (
    '{"managed":[],"scenes":{"Default":{}},"currentScene":"Default"}'
)


class SAX_Bridge_Toggle_Manager:
    """
    グループ・ノード・Boolean ウィジェットの bypass/値をシーン単位で管理するコントローラノード。

    - 管理対象はビジュアルピッカーで選択（配線不要・タイトルベース）
    - シーンを複数定義し、ドロップダウン一発で切り替え
    - グループ bypass / ノード bypass / Boolean ウィジェット値を一括制御
    - シーン状態はワークフローに保存されセッションをまたいで保持
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "config_json": (
                    "STRING",
                    {
                        "default": _DEFAULT_CONFIG,
                        "multiline": False,
                        "tooltip": "シーン設定データ（JSON）。JS が管理するため直接編集不要。",
                    },
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "process"
    CATEGORY = "SAX/Bridge/Utility"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "グループ・ノード・Boolean ウィジェットの bypass/値をシーン単位で管理するコントローラノード。"
        "実行不要。シーン切り替え・トグル操作はフロントエンドで即時反映される。"
    )

    def process(self, config_json: str):
        return {}


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Toggle_Manager": SAX_Bridge_Toggle_Manager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Toggle_Manager": "SAX Toggle Manager",
}
