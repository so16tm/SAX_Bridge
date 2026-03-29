import logging

import torch
import torch.nn.functional as F

from comfy_api.latest import io

from .io_types import AnyType

logger = logging.getLogger("SAX_Bridge")

MAX_SLOTS        = 64
MAX_OUTPUT_IMAGES = 100


def _normalize_channels(frame: torch.Tensor) -> torch.Tensor:
    """[1, H, W, C] → [1, H, W, 3] (RGB) に正規化する。"""
    c = frame.shape[-1]
    if c == 3:
        return frame
    if c == 4:
        return frame[..., :3]          # RGBA → RGB
    if c == 1:
        return frame.expand(-1, -1, -1, 3)  # グレースケール → RGB
    return frame[..., :3]              # その他: 先頭3ch を使用


def _resize_letterbox(frame: torch.Tensor, target_h: int, target_w: int) -> torch.Tensor:
    """
    frame: [1, H, W, 3] float32 → [1, target_h, target_w, 3]

    アスペクト比を維持して bilinear リサイズし、
    余白は黒で埋める（letterbox / pillarbox）。
    基準サイズは最初に接続された IMAGE のサイズを使用する。
    変更する場合はこの関数のみを修正すればよい。
    """
    _, h, w, _ = frame.shape
    if h == target_h and w == target_w:
        return frame

    x = frame.permute(0, 3, 1, 2)          # BHWC → BCHW

    scale = min(target_w / w, target_h / h)
    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))

    x = F.interpolate(x, size=(new_h, new_w), mode="bilinear", align_corners=False)

    pad_top    = (target_h - new_h) // 2
    pad_bottom = target_h - new_h - pad_top
    pad_left   = (target_w - new_w) // 2
    pad_right  = target_w - new_w - pad_left

    if any(p > 0 for p in (pad_top, pad_bottom, pad_left, pad_right)):
        x = F.pad(x, (pad_left, pad_right, pad_top, pad_bottom), value=0.0)

    return x.permute(0, 2, 3, 1)           # BCHW → BHWC


class SAX_Bridge_Image_Collector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Image_Collector",
            display_name="SAX Image Collector",
            category="SAX/Bridge/Collect",
            description=(
                "Collects IMAGE outputs from registered source nodes and concatenates them "
                "into a single batch. Connect to SAX Image Preview to display all images at once."
            ),
            inputs=[
                AnyType.Input(f"slot_{i}", optional=True)
                for i in range(MAX_SLOTS)
            ],
            outputs=[
                io.Image.Output("images"),
            ],
        )

    @classmethod
    def execute(cls, **kwargs) -> io.NodeOutput:
        frames: list[torch.Tensor] = []
        ref_h: int | None = None
        ref_w: int | None = None

        for i in range(MAX_SLOTS):
            val = kwargs.get(f"slot_{i}")
            if val is None:
                continue
            if not isinstance(val, torch.Tensor) or val.ndim != 4:
                logger.debug(f"[SAX_Bridge] Collector: slot_{i} は 4D テンソルではないためスキップ")
                continue
            _, h, w, c = val.shape
            if c not in (1, 3, 4):
                logger.debug(f"[SAX_Bridge] Collector: slot_{i} のチャンネル数 ({c}) が想定外のためスキップ")
                continue

            if ref_h is None:
                ref_h, ref_w = h, w

            for bi in range(val.shape[0]):
                frames.append(val[bi : bi + 1].cpu())   # [1, H, W, C]

        if not frames:
            return io.NodeOutput(torch.zeros(1, 8, 8, 3, dtype=torch.float32))

        total = len(frames)
        if total > MAX_OUTPUT_IMAGES:
            logger.warning(
                f"[SAX_Bridge] Collector: 収集枚数 {total} が上限 {MAX_OUTPUT_IMAGES} を超えました。"
                " ソース数またはバッチサイズを減らしてください。"
            )
            frames = frames[:MAX_OUTPUT_IMAGES]

        normalized = [_normalize_channels(f) for f in frames]
        resized    = [_resize_letterbox(f, ref_h, ref_w) for f in normalized]
        result     = torch.cat(resized, dim=0)   # [N, ref_h, ref_w, 3]
        return io.NodeOutput(result)
