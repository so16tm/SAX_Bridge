"""
SAX_Bridge_Mask_Adjust ノード。

入力マスクに対して invert（反転）→ grow（拡張/収縮）→ blur（ぼかし）→ threshold（二値化）の
順で後処理を適用する単機能ノード。
"""
from __future__ import annotations

import torch

from comfy_api.latest import io

from .mask_ops import (
    apply_mask_blur,
    apply_mask_grow,
    apply_mask_invert,
    apply_mask_threshold,
)


class SAX_Bridge_Mask_Adjust(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Mask_Adjust",
            display_name="SAX Mask Adjust",
            category="SAX/Bridge/Mask",
            description=(
                "Adjust a mask by growing/shrinking, blurring, and optionally "
                "thresholding. Useful for adapting one segmentation result to "
                "multiple downstream nodes."
            ),
            inputs=[
                io.Mask.Input("mask"),
                io.Boolean.Input(
                    "invert", default=False,
                    tooltip="Invert mask (1 - mask) before grow/blur/threshold.",
                ),
                io.Int.Input(
                    "grow", default=0, min=-256, max=256, step=1,
                    tooltip="Positive: dilate. Negative: erode. Unit: px.",
                ),
                io.Float.Input(
                    "blur", default=0.0, min=0.0, max=64.0, step=0.1,
                    tooltip="Gaussian blur sigma in px. 0 disables.",
                ),
                io.Float.Input(
                    "threshold", default=0.0, min=0.0, max=1.0, step=0.01,
                    tooltip="Binarize after blur. 0 keeps soft mask.",
                ),
            ],
            outputs=[io.Mask.Output()],
        )

    @classmethod
    def execute(
        cls,
        mask: torch.Tensor,
        invert: bool,
        grow: int,
        blur: float,
        threshold: float,
    ) -> io.NodeOutput:
        # invert を先頭に置くことで「保護したい領域が白」というユーザーの直感を
        # 最初に解釈し、以降の grow/blur/threshold は反転後マスクに対して
        # 一貫して「対象領域」として作用させる。
        # 各 apply_* は引数が無効値（invert=False, grow=0, blur<=0, threshold<=0）の
        # 場合に内部で早期リターンするため、ここでの条件分岐は不要。
        m = apply_mask_invert(mask, bool(invert))
        m = apply_mask_grow(m, int(grow))
        m = apply_mask_blur(m, float(blur))
        m = apply_mask_threshold(m, float(threshold))
        return io.NodeOutput(m)
