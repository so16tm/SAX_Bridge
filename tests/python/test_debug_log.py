"""SAX_Bridge Debug Log のテスト。"""

import json
import os
import types
from unittest.mock import MagicMock, patch

import pytest

from nodes.debug_log import (
    _build_graph,
    _build_graph_record,
    _build_input_summary,
    _build_output_summary,
    _build_parallel_groups,
    _cleanup_old_files,
    _enforce_record_limit,
    _format_flow_report,
    _order_records,
    _topological_sort,
    _try_capture_prompt,
    _try_get_unique_id,
    _write_jsonl,
    enable,
    disable,
    maybe_flush,
    wrap_execute,
)
import nodes.debug_log as debug_log_mod


# ---------------------------------------------------------------------------
# Fixture: モジュールグローバル状態のリセット
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_module_state():
    """各テスト前後で debug_log のグローバル状態をリセットする。"""
    debug_log_mod._report_requested = False
    debug_log_mod._explicitly_disabled = False
    debug_log_mod._execution_records = []
    debug_log_mod._prompt_data = {}
    yield
    debug_log_mod._report_requested = False
    debug_log_mod._explicitly_disabled = False
    debug_log_mod._execution_records = []
    debug_log_mod._prompt_data = {}


# ---------------------------------------------------------------------------
# is_enabled
# ---------------------------------------------------------------------------


class TestEnableDisable:
    def test_enable_sets_flag(self):
        cls = types.SimpleNamespace(hidden=types.SimpleNamespace(prompt={}, unique_id="1"))
        enable(cls)
        assert debug_log_mod._report_requested is True

    def test_disable_clears_flag(self):
        debug_log_mod._report_requested = True
        disable()
        assert debug_log_mod._report_requested is False
        assert debug_log_mod._explicitly_disabled is True

    def test_enable_captures_prompt(self):
        prompt_data = {"1": {"class_type": "Foo", "inputs": {"a": ["2", 0]}}}
        cls = types.SimpleNamespace(
            hidden=types.SimpleNamespace(prompt=prompt_data, unique_id="1")
        )
        enable(cls)
        assert debug_log_mod._prompt_data != {}

    def test_enable_does_not_flush(self):
        # enable は flush を行わず、フラグ設定と prompt 取得のみ行う
        # （flush は ComfyUI lifecycle hook 経由で on_prompt_end に発火する）
        debug_log_mod._execution_records = [
            {"node_id": "1", "class_type": "T", "display_name": "N",
             "input_summary": {}, "output_summary": {}, "elapsed_s": 0.1,
             "status": "OK", "error": None, "timestamp": "2026-01-01T00:00:00+00:00"}
        ]
        cls = types.SimpleNamespace(hidden=types.SimpleNamespace(prompt={}, unique_id="1"))
        with patch.object(debug_log_mod, "_write_jsonl") as mock_write:
            enable(cls)
        # flush されないので records は残ったまま
        assert len(debug_log_mod._execution_records) == 1
        mock_write.assert_not_called()
        assert debug_log_mod._report_requested is True

    def test_disable_clears_records(self):
        debug_log_mod._execution_records = [
            {"node_id": "1", "class_type": "T", "display_name": "N",
             "input_summary": {}, "output_summary": {}, "elapsed_s": 0.1,
             "status": "OK", "error": None, "timestamp": "2026-01-01T00:00:00+00:00"}
        ]
        with patch.object(debug_log_mod, "_write_jsonl") as mock_write:
            disable()
        # disable() はレコードを即座にクリアし、JSONL 出力を行わない
        assert len(debug_log_mod._execution_records) == 0
        mock_write.assert_not_called()
        assert debug_log_mod._report_requested is False
        assert debug_log_mod._explicitly_disabled is True


# ---------------------------------------------------------------------------
# _build_input_summary
# ---------------------------------------------------------------------------


class TestBuildInputSummary:
    def test_positional_args(self):
        result = _build_input_summary(["a", "b"], ("hello", 42), {})
        assert "a" in result
        assert "b" in result
        assert result["a"] == "hello"
        assert result["b"] == "42"

    def test_keyword_args(self):
        result = _build_input_summary(["x", "y"], (), {"x": "foo", "y": "bar"})
        assert result["x"] == "foo"
        assert result["y"] == "bar"

    def test_mixed_args(self):
        result = _build_input_summary(["a", "b", "c"], ("pos",), {"b": "kw", "c": "kw2"})
        assert result["a"] == "pos"
        assert result["b"] == "kw"
        assert result["c"] == "kw2"

    def test_kwargs_override_positional(self):
        result = _build_input_summary(["a"], ("positional",), {"a": "keyword"})
        assert result["a"] == "keyword"


# ---------------------------------------------------------------------------
# _build_output_summary
# ---------------------------------------------------------------------------


class TestBuildOutputSummary:
    def test_with_node_output_args(self):
        result_obj = types.SimpleNamespace(args=("img", "mask"))
        summary = _build_output_summary(result_obj)
        assert "output_0" in summary
        assert "output_1" in summary

    def test_with_empty_args(self):
        result_obj = types.SimpleNamespace(args=())
        summary = _build_output_summary(result_obj)
        assert "result" in summary

    def test_without_args_attr(self):
        result_obj = types.SimpleNamespace(value=42)
        summary = _build_output_summary(result_obj)
        assert "result" in summary

    def test_with_list_args(self):
        result_obj = types.SimpleNamespace(args=["a", "b"])
        summary = _build_output_summary(result_obj)
        assert "output_0" in summary
        assert "output_1" in summary

    def test_with_none_args(self):
        result_obj = types.SimpleNamespace(args=None)
        summary = _build_output_summary(result_obj)
        assert "result" in summary


# ---------------------------------------------------------------------------
# _build_graph
# ---------------------------------------------------------------------------


class TestBuildGraph:
    def test_linear_chain(self):
        prompt = {
            "1": {"inputs": {}},
            "2": {"inputs": {"image": ["1", 0]}},
            "3": {"inputs": {"image": ["2", 0]}},
        }
        edges = _build_graph(prompt)
        assert "2" in edges.get("1", [])
        assert "3" in edges.get("2", [])

    def test_branching(self):
        prompt = {
            "1": {"inputs": {}},
            "2": {"inputs": {"a": ["1", 0]}},
            "3": {"inputs": {"b": ["1", 0]}},
        }
        edges = _build_graph(prompt)
        assert sorted(edges["1"]) == ["2", "3"]

    def test_isolated_nodes(self):
        prompt = {
            "1": {"inputs": {}},
            "2": {"inputs": {}},
        }
        edges = _build_graph(prompt)
        assert edges == {}

    def test_ignores_non_link_inputs(self):
        prompt = {
            "1": {"inputs": {"value": 42, "text": "hello"}},
        }
        edges = _build_graph(prompt)
        assert edges == {}

    def test_ignores_reference_to_unknown_node(self):
        prompt = {
            "1": {"inputs": {"a": ["999", 0]}},
        }
        edges = _build_graph(prompt)
        assert edges == {}


# ---------------------------------------------------------------------------
# _topological_sort
# ---------------------------------------------------------------------------


class TestTopologicalSort:
    def test_linear(self):
        prompt = {"1": {}, "2": {}, "3": {}}
        edges = {"1": ["2"], "2": ["3"]}
        result = _topological_sort(prompt, edges)
        assert result.index("1") < result.index("2") < result.index("3")

    def test_diamond(self):
        prompt = {"1": {}, "2": {}, "3": {}, "4": {}}
        edges = {"1": ["2", "3"], "2": ["4"], "3": ["4"]}
        result = _topological_sort(prompt, edges)
        assert result.index("1") < result.index("2")
        assert result.index("1") < result.index("3")
        assert result.index("2") < result.index("4")
        assert result.index("3") < result.index("4")

    def test_isolated_nodes(self):
        prompt = {"1": {}, "2": {}, "3": {}}
        edges = {}
        result = _topological_sort(prompt, edges)
        assert sorted(result) == ["1", "2", "3"]

    def test_all_nodes_included(self):
        prompt = {"1": {}, "2": {}, "3": {}}
        edges = {"1": ["2"]}
        result = _topological_sort(prompt, edges)
        assert set(result) == {"1", "2", "3"}


# ---------------------------------------------------------------------------
# _format_flow_report
# ---------------------------------------------------------------------------


class TestFormatFlowReport:
    def _make_record(self, node_id, display_name="Node", elapsed=0.1):
        return {
            "node_id": node_id,
            "class_type": f"type_{node_id}",
            "display_name": display_name,
            "elapsed_s": elapsed,
            "status": "OK",
        }

    def test_empty_records(self):
        assert _format_flow_report([], {}) == ""

    def test_with_prompt_flow_order(self):
        # 新形式: ボトルネック表示なのでフロー順ではなく時間降順。
        # ただし Workflow 行・Bottlenecks 行・ノード名が含まれることを確認する。
        prompt = {
            "1": {"inputs": {}},
            "2": {"inputs": {"a": ["1", 0]}},
        }
        records = [
            self._make_record("2", "NodeB", 0.5),
            self._make_record("1", "NodeA", 0.3),
        ]
        report = _format_flow_report(records, prompt)
        assert "SAX Debug Report" in report
        assert "Workflow" in report
        assert "Bottlenecks" in report
        assert "NodeA" in report
        assert "NodeB" in report

    def test_without_prompt_execution_order(self):
        records = [
            self._make_record("1", "First", 0.1),
            self._make_record("2", "Second", 0.2),
        ]
        report = _format_flow_report(records, {})
        assert "SAX Debug Report" in report
        assert "Workflow" in report
        assert "Bottlenecks" in report

    def test_bottleneck_display(self):
        records = [
            self._make_record("1", "Fast", 0.1),
            self._make_record("2", "Slow", 5.0),
        ]
        report = _format_flow_report(records, {})
        assert "Slow" in report
        assert "5.00s" in report


# ---------------------------------------------------------------------------
# _order_records
# ---------------------------------------------------------------------------


class TestOrderRecords:
    def _make_record(self, node_id, display_name="Node"):
        return {
            "node_id": node_id,
            "class_type": f"type_{node_id}",
            "display_name": display_name,
            "elapsed_s": 0.1,
            "status": "OK",
        }

    def test_with_prompt_topological_order(self):
        prompt = {
            "1": {"inputs": {}},
            "2": {"inputs": {"a": ["1", 0]}},
        }
        records = [
            self._make_record("2"),
            self._make_record("1"),
        ]
        ordered = _order_records(records, prompt)
        assert ordered[0]["node_id"] == "1"
        assert ordered[1]["node_id"] == "2"

    def test_without_prompt_preserves_order(self):
        records = [
            self._make_record("2"),
            self._make_record("1"),
        ]
        ordered = _order_records(records, {})
        assert ordered[0]["node_id"] == "2"
        assert ordered[1]["node_id"] == "1"

    def test_unknown_node_id_appended(self):
        prompt = {"1": {"inputs": {}}}
        records = [
            self._make_record("1"),
            self._make_record("?", "Unknown"),
        ]
        ordered = _order_records(records, prompt)
        assert ordered[0]["node_id"] == "1"
        assert ordered[1]["node_id"] == "?"


# ---------------------------------------------------------------------------
# wrap_execute
# ---------------------------------------------------------------------------


class TestWrapExecute:
    def _make_node_class(self, node_id="TestNode", display_name="Test Node"):
        schema = types.SimpleNamespace(node_id=node_id, display_name=display_name)
        cls = MagicMock()
        cls.GET_SCHEMA.return_value = schema
        return cls

    def test_records_even_when_report_not_requested(self):
        # 常時記録方式: _report_requested が False でも記録される
        node_class = self._make_node_class()
        result_obj = types.SimpleNamespace(args=("output",))

        def original(cls, a, b):
            return result_obj

        wrapped = wrap_execute(original, node_class)
        result = wrapped(MagicMock(), "val_a", "val_b")

        assert result is result_obj
        assert len(debug_log_mod._execution_records) == 1

    def test_normal_execution(self):
        node_class = self._make_node_class()
        result_obj = types.SimpleNamespace(args=("output",))

        def original(cls, a, b):
            return result_obj

        wrapped = wrap_execute(original, node_class)
        result = wrapped(MagicMock(), "val_a", "val_b")

        assert result is result_obj
        assert len(debug_log_mod._execution_records) == 1
        assert debug_log_mod._execution_records[0]["status"] == "OK"

    def test_exception_recorded_and_reraised(self):
        node_class = self._make_node_class()

        def original(cls, a):
            raise ValueError("test error")

        wrapped = wrap_execute(original, node_class)

        with pytest.raises(ValueError, match="test error"):
            wrapped(MagicMock(), "val")

        assert len(debug_log_mod._execution_records) == 1
        assert debug_log_mod._execution_records[0]["status"] == "ERROR"
        assert debug_log_mod._execution_records[0]["error"] == "test error"

    def test_input_summary_recorded(self):
        node_class = self._make_node_class()

        def original(cls, image, mask):
            return types.SimpleNamespace(args=("out",))

        wrapped = wrap_execute(original, node_class)
        wrapped(MagicMock(), "img_data", mask="mask_data")

        record = debug_log_mod._execution_records[0]
        assert "image" in record["input_summary"]
        assert "mask" in record["input_summary"]

    def test_output_summary_recorded(self):
        node_class = self._make_node_class()

        def original(cls):
            return types.SimpleNamespace(args=("a", "b"))

        wrapped = wrap_execute(original, node_class)
        wrapped(MagicMock())

        record = debug_log_mod._execution_records[0]
        assert "output_0" in record["output_summary"]
        assert "output_1" in record["output_summary"]

    def test_class_type_and_display_name(self):
        node_class = self._make_node_class("MyNode", "My Display Name")

        def original(cls):
            return None

        wrapped = wrap_execute(original, node_class)
        wrapped(MagicMock())

        record = debug_log_mod._execution_records[0]
        assert record["class_type"] == "MyNode"
        assert record["display_name"] == "My Display Name"

    def test_skips_recording_when_explicitly_disabled(self):
        # disable() 後はレコード蓄積をスキップし、元の関数だけ実行する
        node_class = self._make_node_class()
        result_obj = types.SimpleNamespace(args=("output",))

        def original(cls, a):
            return result_obj

        wrapped = wrap_execute(original, node_class)
        debug_log_mod._explicitly_disabled = True
        result = wrapped(MagicMock(), "val")

        assert result is result_obj
        assert len(debug_log_mod._execution_records) == 0


# ---------------------------------------------------------------------------
# maybe_flush
# ---------------------------------------------------------------------------


class TestMaybeFlush:
    def test_flush_when_report_requested(self):
        debug_log_mod._report_requested = True
        debug_log_mod._execution_records = [
            {"node_id": "1", "class_type": "T", "display_name": "N",
             "input_summary": {}, "output_summary": {}, "elapsed_s": 0.1,
             "status": "OK", "error": None, "timestamp": "2026-01-01T00:00:00+00:00"}
        ]
        with patch.object(debug_log_mod, "_write_jsonl") as mock_write:
            maybe_flush()
        assert debug_log_mod._execution_records == []
        mock_write.assert_called_once()

    def test_discard_when_report_not_requested(self):
        # _report_requested=False の場合は出力せず破棄のみ
        debug_log_mod._report_requested = False
        debug_log_mod._execution_records = [
            {"node_id": "1", "class_type": "T", "display_name": "N",
             "input_summary": {}, "output_summary": {}, "elapsed_s": 0.1,
             "status": "OK", "error": None, "timestamp": "2026-01-01T00:00:00+00:00"}
        ]
        with patch.object(debug_log_mod, "_write_jsonl") as mock_write:
            maybe_flush()
        assert debug_log_mod._execution_records == []
        mock_write.assert_not_called()

    def test_noop_when_no_records(self):
        maybe_flush()
        assert debug_log_mod._execution_records == []


# ---------------------------------------------------------------------------
# _enforce_record_limit
# ---------------------------------------------------------------------------


class TestEnforceRecordLimit:
    def test_fifo_when_limit_reached(self):
        # 1000件到達時に古い記録から削除し、999件を保持する
        debug_log_mod._execution_records = [{"node_id": str(i)} for i in range(1000)]
        _enforce_record_limit()
        assert len(debug_log_mod._execution_records) == 999
        # 最古の記録（"0"）が削除され、最新の記録（"999"）が保持される
        assert debug_log_mod._execution_records[0]["node_id"] == "1"
        assert debug_log_mod._execution_records[-1]["node_id"] == "999"

    def test_keeps_when_under_limit(self):
        debug_log_mod._execution_records = [{"node_id": str(i)} for i in range(100)]
        _enforce_record_limit()
        assert len(debug_log_mod._execution_records) == 100

    def test_no_drop_at_999(self):
        # 999件では発動しない
        debug_log_mod._execution_records = [{"node_id": str(i)} for i in range(999)]
        _enforce_record_limit()
        assert len(debug_log_mod._execution_records) == 999


# ---------------------------------------------------------------------------
# _write_jsonl
# ---------------------------------------------------------------------------


class TestWriteJsonl:
    def test_creates_jsonl_file(self, tmp_path):
        with patch.object(debug_log_mod, "_get_debug_output_dir", return_value=tmp_path):
            records = [
                {"node_id": "1", "status": "OK"},
                {"node_id": "2", "status": "ERROR"},
            ]
            _write_jsonl(records)

        files = list(tmp_path.glob("sax_debug_*.jsonl"))
        assert len(files) == 1

        lines = files[0].read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 2
        assert json.loads(lines[0])["node_id"] == "1"
        assert json.loads(lines[1])["node_id"] == "2"

    def test_skips_when_folder_paths_unavailable(self):
        with patch.object(
            debug_log_mod, "_get_debug_output_dir", side_effect=ImportError
        ):
            _write_jsonl([{"node_id": "1"}])


# ---------------------------------------------------------------------------
# _cleanup_old_files
# ---------------------------------------------------------------------------


class TestCleanupOldFiles:
    def test_removes_excess_files(self, tmp_path):
        for i in range(25):
            f = tmp_path / f"sax_debug_{i:04d}.jsonl"
            f.write_text("")
            os.utime(f, (i, i))

        _cleanup_old_files(tmp_path)

        remaining = list(tmp_path.glob("sax_debug_*.jsonl"))
        assert len(remaining) == 20

    def test_keeps_all_when_under_limit(self, tmp_path):
        for i in range(5):
            f = tmp_path / f"sax_debug_{i:04d}.jsonl"
            f.write_text("")

        _cleanup_old_files(tmp_path)

        remaining = list(tmp_path.glob("sax_debug_*.jsonl"))
        assert len(remaining) == 5


# ---------------------------------------------------------------------------
# _try_get_unique_id
# ---------------------------------------------------------------------------


class TestTryGetUniqueId:
    def test_with_hidden_holder(self):
        cls = types.SimpleNamespace(hidden=types.SimpleNamespace(unique_id="42"))
        assert _try_get_unique_id(cls) == "42"

    def test_with_int_unique_id(self):
        cls = types.SimpleNamespace(hidden=types.SimpleNamespace(unique_id=99))
        assert _try_get_unique_id(cls) == "99"

    def test_without_hidden(self):
        cls = types.SimpleNamespace()
        assert _try_get_unique_id(cls) == "?"

    def test_hidden_without_unique_id(self):
        cls = types.SimpleNamespace(hidden=types.SimpleNamespace())
        assert _try_get_unique_id(cls) == "?"

    def test_hidden_none(self):
        cls = types.SimpleNamespace(hidden=None)
        assert _try_get_unique_id(cls) == "?"


# ---------------------------------------------------------------------------
# _try_capture_prompt
# ---------------------------------------------------------------------------


class TestTryCapturePrompt:
    def test_captures_prompt(self):
        prompt_data = {"1": {"class_type": "Foo", "inputs": {"a": ["2", 0]}}}
        cls = types.SimpleNamespace(
            hidden=types.SimpleNamespace(prompt=prompt_data)
        )
        _try_capture_prompt(cls)
        # _sanitize_prompt で接続情報のみ保持される
        assert debug_log_mod._prompt_data == {
            "1": {"class_type": "Foo", "inputs": {"a": ["2", 0]}}
        }

    def test_does_not_overwrite_existing(self):
        debug_log_mod._prompt_data = {"existing": True}
        cls = types.SimpleNamespace(
            hidden=types.SimpleNamespace(prompt={"new": True})
        )
        _try_capture_prompt(cls)
        assert debug_log_mod._prompt_data == {"existing": True}

    def test_no_hidden(self):
        cls = types.SimpleNamespace()
        _try_capture_prompt(cls)
        assert debug_log_mod._prompt_data == {}

    def test_hidden_without_prompt(self):
        cls = types.SimpleNamespace(hidden=types.SimpleNamespace())
        _try_capture_prompt(cls)
        assert debug_log_mod._prompt_data == {}

    def test_empty_prompt_not_captured(self):
        cls = types.SimpleNamespace(
            hidden=types.SimpleNamespace(prompt={})
        )
        _try_capture_prompt(cls)
        assert debug_log_mod._prompt_data == {}


# ---------------------------------------------------------------------------
# _build_graph_record
# ---------------------------------------------------------------------------


class TestBuildGraphRecord:
    def test_basic_structure(self):
        prompt = {
            "1": {"class_type": "A", "inputs": {}},
            "2": {"class_type": "B", "inputs": {"x": ["1", 0]}},
        }
        record = _build_graph_record(prompt)
        assert record["type"] == "graph"
        assert "edges" in record
        assert "reverse" in record
        assert "parallel_groups" in record

    def test_edges_and_reverse(self):
        prompt = {
            "1": {"class_type": "A", "inputs": {}},
            "2": {"class_type": "B", "inputs": {"x": ["1", 0]}},
        }
        record = _build_graph_record(prompt)
        assert record["edges"] == {"1": ["2"]}
        assert record["reverse"] == {"2": ["1"]}

    def test_empty_prompt(self):
        record = _build_graph_record({})
        assert record["type"] == "graph"
        assert record["edges"] == {}
        assert record["reverse"] == {}
        assert record["parallel_groups"] == []

    def test_no_connections(self):
        prompt = {
            "1": {"class_type": "A", "inputs": {}},
            "2": {"class_type": "B", "inputs": {}},
        }
        record = _build_graph_record(prompt)
        assert record["edges"] == {}
        assert record["reverse"] == {}
        # 両ノードとも wave=0 なので同一グループ
        assert sorted(record["parallel_groups"][0]) == ["1", "2"]


# ---------------------------------------------------------------------------
# _build_parallel_groups
# ---------------------------------------------------------------------------


class TestBuildParallelGroups:
    def test_linear_chain(self):
        prompt = {"1": {}, "2": {}, "3": {}}
        edges = {"1": ["2"], "2": ["3"]}
        groups = _build_parallel_groups(prompt, edges)
        # 各ノードが別グループ
        assert len(groups) == 3
        assert ["1"] in groups
        assert ["2"] in groups
        assert ["3"] in groups

    def test_parallel_branches(self):
        # 1 → 2, 1 → 3 （2と3は並列）
        prompt = {"1": {}, "2": {}, "3": {}}
        edges = {"1": ["2", "3"]}
        groups = _build_parallel_groups(prompt, edges)
        assert len(groups) == 2
        assert ["1"] in groups
        assert sorted(groups[1]) == ["2", "3"]

    def test_diamond(self):
        # 1 → 2, 1 → 3, 2 → 4, 3 → 4
        prompt = {"1": {}, "2": {}, "3": {}, "4": {}}
        edges = {"1": ["2", "3"], "2": ["4"], "3": ["4"]}
        groups = _build_parallel_groups(prompt, edges)
        # wave: 1=0, 2=1, 3=1, 4=2
        assert len(groups) == 3
        assert ["1"] in groups
        assert sorted(groups[1]) == ["2", "3"]
        assert ["4"] in groups

    def test_isolated_nodes_same_group(self):
        prompt = {"1": {}, "2": {}, "3": {}}
        edges = {}
        groups = _build_parallel_groups(prompt, edges)
        assert len(groups) == 1
        assert sorted(groups[0]) == ["1", "2", "3"]


# ---------------------------------------------------------------------------
# _write_jsonl (graph record)
# ---------------------------------------------------------------------------


class TestWriteJsonlGraphRecord:
    def test_graph_record_appended_when_prompt_data_set(self, tmp_path):
        prompt_data = {
            "1": {"class_type": "A", "inputs": {}},
            "2": {"class_type": "B", "inputs": {"x": ["1", 0]}},
        }
        with patch.object(debug_log_mod, "_get_debug_output_dir", return_value=tmp_path):
            _write_jsonl([{"node_id": "1", "status": "OK"}], prompt_data)

        files = list(tmp_path.glob("sax_debug_*.jsonl"))
        lines = files[0].read_text(encoding="utf-8").strip().split("\n")
        # 通常レコード1行 + グラフレコード1行
        assert len(lines) == 2
        last = json.loads(lines[-1])
        assert last["type"] == "graph"
        assert "edges" in last
        assert "reverse" in last
        assert "parallel_groups" in last

    def test_no_graph_record_when_prompt_data_none(self, tmp_path):
        with patch.object(debug_log_mod, "_get_debug_output_dir", return_value=tmp_path):
            _write_jsonl([{"node_id": "1", "status": "OK"}], None)

        files = list(tmp_path.glob("sax_debug_*.jsonl"))
        lines = files[0].read_text(encoding="utf-8").strip().split("\n")
        # グラフレコードなし
        assert len(lines) == 1
        assert "type" not in json.loads(lines[0])

    def test_no_graph_record_when_prompt_data_empty(self, tmp_path):
        with patch.object(debug_log_mod, "_get_debug_output_dir", return_value=tmp_path):
            _write_jsonl([{"node_id": "1", "status": "OK"}], {})

        files = list(tmp_path.glob("sax_debug_*.jsonl"))
        lines = files[0].read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 1
