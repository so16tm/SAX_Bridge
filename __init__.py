from .nodes import debug as debug_node
from .nodes import detailer as detailer_node
from .nodes import output as output_node
from .nodes import toggle_manager as toggle_manager_node
from .nodes import node_collector as node_collector_node
from .nodes import pipe_collector as pipe_collector_node
from .nodes import image_collector as image_collector_node
from .nodes import primitive_store as primitive_store_node
from .nodes import text_catalog as text_catalog_node
from .nodes import guidance as guidance_node
from .nodes import sam3 as sam3_node
from .nodes import debug_log as debug_log_module
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

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

for v3_node in [
    # Collect
    image_collector_node.SAX_Bridge_Image_Collector,
    node_collector_node.SAX_Bridge_Node_Collector,
    pipe_collector_node.SAX_Bridge_Pipe_Collector,
    # Debug
    debug_node.SAX_Bridge_Assert,
    debug_node.SAX_Bridge_Assert_Pipe,
    debug_node.SAX_Bridge_Debug_Controller,
    debug_node.SAX_Bridge_Debug_Inspector,
    debug_node.SAX_Bridge_Debug_Text,
    # Enhance
    detailer_node.SAX_Bridge_Detailer,
    detailer_node.SAX_Bridge_Detailer_Enhanced,
    finisher_node.SAX_Bridge_Finisher,
    guidance_node.SAX_Bridge_Guidance,
    upscaler_node.SAX_Bridge_Upscaler,
    # Loader
    loader_node.SAX_Bridge_Loader,
    loader_node.SAX_Bridge_Loader_Lora,
    # Option
    noise_node.SAX_Bridge_Noise_Image,
    noise_node.SAX_Bridge_Noise_Latent,
    # Output
    output_node.SAX_Bridge_Image_Preview,
    output_node.SAX_Bridge_Output,
    # Pipe
    pipe_node.SAX_Bridge_Pipe,
    pipe_node.SAX_Bridge_Pipe_Switcher,
    # Prompt
    prompt_node.SAX_Bridge_Prompt,
    prompt_node.SAX_Bridge_Prompt_Concat,
    # Sampler
    sampler_node.SAX_Bridge_KSampler,
    # Segment
    sam3_node.SAX_Bridge_Loader_SAM3,
    sam3_node.SAX_Bridge_Segmenter_Multi,
    # Utility
    cache_node.SAX_Bridge_Cache,
    primitive_store_node.SAX_Bridge_Primitive_Store,
    text_catalog_node.SAX_Bridge_Text_Catalog,
    toggle_manager_node.SAX_Bridge_Toggle_Manager,
]:
    _schema = v3_node.GET_SCHEMA()
    NODE_CLASS_MAPPINGS[_schema.node_id] = v3_node
    NODE_DISPLAY_NAME_MAPPINGS[_schema.node_id] = _schema.display_name

# デバッグログ基盤: 全ノードの execute をラップ（実行時のフラグで ON/OFF 制御）
for node_cls in NODE_CLASS_MAPPINGS.values():
    try:
        original = node_cls.execute.__func__
        wrapped = debug_log_module.wrap_execute(original, node_cls)
        node_cls.execute = classmethod(wrapped)
    except Exception as exc:
        import logging
        logging.getLogger("SAX_Bridge").warning(
            "debug_log: failed to wrap %s: %s", node_cls, exc
        )

# ComfyUI の prompt lifecycle に flush フックを登録する（ワークフロー完了時に発火）
debug_log_module.register_lifecycle_hook()

WEB_DIRECTORY = "js"
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
