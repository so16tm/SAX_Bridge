"""全 V3 ノードのスキーマ構造を検証する。"""

import pytest
from nodes.guidance import SAX_Bridge_Guidance
from nodes.prompt import SAX_Bridge_Prompt, SAX_Bridge_Prompt_Concat
from nodes.output import SAX_Bridge_Output, SAX_Bridge_Image_Preview
from nodes.detailer import SAX_Bridge_Detailer, SAX_Bridge_Detailer_Enhanced
from nodes.sampler import SAX_Bridge_KSampler
from nodes.loader import SAX_Bridge_Loader, SAX_Bridge_Loader_Lora
from nodes.pipe import SAX_Bridge_Pipe, SAX_Bridge_Pipe_Switcher
from nodes.finisher import SAX_Bridge_Finisher
from nodes.noise import SAX_Bridge_Noise_Image, SAX_Bridge_Noise_Latent
from nodes.upscaler import SAX_Bridge_Upscaler
from nodes.cache import SAX_Bridge_Cache
from nodes.toggle_manager import SAX_Bridge_Toggle_Manager
from nodes.node_collector import SAX_Bridge_Node_Collector
from nodes.pipe_collector import SAX_Bridge_Pipe_Collector
from nodes.image_collector import SAX_Bridge_Image_Collector
from nodes.primitive_store import SAX_Bridge_Primitive_Store
from nodes.sam3 import SAX_Bridge_Loader_SAM3, SAX_Bridge_Segmenter_Multi
from nodes.debug import (
    SAX_Bridge_Assert,
    SAX_Bridge_Assert_Pipe,
    SAX_Bridge_Debug_Inspector,
    SAX_Bridge_Debug_Text,
)

ALL_V3_NODES = [
    SAX_Bridge_Guidance,
    SAX_Bridge_Prompt,
    SAX_Bridge_Prompt_Concat,
    SAX_Bridge_Output,
    SAX_Bridge_Image_Preview,
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
    SAX_Bridge_KSampler,
    SAX_Bridge_Loader,
    SAX_Bridge_Loader_Lora,
    SAX_Bridge_Pipe,
    SAX_Bridge_Pipe_Switcher,
    SAX_Bridge_Finisher,
    SAX_Bridge_Noise_Image,
    SAX_Bridge_Noise_Latent,
    SAX_Bridge_Upscaler,
    SAX_Bridge_Cache,
    SAX_Bridge_Toggle_Manager,
    SAX_Bridge_Node_Collector,
    SAX_Bridge_Pipe_Collector,
    SAX_Bridge_Image_Collector,
    SAX_Bridge_Primitive_Store,
    SAX_Bridge_Loader_SAM3,
    SAX_Bridge_Segmenter_Multi,
    SAX_Bridge_Assert,
    SAX_Bridge_Assert_Pipe,
    SAX_Bridge_Debug_Inspector,
    SAX_Bridge_Debug_Text,
]


@pytest.mark.parametrize("node_cls", ALL_V3_NODES, ids=lambda c: c.__name__)
class TestV3Schema:
    def test_has_define_schema(self, node_cls):
        assert hasattr(node_cls, "define_schema"), f"{node_cls.__name__} に define_schema がない"

    def test_schema_has_required_fields(self, node_cls):
        schema = node_cls.define_schema()
        assert hasattr(schema, "node_id"), f"{node_cls.__name__}: node_id がない"
        assert hasattr(schema, "display_name"), f"{node_cls.__name__}: display_name がない"
        assert hasattr(schema, "category"), f"{node_cls.__name__}: category がない"
        assert hasattr(schema, "inputs"), f"{node_cls.__name__}: inputs がない"
        assert hasattr(schema, "outputs"), f"{node_cls.__name__}: outputs がない"

    def test_node_id_is_string(self, node_cls):
        schema = node_cls.define_schema()
        assert isinstance(schema.node_id, str) and len(schema.node_id) > 0

    def test_has_execute_classmethod(self, node_cls):
        assert hasattr(node_cls, "execute"), f"{node_cls.__name__} に execute がない"

    def test_no_v2_remnants(self, node_cls):
        assert not hasattr(node_cls, "INPUT_TYPES") or not callable(getattr(node_cls, "INPUT_TYPES", None)), \
            f"{node_cls.__name__} に V2 API INPUT_TYPES が残っている"
        for attr in ("RETURN_TYPES", "RETURN_NAMES", "FUNCTION", "CATEGORY"):
            val = getattr(node_cls, attr, None)
            if val is not None and not callable(val):
                assert isinstance(val, type(None)), f"{node_cls.__name__} に V2 API {attr} が残っている"

    def test_get_schema_works(self, node_cls):
        schema = node_cls.GET_SCHEMA()
        assert schema.node_id == node_cls.define_schema().node_id
