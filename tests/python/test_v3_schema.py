"""全 V3 ノードのスキーマ構造を検証する。

検証対象のノード一覧は ``__init__.py`` の ``NODE_CLASS_MAPPINGS`` 登録リストから
自動抽出する（抽出処理は ``_node_registry`` に共通化してある）。手書きリストを
廃止したことで、ノードを追加しても検証対象から漏れることがない。
抽出結果が実物と一致することは以下の 2 本で担保する。

* ``TestRegistrationCoverage.test_every_node_class_is_registered``
  — ``nodes/*.py`` に定義された全 ``io.ComfyNode`` 派生ノードが登録されているか
* ``TestRegistrationCoverage.test_matches_runtime_class_mappings``
  — 抽出結果が実行時の ``NODE_CLASS_MAPPINGS`` と一致するか

docs/nodes_*.md との突合は ``test_docs_schema_sync.py`` が担当する。
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from _node_registry import (
    REPO_ROOT as _REPO_ROOT,
    load_registered_nodes as _load_registered_nodes,
    node_classes_defined_in_sources as _node_classes_defined_in_sources,
)

_PACKAGE_PROBE = Path(__file__).resolve().parent / "_package_probe.py"


ALL_V3_NODES = _load_registered_nodes()


@pytest.mark.parametrize("node_cls", ALL_V3_NODES, ids=lambda c: c.__name__)
class TestV3Schema:
    def test_has_define_schema(self, node_cls):
        assert hasattr(node_cls, "define_schema"), f"{node_cls.__name__} に define_schema がない"

    def test_schema_has_required_fields(self, node_cls):
        schema = node_cls.define_schema()
        assert hasattr(schema, "node_id"), f"{node_cls.__name__}: node_id がない"
        assert hasattr(schema, "display_name"), f"{node_cls.__name__}: display_name がない"
        assert hasattr(schema, "category"), f"{node_cls.__name__}: category がない"
        assert hasattr(schema, "inputs"), f"{node_cls.__name__}: inputs がない"
        assert hasattr(schema, "outputs"), f"{node_cls.__name__}: outputs がない"

    def test_node_id_is_string(self, node_cls):
        schema = node_cls.define_schema()
        assert isinstance(schema.node_id, str) and len(schema.node_id) > 0

    def test_has_execute_classmethod(self, node_cls):
        assert hasattr(node_cls, "execute"), f"{node_cls.__name__} に execute がない"

    def test_no_v2_remnants(self, node_cls):
        assert not hasattr(node_cls, "INPUT_TYPES") or not callable(getattr(node_cls, "INPUT_TYPES", None)), \
            f"{node_cls.__name__} に V2 API INPUT_TYPES が残っている"
        for attr in ("RETURN_TYPES", "RETURN_NAMES", "FUNCTION", "CATEGORY"):
            val = getattr(node_cls, attr, None)
            if val is not None and not callable(val):
                assert isinstance(val, type(None)), f"{node_cls.__name__} に V2 API {attr} が残っている"

    def test_get_schema_works(self, node_cls):
        schema = node_cls.GET_SCHEMA()
        assert schema.node_id == node_cls.define_schema().node_id


class TestRegistrationCoverage:
    """検証対象リストと実際の登録内容の突合。"""

    def test_every_node_class_is_registered(self):
        """nodes/*.py の全ノードクラスが __init__.py に登録されていること。"""
        registered = {cls.__name__ for cls in ALL_V3_NODES}
        missing = _node_classes_defined_in_sources() - registered
        assert not missing, (
            "__init__.py の NODE_CLASS_MAPPINGS に未登録のノードがある: "
            + ", ".join(sorted(missing))
        )

    def test_node_ids_are_unique(self):
        node_ids = [cls.GET_SCHEMA().node_id for cls in ALL_V3_NODES]
        duplicates = sorted({nid for nid in node_ids if node_ids.count(nid) > 1})
        assert not duplicates, f"node_id が重複している: {', '.join(duplicates)}"

    def test_matches_runtime_class_mappings(self):
        """抽出したノード一覧が実行時の NODE_CLASS_MAPPINGS と一致すること。

        パッケージ本体の import は全ノードの execute をラップするため、
        他テストへの副作用を避けてサブプロセスで実行する。
        """
        completed = subprocess.run(
            [sys.executable, str(_PACKAGE_PROBE), str(_REPO_ROOT)],
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, (
            f"パッケージの import に失敗した:\n{completed.stderr}"
        )
        probed = json.loads(completed.stdout)

        expected = {cls.GET_SCHEMA().node_id: cls.__name__ for cls in ALL_V3_NODES}
        assert probed["class_mappings"] == expected, (
            "検証対象と NODE_CLASS_MAPPINGS が一致しない"
        )
        assert set(probed["display_name_mappings"]) == set(expected), (
            "NODE_DISPLAY_NAME_MAPPINGS のキーが NODE_CLASS_MAPPINGS と一致しない"
        )
