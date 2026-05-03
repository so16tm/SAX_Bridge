# Regression Matrix

UI 全面再設計 ([docs/plans/20260503-ui-architecture-overhaul.md](../../../docs/plans/20260503-ui-architecture-overhaul.md)) の各 Phase で「変更前後の動作同一性」を検証するマトリクス。MANUAL_TEST.md (シナリオ集) とは独立し、Phase 1〜10 共通で繰り返し参照する。

## 運用ルール

- マトリクスのセルを増減する際は、対応する MANUAL_TEST.md K/L 節の行も同時更新する (末尾の紐付け表参照)
- ベースライン記録は **Phase 1.0 着手前** にユーザーが手動実行し、「現状ベースライン」節を埋める
- CHECKSUMS.txt 更新は `legacy-fixture/CHANGELOG.md` への記録 + 設計レビュー (`A`) または `CR` 承認が必須 (スキーマ変更を伴う場合は `A`、typo 修正等の軽微な変更は `CR` で可)

## Phase 1 専用部 (動的スロット系)

5 ノード × 7 経路 × 3 リンク状態のセルを定義。優先度 (priority) は重要セル (★) とサンプリングセル (○) の 2 段階。

### 経路定義

`canvas-ui/dynamic-slots.md` 必須フック表より:

| 経路 | 略称 | beforeModify 現状 |
|---|---|---|
| add (アイテム追加) | add | あり |
| 削除 (remove) | del | あり |
| 並べ替え (move) | move | **なし (既知バグ、Phase 1.2 で解消)** |
| トグル (leftElements onClick) | toggle | **なし (既知バグ、Phase 1.2 で解消)** |
| 編集 (edit) | edit | あり |
| param drag | drag | **なし (既知バグ、Phase 1.2 で解消)** |
| param popup | popup | **なし (既知バグ、Phase 1.2 で解消)** |

### 対象ノード

| ノード | type | mutation 系統 | toggle 対象 |
|---|---|---|---|
| Primitive Store | `SAX_Bridge_Primitive_Store` | items index (パターン1) | なし |
| Text Catalog | `SAX_Bridge_Text_Catalog` | items index (パターン1) | Relation トグル |
| Node Collector | `SAX_Bridge_Node_Collector` | sourceId (パターン2) | なし |
| Image Collector | `SAX_Bridge_Image_Collector` | sourceId (パターン2) | なし |
| Pipe Collector | `SAX_Bridge_Pipe_Collector` | sourceId (パターン2) | なし |

### リンク状態軸

| 値 | 意味 |
|---|---|
| `none` | 全スロット未接続 |
| `partial` | 中央スロットのみ接続 |
| `all` | 全スロット接続 |

### マトリクス

| ID | ノード | 経路 | リンク状態 | 優先度 | 期待動作 | ベースライン (Phase 1.0 前) | Phase 1.2 後 |
|---|---|---|---|---|---|---|---|
| P1-01 | Primitive Store | add | none | ○ | エラーなく追加 | (未記録) | |
| P1-02 | Primitive Store | add | partial | ★ | 既存接続維持 | (未記録) | |
| P1-03 | Primitive Store | add | all | ★ | 全接続維持 | (未記録) | |
| P1-04 | Primitive Store | del | partial | ○ | 残スロット接続維持 | (未記録) | |
| P1-05 | Primitive Store | del | all | ★ | 残スロット接続が新位置に追従 | (未記録) | |
| P1-06 | Primitive Store | move | partial | ★ | 接続が新位置に追従 | (未記録、FAIL 見込み) | |
| P1-07 | Primitive Store | move | all | ★ | 全接続が新位置に追従 | (未記録、FAIL 見込み) | |
| P1-08 | Primitive Store | edit | partial | ○ | 接続維持 | (未記録) | |
| P1-09 | Primitive Store | edit | all | ★ | 全接続維持 | (未記録) | |
| P1-10 | Primitive Store | drag | partial | ★ | 接続維持 | (未記録、FAIL 見込み) | |
| P1-11 | Primitive Store | drag | all | ★ | 全接続維持 | (未記録、FAIL 見込み) | |
| P1-12 | Primitive Store | popup | partial | ★ | 接続維持 | (未記録、FAIL 見込み) | |
| P1-13 | Primitive Store | popup | all | ★ | 全接続維持 | (未記録、FAIL 見込み) | |
| P1-14 | Text Catalog | add | partial | ★ | 既存接続維持 (addButton 二重 capture 経路) | (未記録) | |
| P1-15 | Text Catalog | add | all | ★ | 全接続維持 | (未記録) | |
| P1-16 | Text Catalog | del | all | ★ | 残スロット接続が新位置に追従 | (未記録) | |
| P1-17 | Text Catalog | move | partial | ★ | 接続が新位置に追従 | (未記録、FAIL 見込み) | |
| P1-18 | Text Catalog | move | all | ★ | 全接続が新位置に追従 | (未記録、FAIL 見込み) | |
| P1-19 | Text Catalog | toggle | partial | ★ | 接続維持 (Relation OFF でも) | (未記録、FAIL 見込み) | |
| P1-20 | Text Catalog | toggle | all | ★ | 全接続維持 | (未記録、FAIL 見込み) | |
| P1-21 | Text Catalog | edit | all | ★ | 全接続維持 | (未記録) | |
| P1-22 | Text Catalog | drag | all | ★ | 全接続維持 | (未記録、FAIL 見込み) | |
| P1-23 | Text Catalog | popup | all | ★ | 全接続維持 (pickItemForRelation 経由) | (未記録、FAIL 見込み) | |
| P1-24 | Node Collector | add | partial | ★ | 既存 source 接続維持 | (未記録) | |
| P1-25 | Node Collector | add | all | ★ | 全 source 接続維持 | (未記録) | |
| P1-26 | Node Collector | del | all | ★ | 残 source 接続が新位置に追従 | (未記録) | |
| P1-27 | Node Collector | move | all | ★ | 全 source 接続が新位置に追従 | (未記録、modifySource 経由なら PASS 見込み) | |
| P1-28 | Node Collector | edit | all | ○ | 接続維持 | (未記録) | |
| P1-29 | Image Collector | add | partial | ★ | 既存接続維持 | (未記録) | |
| P1-30 | Image Collector | del | all | ★ | 残接続が新位置に追従 | (未記録) | |
| P1-31 | Image Collector | move | all | ★ | 全接続が新位置に追従 | (未記録) | |
| P1-32 | Pipe Collector | add | partial | ★ | 既存接続維持 | (未記録) | |
| P1-33 | Pipe Collector | del | all | ★ | 残接続が新位置に追従 | (未記録) | |
| P1-34 | Pipe Collector | move | all | ★ | 全接続が新位置に追従 | (未記録) | |
**重要セル数**: 約 30 (★) / サンプリングセル: 5 (○) — 計 35 セル。Phase 1.0 着手前のベースライン記録対象は重要セルのみ (約 30 セル × 1-2 分 = 30-60 分)。

> N/A セルの省略方針: toggle は Text Catalog (Relation) と Toggle Manager (Group bypass) のみ適用、drag/popup は items 系 (Primitive Store / Text Catalog) のみ適用。Collector 系 / Primitive Store の toggle、Collector 系の drag/popup はセル定義なし。

## Phase 2 専用部 (シリアライズ系)

8 ノード × 4 操作 × schemaVersion 観点。Phase 0 時点では現状の schemaVersion 状態のみベースライン化、Phase 2 で全ノードに v1 付与時の migration 観点はマトリクス枠だけ用意。

### 操作軸

| 操作 | 略称 | 内容 |
|---|---|---|
| state save | save | mutation 後の `widgets_values` / `data[serializeKey]` 状態 |
| state load | load | reload 後の widget / output slot 復元 |
| migration | migrate | 旧形式 JSON 読み込み → 内部表現変換 |
| 旧形式互換 | legacy | `legacy-fixture/` の旧 JSON で全機能動作 |

### 現状 schemaVersion 状態 (Phase 0 ベースライン対象)

| ノード | バージョニング | 凍結対象シナリオ |
|---|---|---|
| Primitive Store | なし | save/load/legacy |
| Text Catalog | v1 (`SCHEMA_VERSION=1`) | save/load/migrate (将来 v2 想定枠)/legacy |
| Node Collector | v1→v2 (`migrateData` 実装済) | save/load/migrate (v1→v2 検証)/legacy |
| Image Collector | なし | save/load/legacy |
| Pipe Collector | なし | save/load/legacy |
| Lora Loader | なし | save/load/legacy |
| SAM3 Multi | なし | save/load/legacy |
| Toggle Manager | なし | save/load/legacy |

### マトリクス (Phase 2 着手時にベースライン記録)

| ID | ノード | 操作 | 期待動作 | ベースライン (Phase 2 着手前) | Phase 2 後 |
|---|---|---|---|---|---|
| P2-01 | Primitive Store | save | items_json が `widgets_values[0]` に格納 (PrimitiveStore 固有スキーマ。TextCatalog の items_json とは別スキーマ — `serialization.md` 参照) | (Phase 2 で記録) | |
| P2-02 | Primitive Store | load | reload で items + 出力スロットが完全復元 | (Phase 2 で記録) | |
| P2-03 | Primitive Store | legacy | `legacy-fixture/11_primitive_store.json` 読み込み成功 | (Phase 2 で記録) | |
| P2-04 | Text Catalog | save | items_json (version=1, catalog, relations) 格納 | (Phase 2 で記録) | |
| P2-05 | Text Catalog | load | items + relations + tags + favorites 完全復元 | (Phase 2 で記録) | |
| P2-06 | Text Catalog | migrate | (Phase 2 で v2 導入時) v1→v2 変換 PASS | (Phase 2 で記録) | |
| P2-07 | Text Catalog | legacy | `legacy-fixture/12_text_catalog.json` + `09_text_catalog.json` 読み込み成功 | (Phase 2 で記録) | |
| P2-08 | Node Collector | migrate | v1 sourceId 直接形式 → v2 sources[] 配列形式の変換 PASS | (Phase 2 で記録、現状 `migrateData` 実装済) | |
| P2-09 | Node Collector | legacy | `legacy-fixture/13_node_collector.json` + `06_multi_collector.json` 読み込み成功 | (Phase 2 で記録) | |
| P2-10 | Image Collector | save/load/legacy | sources 配列の保存・復元 | (Phase 2 で記録) | |
| P2-11 | Pipe Collector | save/load/legacy | sources 配列の保存・復元 | (Phase 2 で記録) | |
| P2-12 | Lora Loader | save/load/legacy | loras_json の保存・復元 (on/lora/strength) | (Phase 2 で記録) | |
| P2-13 | SAM3 Multi | save/load/legacy | segments_json の保存・復元 | (Phase 2 で記録) | |
| P2-14 | Toggle Manager | save/load/legacy | managed/scenes/currentScene の保存・復元 | (Phase 2 で記録) | |

## Phase 3-10 共通部

各 Phase 着手時に子プラン (`docs/plans/{YYYYMMDD}-ui-phase{N}-*.md`) で詳細マトリクスを定義。本節は責務単位の枠のみ。

### Phase 3: onConfigure / ライフサイクル統合

| 観点 | 検証内容 |
|---|---|
| onConfigure 統一 | 3 パターン (makeSourceListWidget 委譲 / beforeRegisterNodeDef 内直接実装 / 未実装) が 1 つに集約 |
| 遅延戦略統一 | setTimeout / requestAnimationFrame / 即時実行が方針単一化 |
| 再ロード復元 | LoraLoader / ToggleManager / SAM3 の onConfigure 不在解消後、widget + 出力スロット完全復元 |

### Phase 4: ダイアログ・ピッカー基盤統合

| 観点 | 検証内容 |
|---|---|
| ダイアログ操作 | Enter / Esc / 外部クリックで閉じる挙動の統一 |
| ネイティブ dialog 全廃 | `confirm()` / `alert()` / `prompt()` が `unifiedConfirm` / `unifiedPrompt` に置換 |
| 循環依存解消 | `sax_canvas_primitives.js` 切り出し後の import パス検証 |

### Phase 5: Jump / Return ナビゲーション

| 観点 | 検証内容 |
|---|---|
| z-index | `showReturnButton` / `showBackButton` がノード/Canvas 上に正しく表示 |
| ハイライト | 3 パターン (target / hover / active) の表示一貫性 |

### Phase 6: テーマ / スタイル

| 観点 | 検証内容 |
|---|---|
| テーマ切替 | ライト / ダーク切替で全 SAX ノードの色定数が `LiteGraph.NODE_*_COLOR` 経由 |

### Phase 7: リサイズ

| 観点 | 検証内容 |
|---|---|
| widget 動的高さ | items add/del 後の `node.size[1]` 自動追従 |

### Phase 8: ウィジェット隠蔽

| 観点 | 検証内容 |
|---|---|
| 非表示時のクリック | 隠蔽 widget がクリックを通さない (背後ノードに到達) |

### Phase 9: 共通ヘルパ集約

| 観点 | 検証内容 |
|---|---|
| LoRA 表示名 | 拡張子・サブディレクトリ除去ロジックが単一実装 |
| dismissComboMenu | コンボメニュー閉じる処理が単一実装 |
| Wildcard ロード | Impact-Pack API 取得・キャッシュが単一実装 |
| beforeRegisterNodeDef | boilerplate (元 type 保存 + onNodeCreated チェーン) 共通化 |

### Phase 10: コンテキストメニュー / IME

| 観点 | 検証内容 |
|---|---|
| 右クリックメニュー位置 | Canvas 座標とビューポート座標の変換が全ノード一貫 |
| IME 中の Enter 暴発防止 | `isComposing` チェックが Manager Editor / Item Edit Dialog / Picker で統一 |

## 現状ベースライン

**(Phase 1.0 着手前にユーザーが手動実行し、本節を埋める)**

実施手順:

1. ComfyUI を起動し、`tests/workflows/11_primitive_store.json` 〜 `15_pipe_collector.json` を順次読込
2. 上記 Phase 1 専用部マトリクスの重要セル (★) を順次実行
3. 各セルの結果 (PASS / FAIL) を本節と Phase 1 専用部マトリクスの「ベースライン」列に記録
4. FAIL セルは原因 (経路名 / `beforeModify` 呼び忘れ箇所等) も併記

想定 FAIL セル (`canvas-ui/dynamic-slots.md` 既知バグ 4 経路に対応):

- P1-06, P1-07 (Primitive Store / move)
- P1-10 〜 P1-13 (Primitive Store / drag, popup)
- P1-17, P1-18 (Text Catalog / move)
- P1-19, P1-20 (Text Catalog / toggle)
- P1-22, P1-23 (Text Catalog / drag, popup)

これらは Phase 1.2 で `DynamicSlotCoordinator` 導入により PASS に転換する想定。

## MANUAL_TEST.md K/L 節との紐付け

MANUAL_TEST.md K/L 節 (ワークフロー単位の手動シナリオ) と本マトリクス (観点単位) のセル対応表。マトリクスのセルを増減する際は、対応する K/L 節の行も同時更新すること。

| マトリクス | MANUAL_TEST.md |
|---|---|
| P1-01 〜 P1-13 | K-1 (11_primitive_store) |
| P1-14 〜 P1-23 | K-2 (12_text_catalog) |
| P1-24 〜 P1-28 | K-3 (13_node_collector) |
| P1-29 〜 P1-31 | K-4 (14_image_collector) |
| P1-32 〜 P1-34 | K-5 (15_pipe_collector) |
| P2-01 〜 P2-03 | K-1 / L-(N/A、Phase 2 着手時に追記) |
| P2-04 〜 P2-07 | K-2 |
| P2-08 〜 P2-09 | K-3 |
| P2-10 | K-4 |
| P2-11 | K-5 |
| P2-12 | L-1 (16_lora_loader) |
| P2-13 | L-2 (17_sam3_multi) |
| P2-14 | L-3 (18_toggle_manager) |
