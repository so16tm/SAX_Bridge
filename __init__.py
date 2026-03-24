from .nodes.detailer import (
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
)
from .nodes.noise import SAX_Bridge_Noise_Image, SAX_Bridge_Noise_Latent
from .nodes.upscaler import SAX_Bridge_Upscaler
from .nodes.cache import SAX_Bridge_Cache
from .nodes.output import SAX_Bridge_Output, SAX_Bridge_Image_Preview
from .nodes.image_collector import SAX_Bridge_Image_Collector
from .nodes.node_collector  import SAX_Bridge_Node_Collector
from .nodes.pipe_collector  import SAX_Bridge_Pipe_Collector
from .nodes.primitive_store import SAX_Bridge_Primitive_Store
from .nodes.toggle_manager  import SAX_Bridge_Toggle_Manager
from .nodes.loader import SAX_Bridge_Loader_Lora
from .nodes.sampler import SAX_Bridge_KSampler
from .nodes.guidance import SAX_Bridge_Guidance
from .nodes.sam3 import SAX_Bridge_Loader_SAM3, SAX_Bridge_Segmenter_Multi

# V3 API ノード
from .nodes import prompt as prompt_node
from .nodes import pipe as pipe_node
from .nodes import loader as loader_node

NODE_CLASS_MAPPINGS = {
    # Detailer 系列
    "SAX_Bridge_Detailer": SAX_Bridge_Detailer,
    "SAX_Bridge_Detailer_Enhanced": SAX_Bridge_Detailer_Enhanced,

    # Noise 系列
    "SAX_Bridge_Noise_Image": SAX_Bridge_Noise_Image,
    "SAX_Bridge_Noise_Latent": SAX_Bridge_Noise_Latent,

    # Upscaler
    "SAX_Bridge_Upscaler": SAX_Bridge_Upscaler,

    # Cache
    "SAX_Bridge_Cache": SAX_Bridge_Cache,

    # Output
    "SAX_Bridge_Output":        SAX_Bridge_Output,
    "SAX_Bridge_Image_Preview": SAX_Bridge_Image_Preview,

    # Collector 系列
    "SAX_Bridge_Image_Collector": SAX_Bridge_Image_Collector,
    "SAX_Bridge_Node_Collector":  SAX_Bridge_Node_Collector,
    "SAX_Bridge_Pipe_Collector":  SAX_Bridge_Pipe_Collector,

    # Loader 系列（旧API）
    "SAX_Bridge_Loader_Lora": SAX_Bridge_Loader_Lora,

    # Utility 系列
    "SAX_Bridge_Primitive_Store": SAX_Bridge_Primitive_Store,
    "SAX_Bridge_Toggle_Manager":  SAX_Bridge_Toggle_Manager,

    # Segment 系列
    "SAX_Bridge_Loader_SAM3":     SAX_Bridge_Loader_SAM3,
    "SAX_Bridge_Segmenter_Multi": SAX_Bridge_Segmenter_Multi,

    # Sampler 系列
    "SAX_Bridge_KSampler": SAX_Bridge_KSampler,

    # Guidance 系列
    "SAX_Bridge_Guidance": SAX_Bridge_Guidance,

    # Prompt 系列 (Class Implementations)
    "SAX_Bridge_Prompt": prompt_node.SAX_Bridge_Prompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Detailer": "SAX Detailer",
    "SAX_Bridge_Detailer_Enhanced": "SAX Enhanced Detailer",
    "SAX_Bridge_Noise_Image": "SAX Image Noise",
    "SAX_Bridge_Noise_Latent": "SAX Latent Noise",
    "SAX_Bridge_Upscaler": "SAX Upscaler",
    "SAX_Bridge_Cache": "SAX Cache",
    "SAX_Bridge_Output":          "SAX Output",
    "SAX_Bridge_Image_Preview":   "SAX Image Preview",
    "SAX_Bridge_Image_Collector": "SAX Image Collector",
    "SAX_Bridge_Node_Collector":  "SAX Node Collector",
    "SAX_Bridge_Pipe_Collector":  "SAX Pipe Collector",
    "SAX_Bridge_Loader_Lora": "SAX Lora Loader",
    "SAX_Bridge_Primitive_Store": "SAX Primitive Store",
    "SAX_Bridge_Toggle_Manager":  "SAX Toggle Manager",
    "SAX_Bridge_Loader_SAM3":     "SAX SAM3 Loader",
    "SAX_Bridge_Segmenter_Multi": "SAX SAM3 Multi Segmenter",
    "SAX_Bridge_KSampler": "SAX KSampler",
    "SAX_Bridge_Guidance": "SAX Guidance",
    "SAX_Bridge_Prompt": "SAX Prompt",
}

# V3 API ノードの登録 (Loader, Pipe, Switch Pipe, Prompt Concat)
for v3_node in [
    loader_node.SAX_Bridge_Loader,
    pipe_node.SAX_Bridge_Pipe,
    pipe_node.SAX_Bridge_Pipe_Switcher,
    prompt_node.SAX_Bridge_Prompt_Concat,
]:
    _schema = v3_node.GET_SCHEMA()
    NODE_CLASS_MAPPINGS[_schema.node_id] = v3_node
    NODE_DISPLAY_NAME_MAPPINGS[_schema.node_id] = _schema.display_name

WEB_DIRECTORY = "js"
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
