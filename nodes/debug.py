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
# Pipe 内容のフォーマット
# ---------------------------------------------------------------------------

def _format_pipe_summary(pipe: Any) -> str:
    """Pipe (dict) の内容を整形された文字列に変換する。"""
    if pipe is None:
        return "pipe: None"
    if not isinstance(pipe, dict):
        return f"pipe: not a dict (type={type(pipe).__name__})"

    lines: list[str] = []

    # 主要な参照フィールド
    for key in ("model", "clip", "vae"):
        v = pipe.get(key)
        lines.append(f"{key}: {'present' if v is not None else 'None'}")

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

    # positive / negative
    for key in ("positive", "negative"):
        v = pipe.get(key)
        if v is None:
            lines.append(f"{key}: None")
        else:
            try:
                lines.append(f"{key}: present ({len(v)} entries)")
            except TypeError:
                lines.append(f"{key}: present")

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
    """文字列値を UI に表示するデバッグノード。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SAX_Bridge_Debug_Text",
            display_name="SAX Debug Text",
            category="SAX/Bridge/Debug",
            description=(
                "Displays a string value in the node UI. "
                "Useful for checking populated text, metadata, or any "
                "intermediate string value."
            ),
            is_output_node=True,
            inputs=[
                io.String.Input("text", multiline=True, default=""),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, text) -> io.NodeOutput:
        s = text if isinstance(text, str) else str(text)
        return io.NodeOutput(ui={"text": [s]})


# ---------------------------------------------------------------------------
# Assert 実行共通処理
# ---------------------------------------------------------------------------

def _run_assertion(
    actual: Any,
    mode: str,
    expected_raw: str,
    label: str,
    stop_on_fail: bool,
    node_name: str,
) -> io.NodeOutput:
    """Assertion 実行の共通処理。UI テキストを生成し結果を返す。"""
    try:
        passed, expected_parsed = _evaluate_assertion(actual, mode, expected_raw)
    except Exception as exc:
        msg = (
            f'[SAX {node_name}] "{label}" ERROR\n'
            f"  mode: {mode}\n"
            f"  reason: {exc}"
        )
        if stop_on_fail:
            raise RuntimeError(msg) from exc
        logger.warning(f"[SAX_Bridge] {msg}")
        return io.NodeOutput(ui={"text": [f"[{label}] ERROR: {exc}"]})

    if passed:
        logger.info(f'[SAX_Bridge] [SAX {node_name}] "{label}" PASS')
        return io.NodeOutput(ui={"text": [f"[{label}] PASS"]})

    # FAIL
    actual_repr = repr(actual)
    if len(actual_repr) > 200:
        actual_repr = actual_repr[:200] + "..."
    fail_msg = (
        f'[SAX {node_name}] "{label}" FAILED\n'
        f"  mode: {mode}\n"
        f"  actual: {actual_repr}\n"
        f"  expected: {expected_parsed!r}"
    )
    if stop_on_fail:
        raise RuntimeError(fail_msg)
    logger.warning(
        f'[SAX_Bridge] [SAX {node_name}] "{label}" FAILED: '
        f"mode={mode}, actual={actual_repr}, expected={expected_parsed!r}"
    )
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
                io.Boolean.Input("stop_on_fail", default=True),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, value, mode, expected="", label="assert", stop_on_fail=True) -> io.NodeOutput:
        return _run_assertion(value, mode, expected, label, stop_on_fail, "Assert")


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
                io.Boolean.Input("stop_on_fail", default=True),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, value, path="", mode="not_none", expected="",
                label="assert", stop_on_fail=True) -> io.NodeOutput:
        try:
            resolved = _resolve_path(value, path)
        except RuntimeError as exc:
            msg = f'[SAX Assert Pipe] "{label}" FAILED: {exc}'
            if stop_on_fail:
                raise RuntimeError(msg) from exc
            logger.warning(f"[SAX_Bridge] {msg}")
            return io.NodeOutput(ui={"text": [f"[{label}] FAIL: {exc}"]})

        return _run_assertion(resolved, mode, expected, label, stop_on_fail, "Assert Pipe")
