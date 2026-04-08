"""SAX_Bridge Debug ノード群 — Pipe 内部確認・文字列表示・Assertion 検証。"""

import logging
import re
from typing import Any

from comfy_api.latest import io

from .io_types import AnyType, PipeLine

logger = logging.getLogger("SAX_Bridge")


# ---------------------------------------------------------------------------
# Assertion モード定義
# ---------------------------------------------------------------------------

ASSERTION_MODES = [
    "not_none",
    "is_none",
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "matches",
    "startswith",
    "endswith",
    "greater_than",
    "less_than",
    "in_range",
    "shape_equals",
    "length_equals",
    "has_key",
    "has_item",
]


# ---------------------------------------------------------------------------
# 期待値の自動パース
# ---------------------------------------------------------------------------

def _parse_expected(expected: str) -> Any:
    """
    期待値文字列を自動パースする。
    優先順位: int → float → bool → None → list/tuple(カンマ区切り) → str
    """
    if expected is None:
        return None
    if not isinstance(expected, str):
        return expected

    s = expected.strip()

    if s == "":
        return ""

    # int
    try:
        if s.lstrip("-").isdigit():
            return int(s)
    except (ValueError, AttributeError):
        pass

    # float
    try:
        f = float(s)
        # NaN/Inf はそのまま通す
        return f
    except ValueError:
        pass

    # bool
    low = s.lower()
    if low == "true":
        return True
    if low == "false":
        return False

    # None
    if low in ("null", "none"):
        return None

    # list/tuple（カンマ区切り）
    if "," in s:
        parts = [p.strip() for p in s.split(",")]
        parsed = []
        for p in parts:
            parsed.append(_parse_expected(p))
        return parsed

    # str fallback
    return s


# ---------------------------------------------------------------------------
# path 解決（Assert Pipe 用）
# ---------------------------------------------------------------------------

def _resolve_path(value: Any, path: str) -> Any:
    """
    ドット区切りパスに従って値を解決する。
    各セグメントで dict アクセス → 属性アクセス → インデックスアクセスの順に試行。
    解決失敗時は RuntimeError を送出する。
    """
    if not path:
        return value

    current = value
    segments = path.split(".")
    for i, seg in enumerate(segments):
        resolved = False

        # dict アクセス
        if isinstance(current, dict):
            if seg in current:
                current = current[seg]
                resolved = True
            else:
                available = list(current.keys())
                raise RuntimeError(
                    f'path resolution error at segment "{seg}" (index {i})\n'
                    f"  available keys: {available}"
                )

        if not resolved:
            # 属性アクセス
            if hasattr(current, seg):
                current = getattr(current, seg)
                resolved = True

        if not resolved:
            # インデックスアクセス
            try:
                idx = int(seg)
                current = current[idx]
                resolved = True
            except (ValueError, TypeError, IndexError, KeyError):
                pass

        if not resolved:
            attrs = [a for a in dir(current) if not a.startswith("_")]
            raise RuntimeError(
                f'path resolution error at segment "{seg}" (index {i})\n'
                f"  available attrs: {attrs[:20]}"
            )

    return current


# ---------------------------------------------------------------------------
# Assertion 評価
# ---------------------------------------------------------------------------

def _evaluate_assertion(actual: Any, mode: str, expected_raw: str) -> tuple[bool, Any]:
    """
    assertion モードと期待値に基づいて検証を実行する。
    戻り値: (passed, expected_parsed)
    """
    if mode == "not_none":
        return (actual is not None, None)
    if mode == "is_none":
        return (actual is None, None)

    expected = _parse_expected(expected_raw)

    if mode == "equals":
        return (actual == expected, expected)
    if mode == "not_equals":
        return (actual != expected, expected)
    if mode == "contains":
        return (str(expected) in str(actual), expected)
    if mode == "not_contains":
        return (str(expected) not in str(actual), expected)
    if mode == "matches":
        return (re.search(str(expected_raw), str(actual)) is not None, expected_raw)
    if mode == "startswith":
        return (str(actual).startswith(str(expected_raw)), expected_raw)
    if mode == "endswith":
        return (str(actual).endswith(str(expected_raw)), expected_raw)
    if mode == "greater_than":
        return (actual > expected, expected)
    if mode == "less_than":
        return (actual < expected, expected)
    if mode == "in_range":
        if not isinstance(expected, list) or len(expected) != 2:
            raise ValueError(
                f"in_range requires 'min,max' format, got: {expected_raw!r}"
            )
        lo, hi = expected
        return (lo <= actual <= hi, expected)
    if mode == "shape_equals":
        if not isinstance(expected, list):
            expected = [expected]
        expected_tuple = tuple(expected)
        shape = getattr(actual, "shape", None)
        if shape is None:
            return (False, expected_tuple)
        return (tuple(shape) == expected_tuple, expected_tuple)
    if mode == "length_equals":
        return (len(actual) == expected, expected)
    if mode == "has_key":
        return (expected_raw in actual, expected_raw)
    if mode == "has_item":
        return (expected in actual, expected)

    raise ValueError(f"unknown assertion mode: {mode}")


# ---------------------------------------------------------------------------
# 任意型の表示用変換
# ---------------------------------------------------------------------------

def _to_display_string(value: Any) -> str:
    """任意型の値を表示用文字列に変換する。"""
    if value is None:
        return "None"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    # Tensor 系（torch.Tensor / numpy.ndarray 等）
    if hasattr(value, "shape") and hasattr(value, "dtype"):
        return (
            f"<{type(value).__name__} shape={tuple(value.shape)} "
            f"dtype={value.dtype} device={getattr(value, 'device', '?')}>"
        )
    # Dict
    if isinstance(value, dict):
        return f"<dict keys={list(value.keys())}>"
    # List/Tuple
    if isinstance(value, (list, tuple)):
        return f"<{type(value).__name__} len={len(value)}>"
    # ComfyUI 系オブジェクト（内部型探索）
    type_name = type(value).__name__
    for attr in ("model", "cond_stage_model", "first_stage_model"):
        if hasattr(value, attr):
            try:
                inner = type(getattr(value, attr)).__name__
                return f"<{type_name} (inner: {inner})>"
            except Exception:
                pass
    return f"<{type_name}>"


# ---------------------------------------------------------------------------
# model/clip/vae の内部型・dtype/device 探索（Inspector 用）
# ---------------------------------------------------------------------------

def _get_inner_type_name(v: Any) -> str | None:
    """ComfyUI の各オブジェクト構造に対応した内部モデル型を取得。"""
    for attr in ("model", "cond_stage_model", "first_stage_model"):
        if hasattr(v, attr):
            try:
                return type(getattr(v, attr)).__name__
            except Exception:
                pass
    return None


def _get_dtype_device_info(v: Any) -> dict:
    """model/clip/vae の dtype/device 情報を取得。取得できない場合は空 dict。"""
    info: dict = {}
    # 内部モジュールから dtype を探索
    for inner_attr in ("model", "cond_stage_model", "first_stage_model"):
        inner = getattr(v, inner_attr, None)
        if inner is not None:
            for dtype_attr in ("dtype", "manual_cast_dtype"):
                dt = getattr(inner, dtype_attr, None)
                if dt is not None:
                    info["dtype"] = str(dt)
                    break
            break
    # ModelPatcher.load_device / offload_device / device を探索
    for dev_attr in ("load_device", "offload_device", "device"):
        dev = getattr(v, dev_attr, None)
        if dev is not None:
            info["device"] = str(dev)
            break
    return info


# ---------------------------------------------------------------------------
# Pipe 内容のフォーマット
# ---------------------------------------------------------------------------

def _format_pipe_summary(pipe: Any) -> str:
    """Pipe (dict) の内容を整形された文字列に変換する。"""
    if pipe is None:
        return "pipe: None"
    if not isinstance(pipe, dict):
        return f"pipe: not a dict (type={type(pipe).__name__})"

    lines: list[str] = []

    # 主要な参照フィールド（型名 + 内部 model 型名 + dtype/device）
    for key in ("model", "clip", "vae"):
        v = pipe.get(key)
        if v is None:
            lines.append(f"{key}: None")
            continue
        type_name = type(v).__name__
        inner_name = _get_inner_type_name(v)
        dtype_device = _get_dtype_device_info(v)

        extras = []
        if inner_name:
            extras.append(f"inner: {inner_name}")
        if "dtype" in dtype_device:
            extras.append(f"dtype={dtype_device['dtype']}")
        if "device" in dtype_device:
            extras.append(f"device={dtype_device['device']}")
        detail = f"{type_name} ({', '.join(extras)})" if extras else type_name
        lines.append(f"{key}: {detail}")

    # seed
    if "seed" in pipe:
        lines.append(f"seed: {pipe['seed']}")

    # loader_settings
    settings = pipe.get("loader_settings")
    if isinstance(settings, dict):
        for sk in ("steps", "cfg", "sampler_name", "scheduler", "denoise", "ckpt_name"):
            if sk in settings:
                lines.append(f"loader_settings.{sk}: {settings[sk]}")

    # images
    imgs = pipe.get("images")
    if imgs is None:
        lines.append("images: None")
    else:
        shape = getattr(imgs, "shape", None)
        if shape is not None:
            lines.append(f"images: shape={tuple(shape)}")
        else:
            lines.append(f"images: {type(imgs).__name__}")

    # samples
    samples = pipe.get("samples")
    if samples is None:
        lines.append("samples: None")
    else:
        inner = None
        if isinstance(samples, dict):
            inner = samples.get("samples")
        if inner is not None:
            shape = getattr(inner, "shape", None)
            if shape is not None:
                lines.append(f"samples.samples: shape={tuple(shape)}")
            else:
                lines.append(f"samples.samples: {type(inner).__name__}")
        else:
            lines.append(f"samples: {type(samples).__name__}")

    # positive / negative（conditioning tensor shape を含める）
    for key in ("positive", "negative"):
        v = pipe.get(key)
        if v is None:
            lines.append(f"{key}: None")
        else:
            try:
                n = len(v)
                first_shape = None
                if n > 0 and isinstance(v[0], (list, tuple)) and len(v[0]) > 0:
                    first = v[0][0]
                    shape = getattr(first, "shape", None)
                    if shape is not None:
                        first_shape = tuple(shape)
                if first_shape:
                    lines.append(f"{key}: {n} entries, first tensor shape={first_shape}")
                else:
                    lines.append(f"{key}: {n} entries")
            except TypeError:
                lines.append(f"{key}: {type(v).__name__}")

    # applied_loras
    applied = pipe.get("_applied_loras")
    if applied is not None:
        try:
            n = len(applied)
        except TypeError:
            n = "?"
        lines.append(f"applied_loras: {applied} ({n} entries)")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# SAX Debug Inspector
# ---------------------------------------------------------------------------

class SAX_Bridge_Debug_Controller(io.ComfyNode):
    """ワークフロー内のデバッグログを ON/OFF するコントローラノード。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Debug_Controller",
            display_name="SAX Debug Controller",
            category="SAX/Bridge/Debug",
            description="Enables debug logging for all SAX nodes in this workflow when toggled ON.",
            is_output_node=True,
            inputs=[
                io.Boolean.Input(
                    "enabled",
                    default=True,
                    label_on="ON",
                    label_off="OFF",
                ),
            ],
            outputs=[],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs) -> float:
        # NaN は自分自身と等しくないためキャッシュミスを強制し、毎回必ず execute が呼ばれる。
        # Controller のフラグ設定を毎回確実に反映するために必要。
        return float("nan")

    @classmethod
    def execute(cls, enabled) -> io.NodeOutput:
        from . import debug_log

        if enabled:
            debug_log.enable(cls)
        else:
            debug_log.disable()
        status = "Debug logging: ON" if enabled else "Debug logging: OFF"
        return io.NodeOutput(ui={"text": [status]})


class SAX_Bridge_Debug_Inspector(io.ComfyNode):
    """Pipe の内部フィールドを UI に表示するデバッグノード。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Debug_Inspector",
            display_name="SAX Debug Inspector",
            category="SAX/Bridge/Debug",
            description=(
                "Inspects a SAX Pipe and displays its internal fields "
                "(model/clip/vae existence, seed, steps, cfg, images shape, "
                "samples shape, applied_loras, etc.) in the node UI."
            ),
            is_output_node=True,
            inputs=[
                PipeLine.Input("pipe"),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, pipe) -> io.NodeOutput:
        text = _format_pipe_summary(pipe)
        logger.info(f"[SAX_Bridge] Debug Inspector:\n{text}")
        return io.NodeOutput(ui={"text": [text]})


# ---------------------------------------------------------------------------
# SAX Debug Text
# ---------------------------------------------------------------------------

class SAX_Bridge_Debug_Text(io.ComfyNode):
    """任意型の値を UI に表示するデバッグノード。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Debug_Text",
            display_name="SAX Debug Text",
            category="SAX/Bridge/Debug",
            description=(
                "Displays any value in the node UI. "
                "Auto-converts to string for display."
            ),
            is_output_node=True,
            inputs=[
                AnyType.Input("value"),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, value) -> io.NodeOutput:
        text = _to_display_string(value)
        return io.NodeOutput(ui={"text": [text]})


# ---------------------------------------------------------------------------
# Assert 実行共通処理
# ---------------------------------------------------------------------------

def _run_assertion(
    actual: Any,
    mode: str,
    expected_raw: str,
    label: str,
    node_name: str,
) -> io.NodeOutput:
    """Assertion 実行の共通処理。PASS/FAIL/ERROR を UI テキストで返す。"""
    try:
        passed, expected_parsed = _evaluate_assertion(actual, mode, expected_raw)
    except Exception as exc:
        err_msg = f'[SAX {node_name}] "{label}" ERROR: {exc}'
        logger.warning(f"[SAX_Bridge] {err_msg}")
        return io.NodeOutput(ui={"text": [err_msg]})

    if passed:
        logger.info(f'[SAX_Bridge] [SAX {node_name}] "{label}" PASS')
        return io.NodeOutput(ui={"text": [f"[{label}] PASS"]})

    # FAIL
    actual_repr = repr(actual)
    if len(actual_repr) > 200:
        actual_repr = actual_repr[:200] + "..."
    fail_msg = (
        f'[SAX {node_name}] "{label}" FAILED '
        f'(mode={mode}, actual={actual_repr}, expected={expected_parsed!r})'
    )
    logger.warning(f"[SAX_Bridge] {fail_msg}")
    return io.NodeOutput(
        ui={"text": [f"[{label}] FAIL: mode={mode} actual={actual_repr}"]}
    )


# ---------------------------------------------------------------------------
# SAX Assert
# ---------------------------------------------------------------------------

class SAX_Bridge_Assert(io.ComfyNode):
    """値が期待条件を満たすかを検証するノード。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Assert",
            display_name="SAX Assert",
            category="SAX/Bridge/Debug",
            description=(
                "Asserts a value meets the expected condition. "
                "Fails the workflow (or warns) on mismatch."
            ),
            is_output_node=True,
            inputs=[
                AnyType.Input("value"),
                io.Combo.Input("mode", options=ASSERTION_MODES, default="not_none"),
                io.String.Input("expected", default="", optional=True),
                io.String.Input("label", default="assert"),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, value, mode, expected="", label="assert") -> io.NodeOutput:
        return _run_assertion(value, mode, expected, label, "Assert")


# ---------------------------------------------------------------------------
# SAX Assert Pipe
# ---------------------------------------------------------------------------

class SAX_Bridge_Assert_Pipe(io.ComfyNode):
    """Pipe（または dict/object）内のフィールドを検証するノード。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Assert_Pipe",
            display_name="SAX Assert Pipe",
            category="SAX/Bridge/Debug",
            description=(
                "Asserts a field inside a Pipe (or nested dict/object) meets "
                "the expected condition. Uses dot-separated path for field extraction."
            ),
            is_output_node=True,
            inputs=[
                AnyType.Input("value"),
                io.String.Input("path", default=""),
                io.Combo.Input("mode", options=ASSERTION_MODES, default="not_none"),
                io.String.Input("expected", default="", optional=True),
                io.String.Input("label", default="assert"),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, value, path="", mode="not_none", expected="",
                label="assert") -> io.NodeOutput:
        try:
            resolved = _resolve_path(value, path) if path else value
        except Exception as exc:
            err_msg = f'[SAX Assert Pipe] "{label}" ERROR: path resolution failed: {exc}'
            logger.warning(f"[SAX_Bridge] {err_msg}")
            return io.NodeOutput(ui={"text": [err_msg]})
        return _run_assertion(resolved, mode, expected, label, "Assert Pipe")
