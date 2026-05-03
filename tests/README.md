# Tests

## 構成

```
tests/
├── python/          # Level 1: pytest 自動テスト
│   ├── conftest.py  #   ComfyUI 依存の mock 環境
│   └── test_*.py    #   ノード単体テスト + V3 スキーマ検証 + legacy-fixture 不変性
├── js/              # Level 1: Node.js テスト
│   └── *.test.mjs   #   JS serialize/deserialize テスト
├── workflows/       # Level 2: 手動テスト用ワークフロー
│   ├── *.json       #   MANUAL_TEST.md と対応
│   └── legacy-fixture/  # Level 3a: リファクタ前 fixture (凍結、編集禁止、Phase 2 migration テスト入力データ)
├── MANUAL_TEST.md       # Level 2: 手動チェックリスト
└── REGRESSION_MATRIX.md # Level 3b: UI リファクタ観点チェックリスト (実行記録は残さない)
```

## 実行方法

### Python テスト
```bash
cd projects/SAX_Bridge
/path/to/comfyui/venv/Scripts/python -m pytest tests/python/ -v
```

### JS テスト
```bash
cd projects/SAX_Bridge
node --test "tests/js/*.test.mjs"
```

### 手動テスト (Level 2)
1. `tests/workflows/` のワークフローを ComfyUI にドラッグ&ドロップで読み込む
2. `MANUAL_TEST.md` のシナリオに沿って確認
3. 結果を MANUAL_TEST.md に ✅ / ❌ で記録

### リグレッション検証 (Level 3)
UI 全面再設計 ([docs/plans/20260503-ui-architecture-overhaul.md](../../../docs/plans/20260503-ui-architecture-overhaul.md)) の各 Phase 着手時に検証観点を参照する**チェックリスト**として使用。

1. `REGRESSION_MATRIX.md` を開き、対応 Phase の観点セル一覧を参照
2. 子プラン (`docs/plans/{YYYYMMDD}-ui-phase{N}-*.md`) で実行方法を定義
3. 必要なシナリオを `tests/workflows/11_*.json` 〜 `18_*.json` + `MANUAL_TEST.md` K/L 節から選んで実行
4. リグレッション検出は通常の pytest / JS test / 実害発見時の都度修正で行う

`legacy-fixture/` は Phase 2 (シリアライズ統合) の migration テスト入力データとして凍結。改変禁止。詳細は [legacy-fixture/README.md](workflows/legacy-fixture/README.md)。

## ワークフロー一覧

| ファイル | MANUAL_TEST | 含まれるノード |
|---|---|---|
| `01_basic_pipeline.json` | A | Loader → Prompt → KSampler → Output ×2 + Finisher→Output (save/format/finisher分岐) |
| `02_prompt_lora.json` | B | Loader → Prompt + Prompt Concat → KSampler → Output |
| `03_guidance.json` | C | Loader → Prompt → Guidance ×5 (全モード分岐) → KSampler → Preview |
| `04_detailer.json` | D | Loader → Prompt → KSampler → Detailer/Enhanced ×3 (パラメータ分岐) |
| `05_image_preview.json` | E | Loader(batch=2) → Prompt → KSampler → Preview ×3 (品質分岐) |
| `06_multi_collector.json` | F | Node Collector ×2 (2 インスタンス独立性検証) |
| `07_toggle_manager.json` | G | Toggle Manager ×2 + Group A/B (2 インスタンス独立性検証) |
| `08_regression.json` | H | Loader(karras,batch=2) → 全ノード統合 ×3 (回帰分岐) |
| `09_text_catalog.json` | I | SAX Text Catalog 1 ノード (全機能シナリオ) |
| `10_mask_adjust.json` | J | Mask Adjust 6 分岐 (identity / dilate / erode+blur / blur+threshold / invert / invert+dilate) |
| `11_primitive_store.json` | K-1 | SAX Primitive Store 単一インスタンス (mutation 経路網羅) |
| `12_text_catalog.json` | K-2 | SAX Text Catalog 単一インスタンス (mutation 経路網羅、09 と切り分け) |
| `13_node_collector.json` | K-3 | Node Collector 単一インスタンス + ソース候補 (06 と切り分け) |
| `14_image_collector.json` | K-4 | Image Collector + Loader → Prompt → KSampler → Image Preview |
| `15_pipe_collector.json` | K-5 | Pipe Collector + Loader → Prompt → KSampler |
| `16_lora_loader.json` | L-1 | Loader → Lora Loader (loras_json mutation シリアライズ) |
| `17_sam3_multi.json` | L-2 | SAM3 Loader → Multi Segmenter + LoadImage (segments_json mutation シリアライズ) |
| `18_toggle_manager.json` | L-3 | Toggle Manager 単一インスタンス (managed/scenes シリアライズ、07 と切り分け) |

### 環境依存パラメータ

ワークフロー読込後に以下を環境に合わせて変更する:

- **Loader**: `ckpt_name` — `CHANGE_ME.safetensors` を利用可能なモデルに変更
- **Output**: `output_dir` — 必要に応じて保存先を変更
- **Prompt**: LoRA名・ワイルドカード名を環境に合わせる
- **LoadImage** (`17_sam3_multi.json`): `image` — `example.png` を実在する画像ファイルに変更

### ワークフロー更新ルール

- ノードのスキーマ (入出力定義) が変わったら対応ワークフローを再保存
- 新ノード追加時は該当ワークフローにノードを追加するか新規作成
- 更新時は MANUAL_TEST.md のシナリオとの対応を維持
- `legacy-fixture/` 配下の `.json` は編集禁止 (CHECKSUMS.txt + immutability test で検証)
