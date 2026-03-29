import logging
import os
import sys

from comfy_api.latest import io

from .io_types import PipeLine

logger = logging.getLogger("SAX_Bridge")


def _get_sax_cache():
    """SAX_Cache モジュールへの参照を遅延取得する。未インストール時は None を返す。"""
    try:
        custom_nodes_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if custom_nodes_dir not in sys.path:
            sys.path.insert(0, custom_nodes_dir)

        from SAX_Cache.cache_deepcache import SAX_Cache_DeepCache
        from SAX_Cache.cache_tgate import SAX_Cache_TGate
        return SAX_Cache_DeepCache, SAX_Cache_TGate
    except ImportError:
        return None, None


class SAX_Bridge_Cache(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Cache",
            display_name="SAX Cache",
            category="SAX/Bridge/Utility",
            description="Applies DeepCache / TGate to the model in the pipe, accelerating all downstream processing (KSampler, Detailer).",
            inputs=[
                PipeLine.Input("pipe"),
                io.Boolean.Input("enabled", default=True,
                                 tooltip="When False, returns the pipe as-is without applying any cache."),
                io.Int.Input("deepcache_interval", default=3, min=1, max=10,
                             tooltip="1=DeepCache disabled. Runs full computation once every N steps; remaining steps use the cache."),
                io.Float.Input("deepcache_start_percent", default=0.2, min=0.0, max=1.0, step=0.01,
                               tooltip="Denoising progress ratio at which DeepCache kicks in. Early steps run normally to preserve quality."),
                io.Boolean.Input("tgate_enabled", default=False, optional=True,
                                 tooltip="When True, also applies TGate (cross-attention caching)."),
                io.Float.Input("tgate_gate_step", default=0.5, min=0.0, max=1.0, step=0.01, optional=True,
                               tooltip="Cache start boundary as a percentage. 0.5 = cache is used from 50% onward."),
            ],
            outputs=[
                PipeLine.Output("PIPE"),
            ],
        )

    @classmethod
    def execute(
        cls,
        pipe,
        enabled,
        deepcache_interval,
        deepcache_start_percent,
        tgate_enabled=False,
        tgate_gate_step=0.5,
    ) -> io.NodeOutput:
        if not enabled:
            return io.NodeOutput(pipe)

        model = pipe.get("model")
        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")

        SAX_Cache_DeepCache, SAX_Cache_TGate = _get_sax_cache()
        if SAX_Cache_DeepCache is None:
            logger.warning("[SAX_Bridge] Cache: SAX_Cache is not installed. Skipping cache application.")
            return io.NodeOutput(pipe)

        if deepcache_interval > 1:
            model, = SAX_Cache_DeepCache().apply(
                model=model,
                enabled=True,
                deepcache_interval=deepcache_interval,
                deepcache_start_ratio=deepcache_start_percent,
                cfg_skip_start_ratio=0.4,
                cfg_skip_multiplier=1,
            )
            logger.info(
                f"[SAX_Bridge] Cache: DeepCache applied (interval={deepcache_interval}, "
                f"start={deepcache_start_percent:.0%})"
            )

        if tgate_enabled:
            model, = SAX_Cache_TGate().apply(
                model=model,
                enabled=True,
                gate_step_percent=tgate_gate_step,
                start_percent=0.0,
                end_percent=1.0,
            )
            logger.info(f"[SAX_Bridge] Cache: TGate applied (gate_step={tgate_gate_step:.0%})")

        new_pipe = pipe.copy()
        new_pipe["model"] = model
        return io.NodeOutput(new_pipe)
