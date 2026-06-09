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
> **前提**: 複数 Manager は **異なる管理対象** を扱う前提 (同一管理対象を複数 Manager で共有すると scene 独立性が成立しない、運用注意)

- [ ] [+ Add] で Manager A に Group A、Manager B に Group B を追加できる
- [ ] pill クリックで bypass 切替、グラフの実 bypass 状態が pill 表示に反映される (外部 bypass 変更にも追従)
- [ ] グループ移動・名称変更 → Manager のラベルに同期される
- [ ] Scene の追加・切替・リネーム・削除が動作する
- [ ] Rescan で未管理 Group を自動追加できる (確認ダイアログ)
- [ ] 行ラベルクリックで Jump → Back ボタンで戻る (位置は記憶される)
- [ ] Manager A / B が独立 (異なる管理対象) に動作する
- [ ] Manager を1つ削除 → エラーなし、残った Manager が正常動作

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

### I-10. Relation トグル（ON/OFF）

- [ ] 各 Relation 行の左端にトグル pill が表示される
- [ ] pill クリックで ON/OFF が切り替わり、OFF 時は行のテキスト（Item 名）が半透明表示になる
- [ ] OFF 状態の Relation は出力ピンが空文字 (`""`) を返す（後段の `SAX Prompt Concat` 等で確認）
- [ ] OFF 状態でも Item 割当は維持され、ON に戻すと元のテキストが復活する
- [ ] OFF + `<orphan>` の組み合わせで、警告色の背景は維持されつつテキストのみ半透明になる
- [ ] OFF 状態の Relation でもスロット接続は維持される
- [ ] ワークフロー保存 → 再読込で ON/OFF 状態が復元される
- [ ] 旧ワークフロー（`on` フィールド欠損の `items_json`）読込で全 Relation が ON 状態になる（後方互換）

### I-11. LoRA / Wildcard ピッカー（Manager Editor 内）

#### LoRA ピッカー
- [ ] Item Text 編集エリア下に `[+ LoRA]` ボタンが表示される
- [ ] LoRA フォルダが空の場合、`[+ LoRA]` が無効化（半透明）になり tooltip に理由が表示される
- [ ] `[+ LoRA]` クリックで LoRA 一覧モーダルが開く（検索ボックスあり）
- [ ] 表示名は拡張子（`.safetensors`）とサブディレクトリ部が除去された短縮名
- [ ] LoRA 選択でカーソル位置に `<lora:NAME>` が挿入される（NAME は拡張子のみ除去、サブディレクトリは保持。例: `<lora:style/foo>`）
- [ ] 同名 LoRA が複数ディレクトリに存在する場合、それぞれ別パスで区別して挿入される
- [ ] textarea のカーソル位置（先頭・中間・末尾）すべてで挿入位置が正しい
- [ ] 挿入後、`dirty` フラグが立ち Save しないと反映されない

#### Wildcard ピッカー
- [ ] Item Text 編集エリア下に `[+ Wildcard]` ボタンが表示される
- [ ] Impact-Pack 未導入時は `[+ Wildcard]` が無効化され tooltip に理由が表示される
- [ ] Impact-Pack 導入時、Manager Dialog 起動後しばらくして API 取得が完了するとボタンが有効化される
- [ ] `[+ Wildcard]` クリックで Wildcard 一覧モーダルが開く
- [ ] Wildcard 選択でカーソル位置に Wildcard 名が挿入される
- [ ] カーソル前のテキストが空でなく `, ` で終わっていない場合、`, ` が前置される
- [ ] カーソル前のテキストが空、または `, ` で終わっている場合、区切りなしで挿入される
- [ ] 挿入後、`dirty` フラグが立ち Save しないと反映されない

#### ピッカーの z-index
- [ ] Manager Dialog 表示中に LoRA / Wildcard ピッカーを開く → ピッカーが Manager Dialog の前面に表示される
- [ ] ピッカーで選択 / Cancel すると Manager Dialog に戻る

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

---

## K. 動的スロット mutation 経路 (UI Phase 1 検証用)

> UI 全面再設計 ([docs/plans/20260503-ui-architecture-overhaul.md](../../../docs/plans/20260503-ui-architecture-overhaul.md)) Phase 1 の手動検証シナリオ。観点リストは [REGRESSION_MATRIX.md](REGRESSION_MATRIX.md) Phase 1 観点参照。各 Phase 着手時に必要なシナリオのみ部分実行する。
>
> **既存節との切り分け**:
> - K-1 (11_primitive_store) — 既存対応節なし (Phase 0 新設)
> - K-2 (12_text_catalog) — I 節 (09_text_catalog) は全機能シナリオ / K-2 は mutation 経路網羅 (重複しない範囲)
> - K-3 (13_node_collector) — F 節 (06_multi_collector) は 2 インスタンス独立性 / K-3 は単一インスタンス mutation 経路網羅
> - K-4 (14_image_collector) / K-5 (15_pipe_collector) — 既存対応節なし (Phase 0 新設)

### K-1. Primitive Store (workflows/11_primitive_store.json)

事前登録済み: items 3 件 (p1/p2/p3)。各経路で「リンク状態 = partial (中央スロットのみ接続) または all (全スロット接続)」を試行する。

- [ ] **add**: 新規 item 追加 → 既存接続維持 (P1-01〜P1-03)
- [ ] **del-mid**: 中央 item 削除 → 残スロット接続が新位置に追従 (P1-04〜P1-05)
- [ ] **move**: item を上下移動 → 接続が新位置に追従 (P1-06〜P1-07、Phase 1.2 で解消予定の既知バグ経路)
- [ ] **edit**: item 名変更 → 接続維持 (P1-08〜P1-09)
- [ ] **drag**: param drag (数値ドラッグ) → 接続維持 (P1-10〜P1-11、Phase 1.2 で解消予定の既知バグ経路)
- [ ] **popup**: param popup (ピッカー) → 接続維持 (P1-12〜P1-13、Phase 1.2 で解消予定の既知バグ経路)

### K-2. Text Catalog mutation (workflows/12_text_catalog.json)

事前登録済み: items 3 件 + relations 3 件 (うち 1 OFF)。

- [ ] **add**: Relation 追加 (addButton 二重 capture 経路) → 既存接続維持 (P1-14〜P1-15)
- [ ] **del-mid**: 中央 Relation 削除 → 残スロット接続が新位置に追従 (P1-16)
- [ ] **move**: Relation を上下移動 → 接続が新位置に追従 (P1-17〜P1-18、Phase 1.2 で解消予定の既知バグ経路)
- [ ] **toggle**: Relation トグル ON/OFF → 接続維持 (P1-19〜P1-20、Phase 1.2 で解消予定の既知バグ経路)
- [ ] **edit**: Item 編集 → 接続維持 (P1-21)
- [ ] **drag**: param drag → 接続維持 (P1-22、Phase 1.2 で解消予定の既知バグ経路)
- [ ] **popup**: pickItemForRelation 経由 → 接続維持 (P1-23、Phase 1.2 で解消予定の既知バグ経路)

### K-3. Node Collector 単一インスタンス (workflows/13_node_collector.json)

ソース候補: Loader / KSampler / Guidance。手動で sources を追加して検証。

- [ ] **add**: source 追加 → 既存 source 接続維持 (P1-24〜P1-25)
- [ ] **del-mid**: 中央 source 削除 → 残 source 接続が新位置に追従 (P1-26)
- [ ] **move**: source 並べ替え → 全 source 接続が新位置に追従 (P1-27、`modifySource` 経由のため `beforeModify` 呼び忘れは発生しない構造)
- [ ] **edit**: source 入替 → 接続維持 (P1-28)

### K-4. Image Collector 単一インスタンス (workflows/14_image_collector.json)

- [ ] **add**: source 追加 → 既存接続維持 (P1-29)
- [ ] **del-mid**: 中央 source 削除 → 残接続が新位置に追従 (P1-30)
- [ ] **move**: source 並べ替え → 全接続が新位置に追従 (P1-31)

### K-5. Pipe Collector 単一インスタンス (workflows/15_pipe_collector.json)

- [ ] **add**: source 追加 → 既存接続維持 (P1-32)
- [ ] **del-mid**: 中央 source 削除 → 残接続が新位置に追従 (P1-33)
- [ ] **move**: source 並べ替え → 全接続が新位置に追従 (P1-34)

---

## L. シリアライズ系 mutation (UI Phase 2 検証用)

> シリアライズ統合 ([docs/plans/20260503-ui-architecture-overhaul.md](../../../docs/plans/20260503-ui-architecture-overhaul.md) Phase 2) の手動検証シナリオ。出力スロット動的増減を伴わないため Phase 1 のスロット維持観点とは独立。観点リストは [REGRESSION_MATRIX.md](REGRESSION_MATRIX.md) Phase 2 観点参照。各 Phase 着手時に必要なシナリオのみ部分実行する。

### L-1. Lora Loader (workflows/16_lora_loader.json)

事前登録済み: 2 LoRA (`example_a.safetensors` ON、`example_b.safetensors` OFF)。

- [ ] **save**: LoRA 追加・削除・順序変更後にワークフロー保存 → `loras_json` に状態反映 (P2-12)
- [ ] **load**: 再読込で LoRA リスト + on/lora/strength 完全復元 (P2-12)
- [ ] **legacy**: `legacy-fixture/16_lora_loader.json` 読込 → エラーなし (P2-12)

### L-2. SAM3 Multi Segmenter (workflows/17_sam3_multi.json)

事前登録済み: segments_json (positive 2 / negative 1)。

- [ ] **save**: segment 追加・削除・編集後に保存 → `segments_json` に状態反映 (P2-13)
- [ ] **load**: 再読込で segments 完全復元 (P2-13)
- [ ] **legacy**: `legacy-fixture/17_sam3_multi.json` 読込 → エラーなし (P2-13)

### L-3. Toggle Manager (workflows/18_toggle_manager.json)

事前登録済み: managed 2 件 + scenes 2 個 (Default + scene_a)。

- [ ] **save**: managed 追加・scene 追加・currentScene 切替後に保存 → hidden JSON に状態反映 (P2-14)
- [ ] **load**: 再読込で managed/scenes/currentScene 完全復元 (P2-14)
- [ ] **legacy**: `legacy-fixture/18_toggle_manager.json` 読込 → エラーなし (P2-14)

## M. UI Phase 1.2.A 検証 (TextCatalog Coordinator 移行)

### M-1. TextCatalog clone smoke (workflows/text_catalog_clone_smoke.json)

事前登録済み: items 2 件 (scene_a / scene_b) + relations 2 件 (両 ON、出力スロット 2 本想定)。

- [ ] **load**: ワークフロー読込 → 出力スロットが 2 本生成され `_saxCoordinator` が onConfigure 経由で `captureFromExisting()` を実行 (リンク復元)
- [ ] **clone**: ノード選択 → Ctrl+C / Ctrl+V で複製。複製先で別 `_saxCoordinator` instance が生成されることを Console から `node._saxCoordinator !== sourceNode._saxCoordinator` で確認
- [ ] **toggle on clone**: 複製先で relation 1 (scene_a) の pill を OFF → ON にトグル → 出力リンクが維持される (`saveItemsValueOnly` 経路 = `applySaveOnly`)
- [ ] **save / reload**: ワークフロー保存 → 再読込で source / clone 両方とも独立に復元される

### M-2. TextCatalog invalid item_id recovery (workflows/text_catalog_invalid_item_id_recovery.json)

事前登録済み: items 1 件 (`valid_id`) + relations 2 件 (`valid_id` + 削除済 `deleted_id`)。

- [ ] **load**: ワークフロー読込 → onConfigure 内 validIds 再検証 fallback (`sax_text_catalog.js:1531-1536`) により `relations[1].item_id` が in-place で `null` 化される
- [ ] **slot 表示**: 2 本目の出力スロット名が `(unset)` 表示 (slot 自体は削除されない仕様、`syncOutputSlots` の `relation.on === false` でも slot 保持と整合)
- [ ] **no error**: コンソールにエラー表示なし
