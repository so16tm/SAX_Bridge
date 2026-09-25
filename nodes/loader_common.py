"""SAX Loader 系ノードの共通定義。

`SAX_Bridge_Loader` (checkpoint 一括ロード) と `SAX_Bridge_Loader_Diffusion`
(UNET / CLIP / VAE 個別ロード) は、モデルの読み込み手段だけが異なり、
サンプリング設定ウィジェット群と出力 pipe の構造は完全に同一である。
片方だけ直して食い違う事故を防ぐため、共通部分をここへ集約する。
"""

from typing import Any

import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths
import torch
from comfy_api.latest import io


def sampling_inputs() -> list:
    """Loader 系が共通で持つサンプリング設定ウィジェット群を返す。

    ウィジェット名・既定値・並び順は pipe["loader_settings"] と
    docs/nodes_*.md の記載に対応する。変更する際は両方を合わせて直すこと。
    呼び出しごとに新しい Input インスタンスを生成する（スキーマ間で共有しない）。
    """
    return [
        io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff, control_after_generate=True),
        io.Int.Input("steps", default=20, min=1, max=10000),
        io.Float.Input("cfg", default=8.0, min=0.0, max=100.0, step=0.5),
        io.Combo.Input("sampler_name", options=comfy.samplers.KSampler.SAMPLERS),
        io.Combo.Input("scheduler_name", options=comfy.samplers.KSampler.SCHEDULERS),
        io.Float.Input("denoise", default=1.0, min=0.0, max=1.0, step=0.01),
        io.Int.Input("width", default=512, min=8, max=8192, step=8),
        io.Int.Input("height", default=512, min=8, max=8192, step=8),
        io.Int.Input("batch_size", default=1, min=1, max=4096),
    ]


def resolve_path(folder: str, name: str, label: str) -> str:
    """`folder_paths.get_full_path` の結果を検証して返す。

    ファイルが見つからない場合、comfy 内部で `None` を読み込もうとして出る
    不明瞭なエラーではなく、どのファイルが無いのかが分かる ValueError を投げる。
    ワークフロー保存後にモデルをリネーム・移動したときに効く。
    """
    path = folder_paths.get_full_path(folder, name)
    if path is None:
        raise ValueError(f"[SAX_Bridge] {label} not found: {name}")
    return path


def apply_single_lora(
    model: Any,
    clip: Any,
    lora_name: str,
    strength: float,
    label: str,
) -> tuple[Any, Any, list[str]]:
    """LoRA を 1 つだけ model / clip に適用する（`lora_name == "None"` なら何もしない）。

    戻り値は (model, clip, 適用した LoRA 名のリスト)。
    `comfy.sd.load_lora_for_models` は model/clip を clone して返すため入力は変更されない。
    """
    if lora_name == "None":
        return model, clip, []

    lora_path = resolve_path("loras", lora_name, f"{label}: LoRA")
    lora = comfy.utils.load_torch_file(lora_path)
    model, clip = comfy.sd.load_lora_for_models(model, clip, lora, strength, strength)
    return model, clip, [lora_name]


def empty_latent(width: int, height: int, batch_size: int) -> dict:
    """4ch 全ゼロ・1/8 縮小の空 latent を作る（ComfyUI 標準 EmptyLatentImage と同形）。

    latent_channels / latent_dimensions / 縮小率はモデル依存だが、KSampler 側の
    `fix_empty_latent_channels` が実行時に自動適応するため 4ch・1/8 固定でよい。
    `downscale_ratio_spacial` を付けないと 1/16 のモデル (Qwen-Image 2.1 等) で
    latent が縮小されず、指定の 2 倍の解像度で生成されてしまう。
    """
    return {
        "samples": torch.zeros([batch_size, 4, height // 8, width // 8], device="cpu"),
        "downscale_ratio_spacial": 8,
    }


def build_pipe(
    *,
    model: Any,
    clip: Any,
    vae: Any,
    latent: dict,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler_name: str,
    denoise: float,
    width: int,
    height: int,
    batch_size: int,
) -> dict:
    """Loader 系が出力する pipe を組み立てる。

    下流ノード（Prompt / KSampler / Detailer 等）はこのキー構成を前提にしているため、
    キーの増減は下流と docs/nodes_*.md の両方に影響する。
    """
    return {
        "model": model,
        "clip": clip,
        "vae": vae,
        "positive": None,
        "negative": None,
        "samples": latent,
        "images": None,
        "seed": seed,
        "loader_settings": {
            "steps": steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "scheduler": scheduler_name,
            "denoise": denoise,
            "clip_width": width,
            "clip_height": height,
            "positive": "",
            "negative": "",
            "xyplot": None,
            "batch_size": batch_size,
        },
    }
