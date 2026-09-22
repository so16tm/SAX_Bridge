import logging

from comfy_api.latest import io

from .cache_impl import apply_deepcache
from .io_types import PipeLine

logger = logging.getLogger("SAX_Bridge")


class SAX_Bridge_Cache(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Cache",
            display_name="SAX Cache",
            category="SAX/Bridge/Utility",
            description=(
                "Applies DeepCache to the model in the pipe, accelerating all downstream processing "
                "(KSampler, Detailer). UNet models only (SD1.5 / SDXL / Illustrious / Pony); "
                "for DiT models such as FLUX, SD3.5 or Qwen-Image the pipe passes through unchanged."
            ),
            inputs=[
                PipeLine.Input("pipe"),
                io.Boolean.Input("enabled", default=True,
                                 tooltip="When False, returns the pipe as-is without applying any cache."),
                io.Int.Input("deepcache_interval", default=3, min=1, max=10,
                             tooltip="1=DeepCache disabled. Runs full computation once every N steps; remaining steps use the cache."),
                io.Float.Input("deepcache_start_percent", default=0.2, min=0.0, max=1.0, step=0.01,
                               tooltip="Denoising progress ratio at which DeepCache kicks in. Early steps run normally to preserve quality."),
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
    ) -> io.NodeOutput:
        if not enabled:
            return io.NodeOutput(pipe)

        model = pipe.get("model")
        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")

        if deepcache_interval > 1:
            patched = apply_deepcache(
                model=model,
                deepcache_interval=deepcache_interval,
                deepcache_start_ratio=deepcache_start_percent,
                cfg_skip_start_ratio=0.4,
                cfg_skip_multiplier=1,
            )
            # apply_deepcache は適用できない場合に同じ model をそのまま返す。
            # 適用できたかどうかで INFO ログを出し分ける (理由は apply_deepcache 側が WARNING で出す)。
            if patched is model:
                logger.info("[SAX_Bridge] Cache: DeepCache was not applied; the pipe passes through unchanged.")
            else:
                logger.info(
                    f"[SAX_Bridge] Cache: DeepCache applied (interval={deepcache_interval}, "
                    f"start={deepcache_start_percent:.0%})"
                )
            model = patched

        new_pipe = pipe.copy()
        new_pipe["model"] = model
        return io.NodeOutput(new_pipe)
