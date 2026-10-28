#!/usr/bin/env bash
# PR を push する前のローカル検査。GitHub Actions の CI は無いので、これが唯一の検査になる。
#   ruff check . → node --test → pytest tests/python
# 1 つ失敗しても残りは続行し、最後にまとめて結果を出す (終了コードは全部通ったときだけ 0)。
#
# 使い方: scripts/check.sh
# push 時に自動実行したいとき: git config core.hooksPath .githooks
set -u
cd "$(dirname "$0")/.."

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || { echo "python が見つかりません (PYTHON=... で指定できます)" >&2; exit 2; }

# テスト依存は tests/requirements.txt 参照。ComfyUI の venv ならほぼ揃っているので pytest だけ足す。
# クラウド環境では download.pytorch.org (CPU 版 index) が使えないため PyPI から入れる。
if ! "$PY" -c "import pytest, torch, numpy, PIL, aiohttp" 2>/dev/null; then
  echo "テスト依存が不足しています。次で導入してください:" >&2
  echo "  $PY -m pip install -r tests/requirements.txt" >&2
  exit 2
fi
command -v ruff >/dev/null 2>&1 || { echo "ruff が見つかりません: $PY -m pip install ruff" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node が見つかりません (Node 20 以上)" >&2; exit 2; }

failed=()
run() {
  local name="$1"; shift
  echo "=== $name: $*"
  if "$@"; then echo "--- $name: OK"; else echo "--- $name: FAILED"; failed+=("$name"); fi
  echo
}

run ruff ruff check .
# 引数なしの `node --test` はリポジトリ直下を再帰探索し、tests/js · unit · integration を取りこぼさない
run js node --test
run pytest "$PY" -m pytest tests/python -q

if [ ${#failed[@]} -eq 0 ]; then
  echo "すべての検査に成功しました。push できます。"
else
  echo "失敗した検査: ${failed[*]}" >&2
  exit 1
fi
