import logging
import os
import re
import datetime

import torch
import numpy as np
from PIL import Image, PngImagePlugin
import folder_paths

from .detailer import _extract_pipe

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
        ("Sampler", "sampler_name"), ("Scheduler", "scheduler_name"),
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
) -> None:
    """PIL を使って画像を保存する。"""
    pil_img = Image.fromarray(img_np[..., 0], mode="L") if grayscale else Image.fromarray(img_np)

    if fmt == "png":
        pnginfo = PngImagePlugin.PngInfo()
        if metadata_str:
            pnginfo.add_text("parameters", metadata_str)
        pil_img.save(path, format="PNG", pnginfo=pnginfo)
    else:
        save_kwargs: dict = {"format": "WEBP", "quality": webp_quality, "lossless": webp_lossless}
        if metadata_str:
            exif = pil_img.getexif()
            exif[0x010E] = metadata_str  # ImageDescription タグ
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
        pass
    settings = pipe.get("loader_settings", {})
    p["ckpt_name"] = settings.get("ckpt_name", p.get("ckpt_name", ""))
    return p


# ---------------------------------------------------------------------------
# SAX_Bridge_Output ノード
# ---------------------------------------------------------------------------

class SAX_Bridge_Output:
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
    def INPUT_TYPES(s):
        return {
            "required": {
                "save": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "True で保存実行。False でプレビューのみ（シャープ化・グレースケールは適用される）。",
                    },
                ),
                "output_dir": (
                    "STRING",
                    {
                        "default": "{date:%Y-%m-%d}",
                        "tooltip": "保存先ディレクトリ。テンプレート変数使用可。空欄 = ComfyUI/output/。相対パスは output/ 基準。絶対パスも可。",
                    },
                ),
                "filename_template": (
                    "STRING",
                    {
                        "default": "{datetime:%Y%m%d_%H%M%S}",
                        "tooltip": "ファイル名テンプレート。{変数} または {変数:フォーマット} 形式。{date} {time} {datetime} {seed} {model} {steps} {cfg} が使用可能。",
                    },
                ),
                "filename_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 999999,
                        "step": 1,
                        "tooltip": "インデックス開始値。保存ごとにカウントアップする。次回セッションではこの値を手動で更新する。",
                    },
                ),
                "index_digits": (
                    "INT",
                    {
                        "default": 3,
                        "min": 1,
                        "max": 6,
                        "tooltip": "インデックスのゼロパディング桁数。3 = 001, 4 = 0001。",
                    },
                ),
                "index_position": (
                    ["prefix", "suffix"],
                    {
                        "tooltip": "インデックスをファイル名の先頭（prefix）または末尾（suffix）に付加する。",
                    },
                ),
                "format": (["webp", "png"],),
                "webp_quality": (
                    "INT",
                    {
                        "default": 90,
                        "min": 1,
                        "max": 100,
                        "tooltip": "WebP 品質 (1-100)。lossless=True の場合は無効。",
                    },
                ),
                "webp_lossless": ("BOOLEAN", {"default": False}),
                "sharpen_strength": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.05,
                        "tooltip": "Unsharp Mask シャープ強度。0.0 = 無効。",
                    },
                ),
                "sharpen_sigma": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.1,
                        "max": 5.0,
                        "step": 0.1,
                        "tooltip": "シャープカーネル幅。小さいほどエッジ・細部に作用。",
                    },
                ),
                "grayscale": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "pipe": (
                    "PIPE_LINE",
                    {"tooltip": "image 未接続時の画像ソース兼メタデータ（seed・steps・CFG・モデル名等）供給元。"},
                ),
                "image": (
                    "IMAGE",
                    {"tooltip": "処理対象画像。未接続の場合は pipe.images を使用。"},
                ),
                "prompt_text": (
                    "STRING",
                    {
                        "tooltip": "メタデータに埋め込むプロンプトテキスト。SAX Prompt の POPULATED_TEXT を接続推奨。",
                        "forceInput": True,
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    FUNCTION = "process"
    CATEGORY = "SAX/Bridge/Output"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "シャープ化・グレースケール変換・WebP/PNG 保存・メタデータ埋め込みを集約した最終出力ノード。"
        "save=False で試行錯誤中の保存をスキップできる。"
    )

    def process(
        self,
        save: bool,
        output_dir: str,
        filename_template: str,
        filename_index: int,
        index_digits: int,
        index_position: str,
        format: str,
        webp_quality: int,
        webp_lossless: bool,
        sharpen_strength: float,
        sharpen_sigma: float,
        grayscale: bool,
        image: torch.Tensor = None,
        pipe=None,
        prompt_text: str = "",
    ):
        # --- 0. 画像ソース解決 ---
        if image is not None:
            src = image
        elif pipe is not None and pipe.get("images") is not None:
            src = pipe["images"]
        else:
            raise ValueError(
                "[CSB] Output: 画像が見つかりません。image または pipe.images を接続してください。"
            )

        # --- 1. シャープ化 ---
        result = _apply_sharpen(src, sharpen_strength, sharpen_sigma)

        # --- 2. グレースケール ---
        if grayscale:
            result = _apply_grayscale(result)

        # --- 3. 保存 ---
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
                # バッチが複数枚の場合はバッチ内位置を付加して区別する
                if batch_size > 1:
                    name = f"{name}_{i:02d}"
                filepath = os.path.join(resolved_dir, name + ext)

                # 同名ファイルが存在する場合は連番を付加
                counter = 1
                while os.path.exists(filepath):
                    filepath = os.path.join(resolved_dir, f"{name}_{counter:04d}{ext}")
                    counter += 1

                _save_image(img_np, filepath, format, webp_quality, webp_lossless, metadata_str, grayscale)
                logger.info(f"[CSB] Output: 保存完了 → {filepath}")

        next_index = filename_index + 1 if save else filename_index
        return {"ui": {"filename_index": [next_index]}, "result": (result,)}


NODE_CLASS_MAPPINGS = {
    "SAX_Bridge_Output": SAX_Bridge_Output,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAX_Bridge_Output": "SAX Output",
}
