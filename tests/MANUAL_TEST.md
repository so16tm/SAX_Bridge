# Manual Test Scenarios

テストワークフロー（`workflows/`）を読み込んで実行し、結果を確認する。
各ワークフローは分岐構成により、1回の実行で複数シナリオを同時検証できる。

## テスト実行ガイド

1. ComfyUI を再起動（ノード定義の最新化）
2. ブラウザの DevTools コンソール (F12) を開く
3. ワークフローを読み込み → `ckpt_name` を環境に合わせて変更
4. Queue Prompt で実行 → 結果を ✅ / ❌ で記録

---

## A. 基本パイプライン

> **Workflow**: `workflows/01_basic_pipeline.json`
> **構成**: Loader → Prompt → KSampler → Output ×3 分岐

実行すると3つの Output が同時に動作する:

| Preview タイトル | 確認内容 |
|---|---|
| A-1: Preview (save=false) | 画像が表示される。ファイルは保存されない |
| A-1: Preview (save=true, webp) | 画像が表示される。WebP ファイルが保存される。index がインクリメントされる |
| *(3番目の Output)* | PNG + sharpen + grayscale で保存される |

- [ ] 3つ全てに画像が表示される
- [ ] save=false の Output はファイルを保存しない
- [ ] save=true(webp) の Output は WebP ファイルを保存する
- [ ] PNG + sharpen Output はシャープ化+グレースケールで保存される
- [ ] 保存した PNG のメタデータに seed, steps, CFG, prompt が含まれる（prompt_text 接続あり）

---

## B. Prompt + LoRA

> **Workflow**: `workflows/02_prompt_lora.json`
> **構成**: Loader → Prompt → KSampler → Output + Prompt Concat 分岐

- [ ] Prompt の POPULATED_TEXT が Output の metadata に反映される
- [ ] Prompt Concat が negative としてエラーなく動作する
- [ ] BREAK 構文テスト: Prompt のテキストを `a girl BREAK blue sky` に変更 → エラーなし
- [ ] LoRA テスト: テキストに `<lora:xxx:0.8>` を追加 → LoRA が適用される（Impact Pack 環境のみ）

---

## C. Guidance

> **Workflow**: `workflows/03_guidance.json`
> **構成**: Loader → Prompt → Guidance ×5 分岐 → KSampler → Preview

実行すると5つの Guidance モードが同時に比較できる:

| Preview タイトル | Guidance 設定 |
|---|---|
| C-1: off | mode=off（ベースライン） |
| C-1: agc | mode=agc, strength=0.5 |
| C-1: fdg | mode=fdg, strength=0.5 |
| C-1: agc+fdg | mode=agc+fdg, strength=0.5 |
| C-1: post_fdg | mode=post_fdg, strength=0.5 |

- [ ] 5つ全てに画像が表示される（エラーなし）
- [ ] off と他のモードで出力に違いが見られる
- [ ] PAG テスト: いずれかの Guidance の pag_strength を 0.5 に変更 → エラーなし

---

## D. Detailer

> **Workflow**: `workflows/04_detailer.json`
> **構成**: Loader → Prompt → KSampler → Detailer/Enhanced ×3 分岐

| Preview タイトル | 設定 |
|---|---|
| D-1: Basic Detailer | denoise=0.45, cycle=1（マスクなし → 全体対象） |
| D-3: shadow + edge | Enhanced: shadow=0.3, edge=0.2, cycle=2 |
| D-3: context_blur + latent_noise | Enhanced: context_blur=8.0, latent_noise=0.15 |

- [ ] 3つ全てに画像が表示される（エラーなし）
- [ ] Basic と Enhanced で出力に違いが見られる
- [ ] ガイダンス連携テスト: Detailer の guidance_mode を `agc` に変更 → エラーなし

---

## E. Image Preview

> **Workflow**: `workflows/05_image_preview.json`
> **構成**: Loader(batch=2) → Prompt → KSampler → Image Preview ×3 分岐

| Preview タイトル | 設定 |
|---|---|
| Preview (low) | preview_quality=low |
| Preview (medium) | preview_quality=medium |
| Preview (high) | preview_quality=high |

- [ ] 3つ全てにプレビューが表示される
- [ ] batch=2 なので各プレビューに2枚のサムネイルが表示される
- [ ] サムネイルクリック → メインビュー切替が動作する

---

## F. Node Collector（複数インスタンス）

> **Workflow**: `workflows/06_multi_collector.json`
> **構成**: Node Collector ×2（ソースは手動追加）

ソース候補として KSampler / Guidance / Detailer が配置済み。Add ボタンから選択する:

1. [ ] Collector A に KSampler と Guidance をソース追加
2. [ ] Collector B に KSampler と Detailer をソース追加
3. [ ] A のソース操作（追加/削除/並替え）が B に影響しない
4. [ ] B のソース操作が A に影響しない
5. [ ] A の Show links ON → A のリンクのみ表示、B に影響なし
6. [ ] ワークフロー保存 → 再読込 → ソース設定・Show links 状態が復元される

---

## G. Toggle Manager

> **Workflow**: `workflows/07_toggle_manager.json`
> **構成**: Toggle Manager ×2 + Group A / Group B

手動操作が必要:

1. [ ] 両方の Manager で Group A / B を管理対象に追加
2. [ ] グループを移動 → 両方の Manager に変更が同期される
3. [ ] シーンを追加 → トグル状態が保存される
4. [ ] シーン切替 → グループの bypass が切り替わる
5. [ ] Manager を1つ削除 → エラーなし、残った Manager が正常動作

---

## H. 回帰テスト

> **Workflow**: `workflows/08_regression.json`
> **構成**: Loader(karras, batch=2) → Prompt → Guidance → KSampler → 3分岐

| タイトル | 検証シナリオ |
|---|---|
| H-1: Detailer result | Detailer が karras scheduler でエラーなく動作 |
| H-1: Enhanced result | Enhanced Detailer が karras scheduler でエラーなく動作 |
| H-3: batch preview | batch=2 の画像が Output で異なるインデックスで保存される |

- [ ] 全ての Preview/Output にエラーなく結果が表示される
- [ ] H-1: 保存した PNG のメタデータに `Scheduler: karras` が含まれる
- [ ] H-3: 保存先に2つのファイルが異なるインデックスで保存される
- [ ] H-2 (early-return): 04_detailer.json で Detailer の pipe を一時切断して実行 → エラーなし
- [ ] H-4 (LoRA picker): 任意のワークフローで SAX LoRA Loader 配置 → ラベルクリックでトグル動作

---

## R. ワークフロー互換性

> V3 移行前に保存した既存ワークフローを使用

- [ ] 旧ワークフロー読込 → 全ノード正常復元
- [ ] パラメータ値が保持されている
- [ ] 生成実行 → エラーなし
