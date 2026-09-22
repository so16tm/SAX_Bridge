"""全 V3 ノードのスキーマ構造を検証する。

検証対象のノード一覧は ``__init__.py`` の ``NODE_CLASS_MAPPINGS`` 登録リストから
自動抽出する。手書きリストを廃止したことで、ノードを追加しても検証対象から
漏れることがない。抽出結果が実物と一致することは以下の 2 本で担保する。

* ``TestRegistrationCoverage.test_every_node_class_is_registered``
  — ``nodes/*.py`` に定義された全 ``io.ComfyNode`` 派生ノードが登録されているか
* ``TestRegistrationCoverage.test_matches_runtime_class_mappings``
  — 抽出結果が実行時の ``NODE_CLASS_MAPPINGS`` と一致するか
"""

import ast
import importlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INIT_PY = _REPO_ROOT / "__init__.py"
_NODES_DIR = _REPO_ROOT / "nodes"
_PACKAGE_PROBE = Path(__file__).resolve().parent / "_package_probe.py"


# ---------------------------------------------------------------------------
# __init__.py の登録リストからノードクラスを抽出する
# ---------------------------------------------------------------------------


def _assigns_to_class_mappings(loop: ast.For) -> bool:
    """ループ本体が ``NODE_CLASS_MAPPINGS[...]`` へ代入しているか判定する。"""
    for node in ast.walk(loop):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if (
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Name)
                and target.value.id == "NODE_CLASS_MAPPINGS"
            ):
                return True
    return False


def _parse_registration_entries() -> list[tuple[str, str]]:
    """``__init__.py`` の登録ループから (モジュール名, クラス名) を抽出する。

    ``NODE_CLASS_MAPPINGS`` へ代入している for ループのリスト要素
    （``module_alias.ClassName``）を読み、``from .nodes import x as module_alias``
    の別名を実モジュール名へ解決する。
    """
    tree = ast.parse(_INIT_PY.read_text(encoding="utf-8"))

    alias_to_module: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module == "nodes":
            for alias in node.names:
                alias_to_module[alias.asname or alias.name] = alias.name

    entries: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.For) or not isinstance(node.iter, ast.List):
            continue
        if not _assigns_to_class_mappings(node):
            continue
        for element in node.iter.elts:
            if not (isinstance(element, ast.Attribute) and isinstance(element.value, ast.Name)):
                raise AssertionError(
                    f"__init__.py の登録リストに未対応の記法がある: {ast.dump(element)}"
                )
            module_name = alias_to_module.get(element.value.id)
            if module_name is None:
                raise AssertionError(
                    f"__init__.py の登録リストの {element.value.id} が nodes 配下の import に紐づかない"
                )
            entries.append((module_name, element.attr))

    if not entries:
        raise AssertionError(
            "__init__.py から登録ノードを抽出できなかった。"
            "登録リストの記法が変わった可能性があるため、この抽出処理を更新すること。"
        )
    return entries


def _load_registered_nodes() -> list[type]:
    classes: list[type] = []
    for module_name, class_name in _parse_registration_entries():
        module = importlib.import_module(f"nodes.{module_name}")
        classes.append(getattr(module, class_name))
    return classes


def _node_classes_defined_in_sources() -> set[str]:
    """``nodes/*.py`` に定義された ``io.ComfyNode`` 派生クラス名を集める。"""
    defined: set[str] = set()
    for path in sorted(_NODES_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            for base in node.bases:
                if isinstance(base, ast.Attribute) and base.attr == "ComfyNode":
                    defined.add(node.name)
                elif isinstance(base, ast.Name) and base.id == "ComfyNode":
                    defined.add(node.name)
    return defined


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
