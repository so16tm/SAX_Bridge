"""latent 空間テンソルの次元ユーティリティ。

動画モデル (Wan 等) の latent は (B, C, T, H, W) の5次元になる。静止画 latent
(B, C, H, W) 前提の空間処理を、時間軸を持つ場合でも壊れないように正規化する。
VAE には依存しない純粋なテンソル形状操作のみを置く。
"""
from typing import Callable

import torch


def apply_spatial_4d(
    x: torch.Tensor, fn_4d: Callable[[torch.Tensor], torch.Tensor]
) -> torch.Tensor:
    """4次元専用の空間処理 fn_4d を 4D/5D latent に適用する。

    5次元 (B, C, T, H, W) は時間軸をバッチへ畳んでフレーム単位に処理し、
    元の次元へ戻す。fn_4d は (N, C, H, W) を受け取り (N, C', H', W') を返す。
    fn_4d は空間サイズ H, W を変えてはならない（C は変えてよい）。
    """
    if x.ndim == 5:
        b, c, t, h, w = x.shape
        # permute 後は非連続。reshape の暗黙コピーを明示し VRAM 挙動を予測可能にする
        x4 = x.permute(0, 2, 1, 3, 4).contiguous().reshape(b * t, c, h, w)
        y4 = fn_4d(x4)
        return y4.reshape(b, t, *y4.shape[1:]).permute(0, 2, 1, 3, 4).contiguous()
    return fn_4d(x)


def insert_temporal_if_5d(mask_bchw: torch.Tensor, latent: torch.Tensor) -> torch.Tensor:
    """(B, C, H, W) マスクを、latent が5次元なら時間軸 singleton を挿入して
    (B, C, 1, H, W) にする。latent が4次元ならそのまま返す。"""
    if latent.ndim == 5:
        return mask_bchw.unsqueeze(2)
    return mask_bchw


def broadcast_mask_to_latent(mask_bhw: torch.Tensor, latent: torch.Tensor) -> torch.Tensor:
    """(B, H, W) 空間マスクを latent(4D/5D) にブロードキャスト可能な形へ整える。

    4D latent: (B, 1, H, W) / 5D latent: (B, 1, 1, H, W)。
    """
    return insert_temporal_if_5d(mask_bhw.unsqueeze(1), latent)
