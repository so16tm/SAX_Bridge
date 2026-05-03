"""legacy-fixture/ の不変性検証。

CHECKSUMS.txt と現状ファイルの SHA-256 が一致することを保証する。Phase 2 (シリアライズ統合)
の migration テスト入力データを安定化させるため、凍結済み fixture の改変を検出する。

CHECKSUMS.txt 更新時は legacy-fixture/CHANGELOG.md への記録 + 設計レビュー承認が必須
(運用ルールは legacy-fixture/README.md 参照)。
"""

from pathlib import Path
import hashlib

import pytest

FIXTURE_DIR = Path(__file__).resolve().parents[1] / "workflows" / "legacy-fixture"
CHECKSUMS_FILE = FIXTURE_DIR / "CHECKSUMS.txt"


def _parse_checksums() -> dict[str, str]:
    """CHECKSUMS.txt を {filename: sha256hex} に変換。"""
    if not CHECKSUMS_FILE.exists():
        pytest.fail(f"{CHECKSUMS_FILE} が存在しません")
    result: dict[str, str] = {}
    for line in CHECKSUMS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            pytest.fail(f"CHECKSUMS.txt 行形式不正: {line!r}")
        digest, name = parts
        digest = digest.strip().lower()
        name = name.strip()
        if len(digest) != 64 or not all(c in "0123456789abcdef" for c in digest):
            pytest.fail(f"CHECKSUMS.txt: ダイジェスト形式不正: {line!r}")
        result[name] = digest
    return result


def _parse_checksums_safe() -> dict[str, str]:
    """コレクションフェーズで呼び出す safe 版。失敗時は空 dict を返す。

    _parse_checksums() が送出しうる例外は OSError (ファイル未存在) と
    pytest.fail() 由来の Failed (_pytest.outcomes.Failed、BaseException 派生)。
    Failed は except Exception では捕捉できないため、実質 OSError のみを抑制する。
    """
    try:
        return _parse_checksums()
    except OSError:
        return {}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


@pytest.fixture(scope="session")
def checksums() -> dict[str, str]:
    """テスト実行フェーズで CHECKSUMS.txt をパースする session-scoped fixture。"""
    return _parse_checksums()


@pytest.mark.parametrize("name", sorted(_parse_checksums_safe().keys()))
def test_legacy_fixture_unchanged(name: str, checksums: dict[str, str]) -> None:
    """凍結済み fixture の SHA-256 が CHECKSUMS.txt と一致する。"""
    path = FIXTURE_DIR / name
    assert path.exists(), f"{name}: legacy-fixture から消失"
    actual = _sha256(path)
    expected = checksums[name]
    assert actual == expected, (
        f"{name}: 凍結済み fixture が改変されています "
        f"(expected={expected[:16]}..., actual={actual[:16]}...)。"
        f"意図的な変更の場合は legacy-fixture/CHANGELOG.md に記録 + 設計レビュー承認後に "
        f"CHECKSUMS.txt を更新してください (legacy-fixture/README.md 参照)。"
    )


def test_no_unlisted_fixture_files(checksums: dict[str, str]) -> None:
    """legacy-fixture/ 内に CHECKSUMS.txt 未記載の .json が存在しない。
    .md / .txt は管理外ファイルとして意図的に除外している。"""
    actual_files = {p.name for p in FIXTURE_DIR.glob("*.json")}
    listed = set(checksums.keys())
    unlisted = actual_files - listed
    assert not unlisted, (
        f"CHECKSUMS.txt 未記載の fixture: {sorted(unlisted)}。"
        f"追加時は CHECKSUMS.txt と CHANGELOG.md を更新してください。"
    )
