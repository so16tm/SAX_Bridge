"""``__init__.py`` の登録リストから検証対象ノードを取り出す共通処理。

``test_v3_schema.py`` と ``test_docs_schema_sync.py`` の双方が同じ「登録済み
ノード一覧」を使うための単一の出どころ。手書きのノード一覧を持たないことで、
ノードを追加しても検証対象から漏れない。
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INIT_PY = REPO_ROOT / "__init__.py"
NODES_DIR = REPO_ROOT / "nodes"


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


def parse_registration_entries() -> list[tuple[str, str]]:
    """``__init__.py`` の登録ループから (モジュール名, クラス名) を抽出する。

    ``NODE_CLASS_MAPPINGS`` へ代入している for ループのリスト要素
    （``module_alias.ClassName``）を読み、``from .nodes import x as module_alias``
    の別名を実モジュール名へ解決する。
    """
    tree = ast.parse(INIT_PY.read_text(encoding="utf-8"))

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


def load_registered_nodes() -> list[type]:
    """登録済みノードクラスを import して返す。"""
    classes: list[type] = []
    for module_name, class_name in parse_registration_entries():
        module = importlib.import_module(f"nodes.{module_name}")
        classes.append(getattr(module, class_name))
    return classes


def node_classes_defined_in_sources() -> set[str]:
    """``nodes/*.py`` に定義された ``io.ComfyNode`` 派生クラス名を集める。"""
    defined: set[str] = set()
    for path in sorted(NODES_DIR.rglob("*.py")):
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
