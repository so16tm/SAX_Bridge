"""Qwen-Image 2.1 用のプロンプトノード（t2i と複数画像 i2i を 1 ノードで扱う）。

エンコード本体は ComfyUI 本体の `TextEncodeQwenImage21` に委ねる。
テンプレート・画像スロット・参照 latent の組み立てはモデル固有で細かく、
自前で複製すると本体の修正に追従できなくなるため。
このノードが足すのは Pipe 方式の入出力、LoRA 構文、
参照画像サイズに合わせた空 latent の batch 対応、
および ComfyUI 本体の QwenImage21Cache / ModelAttentionBackend を
Pipe の model にかけるだけの薄い橋渡し（kv_cache_* / attention）。
"""

from typing import Any

import torch
from comfy_api.latest import io

from .io_types import PipeLine, _APPLIED_LORAS_KEY, filter_new_loras, record_applied_loras, require_pipe
from .prompt import _apply_loras
from .lora_tags import split_lora_tags

# Qwen-Image 2.1 が公式に受け付ける参照画像の上限
MAX_REFERENCE_IMAGES = 10

# 参照画像ありのときの出力サイズの決め方。loader は t2i と同じく Loader の width / height、
# image_1 は image_1 を resolution に縮小した寸法（本体 TextEncodeQwenImage21 の既定の挙動）
OUTPUT_SIZE_LOADER = "loader"
OUTPUT_SIZE_IMAGE_1 = "image_1"
OUTPUT_SIZES = [OUTPUT_SIZE_LOADER, OUTPUT_SIZE_IMAGE_1]

# ComfyUI 本体 QwenImage21Cache の選択肢と既定値（既定のままなら本体ノードは呼ばない）
KV_CACHE_DEVICES = ["auto", "gpu", "cpu", "off"]
KV_CACHE_DTYPES = ["default", "int8", "int4"]

# ComfyUI 本体 ModelAttentionBackend の選択肢。本体側は環境に無い選択肢を
# 実行時に隠すため、保存済みワークフローの検証で落ちないよう固定リストで持つ。
# "default" は本体ノードを呼ばない（起動オプションや他ノードの設定を尊重する）。
ATTENTION_DEFAULT = "default"
ATTENTION_BACKENDS = [ATTENTION_DEFAULT, "pytorch attention", "comfy kitchen attention"]


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


def _apply_core_model_node(node_id: str, display: str, model: Any, **kwargs: Any) -> Any:
    """ComfyUI 本体の「MODEL → MODEL」ノードを名前で取得して model にかける。

    本体の実装（モデルの複製と model_options への書き込み）に委ね、このリポジトリでは
    内部キーを持たない。ComfyUI のバージョンによっては存在しないため、実行時に
    探して原因が分かるエラーにする。
    """
    import nodes

    node_cls = nodes.NODE_CLASS_MAPPINGS.get(node_id)
    if node_cls is None:
        raise ValueError(
            f"[SAX_Bridge] Qwen Image Prompt: {display} ({node_id}) is not available in "
            "this ComfyUI version. Please update ComfyUI, or leave the option at its default."
        )
    if hasattr(node_cls, "GET_SCHEMA"):  # V3
        out = node_cls.execute(model=model, **kwargs)
    else:  # V1
        out = getattr(node_cls(), node_cls.FUNCTION)(model=model, **kwargs)
    return out.args[0] if hasattr(out, "args") else out[0]


def _apply_model_options(
    model: Any, kv_cache_device: str, kv_cache_dtype: str, attention: str
) -> Any:
    """kv_cache_* / attention が既定値以外のときだけ本体ノードをかける。"""
    if kv_cache_device != KV_CACHE_DEVICES[0] or kv_cache_dtype != KV_CACHE_DTYPES[0]:
        model = _apply_core_model_node(
            "QwenImage21Cache", "Qwen Image 2.1 Cache", model,
            device=kv_cache_device, dtype=kv_cache_dtype,
        )
    if attention != ATTENTION_DEFAULT:
        model = _apply_core_model_node(
            "ModelAttentionBackend", "Model Attention Backend", model, attention=attention,
        )
    return model


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
    - 参照画像あり: i2i / 複数画像編集（最大 10 枚。出力サイズは output_size で
      Loader の width / height か image_1 のサイズを選ぶ）
    - positive / negative を同時にエンコードして Pipe に載せる
    - 送信前に展開された文章と LoRA 構文（positive 側のみ）をサポート
    - KV キャッシュ（参照画像・プロンプト部分の再利用）とアテンションバックエンドを
      Pipe の model に設定できる（どちらも ComfyUI 本体の機能。既定では何もしない）
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
                            "Autocomplete++ expands wildcards before submission. LoRA tags are applied here.",
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
                            "With reference images this only sets how they are resized, not the output size "
                            "(see output_size).",
                ),
                io.Combo.Input(
                    "output_size",
                    options=OUTPUT_SIZES,
                    default=OUTPUT_SIZE_LOADER,
                    tooltip="Output size when reference images are connected. loader uses the Loader's "
                            "width / height (same as text-to-image). image_1 uses image_1 resized by "
                            "resolution, which keeps a single-image edit aligned with its source.",
                ),
                io.Combo.Input(
                    "kv_cache_device",
                    options=KV_CACHE_DEVICES,
                    default=KV_CACHE_DEVICES[0],
                    tooltip="Where the prefix KV cache (prompt and reference images) is kept. "
                            "auto uses spare VRAM first, then RAM; cpu saves VRAM at little speed cost; "
                            "off recomputes every step. Leave at auto/default to use ComfyUI's own default.",
                ),
                io.Combo.Input(
                    "kv_cache_dtype",
                    options=KV_CACHE_DTYPES,
                    default=KV_CACHE_DTYPES[0],
                    tooltip="Precision of the KV cache. default is lossless; int8 halves it with "
                            "near-bf16 accuracy; int4 quarters it at a higher error.",
                ),
                io.Combo.Input(
                    "attention",
                    options=ATTENTION_BACKENDS,
                    default=ATTENTION_DEFAULT,
                    tooltip="Attention backend for the model. default leaves ComfyUI's setting untouched. "
                            "An unavailable backend falls back to PyTorch attention.",
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
        output_size: str = OUTPUT_SIZE_LOADER,
        kv_cache_device: str = KV_CACHE_DEVICES[0],
        kv_cache_dtype: str = KV_CACHE_DTYPES[0],
        attention: str = ATTENTION_DEFAULT,
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

        populated = wildcard_text
        positive_text, loras = split_lora_tags(wildcard_text)
        # Qwen の negative 側の LoRA タグは除去のみ行い、適用しない。
        negative_text, _neg_loras = split_lora_tags(negative_text)

        applied_names: list[str] = []
        new_loras = filter_new_loras(pipe, loras)
        if new_loras:
            model, clip, applied_names = _apply_loras(model, clip, new_loras, pipe.get(_APPLIED_LORAS_KEY, ()))
        model = _apply_model_options(model, kv_cache_device, kv_cache_dtype, attention)

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

        if ref_images and output_size == OUTPUT_SIZE_IMAGE_1:
            # image_1 の縮小後サイズに合わせる（単一画像の編集では元画像とずれにくい）。
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
