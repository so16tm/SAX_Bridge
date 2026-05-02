"""
SAX シリーズ共通のマスク操作ユーティリティ。

各関数は (H, W) / (B, H, W) / (B, 1, H, W) のいずれかの float32 マスクを受け、
入力と同じ形状で結果を返す。
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

from .noise import SAXNoiseEngine

# CUDA max_pool2d のカーネルサイズ上限 (2 * step + 1 = 255)
_MAX_POOL_STEP = 127


def _to_b1hw(mask: torch.Tensor) -> tuple[torch.Tensor, int]:
    """マスクを (B, 1, H, W) に正規化し、元の rank を返す。"""
    rank = mask.dim()
    if rank == 2:
        return mask.unsqueeze(0).unsqueeze(0), rank
    if rank == 3:
        return mask.unsqueeze(1), rank
    if rank == 4:
        # MASK は単一チャネル前提。多チャネル画像が誤接続された場合は
        # 後段の squeeze(1) で形状が壊れるため、ここで明示的に弾く。
        if mask.shape[1] != 1:
            raise ValueError(
                f"4D mask must have 1 channel (B, 1, H, W), got C={mask.shape[1]}"
            )
        return mask, rank
    raise ValueError(f"mask must be 2D/3D/4D tensor, got rank={rank}")


def _from_b1hw(mask: torch.Tensor, rank: int) -> torch.Tensor:
    """_to_b1hw で正規化したマスクを元の rank に戻す。"""
    if rank == 2:
        return mask.squeeze(0).squeeze(0)
    if rank == 3:
        return mask.squeeze(1)
    return mask


def apply_mask_invert(mask: torch.Tensor, invert: bool) -> torch.Tensor:
    """
    invert=True なら 1 - mask、False なら入力をそのまま返す。

    mask: float32, 値域 [0, 1] を想定（範囲外は clamp で正規化）
    戻り値: 入力と同じ形状
    """
    if not invert:
        return mask
    return (1.0 - mask).clamp(0.0, 1.0)


def apply_mask_grow(mask: torch.Tensor, grow: int) -> torch.Tensor:
    """
    マスクを grow ピクセル分拡張（正値）または収縮（負値）する。
    セパラブル MaxPool で O(r) に削減し、CUDA カーネルサイズ上限を回避。

    mask: (H, W) / (B, H, W) / (B, 1, H, W) の float32, 値域 [0, 1]
    戻り値: 入力と同じ形状
    """
    if grow == 0:
        return mask

    x, rank = _to_b1hw(mask)
    pad = abs(grow)
    expand = grow > 0

    def apply_steps(t: torch.Tensor, total: int, horizontal: bool) -> torch.Tensor:
        remaining = total
        while remaining > 0:
            step = min(remaining, _MAX_POOL_STEP)
            if horizontal:
                t = F.max_pool2d(t, (1, 2 * step + 1), stride=1, padding=(0, step))
            else:
                t = F.max_pool2d(t, (2 * step + 1, 1), stride=1, padding=(step, 0))
            remaining -= step
        return t

    if not expand:
        x = -x
    x = apply_steps(x, pad, horizontal=True)
    x = apply_steps(x, pad, horizontal=False)
    if not expand:
        x = -x
    x = x.clamp(0.0, 1.0)
    return _from_b1hw(x, rank)


def apply_mask_blur(mask: torch.Tensor, sigma: float) -> torch.Tensor:
    """
    マスクにガウシアンぼかしを適用する。

    mask: (H, W) / (B, H, W) / (B, 1, H, W) の float32, 値域 [0, 1]
    sigma: 標準偏差 (px)。0 以下なら入力をそのまま返す。
    戻り値: 入力と同じ形状（クランプ後）
    """
    if sigma <= 0.0:
        return mask

    x, rank = _to_b1hw(mask)
    x = SAXNoiseEngine.gaussian_blur(x, sigma).clamp(0.0, 1.0)
    return _from_b1hw(x, rank)


def apply_mask_threshold(mask: torch.Tensor, threshold: float) -> torch.Tensor:
    """
    マスクを threshold で二値化する。threshold <= 0 なら入力をそのまま返す。

    mask: 任意形状の float32 テンソル
    戻り値: 入力と同じ形状の float32 テンソル（値は 0.0 / 1.0 のみ）
    """
    if threshold <= 0.0:
        return mask
    return (mask > threshold).to(mask.dtype)
