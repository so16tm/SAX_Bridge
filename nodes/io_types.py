import os

from comfy_api.latest import io


@io.comfytype(io_type="PIPE_LINE")
class PipeLine(io.ComfyTypeIO):
    Type = dict


@io.comfytype(io_type="*")
class AnyType(io.ComfyTypeIO):
    Type = object


_APPLIED_LORAS_KEY = "_applied_loras"


def _normalize_lora_name(name: str) -> str:
    """LoRA名をパス末尾のファイル名（拡張子なし）に正規化する"""
    return os.path.splitext(os.path.basename(name))[0]


def filter_new_loras(pipe: dict, loras: list) -> list:
    """
    pipe["_applied_loras"] を参照し、未適用のLoRAだけを返す。
    loras: [(lora_name, ...), ...] — 第1要素がLoRAファイル名
    """
    applied = pipe.get(_APPLIED_LORAS_KEY, set())
    return [lora for lora in loras if _normalize_lora_name(lora[0]) not in applied]


def record_applied_loras(pipe: dict, lora_names) -> None:
    """
    pipe["_applied_loras"] に適用済みLoRA名を追記する。
    常に新しい set を作成し、shallow copy 経由でのキャッシュ汚染を防ぐ。
    """
    applied = set(pipe.get(_APPLIED_LORAS_KEY, ()))
    for name in lora_names:
        applied.add(_normalize_lora_name(name))
    pipe[_APPLIED_LORAS_KEY] = applied

