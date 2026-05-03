# Legacy Fixture CHANGELOG

CHECKSUMS.txt 変更時は本ファイルに **変更理由 + Phase 名 + git commit hash** を追記する。承認なしの更新禁止 (詳細は [README.md](README.md))。

## 2026-05-04 — 14_image_collector.json 修正 (CR 承認)

- 理由: CR (code-reviewer) 指摘 HIGH-2 対応。SAX_Bridge_Image_Preview ノードの inputs 配列から widget 専用フィールド (cell_w / max_cols / preview_quality) を除去し、既存 05_image_preview.json と同形式に統一。links の dst slot index も 3 → 0 に修正。承認: CR PASS (同セッション内)
- Phase: UI Phase 0
- git commit hash: a283a5d (Phase 0 commit)

## 2026-05-04 — 初回凍結

- 理由: UI Phase 0 (テスト整備) で legacy-fixture 新設。tests/workflows/ の 01-18 を凍結
- Phase: UI Phase 0
- git commit hash: 20c46ce772f07c1ae2804529736e4a3986b2f153 (凍結時点 HEAD)
- 承認: Plan 確定時の architect レビュー (2 回目) PASS
