from comfy_api.latest import io

from .io_types import AnyType, PipeLine

MAX_SLOTS = 16


class SAX_Bridge_Pipe_Collector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Pipe_Collector",
            display_name="SAX Pipe Collector",
            category="SAX/Bridge/Collect",
            description=(
                "Collects PIPE outputs from registered source nodes and returns the first "
                "non-None PIPE found. Use the JS picker to register source nodes."
            ),
            inputs=[
                AnyType.Input(f"slot_{i}", optional=True)
                for i in range(MAX_SLOTS)
            ],
            outputs=[
                PipeLine.Output("pipe"),
            ],
        )

    @classmethod
    def execute(cls, **kwargs) -> io.NodeOutput:
        for i in range(MAX_SLOTS):
            val = kwargs.get(f"slot_{i}")
            if val is not None:
                return io.NodeOutput(val)
        return io.NodeOutput(None)
