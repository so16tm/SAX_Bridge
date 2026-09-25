import os

from comfy_api.latest import io


@io.comfytype(io_type="PIPE_LINE")
class PipeLine(io.ComfyTypeIO):
    Type = dict


@io.comfytype(io_type="*")
class AnyType(io.ComfyTypeIO):
    Type = object


_APPLIED_LORAS_KEY = "_applied_loras"


def require_pipe(pipe, node_label: str) -> dict:
    """pipe が空 (None) で届いたときに、原因の分かるエラーにする。

    ComfyUI は入力のない上流ノード (Loader 等) がバイパスされると出力を None にし、
    SAX Pipe Collector も有効なソースが無ければ None を返す。そのまま `pipe.get`
    すると AttributeError になり、配線の問題だと分からないため先に弾く。
    """
    if pipe is None:
        raise ValueError(
            f"[SAX_Bridge] {node_label}: the pipe input is empty. "
            "The upstream Loader may be bypassed or muted (e.g. by Toggle Manager), "
            "or SAX Pipe Collector has no active source. Check the pipe wiring."
        )
    return pipe


def basename_no_ext(name: str) -> str:
    """パス末尾のファイル名を拡張子なしで返す（実行 OS に依存しない）。

    Windows で保存されたワークフローはモデル名を `\\` 区切りで持つため、
    os.path.basename では Linux/macOS 上で区切りを落とせない。ワークフローの
    可搬性を保つため、`/` と `\\` の両方を区切りとして自前で処理する。
    """
    tail = name.replace("\\", "/").rpartition("/")[2]
    return os.path.splitext(tail)[0]


def _normalize_lora_name(name: str) -> str:
    """LoRA名を照合キー（拡張子なしのファイル名）に正規化する。"""
    return basename_no_ext(name)


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

