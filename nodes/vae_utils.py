import logging
from typing import Any

import torch

logger = logging.getLogger("SAX_Bridge")


def decode_image(vae: Any, latent_tensor: torch.Tensor) -> torch.Tensor:
    """VAE decode して 4D IMAGE (B, H, W, C) を返す。

    動画系 VAE の 5 次元出力 (B, T, H, W, C) と nested latent を、
    標準 VAEDecode (nodes.py VAEDecode.decode) と同一ロジックで正規化する。
    値域クランプ (0..1) は行わない。必要なら呼び出し側の責務とする。
    """
    if latent_tensor.is_nested:
        # nested tensor は先頭要素を取り出す（標準 VAEDecode と同一）
        latent_tensor = latent_tensor.unbind()[0]
    images = vae.decode(latent_tensor)
    if images.ndim == 5:
        # 動画系 VAE は (B, T, H, W, C) を返すため、時間軸をバッチへ畳み込む
        logger.debug(
            "[SAX_Bridge] 5D VAE output detected (shape=%s), reshaping to 4D",
            images.shape,
        )
        images = images.reshape(-1, *images.shape[-3:])
    return images
