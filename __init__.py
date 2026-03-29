from .nodes.detailer import (
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
)
from .nodes.output import SAX_Bridge_Output, SAX_Bridge_Image_Preview
from .nodes import toggle_manager as toggle_manager_node
from .nodes import node_collector as node_collector_node
from .nodes import pipe_collector as pipe_collector_node
from .nodes import image_collector as image_collector_node
from .nodes import primitive_store as primitive_store_node
from .nodes.guidance import SAX_Bridge_Guidance
from .nodes.sam3 import SAX_Bridge_Loader_SAM3, SAX_Bridge_Segmenter_Multi
from .nodes.schedulers import register_schedulers

register_schedulers()

from .nodes import prompt as prompt_node
from .nodes import pipe as pipe_node
from .nodes import loader as loader_node
from .nodes import sampler as sampler_node
from .nodes import cache as cache_node
from .nodes import noise as noise_node
from .nodes import upscaler as upscaler_node
from .nodes import finisher as finisher_node

NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Detailer": SAX_Bridge_Detailer,
    "SAX_Bridge_Detailer_Enhanced": SAX_Bridge_Detailer_Enhanced,
    "SAX_Bridge_Output":          SAX_Bridge_Output,
    "SAX_Bridge_Image_Preview":   SAX_Bridge_Image_Preview,
    "SAX_Bridge_Loader_SAM3":     SAX_Bridge_Loader_SAM3,
    "SAX_Bridge_Segmenter_Multi": SAX_Bridge_Segmenter_Multi,
    "SAX_Bridge_Guidance":        SAX_Bridge_Guidance,
    "SAX_Bridge_Prompt":          prompt_node.SAX_Bridge_Prompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Detailer": "SAX Detailer",
    "SAX_Bridge_Detailer_Enhanced": "SAX Enhanced Detailer",
    "SAX_Bridge_Output":          "SAX Output",
    "SAX_Bridge_Image_Preview":   "SAX Image Preview",
    "SAX_Bridge_Loader_SAM3":     "SAX SAM3 Loader",
    "SAX_Bridge_Segmenter_Multi": "SAX SAM3 Multi Segmenter",
    "SAX_Bridge_Guidance": "SAX Guidance",
    "SAX_Bridge_Prompt": "SAX Prompt",
}

for v3_node in [
    loader_node.SAX_Bridge_Loader,
    loader_node.SAX_Bridge_Loader_Lora,
    pipe_node.SAX_Bridge_Pipe,
    pipe_node.SAX_Bridge_Pipe_Switcher,
    prompt_node.SAX_Bridge_Prompt_Concat,
    sampler_node.SAX_Bridge_KSampler,
    toggle_manager_node.SAX_Bridge_Toggle_Manager,
    node_collector_node.SAX_Bridge_Node_Collector,
    pipe_collector_node.SAX_Bridge_Pipe_Collector,
    image_collector_node.SAX_Bridge_Image_Collector,
    primitive_store_node.SAX_Bridge_Primitive_Store,
    cache_node.SAX_Bridge_Cache,
    finisher_node.SAX_Bridge_Finisher,
    noise_node.SAX_Bridge_Noise_Image,
    noise_node.SAX_Bridge_Noise_Latent,
    upscaler_node.SAX_Bridge_Upscaler,
]:
    _schema = v3_node.GET_SCHEMA()
    NODE_CLASS_MAPPINGS[_schema.node_id] = v3_node
    NODE_DISPLAY_NAME_MAPPINGS[_schema.node_id] = _schema.display_name

WEB_DIRECTORY = "js"
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
