import logging

from comfy_api.latest import io

logger = logging.getLogger("SAX_Bridge")

_DEFAULT_CONFIG = (
    '{"managed":[],"scenes":{"Default":{}},"currentScene":"Default"}'
)


class SAX_Bridge_Toggle_Manager(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Toggle_Manager",
            display_name="SAX Toggle Manager",
            category="SAX/Bridge/Utility",
            description=(
                "グループ・ノード・Boolean ウィジェットの bypass/値をシーン単位で管理するコントローラノード。"
                "実行不要。シーン切り替え・トグル操作はフロントエンドで即時反映される。"
            ),
            is_output_node=True,
            inputs=[
                io.String.Input(
                    "config_json",
                    default=_DEFAULT_CONFIG,
                    multiline=False,
                    tooltip="シーン設定データ（JSON）。JS が管理するため直接編集不要。",
                ),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, config_json: str) -> io.NodeOutput:  # noqa: ARG003
        return io.NodeOutput()
