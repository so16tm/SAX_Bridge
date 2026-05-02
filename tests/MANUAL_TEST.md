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
> **構成**: Loader → Prompt → KSampler → Output ×2 + (Finisher → Output) 分岐

実行すると3つの Output が同時に動作する:

| Preview タイトル | 確認内容 |
|---|---|
| A-1: Preview (save=false) | 画像が表示される。ファイルは保存されない |
| A-1: Preview (save=true, webp) | 画像が表示される。WebP ファイルが保存される。index がインクリメントされる |
| A-2: Preview (finisher + png) | Finisher で sharpen + grayscale を適用した画像が PNG で保存される |

- [ ] 3つ全てに画像が表示される
- [ ] save=false の Output はファイルを保存しない
- [ ] save=true(webp) の Output は WebP ファイルを保存する
- [ ] Finisher 経由の Output は sharpen + grayscale 適用済みで PNG 保存される
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

## I. Text Catalog

> **Workflow**: `workflows/09_text_catalog.json`
> **構成**: SAX Text Catalog 1 ノード（事前登録の 3 Item / 4 Relation を含む）

### I-1. 基本表示と起動口

- [ ] ワークフロー読込でノード本体に 4 行の Relation が表示される
- [ ] Relation 1 = `scene_day`、Relation 2 = `neg_default`
- [ ] Relation 3 が `(unset)` を灰色で表示
- [ ] Relation 4 が `<orphan>` を警告色で表示（削除済み Item `ghost` 参照）
- [ ] 出力ピン名がそれぞれの Item 名 / unset / orphan 表記と一致
- [ ] `[📖 Manage Texts...]` ボタンで Manager Dialog が開く
- [ ] ノード右クリックメニューにも `📖 Manage Texts...` が表示され、同じ Dialog が開く

### I-2. Manager Dialog（編集）

- [ ] 左ペインに 3 件の Item が表示される
- [ ] 起動時の初期選択がリスト先頭の Item（タグソート適用後）になっている
- [ ] Item 行右に `×N` 参照数バッジが表示される（`scene_day` は ×1、`scene_night` は ×0、`neg_default` は ×1）
- [ ] 左ペインの Item をクリックすると右ペインの Editor が切り替わる
- [ ] Name 編集 → 左ペインの表示名がリアルタイム更新
- [ ] Text 編集 → リアルタイムには反映されないが Save 後に出力に反映される
- [ ] `[+ New]` で新規 Item 追加、初期選択がそれに切り替わる
- [ ] `[Duplicate]` で複製、`(copy)` 付きの名前になり選択も切り替わる
- [ ] 参照中 Item（`×N` バッジあり）の `[Delete]` で確認ダイアログが出る
- [ ] 削除実行後、該当 Relation が `(unset)` になる

### I-3. タグ機能

- [ ] Editor の Tags 行で `+ tag` 入力 → Enter でタグ追加
- [ ] 大文字や前後空白を含めて入力 → 自動で `trim` + 小文字化される
- [ ] タグバッジの `×` クリックでタグ除去
- [ ] タグフィルタ行のタグをクリック → 該当タグ持ちの Item に絞り込まれる
- [ ] 検索ボックスに入力 → Item 名 / タグの部分一致で絞り込まれる
- [ ] 検索 + タグ選択は AND 条件
- [ ] タグ件数 13 個以上では `[Show all (N more)]` ボタンが現れる

### I-4. お気に入りタグ

- [ ] `[Manage Tags…]` でサブダイアログが開く
- [ ] `[☆]` クリックでお気に入りに追加され、Favorites セクションに移動
- [ ] Favorites 内の `[↑] [↓]` で順序変更
- [ ] お気に入りタグはフィルタ行の先頭に `★` 付きバッジで表示される
- [ ] お気に入りでもコンテキスト外（フィルタ後 items に登場しない）なら表示されない
- [ ] `[★]` クリックでお気に入りから外す
- [ ] お気に入りタグの並び順が Item の表示順 / Item 内タグの表示順にも反映される

### I-5. 並び順の連動

- [ ] タグトグルで上位に来るタグを持つ Item がリスト先頭に並ぶ
- [ ] Item 行のタグバッジ（最大 3 個）の並びがタグトグル並びと一致
- [ ] Editor のタグバッジの並びもタグトグル並びと一致
- [ ] タグなしの Item はリスト末尾に集約される

### I-6. Save / Close

- [ ] `[Save]` 押下で変更が反映され、Dialog は開いたまま継続
- [ ] Save 後すぐに `[Close]` → 確認なしで閉じる
- [ ] 編集後に `[Close]` → 「未保存変更を破棄して閉じる？」確認
- [ ] Cancel すると Dialog に戻る
- [ ] 確認で OK → 変更破棄して Close

### I-7. スロット接続維持

- [ ] Relation 1 を任意の STRING 入力ノード（例：Note）に接続
- [ ] Manager で `scene_day` の Text を編集して Save → 接続が維持されている
- [ ] ピッカーで Relation 1 の Item を `scene_night` に変更 → Slot 1 の接続が維持されている
- [ ] `[+ Add Relation]` で 5 つ目の Relation を追加 → 既存 Slot 1 の接続が維持されている

### I-8. ワークフロー保存・読込

- [ ] Manager でいくつか変更し Save → ワークフローを保存
- [ ] ComfyUI を再読込 → ノード状態が完全復元される（Item, tags, favorites, Relations すべて）
- [ ] Slot の接続も復元されている

### I-9. オートコンプリート連携（pyssss ComfyUI-Custom-Scripts）

#### pyssss 導入時
- [ ] Item Text 編集 textarea にフォーカスし `1g` と入力 → `1girl` 等の候補ポップアップが出る
- [ ] ↑↓ キーで候補移動、Enter / Tab で確定
- [ ] 確定後、自動でカンマ + スペース (`, `) が挿入される
- [ ] カテゴリ別の色分けが反映される
- [ ] Esc で候補を閉じる、textarea からフォーカスが外れた時も閉じる

#### pyssss 未導入時
- [ ] Item Text 編集 textarea で何を入力しても候補は出ない（ノードはエラーなく動作する）
- [ ] ブラウザコンソールに目立ったエラーが出ない

---

## J. Mask Adjust

> ワークフロー: `tests/workflows/10_mask_adjust.json`
> 入力画像はアルファマスクを持つ PNG、または `LoadImage` で alpha → MASK が出るものを使用

### J-1. 基本動作
- [ ] `M-1: identity (all defaults)` のプレビューが入力マスクと完全一致
- [ ] `M-2: dilate +8` で領域が外側に拡張されている
- [ ] `M-3: erode -4 + blur 2.0` で領域が収縮し、エッジがソフトになっている
- [ ] `M-4: blur 3.0 + threshold 0.5` でエッジは滑らかだが二値（0/1 のみ）になっている
- [ ] `M-5: invert` で白黒が完全に反転している
- [ ] `M-6: invert + dilate +8` で反転後マスクが拡張されている（元の白領域が 8px 縮んだ形）

### J-2. SAM3 連携
- [ ] SAM3 Multi Segmenter の MASK 出力を Mask Adjust に接続 → エラーなく実行
- [ ] SAM3 側 `mask_grow=0`、Mask Adjust 側 `grow=+8` の組み合わせで意図通りの拡張

### J-3. 既存ノード非破壊
- [ ] SAM3 Multi Segmenter 単体（`mask_grow` 設定あり）の挙動が従来と一致
- [ ] NoiseInjector 単体（`mask_shrink` / `mask_blur` 設定あり）の挙動が従来と一致

---

## R. ワークフロー互換性

> V3 移行前に保存した既存ワークフローを使用

- [ ] 旧ワークフロー読込 → 全ノード正常復元
- [ ] パラメータ値が保持されている
- [ ] 生成実行 → エラーなし
