from .detailer import (
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
)
from .noise import SAX_Bridge_Noise_Image, SAX_Bridge_Noise_Latent
from .upscaler import SAX_Bridge_Upscaler
from .cache import SAX_Bridge_Cache
from .output import SAX_Bridge_Output, SAX_Bridge_Image_Preview
from .image_collector import SAX_Bridge_Image_Collector
from .toggle_manager import SAX_Bridge_Toggle_Manager
from .remote_get import SAX_Bridge_Remote_Get
from .loader import SAX_Bridge_Loader_Lora
from .sam3 import SAX_Bridge_Loader_SAM3, SAX_Bridge_Segmenter_Multi

# V3 API ノード
from . import prompt as prompt_node
from . import pipe as pipe_node
from . import loader as loader_node

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

    # Collector
    "SAX_Bridge_Image_Collector": SAX_Bridge_Image_Collector,

    # Loader 系列（旧API）
    "SAX_Bridge_Loader_Lora": SAX_Bridge_Loader_Lora,

    # Utility 系列
    "SAX_Bridge_Toggle_Manager": SAX_Bridge_Toggle_Manager,
    "SAX_Bridge_Remote_Get": SAX_Bridge_Remote_Get,

    # Segment 系列
    "SAX_Bridge_Loader_SAM3":     SAX_Bridge_Loader_SAM3,
    "SAX_Bridge_Segmenter_Multi": SAX_Bridge_Segmenter_Multi,

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
    "SAX_Bridge_Loader_Lora": "SAX Lora Loader",
    "SAX_Bridge_Toggle_Manager": "SAX Toggle Manager",
    "SAX_Bridge_Remote_Get": "SAX Remote Get",
    "SAX_Bridge_Loader_SAM3":     "SAX SAM3 Loader",
    "SAX_Bridge_Segmenter_Multi": "SAX SAM3 Multi Segmenter",
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
