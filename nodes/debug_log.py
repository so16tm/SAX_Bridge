"""SAX_Bridge デバッグログ基盤 — ワークフロー内の実行追跡・レポート・JSONL 出力。

全ノードの execute を常にラップし、実行記録を常に蓄積する。
Debug Controller ノードが ON の場合のみ、flush 時にレポートが出力される。
Controller の実行順序に依存せず、ワークフロー内の全ノードの記録を取得できる。
"""

import functools
import inspect
import json
import logging
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .debug import _to_display_string

logger = logging.getLogger("SAX_Bridge.debug")

# ---------------------------------------------------------------------------
# モジュールグローバル状態
# ---------------------------------------------------------------------------

# flush 時にレポートを出力するか（Debug Controller が ON にする）
_report_requested: bool = False
_execution_records: list[dict[str, Any]] = []
_prompt_data: dict[str, Any] = {}

_MAX_LOG_FILES = 20
# Debug Controller 不在時に蓄積が無制限になるのを防ぐ安全弁
_MAX_RECORDS = 1000


# ---------------------------------------------------------------------------
# 公開 API
# ---------------------------------------------------------------------------


def enable(cls: type) -> None:
    """Debug Controller から呼ばれる。前回分を flush し、今回のレポート出力を要求する。

    同一ワークフロー内で複数回呼ばれた場合、2回目以降は _try_capture_prompt が no-op になり
    最初の prompt が保持される（_prompt_data の上書きガードによる）。
    """
    global _report_requested
    _do_flush()
    _report_requested = True
    _try_capture_prompt(cls)


def disable() -> None:
    """Debug Controller から呼ばれる。前回分を flush し、今回のレポート出力を取り下げる。"""
    global _report_requested
    _do_flush()
    _report_requested = False


def wrap_execute(original_func: Callable, node_class: type) -> Callable:
    """execute の生関数をラップして返す。

    呼び出し元（__init__.py）で classmethod() に再ラップして適用する。
    全ノードで常に記録を蓄積する。出力可否は flush 時に判定される。
    """
    schema = node_class.GET_SCHEMA()
    class_type: str = schema.node_id
    display_name: str = schema.display_name
    # シグネチャをクロージャ生成時にキャッシュ（毎回の inspect.signature 呼び出しを回避）
    sig = inspect.signature(original_func)
    param_names: list[str] = [
        p.name for p in sig.parameters.values() if p.name != "cls"
    ]

    @functools.wraps(original_func)
    def wrapper(cls: type, *args: Any, **kwargs: Any) -> Any:
        _enforce_record_limit()

        node_id = _try_get_unique_id(cls)
        input_summary = _build_input_summary(param_names, args, kwargs)

        start = time.perf_counter()
        status = "OK"
        error_msg: str | None = None
        result = None
        try:
            result = original_func(cls, *args, **kwargs)
        except Exception as exc:
            status = "ERROR"
            error_msg = str(exc)
            raise
        finally:
            elapsed = time.perf_counter() - start
            output_summary = (
                _build_output_summary(result) if result is not None else {}
            )
            record: dict[str, Any] = {
                "node_id": node_id,
                "class_type": class_type,
                "display_name": display_name,
                "input_summary": input_summary,
                "output_summary": output_summary,
                "elapsed_s": round(elapsed, 4),
                "status": status,
                "error": error_msg,
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            }
            _execution_records.append(record)

        return result

    return wrapper


def maybe_flush() -> None:
    """外部から明示的に flush を要求する公開 API。

    _report_requested フラグはリセットされない。次回の enable/disable 呼び出しまで
    現在の値が維持されるため、連続する flush 呼び出しで出力可否の判定は一貫する。
    """
    _do_flush()


# ---------------------------------------------------------------------------
# 内部: 蓄積上限ガード & flush
# ---------------------------------------------------------------------------


def _enforce_record_limit() -> None:
    """Debug Controller 不在時の無限蓄積を防ぐ安全弁。

    上限到達時は FIFO（古い順）で削除し、最新の記録を保持する。
    直近のノード実行状況を優先的に残すことで、問題発生時のデバッグ精度を維持する。
    """
    global _execution_records
    if len(_execution_records) >= _MAX_RECORDS:
        # warning が毎回出るのを防ぐため、上限ちょうどで到達した瞬間のみ記録する
        if len(_execution_records) == _MAX_RECORDS:
            logger.warning(
                "debug_log: record buffer reached %d, dropping oldest records (FIFO)",
                _MAX_RECORDS,
            )
        _execution_records = _execution_records[-(_MAX_RECORDS - 1):]


def _do_flush() -> None:
    """蓄積された記録を処理し、状態をリセットする。

    _report_requested=True なら出力、False なら破棄。
    """
    global _execution_records, _prompt_data

    if not _execution_records:
        return

    if _report_requested:
        report = _format_flow_report(_execution_records, _prompt_data)
        if report:
            logger.info("\n%s", report)
        _write_jsonl(_execution_records)

    _execution_records = []
    _prompt_data = {}


# ---------------------------------------------------------------------------
# 内部: hidden からの情報取得
# ---------------------------------------------------------------------------


def _try_get_unique_id(cls: type) -> str:
    """hidden.unique_id があれば取得、なければ "?" を返す。"""
    hidden = getattr(cls, "hidden", None)
    if hidden is not None:
        uid = getattr(hidden, "unique_id", None)
        if uid is not None:
            return str(uid)
    return "?"


def _sanitize_prompt(prompt: dict[str, Any]) -> dict[str, Any]:
    """prompt dict からノード接続構造のみを抽出する（文字列値を除外）。"""
    sanitized: dict[str, Any] = {}
    for node_id, node_data in prompt.items():
        inputs = node_data.get("inputs", {})
        # list 型（[node_id, output_index] 形式）の接続情報のみ保持
        safe_inputs = {
            k: v for k, v in inputs.items()
            if isinstance(v, list) and len(v) == 2
        }
        sanitized[node_id] = {
            "class_type": node_data.get("class_type", ""),
            "inputs": safe_inputs,
        }
    return sanitized


def _try_capture_prompt(cls: type) -> None:
    """hidden.prompt があればグローバルに保存する（最初の1回のみ）。"""
    global _prompt_data
    if _prompt_data:
        return
    hidden = getattr(cls, "hidden", None)
    if hidden is not None:
        prompt = getattr(hidden, "prompt", None)
        if prompt:
            _prompt_data = _sanitize_prompt(prompt)


# ---------------------------------------------------------------------------
# 内部: 入出力サマリ
# ---------------------------------------------------------------------------


# 機密情報保護のため、長い文字列は長さのみ表示する
_MAX_STR_DISPLAY_LEN = 50


def _summarize_value(value: Any) -> str:
    """値をサマリ文字列に変換する。長い文字列は長さのみ表示。"""
    if isinstance(value, str):
        if len(value) <= _MAX_STR_DISPLAY_LEN:
            return value
        return f"<str len={len(value)}>"
    return _to_display_string(value)


def _build_input_summary(
    param_names: list[str],
    args: tuple,
    kwargs: dict[str, Any],
) -> dict[str, str]:
    """実行時の引数からサマリを構築する。"""
    summary: dict[str, str] = {}
    for i, name in enumerate(param_names):
        if name in kwargs:
            summary[name] = _summarize_value(kwargs[name])
        elif i < len(args):
            summary[name] = _summarize_value(args[i])
    return summary


def _build_output_summary(result: Any) -> dict[str, str]:
    """NodeOutput の内容をサマリ化する。"""
    args = getattr(result, "args", None)
    if args and isinstance(args, (tuple, list)):
        return {
            f"output_{i}": _summarize_value(v) for i, v in enumerate(args)
        }
    return {"result": _summarize_value(result)}


# ---------------------------------------------------------------------------
# 内部: フロー順レポート生成
# ---------------------------------------------------------------------------


def _build_graph(prompt: dict[str, Any]) -> dict[str, list[str]]:
    """prompt dict から有向グラフ（親 → 子）を構築する。"""
    edges: dict[str, list[str]] = defaultdict(list)
    for node_id, node_data in prompt.items():
        inputs = node_data.get("inputs", {})
        for _key, val in inputs.items():
            if isinstance(val, list) and len(val) == 2:
                src_id = str(val[0])
                if src_id in prompt:
                    edges[src_id].append(node_id)
    return dict(edges)


def _topological_sort(
    prompt: dict[str, Any],
    edges: dict[str, list[str]],
) -> list[str]:
    """Kahn's algorithm によるトポロジカルソート。"""
    in_degree: dict[str, int] = {nid: 0 for nid in prompt}
    for _src, dsts in edges.items():
        for dst in dsts:
            if dst in in_degree:
                in_degree[dst] += 1

    queue = deque(sorted(nid for nid, deg in in_degree.items() if deg == 0))
    result: list[str] = []
    while queue:
        node = queue.popleft()
        result.append(node)
        new_zeros: list[str] = []
        for dst in edges.get(node, []):
            if dst in in_degree:
                in_degree[dst] -= 1
                if in_degree[dst] == 0:
                    new_zeros.append(dst)
        # 安定ソートのため新しいゼロ次数ノードをソートして追加
        queue.extend(sorted(new_zeros))
    return result


def _format_flow_report(
    records: list[dict[str, Any]],
    prompt: dict[str, Any],
) -> str:
    """フロー順にサマリレポートを生成する。"""
    if not records:
        return ""

    ordered = _order_records(records, prompt)
    if not ordered:
        return ""

    lines: list[str] = ["=== SAX Debug Report ==="]
    for i, rec in enumerate(ordered):
        label = rec["display_name"]
        if rec["node_id"] != "?":
            label += f" (node#{rec['node_id']})"
        prefix = "  " if i == 0 else "\u2192 "
        lines.append(f"  {prefix}{label}  [{rec['elapsed_s']:.2f}s]")

    total = sum(r["elapsed_s"] for r in ordered)
    bottleneck = max(ordered, key=lambda r: r["elapsed_s"])
    bn_label = f"{bottleneck['display_name']} {bottleneck['elapsed_s']:.2f}s"
    lines.append(f"Total: {total:.2f}s / Bottleneck: {bn_label}")
    lines.append("========================")
    return "\n".join(lines)


def _order_records(
    records: list[dict[str, Any]],
    prompt: dict[str, Any],
) -> list[dict[str, Any]]:
    """prompt があればトポロジカル順、なければ実行順で返す。"""
    if not prompt:
        return list(records)

    edges = _build_graph(prompt)
    sorted_ids = _topological_sort(prompt, edges)

    record_map: dict[str, dict[str, Any]] = {}
    for rec in records:
        if rec["node_id"] != "?":
            record_map[rec["node_id"]] = rec

    ordered: list[dict[str, Any]] = []
    for nid in sorted_ids:
        if nid in record_map:
            ordered.append(record_map[nid])

    # sorted_ids に含まれなかった記録も追加（node_id="?" や孤立ノード）
    seen = {r["node_id"] for r in ordered}
    for rec in records:
        if rec["node_id"] not in seen:
            ordered.append(rec)

    return ordered


# ---------------------------------------------------------------------------
# 内部: JSONL ファイル出力
# ---------------------------------------------------------------------------


def _get_debug_output_dir() -> Path:
    """HTTP 非公開の system user ディレクトリ配下にログを出力する。"""
    import folder_paths  # type: ignore[import-untyped]

    debug_dir = Path(folder_paths.get_system_user_directory("sax_debug"))
    debug_dir.mkdir(parents=True, exist_ok=True)
    return debug_dir


def _write_jsonl(records: list[dict[str, Any]]) -> None:
    """記録を JSONL ファイルに書き出す。"""
    try:
        debug_dir = _get_debug_output_dir()
    except Exception:
        logger.warning("JSONL output skipped: folder_paths unavailable")
        return

    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    filepath = debug_dir / f"sax_debug_{ts}.jsonl"

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
        logger.info("Debug log written: %s", filepath)
        _cleanup_old_files(debug_dir)
    except OSError as exc:
        logger.warning("JSONL write failed: %s", exc)


def _cleanup_old_files(debug_dir: Path) -> None:
    """最新 _MAX_LOG_FILES 件を残し、古いファイルを削除する。"""
    files = sorted(
        debug_dir.glob("sax_debug_*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old_file in files[_MAX_LOG_FILES:]:
        try:
            old_file.unlink()
        except OSError as exc:
            logger.warning("Failed to delete old debug log: %s", exc)
