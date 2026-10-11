"""Autocomplete++ のワイルドカード編集画面を開くための独立ノード。"""
from comfy_api.latest import io


class SAX_Bridge_Wildcard_Editor(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Wildcard_Editor",
            display_name="SAX Wildcard Editor",
            category="SAX/Bridge/Utility",
            description="Autocomplete++ のワイルドカード .txt を作成・編集する画面を開きます。ノード実行は不要です。",
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        return io.NodeOutput()
