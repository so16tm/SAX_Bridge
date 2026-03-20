import logging
import os
import sys

logger = logging.getLogger("SAX_Bridge")


def _get_sax_cache():
    """SAX_Cache モジュールへの参照を遅延取得する（循環インポート回避）"""
    try:
        # custom_nodes/ ディレクトリを検索パスに追加
        custom_nodes_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if custom_nodes_dir not in sys.path:
            sys.path.insert(0, custom_nodes_dir)

        from SAX_Cache.cache_deepcache import SAX_Cache_DeepCache
        from SAX_Cache.cache_tgate import SAX_Cache_TGate
        return SAX_Cache_DeepCache, SAX_Cache_TGate
    except ImportError as e:
        raise RuntimeError(
            f"[SAX_Bridge] SAX_Cache not found. Make sure the SAX_Cache custom node is installed. ({e})"
        )


# ---------------------------------------------------------------------------
# SAX_Bridge_Pipe_Cache ノード
# ---------------------------------------------------------------------------
class SAX_Bridge_Pipe_Cache:
    """
    Pipe 内のモデルに DeepCache / TGate をワンタッチ適用するノード。

    SAX Loader → [SAX Pipe Cache] → KSampler / Detailer の順に挿入することで、
    t2i から全 Detailer パスまで一括してキャッシュ高速化を適用できる。

    - DeepCache: UNet の深層ブロックを N ステップに 1 回だけ計算し残りをスキップ。
    - TGate    : cross-attention の出力を前半でキャッシュし後半をスキップ。
    両方を同時に有効にすることも可能。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipe": ("PIPE_LINE",),
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "When False, returns the pipe as-is without applying any cache.",
                    },
                ),
                # --- DeepCache ---
                "deepcache_interval": (
                    "INT",
                    {
                        "default": 3,
                        "min": 1,
                        "max": 10,
                        "tooltip": "1=DeepCache disabled. Runs full computation once every N steps; remaining steps use the cache.",
                    },
                ),
                "deepcache_start_percent": (
                    "FLOAT",
                    {
                        "default": 0.2,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Denoising progress ratio at which DeepCache kicks in. Early steps run normally to preserve quality.",
                    },
                ),
            },
            "optional": {
                # --- TGate ---
                "tgate_enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "When True, also applies TGate (cross-attention caching).",
                    },
                ),
                "tgate_gate_step": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Cache start boundary as a percentage. 0.5 = cache is used from 50% onward.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("PIPE_LINE",)
    RETURN_NAMES = ("PIPE",)
    FUNCTION = "apply"
    CATEGORY = "SAX/Bridge/Cache"
    DESCRIPTION = (
        "Applies DeepCache / TGate to the model in the pipe, accelerating all downstream processing (KSampler, Detailer)."
    )

    def apply(
        self,
        pipe,
        enabled,
        deepcache_interval,
        deepcache_start_percent,
        tgate_enabled=False,
        tgate_gate_step=0.5,
    ):
        if not enabled:
            return (pipe,)

        model = pipe.get("model")
        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")

        SAX_Cache_DeepCache, SAX_Cache_TGate = _get_sax_cache()

        # --- DeepCache 適用 ---
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
                f"[SAX_Bridge] Cache Pipe: DeepCache applied (interval={deepcache_interval}, "
                f"start={deepcache_start_percent:.0%})"
            )

        # --- TGate 適用 ---
        if tgate_enabled:
            model, = SAX_Cache_TGate().apply(
                model=model,
                enabled=True,
                gate_step_percent=tgate_gate_step,
                start_percent=0.0,
                end_percent=1.0,
            )
            logger.info(f"[SAX_Bridge] Cache Pipe: TGate applied (gate_step={tgate_gate_step:.0%})")

        new_pipe = pipe.copy()
        new_pipe["model"] = model
        return (new_pipe,)


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Pipe_Cache": SAX_Bridge_Pipe_Cache,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Pipe_Cache": "SAX Cache",
}
