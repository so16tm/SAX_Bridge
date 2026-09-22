"""``docs/nodes_ja.md`` / ``docs/nodes_en.md`` のノード節を構造化して読み出す。

ノードリファレンスは「見出し → ノード ID 行 → **入力** → **出力**」という
決まった並びで書かれている。この規約を機械的に読み取り、
``test_docs_schema_sync.py`` が ``define_schema()`` と突き合わせられる形にする。

**入力** の記法は 2 通りある。どちらも同じ結果（パラメータ名の並び）を返す。

1. 表形式::

       **入力**

       | パラメータ | 型 | 説明 |
       |-----------|-----|------|
       | `pipe` | PIPE_LINE | 入力パイプ |

2. インライン形式（スロットが多いノード等、表にすると冗長な場合）::

       **入力**: `slot_0` 〜 `slot_63` (ANY, optional) — 収集対象の IMAGE 出力

   ``—`` 以降の説明文と括弧内の注記（型・optional・選択肢）は読み飛ばし、
   ``a_0 〜 a_63`` のような連番レンジは全要素へ展開する。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DOCS_DIR = _REPO_ROOT / "docs"


@dataclass(frozen=True)
class DocsDialect:
    """言語ごとの見出しラベル。"""

    lang: str
    filename: str
    inputs_label: str
    outputs_label: str
    param_column: str
    index_heading: str
    no_output_marker: str

    @property
    def path(self) -> Path:
        return _DOCS_DIR / self.filename


JA = DocsDialect(
    lang="ja",
    filename="nodes_ja.md",
    inputs_label="入力",
    outputs_label="出力",
    param_column="パラメータ",
    index_heading="カテゴリ一覧",
    no_output_marker="なし",
)

EN = DocsDialect(
    lang="en",
    filename="nodes_en.md",
    inputs_label="Inputs",
    outputs_label="Outputs",
    param_column="Parameter",
    index_heading="Category List",
    no_output_marker="None",
)

DIALECTS = (JA, EN)


@dataclass
class DocsNode:
    """docs 内の 1 ノード節。"""

    node_id: str
    display_name: str
    category: str
    line: int
    inputs: list[str] = field(default_factory=list)
    has_inputs_section: bool = False
    outputs_text: str | None = None

    @property
    def location(self) -> str:
        return f"{self.display_name} (L{self.line})"


# ``### SAX Loader``
_HEADING_RE = re.compile(r"^###\s+(?P<name>.+?)\s*$")
_CATEGORY_RE = re.compile(r"^##\s+(?P<name>.+?)\s*$")
# ``​`SAX_Bridge_Loader` — 説明``
_NODE_ID_RE = re.compile(r"^`(?P<node_id>[A-Za-z0-9_]+)`\s*[—\-–]")
_BACKTICK_RE = re.compile(r"`([^`]+)`")
# ``​`slot_0` 〜 `slot_63```/``​`slot_0` to `slot_63```
_RANGE_RE = re.compile(
    r"`(?P<prefix>[A-Za-z_][A-Za-z0-9_]*?)(?P<start>\d+)`\s*(?:〜|~|–|-|to)\s*"
    r"`(?P=prefix)(?P<end>\d+)`"
)
_PARENS_RE = re.compile(r"[（(][^）)]*[）)]")
# インライン記述の末尾に付く「 — 説明文」
_TRAILING_NOTE_RE = re.compile(r"\s[—–]\s.*$")


def _expand_ranges(text: str) -> tuple[str, list[str]]:
    """連番レンジ表記を展開し、(レンジを除いた残りテキスト, 展開結果) を返す。"""
    expanded: list[str] = []

    def _replace(match: re.Match[str]) -> str:
        prefix = match.group("prefix")
        start = int(match.group("start"))
        end = int(match.group("end"))
        if end < start:
            raise ValueError(f"docs の連番レンジが逆順: {match.group(0)}")
        expanded.extend(f"{prefix}{index}" for index in range(start, end + 1))
        return " "

    remainder = _RANGE_RE.sub(_replace, text)
    return remainder, expanded


def _parse_inline_inputs(text: str) -> list[str]:
    """``**入力**: ...`` の 1 行からパラメータ名を取り出す。"""
    text = _TRAILING_NOTE_RE.sub("", text)
    text = _PARENS_RE.sub(" ", text)
    remainder, names = _expand_ranges(text)
    names.extend(_BACKTICK_RE.findall(remainder))
    return names


def _parse_table_inputs(lines: list[str], start: int, dialect: DocsDialect) -> list[str] | None:
    """``**入力**`` 直後の表を読む。表が続いていなければ None。"""
    index = start
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index >= len(lines) or not lines[index].lstrip().startswith("|"):
        return None

    header_cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
    if not header_cells or header_cells[0] != dialect.param_column:
        return None

    index += 2  # ヘッダ行と区切り行を飛ばす
    names: list[str] = []
    while index < len(lines) and lines[index].lstrip().startswith("|"):
        first_cell = lines[index].strip().strip("|").split("|")[0]
        remainder, expanded = _expand_ranges(first_cell)
        names.extend(expanded)
        names.extend(_BACKTICK_RE.findall(remainder))
        index += 1
    return names


def parse_docs(dialect: DocsDialect) -> dict[str, DocsNode]:
    """1 ファイル分のノード節を ``node_id -> DocsNode`` で返す。"""
    lines = dialect.path.read_text(encoding="utf-8").splitlines()

    nodes: dict[str, DocsNode] = {}
    category = ""
    current: DocsNode | None = None

    inputs_prefix = f"**{dialect.inputs_label}**"
    outputs_prefix = f"**{dialect.outputs_label}**"

    for number, line in enumerate(lines, start=1):
        category_match = _CATEGORY_RE.match(line)
        if category_match:
            category = category_match.group("name")
            current = None
            continue

        heading_match = _HEADING_RE.match(line)
        if heading_match:
            current = DocsNode(
                node_id="",
                display_name=heading_match.group("name"),
                category=category,
                line=number,
            )
            continue

        if current is None:
            continue

        if not current.node_id:
            node_id_match = _NODE_ID_RE.match(line.strip())
            if node_id_match:
                current.node_id = node_id_match.group("node_id")
                if current.node_id in nodes:
                    raise AssertionError(
                        f"{dialect.filename}: {current.node_id} の節が重複している (L{number})"
                    )
                nodes[current.node_id] = current
            continue

        stripped = line.strip()
        if stripped.startswith(inputs_prefix):
            current.has_inputs_section = True
            rest = stripped[len(inputs_prefix):].lstrip()
            if rest.startswith(":"):
                current.inputs = _parse_inline_inputs(rest[1:])
            else:
                table = _parse_table_inputs(lines, number, dialect)
                if table is None:
                    raise AssertionError(
                        f"{dialect.filename}: {current.display_name} (L{number}) の "
                        f"**{dialect.inputs_label}** に表もインライン記述も続いていない"
                    )
                current.inputs = table
        elif stripped.startswith(outputs_prefix):
            current.outputs_text = stripped[len(outputs_prefix):].lstrip(": ").strip()

    missing_id = [node.display_name for node in nodes.values() if not node.node_id]
    if missing_id:
        raise AssertionError(f"{dialect.filename}: ノード ID 行が無い節: {missing_id}")
    if not nodes:
        raise AssertionError(f"{dialect.filename} からノード節を 1 件も抽出できなかった")
    return nodes


def parse_category_index(dialect: DocsDialect) -> set[str]:
    """冒頭のカテゴリ一覧表がリンクしている表示名の集合を返す。"""
    lines = dialect.path.read_text(encoding="utf-8").splitlines()

    names: set[str] = set()
    in_index = False
    for line in lines:
        category_match = _CATEGORY_RE.match(line)
        if category_match:
            in_index = category_match.group("name") == dialect.index_heading
            continue
        if not in_index or not line.lstrip().startswith("|"):
            continue
        cells = line.strip().strip("|").split("|")
        if len(cells) < 3:
            continue
        names.update(re.findall(r"\[([^\]]+)\]\(#[^)]+\)", cells[2]))
    if not names:
        raise AssertionError(f"{dialect.filename}: カテゴリ一覧表からノードリンクを抽出できなかった")
    return names
