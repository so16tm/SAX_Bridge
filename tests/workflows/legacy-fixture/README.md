# Legacy Workflow Fixture (FROZEN — DO NOT EDIT)

UI 全面再設計 ([docs/plans/20260503-ui-architecture-overhaul.md](../../../../docs/plans/20260503-ui-architecture-overhaul.md)) Phase 2 (シリアライズ統合) の migration テスト用に、リファクタ前の workflow JSON を凍結保存している。

## 凍結時点

- 凍結日: 2026-05-04
- pyproject.toml version: 2.2.0
- git commit hash: 20c46ce772f07c1ae2804529736e4a3986b2f153

## 編集禁止

本ディレクトリ配下の `.json` ファイルは編集禁止。Phase 2 の migration テストで「リファクタ前のスキーマ形」を入力データとして使うため、不変性を pytest (`tests/python/test_legacy_fixture_immutability.py`) で検証している。

## CHECKSUMS.txt 更新ポリシー (方針 B: 運用ルール)

CHECKSUMS.txt の変更が必要になった場合 (例: 凍結 fixture 自体に typo が見つかった、または Phase 進行中に新規 fixture を追加する場合) は、以下を必ず実施:

1. `CHANGELOG.md` に **変更理由 + Phase 名 + git commit hash** を追記
2. 設計レビュー (`A` agent) または `CR` (code-reviewer) のいずれかから承認を得る
3. CHECKSUMS.txt と対応 .json を同一 commit で更新
4. immutability test が再度 PASS することを確認

承認なしに CHECKSUMS.txt を更新してはならない。本ルール違反は immutability test の形骸化につながる。

## ファイル一覧

18 ファイル。`tests/workflows/01_*.json` 〜 `18_*.json` の凍結時点コピー。
