"""Qwen-Image 2.1 用のプロンプトノード（t2i と複数画像 i2i を 1 ノードで扱う）。

エンコード本体は ComfyUI 本体の `TextEncodeQwenImage21` に委ねる。
テンプレート・画像スロット・参照 latent の組み立てはモデル固有で細かく、
自前で複製すると本体の修正に追従できなくなるため。
このノードが足すのは Pipe 方式の入出力、Wildcard / LoRA 構文、
参照画像サイズに合わせた空 latent の batch 対応だけ。
"""

from typing import Any

import torch
from comfy_api.latest import io

from .io_types import PipeLine, filter_new_loras, record_applied_loras, require_pipe
from .prompt import _apply_loras, _get_impact_wildcards

# Qwen-Image 2.1 が公式に受け付ける参照画像の上限
MAX_REFERENCE_IMAGES = 10


def _get_upstream_encoder():
    """ComfyUI 本体の TextEncodeQwenImage21 を遅延取得する。

    Qwen-Image 2.1 対応前の ComfyUI では存在しないため、読み込み時ではなく
    実行時に import し、原因が分かるエラーにする。
    """
    try:
        from comfy_extras.nodes_qwen import TextEncodeQwenImage21
    except ImportError as exc:
        raise ValueError(
            "[SAX_Bridge] Qwen Image Prompt requires a ComfyUI version with "
            "Qwen-Image 2.1 support (TextEncodeQwenImage21). Please update ComfyUI."
        ) from exc
    return TextEncodeQwenImage21


def _expand_text(wildcards: Any, text: str, seed: int) -> tuple[str, str, list]:
    """Wildcard を展開し (populated, LoRA タグ除去後のテキスト, LoRA リスト) を返す。"""
    if wildcards is None:
        return text, text, []
    populated = wildcards.process(text, seed)
    loras = wildcards.extract_lora_values(populated)
    return populated, wildcards.remove_lora_tags(populated), loras


def _ordered_images(images: dict | None) -> list[tuple[str, torch.Tensor]]:
    """Autogrow の {image_N: IMAGE} を N の昇順に並べ、未接続を除いて返す。"""
    if not images:
        return []
    names = sorted(images, key=lambda n: int(n.rsplit("_", 1)[-1]))
    return [(n, images[n]) for n in names if images[n] is not None]


class SAX_Bridge_Prompt_Qwen_Image(io.ComfyNode):
    """
    Qwen-Image 2.1 用の Pipe 対応プロンプトノード。
    - 参照画像なし: t2i（latent は Loader の width / height のまま）
    - 参照画像あり: i2i / 複数画像編集（最大 10 枚。latent は image_1 のサイズに合わせる）
    - positive / negative を同時にエンコードして Pipe に載せる
    - Wildcard 構文と LoRA 構文（positive 側のみ）をサポート
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        autogrow_template = io.Autogrow.TemplateNames(
            io.Image.Input("image"),
            names=[f"image_{i}" for i in range(1, MAX_REFERENCE_IMAGES + 1)],
            min=0,
        )
        return io.Schema(
            node_id="SAX_Bridge_Prompt_Qwen_Image",
            display_name="SAX Qwen Image Prompt",
            category="SAX/Bridge/Prompt",
            description=(
                "Encodes prompts for Qwen-Image 2.1. Without images it works as text-to-image; "
                "with images (up to 10) it edits / composes them. Refer to them as <image1>, <image2>, ..."
            ),
            inputs=[
                PipeLine.Input("pipe"),
                io.String.Input(
                    "wildcard_text",
                    multiline=True,
                    tooltip="Prompt or edit instruction. Refer to reference images as <image1>, <image2>, ... "
                            "Wildcard and LoRA syntax are supported.",
                ),
                io.String.Input(
                    "negative_text",
                    multiline=True,
                    default="",
                    tooltip="Negative prompt. Has no effect while cfg is 1 (the official setting).",
                ),
                io.Int.Input(
                    "resolution",
                    default=1024,
                    min=0,
                    max=4096,
                    step=32,
                    tooltip="Reference images are resized to about resolution x resolution pixels "
                            "(aspect ratio kept, multiples of 32). 0 keeps each image at its own size. "
                            "The output size follows image_1.",
                ),
                io.Autogrow.Input(
                    "images",
                    template=autogrow_template,
                    tooltip="Reference images for editing. image_1 is the edit target. "
                            "Leave all empty for text-to-image.",
                ),
            ],
            outputs=[
                PipeLine.Output(display_name="PIPE"),
                io.String.Output(display_name="POPULATED_TEXT"),
            ],
        )

    @classmethod
    def execute(
        cls,
        pipe,
        wildcard_text: str,
        negative_text: str = "",
        resolution: int = 1024,
        images: io.Autogrow.Type = None,
    ) -> io.NodeOutput:
        require_pipe(pipe, "SAX Qwen Image Prompt")
        model = pipe.get("model")
        clip = pipe.get("clip")
        vae = pipe.get("vae")
        if model is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a model.")
        if clip is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a CLIP model.")

        ref_images = _ordered_images(images)
        if ref_images and vae is None:
            raise ValueError("[SAX_Bridge] Pipe does not contain a VAE (required for reference images).")

        seed = pipe.get("seed", 0)
        wildcards = _get_impact_wildcards()
        populated, positive_text, loras = _expand_text(wildcards, wildcard_text, seed)
        # negative の LoRA タグは除去だけ行い適用しない（SAX Prompt Concat の negative と揃える方針）
        _neg_populated, negative_text, _neg_loras = _expand_text(wildcards, negative_text, seed)

        applied_names: list[str] = []
        new_loras = filter_new_loras(pipe, loras)
        if new_loras:
            model, clip, applied_names = _apply_loras(model, clip, new_loras)

        encoder = _get_upstream_encoder()
        out = encoder.execute(
            clip,
            positive_text,
            negative_text,
            vae=vae if ref_images else None,
            resolution=resolution,
            images=dict(ref_images),
        )
        positive, negative, ref_latent = out.args[:3]

        new_pipe = {
            **pipe,
            "model": model,
            "clip": clip,
            "positive": positive,
            "negative": negative,
        }
        record_applied_loras(new_pipe, applied_names)

        settings = dict(new_pipe.get("loader_settings") or {})
        settings["positive"] = positive_text
        settings["negative"] = negative_text

        if ref_images:
            # 出力サイズは image_1 に合わせる（他のサイズだと編集結果がずれる）。
            # 本体は batch 1 で返すので Loader の batch_size まで広げる。
            samples = ref_latent["samples"]
            batch_size = max(1, int(settings.get("batch_size", 1) or 1))
            if samples.shape[0] != batch_size:
                samples = torch.zeros(
                    [batch_size, *samples.shape[1:]], dtype=samples.dtype, device=samples.device
                )
            new_pipe["samples"] = {"samples": samples}
            # latent は 1/16 (Qwen-Image 2.1 VAE)。表示・メタデータ用に px で記録する
            settings["clip_width"] = samples.shape[-1] * 16
            settings["clip_height"] = samples.shape[-2] * 16

        if "loader_settings" in new_pipe:
            new_pipe["loader_settings"] = settings

        return io.NodeOutput(new_pipe, populated)
