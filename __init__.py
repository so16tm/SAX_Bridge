from .detailer import (
    SAX_Bridge_Detailer,
    SAX_Bridge_Detailer_Enhanced,
)
from .noise import SAX_Bridge_Noise_Image, SAX_Bridge_Noise_Latent
from .upscaler import SAX_Bridge_Pipe_Upscaler
from .pipe_cache import SAX_Bridge_Pipe_Cache
from .output import SAX_Bridge_Output
from .toggle_manager import SAX_Bridge_Toggle_Manager
from .remote_get import SAX_Bridge_Remote_Get

# V3 API ノード
from . import prompt as prompt_node
from . import pipe as pipe_node

NODE_CLASS_MAPPINGS = {
    # Detailer 系列
    "SAX_Bridge_Detailer": SAX_Bridge_Detailer,
    "SAX_Bridge_Detailer_Enhanced": SAX_Bridge_Detailer_Enhanced,

    # Noise 系列
    "SAX_Bridge_Noise_Image": SAX_Bridge_Noise_Image,
    "SAX_Bridge_Noise_Latent": SAX_Bridge_Noise_Latent,

    # Upscaler 系列
    "SAX_Bridge_Pipe_Upscaler": SAX_Bridge_Pipe_Upscaler,

    # Cache 系列
    "SAX_Bridge_Pipe_Cache": SAX_Bridge_Pipe_Cache,

    # Output 系列
    "SAX_Bridge_Output": SAX_Bridge_Output,

    # Control 系列
    "SAX_Bridge_Toggle_Manager": SAX_Bridge_Toggle_Manager,
    "SAX_Bridge_Remote_Get": SAX_Bridge_Remote_Get,

    # Prompt 系列 (Class Implementations)
    "SAX_Bridge_Prompt": prompt_node.SAX_Bridge_Prompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Detailer": "SAX Detailer",
    "SAX_Bridge_Detailer_Enhanced": "SAX Enhanced Detailer",
    "SAX_Bridge_Noise_Image": "SAX Image Noise",
    "SAX_Bridge_Noise_Latent": "SAX Latent Noise",
    "SAX_Bridge_Pipe_Upscaler": "SAX Pipe Upscaler",
    "SAX_Bridge_Pipe_Cache": "SAX Pipe Cache",
    "SAX_Bridge_Output": "SAX Output",
    "SAX_Bridge_Toggle_Manager": "SAX Toggle Manager",
    "SAX_Bridge_Remote_Get": "SAX Remote Get",
    "SAX_Bridge_Prompt": "SAX Prompt",
}

# V3 API ノードの登録 (Loader, Pipe, Prompt Concat)
for v3_node in [
    pipe_node.SAX_Bridge_Pipe_Loader,
    pipe_node.SAX_Bridge_Pipe,
    prompt_node.SAX_Bridge_Prompt_Concat,
]:
    _schema = v3_node.GET_SCHEMA()
    NODE_CLASS_MAPPINGS[_schema.node_id] = v3_node
    NODE_DISPLAY_NAME_MAPPINGS[_schema.node_id] = _schema.display_name

WEB_DIRECTORY = "js"
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
