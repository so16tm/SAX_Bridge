from comfy_api.latest import io

from .io_types import AnyType

MAX_SLOTS = 32


class SAX_Bridge_Node_Collector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Node_Collector",
            display_name="SAX Node Collector",
            category="SAX/Bridge/Collect",
            inputs=[
                AnyType.Input(f"slot_{i}", optional=True)
                for i in range(MAX_SLOTS)
            ],
            outputs=[
                AnyType.Output(f"out_{i}")
                for i in range(MAX_SLOTS)
            ],
        )

    @classmethod
    def execute(cls, **kwargs) -> io.NodeOutput:
        return io.NodeOutput(
            *[kwargs.get(f"slot_{i}") for i in range(MAX_SLOTS)]
        )
