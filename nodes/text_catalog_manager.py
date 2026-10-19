"""共有カタログの整理（一覧・複製・アーカイブ）用の暫定ノード。操作はUIのボタンだけで、Queueでは何もしない。"""

from comfy_api.latest import io


class SAX_Bridge_Text_Catalog_Manager(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(node_id="SAX_Bridge_Text_Catalog_Manager", display_name="SAX Text Catalog Manager",
                         category="SAX/Bridge/Utility", is_output_node=True,
                         description="共有カタログの一覧・複製・アーカイブをボタン操作で行う暫定ノードです。接続不要・Queue実行では何もしません。",
                         inputs=[], outputs=[])

    @classmethod
    def execute(cls):
        return io.NodeOutput()
