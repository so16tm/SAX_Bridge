"""tests/workflows/*.json のスモーク検証。glob で全 JSON を動的に走査するため、ワークフロー追加・削除時にこのファイルの修正は不要。"""

from pathlib import Path
import json

import pytest

WORKFLOWS_DIR = Path(__file__).resolve().parents[1] / "workflows"


@pytest.mark.parametrize("path", sorted(WORKFLOWS_DIR.glob("*.json")), ids=lambda p: p.name)
def test_workflow_is_valid_json(path: Path) -> None:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)

    assert isinstance(data, dict), f"{path.name}: トップレベルは dict"
    assert "nodes" in data, f"{path.name}: nodes キー必須"
    assert isinstance(data["nodes"], list), f"{path.name}: nodes は配列"
