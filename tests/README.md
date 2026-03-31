# Tests

## 構成

```
tests/
├── python/          # Level 1: pytest 自動テスト
│   ├── conftest.py  #   ComfyUI 依存の mock 環境
│   └── test_*.py    #   ノード単体テスト + V3 スキーマ検証
├── js/              # Level 1: Node.js テスト
│   └── *.test.mjs   #   JS serialize/deserialize テスト
├── workflows/       # Level 2: 手動テスト用ワークフロー
│   └── *.json       #   MANUAL_TEST.md と対応
└── MANUAL_TEST.md   # Level 2: 手動チェックリスト
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
node --experimental-vm-modules tests/js/collector_serialize.test.mjs
```

### 手動テスト
1. `tests/workflows/` のワークフローを ComfyUI にドラッグ&ドロップで読み込む
2. `MANUAL_TEST.md` のシナリオに沿って確認
3. 結果を MANUAL_TEST.md に ✅ / ❌ で記録

## ワークフロー一覧

| ファイル | MANUAL_TEST | 含まれるノード |
|---|---|---|
| `01_basic_pipeline.json` | A | Loader → Prompt → KSampler → Output ×3 (save/format/sharpen分岐) |
| `02_prompt_lora.json` | B | Loader → Prompt + Prompt Concat → KSampler → Output |
| `03_guidance.json` | C | Loader → Prompt → Guidance ×5 (全モード分岐) → KSampler → Preview |
| `04_detailer.json` | D | Loader → Prompt → KSampler → Detailer/Enhanced ×3 (パラメータ分岐) |
| `05_image_preview.json` | E | Loader(batch=2) → Prompt → KSampler → Preview ×3 (品質分岐) |
| `06_multi_collector.json` | F | Node Collector ×2（ソースは手動追加） |
| `07_toggle_manager.json` | G | Toggle Manager ×2 + Group A/B |
| `08_regression.json` | H | Loader(karras,batch=2) → 全ノード統合 ×3 (回帰分岐) |

### 環境依存パラメータ

ワークフロー読込後に以下を環境に合わせて変更する:

- **Loader**: `ckpt_name` — `CHANGE_ME.safetensors` を利用可能なモデルに変更
- **Output**: `output_dir` — 必要に応じて保存先を変更
- **Prompt**: LoRA名・ワイルドカード名を環境に合わせる

### ワークフロー更新ルール

- ノードのスキーマ（入出力定義）が変わったら対応ワークフローを再保存
- 新ノード追加時は該当ワークフローにノードを追加するか新規作成
- 更新時は MANUAL_TEST.md のシナリオとの対応を維持
