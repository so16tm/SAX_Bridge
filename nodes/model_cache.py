"""ローダー系ノード用のプロセス内モデルキャッシュ。

ComfyUI は「ノードの全 widget 値」をキャッシュキーに含めるため、SAX Loader の
ように seed / steps / cfg 等のサンプリング設定を同一ノードに持つローダーは、
seed を変えただけでも execute() が再実行される。その際 comfy.sd.load_checkpoint_guess_config
などがチェックポイントをディスクから読み直し、新しい ModelPatcher（=新しい .model）を
生成するため、既に VRAM 常駐していた重みが別物と判定されて再転送される。

このモジュールは「実際にディスクから重みを読む処理」の結果だけを、それに影響する
入力（ファイル名など）をキーにして保持し、同じ重みなら同じオブジェクトを返す。
サンプリング設定（seed/steps/cfg…）はキーに含めないため、それらを変えても
再ロードが走らない。返すオブジェクトは基底の ModelPatcher / VAE / upscale model で、
呼び出し側の clip_skip / LoRA / v_pred などの後段処理はすべて clone 上で行われる
（ComfyUI の load_lora_for_models・clone がそう実装されている）ため、キャッシュ本体は
変更されない。

キャッシュはファイル更新時刻もキーに含めるので、同名ファイルを差し替えた場合は
自動で読み直す。上限を超えたエントリは LRU で破棄する（強参照が切れるだけで、
VRAM の解放は ComfyUI の model_management に委ねる）。
"""

import logging
import os
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import Any

logger = logging.getLogger("SAX_Bridge")

# 各キャッシュが保持する最大エントリ数。イテレーション運用で直近数モデルを
# 切り替えても再ロードが起きない程度に小さく保つ。
_MAX_ENTRIES = 3


def file_token(path: Any) -> float | None:
    """ファイルの更新時刻を返す。取得できない場合は None（テスト等でパスが未解決の場合）。

    キーに含めることで、同名ファイルを差し替えたときに自動で読み直させる。
    """
    if not path:
        return None
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


class _LRUCache:
    """名前付き LRU キャッシュ。キー→ロード済みオブジェクト。"""

    def __init__(self, name: str, max_entries: int = _MAX_ENTRIES) -> None:
        self._name = name
        self._max = max_entries
        self._store: OrderedDict[Hashable, Any] = OrderedDict()

    def get_or_load(self, key: Hashable, loader: Callable[[], Any]) -> Any:
        """key に対応する値を返す。無ければ loader() を呼んで格納する。"""
        if key in self._store:
            self._store.move_to_end(key)
            logger.debug("[SAX_Bridge] model cache hit (%s): %r", self._name, key)
            return self._store[key]

        value = loader()
        self._store[key] = value
        self._store.move_to_end(key)
        logger.debug("[SAX_Bridge] model cache load (%s): %r", self._name, key)

        while len(self._store) > self._max:
            evicted_key, _ = self._store.popitem(last=False)
            logger.debug("[SAX_Bridge] model cache evict (%s): %r", self._name, evicted_key)

        return value

    def clear(self) -> None:
        self._store.clear()

    def __len__(self) -> int:  # テスト・デバッグ用
        return len(self._store)


# ローダー系ノードが共有するキャッシュ。
checkpoint_cache = _LRUCache("checkpoint")
diffusion_model_cache = _LRUCache("diffusion_model")
clip_cache = _LRUCache("clip")
vae_cache = _LRUCache("vae")
upscale_model_cache = _LRUCache("upscale_model")

_ALL_CACHES = (
    checkpoint_cache,
    diffusion_model_cache,
    clip_cache,
    vae_cache,
    upscale_model_cache,
)


def clear_all() -> None:
    """全キャッシュを破棄する（テストのアイソレーションや手動リセット用）。"""
    for cache in _ALL_CACHES:
        cache.clear()
