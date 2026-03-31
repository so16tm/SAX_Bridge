import json
import logging
import os
import re
import datetime
import uuid

import torch
import numpy as np
from PIL import Image, PngImagePlugin
import folder_paths

from comfy_api.latest import io

from .detailer import _extract_pipe
from .io_types import PipeLine

logger = logging.getLogger("SAX_Bridge")


# ---------------------------------------------------------------------------
# 画像処理ユーティリティ
# ---------------------------------------------------------------------------

def _apply_sharpen(image: torch.Tensor, strength: float, sigma: float) -> torch.Tensor:
    """Unsharp Mask シャープ化。image: (B, H, W, C) float32"""
    if strength <= 0.0:
        return image
    import torch.nn.functional as F

    bchw = image.permute(0, 3, 1, 2)
    kernel_size = max(3, int(6 * sigma + 1) | 1)
    x = torch.arange(kernel_size, dtype=torch.float32, device=bchw.device) - kernel_size // 2
    g = torch.exp(-0.5 * (x / sigma) ** 2)
    g = g / g.sum()
    kernel = (g.unsqueeze(0) * g.unsqueeze(1)).unsqueeze(0).unsqueeze(0)
    kernel = kernel.expand(bchw.shape[1], 1, kernel_size, kernel_size).contiguous()
    blurred = F.conv2d(bchw, kernel, padding=kernel_size // 2, groups=bchw.shape[1])
    return torch.clamp(bchw + strength * (bchw - blurred), 0.0, 1.0).permute(0, 2, 3, 1)


def _apply_grayscale(image: torch.Tensor) -> torch.Tensor:
    """ITU-R BT.709 グレースケール変換。image: (B, H, W, C) float32"""
    gray = 0.2126 * image[..., 0] + 0.7152 * image[..., 1] + 0.0722 * image[..., 2]
    return gray.unsqueeze(-1).expand_as(image)


# ---------------------------------------------------------------------------
# 保存ユーティリティ
# ---------------------------------------------------------------------------

def _expand_template(
    template: str,
    p: dict,
    now: datetime.datetime,
) -> str:
    """
    テンプレート変数を展開する。{変数} または {変数:フォーマット} 形式。

    日付・時刻: strftime フォーマット指定  例) {date:%Y-%m-%d}  {time:%H-%M-%S}
    数値      : Python format 仕様         例) {seed:08d}
    """
    ckpt = p.get("ckpt_name", "")
    if ckpt:
        ckpt = os.path.splitext(os.path.basename(ckpt))[0]

    def replace(m: re.Match) -> str:
        var, _, fmt = m.group(1).partition(":")
        var = var.strip()
        if var == "date":
            return now.strftime(fmt or "%Y%m%d")
        if var == "time":
            return now.strftime(fmt or "%H%M%S")
        if var == "datetime":
            return now.strftime(fmt or "%Y%m%d_%H%M%S")
        if var == "seed":
            val = p.get("seed", 0)
            return format(int(val), fmt) if fmt else str(val)
        if var == "model":
            return ckpt or "unknown"
        if var == "steps":
            return str(p.get("steps", ""))
        if var == "cfg":
            return str(p.get("cfg", ""))
        return m.group(0)  # 未知の変数はそのまま残す

    return re.sub(r"\{([^}]+)\}", replace, template)


# ファイル名として使用できない文字を置換（パスセパレータは除く）
_UNSAFE_FILENAME = re.compile(r'[<>:"|?*]')
# ディレクトリパスセグメントとして使用できない文字を置換
_UNSAFE_SEGMENT = re.compile(r'[<>:"|?*\\\0]')


def _resolve_dir(output_dir: str, p: dict, now: datetime.datetime) -> str:
    """テンプレート展開・パス解決・ディレクトリ作成を行う。"""
    expanded = _expand_template(output_dir, p, now) if output_dir else ""

    if not expanded:
        path = folder_paths.get_output_directory()
    elif os.path.isabs(expanded):
        path = expanded
    else:
        # `/` をセパレータとして分割し、各セグメントを個別にサニタイズ
        segments = [_UNSAFE_SEGMENT.sub("_", seg) for seg in expanded.replace("\\", "/").split("/") if seg]
        path = os.path.join(folder_paths.get_output_directory(), *segments)

    os.makedirs(path, exist_ok=True)
    return path


def _expand_filename(template: str, p: dict, now: datetime.datetime) -> str:
    """ファイル名テンプレートを展開してサニタイズする。"""
    expanded = _expand_template(template, p, now)
    return _UNSAFE_FILENAME.sub("_", expanded)


def _build_indexed_name(template_result: str, index: int, digits: int, position: str) -> str:
    """テンプレート展開済み文字列にインデックスを付加する。"""
    formatted = format(index, f"0{digits}d")
    if position == "prefix":
        return f"{formatted}_{template_result}"
    return f"{template_result}_{formatted}"


def _build_metadata_str(p: dict, prompt_text: str) -> str:
    """Pipe データとプロンプトテキストからメタデータ文字列を生成する。"""
    parts = []
    if prompt_text:
        parts.append(prompt_text)
    params = []
    for label, key in [
        ("Seed", "seed"), ("Steps", "steps"), ("CFG scale", "cfg"),
        ("Sampler", "sampler_name"), ("Scheduler", "scheduler"),
    ]:
        v = p.get(key)
        if v is not None:
            params.append(f"{label}: {v}")
    ckpt = p.get("ckpt_name", "")
    if ckpt:
        params.append(f"Model: {os.path.splitext(os.path.basename(ckpt))[0]}")
    if params:
        parts.append(", ".join(params))
    return "\n".join(parts)


def _save_image(
    img_np: np.ndarray,
    path: str,
    fmt: str,
    webp_quality: int,
    webp_lossless: bool,
    metadata_str: str,
    grayscale: bool,
    prompt=None,
    extra_pnginfo=None,
) -> None:
    """PIL を使って画像を保存する。"""
    pil_img = Image.fromarray(img_np[..., 0], mode="L") if grayscale else Image.fromarray(img_np)

    if fmt == "png":
        pnginfo = PngImagePlugin.PngInfo()
        if metadata_str:
            pnginfo.add_text("parameters", metadata_str)
        if prompt is not None:
            pnginfo.add_text("prompt", json.dumps(prompt))
        if extra_pnginfo is not None:
            for key in extra_pnginfo:
                pnginfo.add_text(key, json.dumps(extra_pnginfo[key]))
        pil_img.save(path, format="PNG", pnginfo=pnginfo)
    else:
        save_kwargs: dict = {"format": "WEBP", "quality": webp_quality, "lossless": webp_lossless}
        exif = pil_img.getexif()
        if metadata_str:
            exif[0x010E] = metadata_str
        # ComfyUI 標準の WebP ワークフロー埋め込み形式（EXIF Model/Make タグ）
        if prompt is not None:
            exif[0x0110] = "prompt:" + json.dumps(prompt)
        if extra_pnginfo is not None:
            tag = 0x010F
            for key, value in extra_pnginfo.items():
                exif[tag] = key + ":" + json.dumps(value)
                tag -= 1
        save_kwargs["exif"] = exif.tobytes()
        pil_img.save(path, **save_kwargs)


def _pipe_to_meta(pipe: dict) -> dict:
    """Pipe からメタデータ用の辞書を抽出する。"""
    p: dict = {}
    try:
        extracted = _extract_pipe(pipe)
        if isinstance(extracted, dict):
            p.update(extracted)
    except Exception:
        logger.warning("[SAX_Bridge] Failed to extract pipe metadata", exc_info=True)
    settings = pipe.get("loader_settings", {})
    p["ckpt_name"] = settings.get("ckpt_name", p.get("ckpt_name", ""))
    return p


# ---------------------------------------------------------------------------
# SAX_Bridge_Output ノード
# ---------------------------------------------------------------------------

class SAX_Bridge_Output(io.ComfyNode):
    """
    最終出力処理を集約するノード。

    - シャープ化（Unsharp Mask）: 全体への微細シャープ調整
    - グレースケール変換: ITU-R BT.709 係数による変換
    - 保存スイッチ: False でプレビューのみ（試行錯誤中の保存抑制）
    - 出力ディレクトリ指定: 絶対パス または output/ からの相対パス
    - ファイル名テンプレート: {seed} {date} {time} {datetime} {model} {steps} {cfg}
    - インデックス: filename_index から開始し保存ごとにカウントアップ
    - メタデータ埋め込み: Pipe から seed・steps・CFG・モデル名等を自動取得

    画像ソースの優先順位:
      1. image（直接接続）
      2. pipe.images（image 未接続時のフォールバック）
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Output",
            display_name="SAX Output",
            description=(
                "Final output node combining sharpening, grayscale conversion, WebP/PNG saving, and metadata embedding. "
                "Set save=False to skip saving during experimentation."
            ),
            category="SAX/Bridge/Output",
            is_output_node=True,
            inputs=[
                io.Boolean.Input("save", default=True,
                    tooltip="True to save. False for preview only (sharpening and grayscale are still applied)."),
                io.String.Input("output_dir", default="{date:%Y-%m-%d}",
                    tooltip="Output directory. Template variables supported. Leave empty for ComfyUI/output/. Relative paths are based on output/. Absolute paths also accepted."),
                io.String.Input("filename_template", default="{datetime:%Y%m%d_%H%M%S}",
                    tooltip="Filename template. Use {var} or {var:format} syntax. Available: {date} {time} {datetime} {seed} {model} {steps} {cfg}."),
                io.Int.Input("filename_index", default=1, min=0, max=999999, step=1,
                    tooltip="Starting index value. Increments with each save. Update manually at the next session."),
                io.Int.Input("index_digits", default=3, min=1, max=6,
                    tooltip="Zero-padding digit count for the index. 3 = 001, 4 = 0001."),
                io.Combo.Input("index_position", options=["prefix", "suffix"],
                    tooltip="Attach the index to the beginning (prefix) or end (suffix) of the filename."),
                io.Combo.Input("format", options=["webp", "png"]),
                io.Int.Input("webp_quality", default=90, min=1, max=100,
                    tooltip="WebP quality (1–100). Ignored when lossless=True."),
                io.Boolean.Input("webp_lossless", default=False),
                io.Float.Input("sharpen_strength", default=0.0, min=0.0, max=2.0, step=0.05,
                    tooltip="Unsharp Mask sharpening strength. 0.0 = disabled."),
                io.Float.Input("sharpen_sigma", default=1.0, min=0.1, max=5.0, step=0.1,
                    tooltip="Sharpening kernel width. Smaller values affect finer edges and details."),
                io.Boolean.Input("grayscale", default=False),
                PipeLine.Input("pipe", optional=True,
                    tooltip="Image source and metadata supplier (seed, steps, CFG, model name, etc.) when image is not connected."),
                io.Image.Input("image", optional=True,
                    tooltip="Target image to process. Falls back to pipe.images if not connected."),
                io.String.Input("prompt_text", optional=True, force_input=True,
                    tooltip="Prompt text to embed in metadata. Recommended: connect SAX Prompt's POPULATED_TEXT."),
            ],
            outputs=[
                io.Image.Output(),
            ],
        )

    @classmethod
    def execute(cls, save, output_dir, filename_template, filename_index,
                index_digits, index_position, format, webp_quality, webp_lossless,
                sharpen_strength, sharpen_sigma, grayscale,
                pipe=None, image=None, prompt_text="") -> io.NodeOutput:
        prompt = cls.hidden.prompt
        extra_pnginfo = cls.hidden.extra_pnginfo

        if image is not None:
            src = image
        elif pipe is not None and pipe.get("images") is not None:
            src = pipe["images"]
        else:
            raise ValueError(
                "[SAX_Bridge] Output: no image found. Connect image or pipe.images."
            )

        result = _apply_sharpen(src, sharpen_strength, sharpen_sigma)

        if grayscale:
            result = _apply_grayscale(result)

        if save:
            now = datetime.datetime.now()
            p = _pipe_to_meta(pipe) if pipe is not None else {}
            metadata_str = _build_metadata_str(p, prompt_text)
            resolved_dir = _resolve_dir(output_dir, p, now)
            ext = f".{format}"
            template_result = _expand_filename(filename_template, p, now)
            imgs_np = (result.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)

            batch_size = len(imgs_np)
            for i, img_np in enumerate(imgs_np):
                name = _build_indexed_name(template_result, filename_index, index_digits, index_position)
                if batch_size > 1:
                    name = f"{name}_{i:02d}"
                filepath = os.path.join(resolved_dir, name + ext)

                counter = 1
                while os.path.exists(filepath):
                    filepath = os.path.join(resolved_dir, f"{name}_{counter:04d}{ext}")
                    counter += 1

                _save_image(img_np, filepath, format, webp_quality, webp_lossless, metadata_str, grayscale, prompt, extra_pnginfo)
                logger.info(f"[SAX_Bridge] Output: saved → {filepath}")

        next_index = filename_index + 1 if save else filename_index
        return io.NodeOutput(result, ui={"filename_index": [next_index]})


class SAX_Bridge_Image_Preview(io.ComfyNode):
    """
    IMAGE バッチを比較プレビュー表示する終端ノード。

    SAX Image Collector と組み合わせて使用するが、単独でも動作する。
    cell_w でメインビューの各セル幅を指定し（高さはアスペクト比から自動算出）、
    max_cols で同時表示列数を制御する。
    グリッドは JS 側でトグル表示でき、サムネイルクリックで比較対象を選択できる。
    """

    _PREVIEW_MAX_PX = {"low": 512, "medium": 1024, "high": None}

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Image_Preview",
            display_name="SAX Image Preview",
            description=(
                "Displays an IMAGE batch with a toggleable thumbnail grid for comparison. "
                "Click thumbnails to select images for the main view. "
                "Designed to work with SAX Image Collector, but accepts any IMAGE input."
            ),
            category="SAX/Bridge/Output",
            is_output_node=True,
            hidden=[io.Hidden.unique_id],
            inputs=[
                io.Int.Input("cell_w", default=200, min=64, max=512, step=16,
                    tooltip="Width (px) of each cell. Height is auto-calculated from the images' actual aspect ratios."),
                io.Int.Input("max_cols", default=1, min=1, max=8, step=1,
                    tooltip="Number of columns in the main comparison view. Node width is set automatically from cell_w × max_cols."),
                io.Combo.Input("preview_quality", options=["low", "medium", "high"], default="low",
                    tooltip="Preview resolution. low=512px, medium=1024px, high=full size. Higher quality increases encoding time."),
                io.Image.Input("images", optional=True),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, cell_w, max_cols, preview_quality="low", images=None) -> io.NodeOutput:
        if images is None:
            return io.NodeOutput(ui={"images": []})

        import glob
        temp_dir = folder_paths.get_temp_directory()
        node_id = getattr(cls, "hidden", None)
        node_id = node_id.unique_id if node_id else None
        prefix = f"sax_preview_{node_id}_" if node_id else "sax_preview_"

        for old in glob.glob(os.path.join(temp_dir, f"{prefix}*.webp")):
            try:
                os.remove(old)
            except OSError:
                pass

        max_px  = cls._PREVIEW_MAX_PX.get(preview_quality)
        results = []

        for i in range(images.shape[0]):
            frame  = images[i]
            img_np = (frame.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)

            if img_np.shape[-1] == 1:
                pil_img = Image.fromarray(img_np[..., 0], mode="L").convert("RGB")
            else:
                pil_img = Image.fromarray(img_np)

            if max_px is not None:
                w, h = pil_img.size
                long_edge = max(w, h)
                if long_edge > max_px:
                    scale   = max_px / long_edge
                    pil_img = pil_img.resize(
                        (max(1, round(w * scale)), max(1, round(h * scale))),
                        Image.LANCZOS,
                    )

            filename = f"{prefix}{uuid.uuid4().hex[:12]}.webp"
            filepath = os.path.join(temp_dir, filename)
            pil_img.save(filepath, format="WEBP", quality=85)

            results.append({"filename": filename, "subfolder": "", "type": "temp"})

        return io.NodeOutput(ui={"images": results})
