# SAX_Bridge 開発メモ

- **GitHub Actions の CI は無い。** PR を push する前に `scripts/check.sh`（ruff → `node --test` → `pytest tests/python`）をローカルで実行し、全部通ってから push する。
- push 時に自動実行したい場合は `git config core.hooksPath .githooks`（clone ごとに一度）。詳細は [tests/README.md](tests/README.md)。
- テスト依存は `pip install -r tests/requirements.txt`。クラウド環境では download.pytorch.org が 403 になるため PyPI から torch を入れる。
