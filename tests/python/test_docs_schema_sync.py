"""``docs/nodes_ja.md`` / ``docs/nodes_en.md`` と ``define_schema()`` の整合を検証する。

ノードリファレンスのウィジェット表は手書きなので、実装だけを変えると静かに
ドリフトする。実際 SAX Cache の docs には実装に存在しない `tgate_enabled` /
`tgate_gate_step` が長く残り、SAX Guidance と SAX Debug Controller は
リファレンスに 1 行も載っていなかった。このテストは

* docs にしか無い入力（実装から消えた／最初から無かった記述）
* 実装にしか無い入力（docs へ未反映の追加）

の両方向を機械的に検出する。検証対象ノードは ``test_v3_schema.py`` と同じく
``__init__.py`` の登録リストから自動抽出するため、ノードを足せば自動的に
「docs も書け」と言われる。

docs の書式は ``_docs_reference.py`` のモジュール docstring を参照。

**対象外**: 入力の記載順。docs は接続入力（`pipe` / `image` 等）を先に並べる方が
読みやすく、``define_schema`` の宣言順と意図的に違うノードがある。

**対象外**: 出力名。``define_schema`` の ``Output`` は位置引数の id・
``display_name=`` キーワード・引数なしが混在しており、機械的に比較できる
名前を持たないノードがある。出力については「終端ノード（出力 0 本）かどうか」
だけを突き合わせる。
"""

from __future__ import annotations

import pytest

from _docs_reference import DIALECTS, EN, JA, parse_category_index, parse_docs
from _node_registry import load_registered_nodes

# ---------------------------------------------------------------------------
# 既知のドリフト（意図的な一時例外）
# ---------------------------------------------------------------------------
#
# 現在は空。docs の当該箇所を別 PR が直している最中など、この PR では触れない方が
# よいドリフトを一時的に通すためだけの逃げ道として残してある。
#
# ここに書けるのは「docs にあるが実装に無い入力名」だけ。実装側にしか無い入力を
# 見逃す抜け道は用意しない（docs に書けば済むため）。
#
# 各エントリは test_known_drift_is_still_drifting が検証する。docs が直れば
# そのテストが「このエントリを消せ」と失敗するので、例外が残り続けることはない。
_KNOWN_DOC_DRIFT: dict[str, set[str]] = {}


ALL_NODES = load_registered_nodes()
SCHEMAS = {cls.GET_SCHEMA().node_id: cls.GET_SCHEMA() for cls in ALL_NODES}
DOCS = {dialect.lang: parse_docs(dialect) for dialect in DIALECTS}

_DIALECT_IDS = [dialect.lang for dialect in DIALECTS]
_NODE_CASES = [
    pytest.param(dialect, node_id, id=f"{dialect.lang}-{node_id}")
    for dialect in DIALECTS
    for node_id in sorted(SCHEMAS)
]


def _schema_input_ids(node_id: str) -> list[str]:
    return [inp.id for inp in SCHEMAS[node_id].inputs]


# ---------------------------------------------------------------------------
# ノード単位の網羅
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("dialect", DIALECTS, ids=_DIALECT_IDS)
class TestNodeCoverage:
    def test_every_registered_node_is_documented(self, dialect):
        missing = sorted(set(SCHEMAS) - set(DOCS[dialect.lang]))
        assert not missing, (
            f"{dialect.filename} に節が無い登録済みノード: {', '.join(missing)}"
        )

    def test_documented_node_is_registered(self, dialect):
        unknown = sorted(set(DOCS[dialect.lang]) - set(SCHEMAS))
        assert not unknown, (
            f"{dialect.filename} に登録されていないノードの節がある: {', '.join(unknown)}"
        )

    def test_category_index_matches_sections(self, dialect):
        indexed = parse_category_index(dialect)
        sectioned = {node.display_name for node in DOCS[dialect.lang].values()}
        assert indexed == sectioned, (
            f"{dialect.filename}: カテゴリ一覧表と節の一覧が食い違っている\n"
            f"  一覧表だけにある: {sorted(indexed - sectioned)}\n"
            f"  節だけにある    : {sorted(sectioned - indexed)}"
        )


# ---------------------------------------------------------------------------
# ノード見出しとスキーマのメタ情報
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("dialect", "node_id"), _NODE_CASES)
class TestNodeHeading:
    def test_display_name_matches(self, dialect, node_id):
        docs_node = DOCS[dialect.lang].get(node_id)
        if docs_node is None:
            pytest.skip("test_every_registered_node_is_documented が検出する")
        assert docs_node.display_name == SCHEMAS[node_id].display_name, (
            f"{dialect.filename} L{docs_node.line}: 見出しが display_name と違う"
        )

    def test_category_matches(self, dialect, node_id):
        docs_node = DOCS[dialect.lang].get(node_id)
        if docs_node is None:
            pytest.skip("test_every_registered_node_is_documented が検出する")
        expected = SCHEMAS[node_id].category.rsplit("/", 1)[-1]
        assert docs_node.category == expected, (
            f"{dialect.filename} L{docs_node.line}: {node_id} の節が "
            f"'## {docs_node.category}' の下にあるが、category は "
            f"'{SCHEMAS[node_id].category}'"
        )


# ---------------------------------------------------------------------------
# 入力（ウィジェット）の突合 — 本体
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("dialect", "node_id"), _NODE_CASES)
class TestInputSync:
    def test_inputs_section_exists(self, dialect, node_id):
        docs_node = DOCS[dialect.lang].get(node_id)
        if docs_node is None:
            pytest.skip("test_every_registered_node_is_documented が検出する")
        expected = bool(_schema_input_ids(node_id))
        assert docs_node.has_inputs_section == expected, (
            f"{dialect.filename} L{docs_node.line}: {node_id} の "
            f"**{dialect.inputs_label}** の有無が実装と食い違っている"
            f"（実装の入力数 = {len(_schema_input_ids(node_id))}）"
        )

    def test_no_duplicated_entries(self, dialect, node_id):
        docs_node = DOCS[dialect.lang].get(node_id)
        if docs_node is None or not docs_node.has_inputs_section:
            pytest.skip("他のテストが検出する")
        seen: set[str] = set()
        duplicated = sorted({n for n in docs_node.inputs if n in seen or seen.add(n)})
        assert not duplicated, (
            f"{dialect.filename} L{docs_node.line}: {node_id} の入力が重複記載: "
            f"{', '.join(duplicated)}"
        )

    def test_input_names_match_schema(self, dialect, node_id):
        docs_node = DOCS[dialect.lang].get(node_id)
        if docs_node is None or not docs_node.has_inputs_section:
            pytest.skip("他のテストが検出する")

        schema_ids = _schema_input_ids(node_id)
        allowed = _KNOWN_DOC_DRIFT.get(node_id, set())

        only_in_docs = [
            name for name in docs_node.inputs
            if name not in schema_ids and name not in allowed
        ]
        only_in_schema = [name for name in schema_ids if name not in docs_node.inputs]

        assert not only_in_docs and not only_in_schema, (
            f"{dialect.filename} L{docs_node.line}: {node_id} の入力が "
            f"define_schema と一致しない\n"
            f"  docs にしか無い  : {only_in_docs}\n"
            f"  実装にしか無い  : {only_in_schema}\n"
            f"  実装の入力      : {schema_ids}"
        )


# ---------------------------------------------------------------------------
# 出力（終端ノードかどうかだけ）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("dialect", "node_id"), _NODE_CASES)
def test_terminal_node_is_documented_as_such(dialect, node_id):
    docs_node = DOCS[dialect.lang].get(node_id)
    if docs_node is None:
        pytest.skip("test_every_registered_node_is_documented が検出する")

    assert docs_node.outputs_text is not None, (
        f"{dialect.filename} L{docs_node.line}: {node_id} に "
        f"**{dialect.outputs_label}** の記載が無い"
    )
    documented_as_terminal = docs_node.outputs_text.startswith(dialect.no_output_marker)
    is_terminal = len(SCHEMAS[node_id].outputs) == 0
    assert documented_as_terminal == is_terminal, (
        f"{dialect.filename} L{docs_node.line}: {node_id} の出力記載 "
        f"'{docs_node.outputs_text}' が実装の出力数 "
        f"{len(SCHEMAS[node_id].outputs)} と食い違っている"
    )


# ---------------------------------------------------------------------------
# 日英の対応
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("node_id", sorted(SCHEMAS))
def test_ja_and_en_document_the_same_inputs(node_id):
    ja_node = DOCS[JA.lang].get(node_id)
    en_node = DOCS[EN.lang].get(node_id)
    if ja_node is None or en_node is None:
        pytest.skip("test_every_registered_node_is_documented が検出する")
    assert ja_node.inputs == en_node.inputs, (
        f"{node_id} の入力記載が日英で違う\n"
        f"  ja: {ja_node.inputs}\n"
        f"  en: {en_node.inputs}"
    )


# ---------------------------------------------------------------------------
# 例外リストの鮮度
# ---------------------------------------------------------------------------


class TestKnownDriftIsStale:
    def test_known_drift_nodes_exist(self):
        unknown = sorted(set(_KNOWN_DOC_DRIFT) - set(SCHEMAS))
        assert not unknown, (
            f"_KNOWN_DOC_DRIFT に存在しないノードが残っている: {', '.join(unknown)}"
        )

    @pytest.mark.parametrize("node_id", sorted(_KNOWN_DOC_DRIFT))
    def test_known_drift_is_still_drifting(self, node_id):
        """例外エントリが「まだドリフトしている」ことを確認する。

        docs が直った（または実装側に入力が追加された）のに例外が残っていると、
        本来検出すべきドリフトを握りつぶしてしまう。ここで失敗させて掃除を促す。
        """
        schema_ids = set(_schema_input_ids(node_id))
        resolved = sorted(_KNOWN_DOC_DRIFT[node_id] & schema_ids)
        assert not resolved, (
            f"_KNOWN_DOC_DRIFT[{node_id!r}] の {resolved} は実装に存在する。"
            "例外エントリを削除すること。"
        )
        for dialect in DIALECTS:
            docs_node = DOCS[dialect.lang].get(node_id)
            if docs_node is None:
                continue
            stale = sorted(_KNOWN_DOC_DRIFT[node_id] - set(docs_node.inputs))
            assert not stale, (
                f"_KNOWN_DOC_DRIFT[{node_id!r}] の {stale} は "
                f"{dialect.filename} にもう書かれていない。例外エントリを削除すること。"
            )
