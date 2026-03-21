"""
SAX_Bridge SAM3 統合モジュール

・SAX_Bridge_Loader_SAM3  : SAM3モデルのロード（VRAM管理統合）
・SAX_Bridge_Segmenter_Multi : テキストプロンプト複数エントリーによるセグメンテーション

SAX_SAM3 リポジトリの実装を SAX_Bridge へ統合したもの。
VRAM管理は ComfyUI ModelPatcher 経由で行い、モデルの共有を可能にする。
"""

import gc
import json
import logging
import os
from typing import Dict

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import comfy.model_management
from comfy.model_patcher import ModelPatcher

logger = logging.getLogger("SAX_Bridge")

# ── folder_paths 登録 ─────────────────────────────────────────────────────────
try:
    import folder_paths

    _sam3_model_dir = os.path.join(folder_paths.models_dir, "sam3")
    os.makedirs(_sam3_model_dir, exist_ok=True)
    folder_paths.add_model_folder_path("sam3", _sam3_model_dir)
except ImportError:
    folder_paths = None


# ═════════════════════════════════════════════════════════════════════════════
# SAM3ModelWrapper — ComfyUI VRAM管理統合
# ═════════════════════════════════════════════════════════════════════════════

class SAM3ModelWrapper(ModelPatcher):
    """
    SAM3モデルをComfyUIのVRAM管理に統合するラッパー。
    load_models_gpu() に渡すことで、必要時にGPUへロードし、
    他モデルがVRAMを必要とする際に自動的にCPUへ退避される。
    """

    def __init__(self, model, processor, load_device, offload_device, dtype):
        self._processor = processor
        self._dtype = dtype
        self._load_device = load_device
        self._offload_device = offload_device
        model_size = comfy.model_management.module_size(model)

        super().__init__(
            model,
            load_device=load_device,
            offload_device=offload_device,
            size=model_size,
        )

    @property
    def processor(self):
        return self._processor

    @property
    def current_device(self):
        try:
            return next(self.model.parameters()).device
        except StopIteration:
            return self._offload_device

    def patch_model(self, device_to=None, lowvram_model_memory=0,
                    load_weights=True, force_patch_weights=False):
        if device_to is None:
            device_to = self._load_device
        self.model.to(device_to)
        self._sync_processor(device_to)
        return self.model

    def unpatch_model(self, device_to=None, unpatch_weights=True):
        if device_to is None:
            device_to = self._offload_device
        self.model.to(device_to)
        self._sync_processor(device_to)
        gc.collect()
        comfy.model_management.soft_empty_cache()

    def clone(self):
        n = SAM3ModelWrapper(
            self.model, self._processor,
            self._load_device, self._offload_device,
            self._dtype,
        )
        n.patches = {}
        n.object_patches = {}
        n.model_options = {"transformer_options": {}}
        return n

    def model_size(self):
        return comfy.model_management.module_size(self.model)

    def memory_required(self, input_shape=None):
        base = self.model_size()
        activation_estimate = 1008 * 1008 * 256 * 4 * 8
        return base + activation_estimate

    def model_patches_to(self, device):
        pass

    def model_patches_models(self):
        return []

    def current_loaded_device(self):
        return self.current_device

    def loaded_size(self):
        device = self.current_device
        if device is not None and device.type != "cpu":
            return self.model_size()
        return 0

    def partially_load(self, device_to, extra_memory=0, force_patch_weights=False):
        self.patch_model(device_to)
        return self.model_size()

    def partially_unload(self, device_to, memory_to_free=0, force_patch_weights=False):
        self.unpatch_model(device_to)
        return self.model_size()

    def cleanup(self):
        self.unpatch_model()
        super().cleanup()

    def _sync_processor(self, device):
        if hasattr(self._processor, "device"):
            self._processor.device = str(device)
        fs = getattr(self._processor, "find_stage", None)
        if fs is not None:
            for attr in ["img_ids", "text_ids", "input_boxes",
                          "input_boxes_label", "input_points"]:
                val = getattr(fs, attr, None)
                if isinstance(val, torch.Tensor):
                    setattr(fs, attr, val.to(device=device))


# ═════════════════════════════════════════════════════════════════════════════
# CustomSam3Processor — presence_weight 可変スコアリング版
# ═════════════════════════════════════════════════════════════════════════════

try:
    from sam3.model.sam3_image_processor import Sam3Processor
    from sam3.model import box_ops
    from sam3.model.data_misc import interpolate
    _SAM3_AVAILABLE = True
except ImportError:
    _SAM3_AVAILABLE = False
    Sam3Processor = object


class CustomSam3Processor(Sam3Processor):
    """
    公式 Sam3Processor を継承し、_forward_grounding のスコア計算を変更。
    presence_weight パラメータで presence_score の影響度を連続制御する。
      0.0 = presence_score 無視（広い検出）
      1.0 = presence_score フル適用（高精度）
      0.5 = 中間（推奨デフォルト）
    """

    def __init__(self, model, presence_weight=0.5, **kwargs):
        super().__init__(model, **kwargs)
        self.presence_weight = presence_weight

    @torch.inference_mode()
    def _forward_grounding(self, state: Dict):
        target_dtype = next(self.model.parameters()).dtype

        def cast_recursive(obj):
            if isinstance(obj, torch.Tensor) and torch.is_floating_point(obj):
                return obj.to(dtype=target_dtype)
            elif isinstance(obj, dict):
                for k, v in obj.items():
                    obj[k] = cast_recursive(v)
            elif isinstance(obj, list):
                for i in range(len(obj)):
                    obj[i] = cast_recursive(obj[i])
            return obj

        state = cast_recursive(state)

        gp = state.get("geometric_prompt", None)
        if gp is not None:
            for attr in ["box_embeddings", "point_embeddings", "mask_embeddings"]:
                val = getattr(gp, attr, None)
                if isinstance(val, torch.Tensor) and torch.is_floating_point(val):
                    setattr(gp, attr, val.to(dtype=target_dtype))

        outputs = self.model.forward_grounding(
            backbone_out=state["backbone_out"],
            find_input=self.find_stage,
            geometric_prompt=state["geometric_prompt"],
            find_target=None,
        )

        out_bbox   = outputs["pred_boxes"]
        out_logits = outputs["pred_logits"]
        out_masks  = outputs["pred_masks"]

        out_probs = out_logits.sigmoid()
        if self.presence_weight > 0.0:
            presence_score = outputs["presence_logit_dec"].sigmoid().unsqueeze(1)
            out_probs = out_probs * presence_score.pow(self.presence_weight)
        out_probs = out_probs.squeeze(-1)

        keep      = out_probs > self.confidence_threshold
        out_probs = out_probs[keep]
        out_masks = out_masks[keep]
        out_bbox  = out_bbox[keep]

        boxes = box_ops.box_cxcywh_to_xyxy(out_bbox)

        img_h = state["original_height"]
        img_w = state["original_width"]
        scale_fct = torch.tensor(
            [img_w, img_h, img_w, img_h], device=boxes.device, dtype=boxes.dtype
        )
        boxes = boxes * scale_fct[None, :]

        out_masks = interpolate(
            out_masks.unsqueeze(1),
            (img_h, img_w),
            mode="bilinear",
            align_corners=False,
        ).sigmoid()

        state["masks_logits"] = out_masks
        state["masks"]  = out_masks > 0.5
        state["boxes"]  = boxes
        state["scores"] = out_probs
        return state


# ═════════════════════════════════════════════════════════════════════════════
# 内部ユーティリティ
# ═════════════════════════════════════════════════════════════════════════════

_MAX_POOL_STEP = 127  # CUDA max_pool2d のカーネルサイズ上限 (2*127+1=255)


def _apply_mask_grow(mask: torch.Tensor, grow: int) -> torch.Tensor:
    """
    マスクを grow ピクセル分拡張（正値）または縮小（負値）する。
    セパラブル MaxPool で O(r) に削減し、CUDA カーネルサイズ上限を回避。

    mask: [H, W] float32, 値域 [0, 1]
    """
    if grow == 0:
        return mask

    pad  = abs(grow)
    expand = grow > 0

    def apply_steps(x: torch.Tensor, total: int, horizontal: bool) -> torch.Tensor:
        remaining = total
        while remaining > 0:
            step = min(remaining, _MAX_POOL_STEP)
            if horizontal:
                x = F.max_pool2d(x, (1, 2 * step + 1), stride=1, padding=(0, step))
            else:
                x = F.max_pool2d(x, (2 * step + 1, 1), stride=1, padding=(step, 0))
            remaining -= step
        return x

    x = mask.unsqueeze(0).unsqueeze(0)   # [1, 1, H, W]
    if not expand:
        x = -x
    x = apply_steps(x, pad, horizontal=True)
    x = apply_steps(x, pad, horizontal=False)
    if not expand:
        x = -x
    return x.squeeze(0).squeeze(0).clamp(0.0, 1.0)


def _segment_single(processor, pil_image: Image.Image, prompt: str,
                    threshold: float, presence_weight: float,
                    device, target_dtype) -> torch.Tensor:
    """
    1枚の PIL 画像に対してセグメンテーションを実行し、
    OR 結合した [H, W] float32 マスクを返す（検出なし → ゼロマスク）。
    """
    processor.confidence_threshold = threshold
    processor.presence_weight       = presence_weight

    device_type  = "cuda" if device.type == "cuda" else "cpu"
    use_autocast = (target_dtype != torch.float32)

    with torch.amp.autocast(device_type=device_type, enabled=use_autocast, dtype=target_dtype):
        state = processor.set_image(pil_image)
        state = processor.set_text_prompt(prompt, state)

    masks = state.get("masks", None)
    if masks is None or len(masks) == 0:
        img_h = pil_image.height
        img_w = pil_image.width
        return torch.zeros(img_h, img_w, device=device)

    mask_tensors = masks.squeeze(1).float()   # [N, H, W]
    return mask_tensors.max(dim=0)[0]          # [H, W]


# ═════════════════════════════════════════════════════════════════════════════
# SAX_Bridge_Loader_SAM3 — モデルロードノード
# ═════════════════════════════════════════════════════════════════════════════

class SAX_Bridge_Loader_SAM3:
    """
    SAM3モデルをロードし、ComfyUIのVRAM管理下に配置する。
    models/sam3/ ディレクトリ内のチェックポイントを選択可能。
    precision 設定で VRAM 使用量を制御。
    """

    @classmethod
    def INPUT_TYPES(cls):
        model_list = []
        if folder_paths is not None:
            model_list = folder_paths.get_filename_list("sam3")
        return {
            "required": {
                "model_name": (
                    model_list,
                    {"tooltip": "Checkpoint file in models/sam3/."},
                ),
                "precision": (
                    ["fp32", "bf16", "fp16", "auto"],
                    {
                        "default": "fp32",
                        "tooltip": (
                            "Model precision. "
                            "fp32: highest quality (recommended). "
                            "bf16: reduced VRAM (Ampere+). "
                            "fp16: reduced VRAM (Volta+). "
                            "auto: select best for GPU."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES  = ("CSAM3_MODEL",)
    RETURN_NAMES  = ("SAM3_MODEL",)
    FUNCTION      = "load_model"
    CATEGORY      = "SAX/Bridge/Segment"
    DESCRIPTION   = "SAM3モデルをロードして ComfyUI の VRAM 管理下に配置する。"

    def load_model(self, model_name: str, precision: str = "fp32"):
        if not _SAM3_AVAILABLE:
            raise RuntimeError(
                "[SAX_Bridge] sam3 package is not installed. "
                "Please install it: pip install sam3"
            )

        from sam3.model_builder import build_sam3_image_model

        checkpoint_path = folder_paths.get_full_path("sam3", model_name)
        load_device    = comfy.model_management.get_torch_device()
        offload_device = comfy.model_management.unet_offload_device()

        if precision == "auto":
            if comfy.model_management.should_use_bf16(load_device):
                dtype = torch.bfloat16
            elif comfy.model_management.should_use_fp16(load_device):
                dtype = torch.float16
            else:
                dtype = torch.float32
        elif precision == "bf16":
            dtype = torch.bfloat16
        elif precision == "fp16":
            dtype = torch.float16
        else:
            dtype = torch.float32

        logger.info(f"[SAX_Bridge] SAM3 loading: {model_name} (precision={precision} → {dtype})")

        model = build_sam3_image_model(
            checkpoint_path=checkpoint_path,
            device="cpu",
            eval_mode=True,
            load_from_HF=False,
            enable_segmentation=True,
            enable_inst_interactivity=False,
        )

        if dtype != torch.float32:
            for param in model.parameters():
                if torch.is_floating_point(param):
                    param.data = param.data.to(dtype=dtype)
            for buf in model.buffers():
                if torch.is_floating_point(buf):
                    buf.data = buf.data.to(dtype=dtype)

            def _type_cast_hook(mod, args):
                try:
                    p = next(mod.parameters(), next(mod.buffers(), None))
                    if p is None or not torch.is_floating_point(p):
                        return args
                    td = p.dtype
                except StopIteration:
                    return args
                new_args = []
                changed  = False
                for a in args:
                    if isinstance(a, torch.Tensor) and torch.is_floating_point(a) and a.dtype != td:
                        new_args.append(a.to(dtype=td, non_blocking=True))
                        changed = True
                    else:
                        new_args.append(a)
                return tuple(new_args) if changed else args

            for _, module in model.named_modules():
                if any(True for _ in module.parameters(recurse=False)):
                    module.register_forward_pre_hook(_type_cast_hook)

        processor = CustomSam3Processor(
            model=model,
            device=str(load_device),
            confidence_threshold=0.2,
            presence_weight=0.5,
        )

        wrapper = SAM3ModelWrapper(
            model=model,
            processor=processor,
            load_device=load_device,
            offload_device=offload_device,
            dtype=dtype,
        )

        size_mb = wrapper.model_size() / 1024 / 1024
        logger.info(f"[SAX_Bridge] SAM3 loaded ({size_mb:.1f} MB, dtype={dtype})")

        return (wrapper,)


# ═════════════════════════════════════════════════════════════════════════════
# SAX_Bridge_Segmenter_Multi — 複数エントリーセグメンテーションノード
# ═════════════════════════════════════════════════════════════════════════════

_DEFAULT_SEGMENTS = json.dumps([
    {
        "on": True,
        "mode": "positive",
        "prompt": "person",
        "threshold": 0.2,
        "presence_weight": 0.5,
        "mask_grow": 0,
    }
])


class SAX_Bridge_Segmenter_Multi:
    """
    複数のテキストプロンプトエントリーでセグメンテーションを行い、
    positive OR − negative OR でマスクを合成して出力する。

    入力:
      sam3_model  : SAX_Bridge_Loader_SAM3 から接続
      pipe        : PIPE_LINE（任意）
      image       : IMAGE（任意、pipe より優先）
      mask        : MASK（任意、最終マスクを制限する ROI）

    pipe と image は片方が必須。image が優先。

    セグメントエントリー（segments_json）の各フィールド:
      on              : bool — エントリーの有効フラグ
      mode            : "positive" | "negative"
      prompt          : str  — テキストプロンプト
      threshold       : float [0, 1]
      presence_weight : float [0, 1]
      mask_grow       : int [-512, 512]
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "segments_json": (
                    "STRING",
                    {
                        "default": _DEFAULT_SEGMENTS,
                        "multiline": False,
                        "tooltip": "セグメントエントリーデータ（JSON）。JS が管理するため直接編集不要。",
                    },
                ),
            },
            "optional": {
                "pipe":       ("PIPE_LINE",),
                "image":      ("IMAGE",),
                "mask":       ("MASK",),
                "sam3_model": (
                    "CSAM3_MODEL",
                    {"tooltip": "Connect from SAX SAM3 Loader."},
                ),
            },
        }

    RETURN_TYPES  = ("PIPE_LINE", "MASK")
    RETURN_NAMES  = ("PIPE",      "MASK")
    FUNCTION      = "segment"
    CATEGORY      = "SAX/Bridge/Segment"
    OUTPUT_NODE   = False
    DESCRIPTION   = (
        "複数テキストプロンプトによる SAM3 セグメンテーション。"
        "positive OR − negative OR でマスクを合成して出力する。"
    )

    def segment(
        self,
        segments_json: str,
        pipe=None,
        image=None,
        mask=None,
        sam3_model=None,
    ):
        if sam3_model is None:
            raise ValueError(
                "[SAX_Bridge] sam3_model is required. Connect from SAX SAM3 Loader."
            )
        if not _SAM3_AVAILABLE:
            raise RuntimeError(
                "[SAX_Bridge] sam3 package is not installed. "
                "Please install it: pip install sam3"
            )

        # ── 画像ソースの解決（image 優先） ──────────────────────────────────
        if image is not None:
            images = image
        elif pipe is not None:
            images = pipe.get("images")
            if images is None:
                raise ValueError(
                    "[SAX_Bridge] Pipe does not contain images. "
                    "Run Loader → KSampler → VAEDecode first."
                )
        else:
            raise ValueError(
                "[SAX_Bridge] Either 'image' or 'pipe' must be provided."
            )

        # ── セグメントエントリーのパース ────────────────────────────────────
        try:
            segments = json.loads(segments_json)
            if not isinstance(segments, list):
                segments = []
        except (json.JSONDecodeError, ValueError):
            segments = []

        enabled = [s for s in segments if s.get("on", True)]

        img_h, img_w = images.shape[1], images.shape[2]

        # 有効エントリーなし → ゼロマスク出力
        if not enabled:
            logger.info("[SAX_Bridge] Segmenter: no enabled entries, returning zero mask")
            empty = torch.zeros(images.shape[0], img_h, img_w)
            out_pipe = pipe.copy() if pipe is not None else {}
            return (out_pipe, empty)

        # ── モデルを GPU にロード ───────────────────────────────────────────
        comfy.model_management.load_models_gpu([sam3_model])
        processor    = sam3_model.processor
        device       = sam3_model.current_device
        target_dtype = sam3_model._dtype

        batch_size   = images.shape[0]
        batch_masks  = []

        for b in range(batch_size):
            img_np    = (images[b].cpu().numpy() * 255).astype(np.uint8)
            pil_image = Image.fromarray(img_np)

            positive_list = []
            negative_list = []

            for seg in enabled:
                prompt          = seg.get("prompt", "")
                threshold       = float(seg.get("threshold", 0.2))
                presence_weight = float(seg.get("presence_weight", 0.5))
                grow            = int(seg.get("mask_grow", 0))
                mode            = seg.get("mode", "positive")

                if not prompt.strip():
                    continue

                seg_mask = _segment_single(
                    processor, pil_image, prompt,
                    threshold, presence_weight,
                    device, target_dtype,
                )
                logger.info(
                    f"[SAX_Bridge] Segmenter [{b+1}/{batch_size}] "
                    f"'{prompt}' mode={mode} thr={threshold} pw={presence_weight}: "
                    f"coverage={seg_mask.sum().item():.0f}px"
                )

                if grow != 0:
                    seg_mask = _apply_mask_grow(seg_mask, grow)

                if mode == "negative":
                    negative_list.append(seg_mask)
                else:
                    positive_list.append(seg_mask)

            # positive OR 合成
            if positive_list:
                pos = torch.stack(positive_list).max(dim=0)[0]
            else:
                pos = torch.zeros(img_h, img_w, device=device)

            # negative OR 合成 → subtract
            if negative_list:
                neg   = torch.stack(negative_list).max(dim=0)[0]
                final = (pos - neg).clamp(0.0, 1.0)
            else:
                final = pos

            batch_masks.append(final)

        # [B, H, W]
        result_mask = torch.stack(batch_masks).cpu()

        # ── 入力 mask による ROI 制限 ───────────────────────────────────────
        if mask is not None:
            m = mask
            # バッチ次元を合わせる
            if m.shape[0] == 1 and result_mask.shape[0] > 1:
                m = m.expand(result_mask.shape[0], -1, -1)
            # 空間サイズを合わせる（必要なら）
            if m.shape[-2:] != result_mask.shape[-2:]:
                m = F.interpolate(
                    m.unsqueeze(1),
                    size=(img_h, img_w),
                    mode="bilinear",
                    align_corners=False,
                ).squeeze(1)
            result_mask = (result_mask * m.cpu()).clamp(0.0, 1.0)

        # ── パイプラインの更新 ──────────────────────────────────────────────
        if pipe is not None:
            out_pipe = pipe.copy()
        else:
            out_pipe = {}

        gc.collect()
        comfy.model_management.soft_empty_cache()

        return (out_pipe, result_mask)


# ═════════════════════════════════════════════════════════════════════════════
# ノード登録
# ═════════════════════════════════════════════════════════════════════════════

NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Loader_SAM3":        SAX_Bridge_Loader_SAM3,
    "SAX_Bridge_Segmenter_Multi":    SAX_Bridge_Segmenter_Multi,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Loader_SAM3":        "SAX SAM3 Loader",
    "SAX_Bridge_Segmenter_Multi":    "SAX SAM3 Multi Segmenter",
}
