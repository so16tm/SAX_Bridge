# SAX_Bridge

ComfyUI のワークフローを補完・拡張する統合ブリッジモジュールです。Pipe 形式によるコンテキスト管理、Wildcard/LoRA 対応プロンプト処理、高精度な Detailer、画像アップスケール、SAM3 テキストセグメンテーション、推論高速化キャッシュ、最終出力処理、マスク付きノイズ注入、複数ノードのリモート参照、シーンベースのトグル管理、Pipe スイッチ、バッチ比較プレビューを提供します。

## 目次

- [ノード一覧](#ノード一覧)
- [ノード詳細](#ノード詳細)
  - [Loader](#loader)
    - [SAX Loader](#sax-loader)
    - [SAX Lora Loader](#sax-lora-loader)
  - [Pipe](#pipe)
    - [SAX Pipe](#sax-pipe)
    - [SAX Pipe Switcher](#sax-pipe-switcher)
  - [Prompt](#prompt)
    - [SAX Prompt](#sax-prompt)
    - [SAX Prompt Concat](#sax-prompt-concat)
  - [Enhance](#enhance)
    - [SAX Detailer](#sax-detailer)
    - [SAX Enhanced Detailer](#sax-enhanced-detailer)
    - [SAX Upscaler](#sax-upscaler)
    - [SAX Image Noise](#sax-image-noise)
    - [SAX Latent Noise](#sax-latent-noise)
  - [Segment](#segment)
    - [SAX SAM3 Loader](#sax-sam3-loader)
    - [SAX SAM3 Multi Segmenter](#sax-sam3-multi-segmenter)
  - [Output](#output)
    - [SAX Output](#sax-output)
    - [SAX Image Preview](#sax-image-preview)
  - [Collect](#collect)
    - [SAX Image Collector](#sax-image-collector)
    - [SAX Node Collector](#sax-node-collector)
    - [SAX Pipe Collector](#sax-pipe-collector)
  - [Utility](#utility)
    - [SAX Cache](#sax-cache)
    - [SAX Toggle Manager](#sax-toggle-manager)
- [典型的なワークフロー](#典型的なワークフロー)
- [インストール](#インストール)
- [依存関係](#依存関係)
- [ライセンス](#ライセンス)

---

## ノード一覧

### Loader

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Loader` | [SAX Loader](#sax-loader) |
| `SAX_Bridge_Loader_Lora` | [SAX Lora Loader](#sax-lora-loader) |

### Pipe

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Pipe` | [SAX Pipe](#sax-pipe) |
| `SAX_Bridge_Pipe_Switcher` | [SAX Pipe Switcher](#sax-pipe-switcher) |

### Prompt

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Prompt` | [SAX Prompt](#sax-prompt) |
| `SAX_Bridge_Prompt_Concat` | [SAX Prompt Concat](#sax-prompt-concat) |

### Enhance

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Detailer` | [SAX Detailer](#sax-detailer) |
| `SAX_Bridge_Detailer_Enhanced` | [SAX Enhanced Detailer](#sax-enhanced-detailer) |
| `SAX_Bridge_Upscaler` | [SAX Upscaler](#sax-upscaler) |
| `SAX_Bridge_Noise_Image` | [SAX Image Noise](#sax-image-noise) |
| `SAX_Bridge_Noise_Latent` | [SAX Latent Noise](#sax-latent-noise) |

### Segment

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Loader_SAM3` | [SAX SAM3 Loader](#sax-sam3-loader) |
| `SAX_Bridge_Segmenter_Multi` | [SAX SAM3 Multi Segmenter](#sax-sam3-multi-segmenter) |

### Output

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Output` | [SAX Output](#sax-output) |
| `SAX_Bridge_Image_Preview` | [SAX Image Preview](#sax-image-preview) |

### Collect

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Image_Collector` | [SAX Image Collector](#sax-image-collector) |
| `SAX_Bridge_Node_Collector`  | [SAX Node Collector](#sax-node-collector) |
| `SAX_Bridge_Pipe_Collector`  | [SAX Pipe Collector](#sax-pipe-collector) |

### Utility

| Node ID | 表示名 |
|---------|--------|
| `SAX_Bridge_Cache` | [SAX Cache](#sax-cache) |
| `SAX_Bridge_Toggle_Manager` | [SAX Toggle Manager](#sax-toggle-manager) |

---

## ノード詳細

## Loader

### SAX Loader

`SAX_Bridge_Loader` — Checkpoint・VAE・LoRA を一括ロードし、`PIPE_LINE` コンテキストを初期化します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `ckpt_name` | Combo | Checkpoint ファイル選択 |
| `clip_skip` | Int (-24〜-1) | CLIP レイヤースキップ数 |
| `vae_name` | Combo | VAE 選択（`baked_vae` でモデル内蔵 VAE を使用） |
| `lora_name` | Combo | LoRA 選択（`None` でスキップ） |
| `lora_model_strength` | Float (-10.0〜10.0) | LoRA のモデル適用強度 |
| `v_pred` | Boolean | V-Prediction モード（自動で V_PREDICTION + ZSNR 適用） |
| `seed` | Int | 初期シード値 |
| `steps` | Int | サンプリングステップ数 |
| `cfg` | Float | CFG スケール |
| `sampler_name` | Combo | サンプラー選択 |
| `scheduler_name` | Combo | スケジューラー選択 |
| `denoise` | Float (0.0〜1.0) | デノイズ強度 |
| `width` / `height` | Int | 生成解像度 |
| `batch_size` | Int | バッチサイズ |

**出力**: `PIPE`, `SEED`

---

### SAX Lora Loader

`SAX_Bridge_Loader_Lora` — Pipe 内の model / clip に複数の LoRA を一括適用するノードです。各 LoRA を個別に ON/OFF・強度調整・並び替えできます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `enabled` | Boolean | `False` で LoRA を適用せずそのまま返す |
| `loras_json` | String (hidden) | LoRA エントリの JSON 配列。ノード UI が自動管理 |

**出力**: `PIPE`（model / clip を上書き）

#### UI 操作

| 操作 | 動作 |
|------|------|
| LoRA 名エリアをクリック | LoRA 選択ピッカーを開く |
| 強度ボックスをドラッグ（上下） | 強度を連続調整（1px = 0.01） |
| 強度ボックスをクリック | 数値直接入力ポップアップ |
| pill クリック | LoRA の ON/OFF 切り替え |
| ▲ / ▼ クリック | LoRA の並び替え |
| ✕ クリック | LoRA を削除 |
| `+ Add LoRA` クリック | LoRA エントリを追加（最大 10 本） |

> **クリップ強度**: モデル強度と常に連動（1スライダー制御）。

---

## Pipe

### SAX Pipe

`SAX_Bridge_Pipe` — `PIPE_LINE` から任意の要素を抽出・上書き・再構成します。入力が `None` の場合は Pipe 内の値を保持するため、部分的な上書きが可能です。

**入力**: `pipe` (optional) + `model`, `pos`, `neg`, `latent`, `vae`, `clip`, `image`, `seed`, `steps`, `cfg`, `sampler`, `scheduler`, `denoise`, `optional_sampler`, `optional_sigmas`（すべて optional）

**出力**: `PIPE`, `MODEL`, `POS`, `NEG`, `LATENT`, `VAE`, `CLIP`, `IMAGE`, `SEED`, `STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`, `DENOISE`, `OPTIONAL_SAMPLER`, `OPTIONAL_SIGMAS`

---

### SAX Pipe Switcher

`SAX_Bridge_Pipe_Switcher` — 複数の Pipe 入力から有効な Pipe を選択して展開します。Pipe の経路を条件によって切り替えるスイッチとして機能します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `slot` | Int (0〜5) | 優先するスロット番号（1 始まり）。`0` でスロット順に自動スキャン |
| `pipe1`〜`pipe5` | PIPE_LINE (optional) | 入力 Pipe |

**出力**: SAX Pipe と完全共通（`PIPE`, `MODEL`, `POS`, `NEG`, `LATENT`, `VAE`, `CLIP`, `IMAGE`, `SEED`, `STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`, `DENOISE`, `OPTIONAL_SAMPLER`, `OPTIONAL_SIGMAS`）

**選択ロジック**:
1. `slot` が 1〜5 の場合、該当スロットの Pipe を最優先で参照
2. 指定スロットが None の場合、`pipe1` → `pipe5` の順にスキャンして最初の非 None を採用
3. 全スロットが None の場合、空 Pipe として安全に展開

---

## Prompt

### SAX Prompt

`SAX_Bridge_Prompt` — Wildcard 展開・LoRA タグ抽出・`BREAK` 構文による分割エンコードをまとめて処理します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `wildcard_text` | String (multiline) | プロンプトテキスト。Wildcard (`__tag__`)・LoRA タグ (`<lora:name:weight>`)・`BREAK` 構文に対応 |
| `seed` | Int | Wildcard 展開用シード |

**出力**: `PIPE`, `POPULATED_TEXT`（展開後テキスト）

**動作**:
1. Wildcard トークンをシードに基づきランダム展開
2. LoRA タグを抽出し、Model・CLIP に適用
3. `BREAK` でテキストをチャンク分割し、各チャンクを CLIP エンコード → `ConditioningConcat` で結合

---

### SAX Prompt Concat

`SAX_Bridge_Prompt_Concat` — 複数のテキスト入力（最大 10 ポート）を連結して一括処理します。

**入力**: `pipe`, `target_positive` (Boolean), `seed`, `text_1`〜`text_N`（可変、最大 10）

**出力**: `PIPE`, `CONDITIONING`, `POPULATED_TEXT`

`target_positive` で Positive / Negative のどちらに結果を格納するか選択します。

---

## Enhance

### SAX Detailer

`SAX_Bridge_Detailer` — マスク領域をクロップして i2i 再描画し、元画像にブレンドして合成します。Differential Diffusion を内蔵しており、境界の自然な馴染みを実現します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ（Model, VAE, Conditioning を使用） |
| `mask` | MASK (optional) | 詳細化対象マスク |
| `denoise` | Float (0.0〜1.0) | 初回ステップのデノイズ強度 |
| `denoise_decay` | Float (0.0〜1.0) | 繰り返しごとのデノイズ減衰率 |
| `cycle` | Int (1〜10) | 繰り返し回数 |
| `crop_factor` | Float (1.0〜10.0) | バウンディングボックス拡張倍率 |
| `noise_mask_feather` | Int (0〜100) | Latent 空間でのマスク境界ぼかし量（Differential Diffusion） |
| `blend_feather` | Int (0〜100) | 画像空間でのブレンド境界ぼかし量 |
| `positive_prompt` | String (optional) | Positive プロンプト上書き |
| `steps_override` | Int (0〜200, optional) | i2i の steps 上書き（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0, optional) | i2i の CFG 上書き（0.0 = Loader 設定を継承） |

**出力**: `PIPE`, `IMAGE`

---

### SAX Enhanced Detailer

`SAX_Bridge_Detailer_Enhanced` — SAX Detailer の全機能に加え、Shadow Enhancement・Edge Enhancement・Latent Noise 注入を追加したエンハンスト版です。

**入力**（SAX Detailer の全入力に加え）

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `latent_noise_intensity` | Float (0.0〜2.0) | Latent ノイズ注入強度（i2i ディテール補強） |
| `noise_type` | Combo | `gaussian` / `uniform` |
| `shadow_enhance` | Float (0.0〜1.0) | 暗部への陰影描き込み強度 |
| `shadow_decay` | Float (0.0〜1.0) | 繰り返しごとの Shadow 強度減衰率 |
| `edge_weight` | Float (0.0〜1.0) | エッジ鮮鋭化強度（Unsharp Mask） |
| `edge_blur_sigma` | Float (0.1〜10.0) | Unsharp Mask 用ガウスカーネル幅 |
| `steps_override` | Int (0〜200, optional) | i2i の steps 上書き（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0, optional) | i2i の CFG 上書き（0.0 = Loader 設定を継承） |

**出力**: `PIPE`, `IMAGE`

---

### SAX Upscaler

`SAX_Bridge_Upscaler` — Pipe 内の画像をアップスケールし、オプションで軽量 i2i を適用するノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `upscale_model_name` | Combo | アップスケールモデル選択（`None` = ピクセル補間のみ） |
| `method` | Combo | ピクセル補間メソッド（`lanczos` / `bilinear` / `bicubic` / `nearest-exact`）。モデル選択時は最終リサイズ調整にのみ使用 |
| `scale_by` | Float (0.25〜8.0, step 0.05) | 元解像度に対する拡大倍率 |
| `denoise` | Float (0.0〜1.0) | 0 = アップスケールのみ。0 より大きい値でアップスケール後に軽量 i2i を実行 |
| `steps_override` | Int (0〜200) | i2i 時の steps（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0) | i2i 時の CFG（0.0 = Loader 設定を継承） |

**出力**: `PIPE`, `IMAGE`

**動作**:
- `upscale_model_name` が `None` 以外の場合、ESRGAN 系モデルでアップスケール後、`scale_by` の目標サイズへ `method` で指定した補間メソッドでリサイズ
- `upscale_model_name` が `None` の場合、`method` で指定したピクセル補間のみ
- `scale_by=1.0` かつモデルなしの場合、リサイズ処理をスキップ
- `denoise > 0` の場合、アップスケール後に KSampler (i2i) を実行してテクスチャを補完

> **アップスケールモデルの選択について**: ESRGAN 系モデルは実写・圧縮画像の復元に効果的。AI 生成アニメ調画像には `4x-AnimeSharp` 等のアニメ特化モデルを推奨。

---

### SAX Image Noise

`SAX_Bridge_Noise_Image` — 画像領域（またはマスク領域）にノイズを注入します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `image` | IMAGE | 入力画像 |
| `intensity` | Float | ノイズ強度 |
| `noise_type` | Combo | `gaussian` / `grain` / `uniform` |
| `color_mode` | Combo | `rgb`（カラーノイズ） / `grayscale`（輝度ノイズ） |
| `seed` | Int | ノイズ生成シード |
| `mask` | MASK (optional) | 注入対象マスク |
| `mask_shrink` | Int | マスク収縮量（px） |
| `mask_blur` | Int | マスク境界ぼかし量（px） |

**出力**: `IMAGE`

> `grain` モードは輝度感応型（暗部に強くノイズを適用）。

---

### SAX Latent Noise

`SAX_Bridge_Noise_Latent` — Latent 領域にノイズを注入します。i2i での質感復元・ディテール補強に使用します。

**入力**: `samples` (LATENT), `intensity`, `noise_type` (`gaussian` / `uniform`), `seed`, `mask` (optional), `mask_shrink`, `mask_blur`

**出力**: `LATENT`

---

## Segment

### SAX SAM3 Loader

`SAX_Bridge_Loader_SAM3` — SAM3 モデルをロードし、ComfyUI の VRAM 管理下に配置します。他のモデルと VRAM を共有し、必要に応じて自動的に CPU へ退避されます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `model_name` | Combo | `models/sam3/` ディレクトリ内のチェックポイントファイル |
| `precision` | Combo | `fp32`（最高品質・推奨）/ `bf16`（Ampere+ 省 VRAM）/ `fp16`（Volta+ 省 VRAM）/ `auto`（GPU に応じて自動選択） |

**出力**: `CSAM3_MODEL`

> **モデルの配置**: `ComfyUI/models/sam3/` に `.pt` / `.pth` ファイルを配置してください。

---

### SAX SAM3 Multi Segmenter

`SAX_Bridge_Segmenter_Multi` — 複数テキストプロンプトのエントリーを positive / negative で指定し、SAM3 セグメンテーション結果を合成してマスクを出力します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `sam3_model` | CSAM3_MODEL | SAX SAM3 Loader から接続 |
| `image` | IMAGE | 処理対象画像 |
| `mask` | MASK (optional) | ROI マスク。最終マスクを指定領域内に制限する |
| `segments_json` | String (hidden) | セグメントエントリーデータ（JSON）。UI が管理するため直接編集不要 |

**出力**: `MASK`

**マスク合成ロジック**:
1. 有効（`on=true`）な各エントリーに対し SAM3 セグメンテーションを実行
2. positive エントリーの結果を OR 合成 → positive マスク
3. negative エントリーの結果を OR 合成 → negative マスク
4. 最終マスク = `clamp(positive − negative, 0, 1)`
5. `mask` 入力がある場合、最終マスクと AND（ROI 制限）

#### UI 操作

各エントリー行は以下の要素で構成されます:

| 要素 | 操作 | 動作 |
|------|------|------|
| Toggle pill | クリック | エントリーの有効 / 無効を切り替え |
| Mode badge（＋/－） | クリック | `positive` / `negative` を切り替え |
| Prompt テキスト | クリック | プロンプト編集ダイアログを開く |
| `thr` ボックス | 上下ドラッグ | Threshold を連続調整（click でポップアップ） |
| `p.w.` ボックス | 上下ドラッグ | Presence Weight を連続調整（click でポップアップ） |
| `grow` ボックス | 上下ドラッグ | Mask Grow を連続調整（click でポップアップ） |
| ▲ / ▼ | クリック | エントリーの並び替え |
| ✕ | クリック | エントリーを削除 |
| `+ Add Segment` | クリック | エントリーを追加（最大 20 件） |

#### エントリーパラメータ

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `prompt` | `"person"` | 検出対象のテキストプロンプト |
| `threshold` | `0.2` | 検出信頼度の閾値（小さいほど広く検出） |
| `presence_weight` | `0.5` | presence_score の影響度。`0.0` = 範囲優先 / `1.0` = 精度優先 |
| `mask_grow` | `0` | マスクの拡張（正値）または縮小（負値）ピクセル数 |

---

## Output

### SAX Output

`SAX_Bridge_Output` — シャープ化・グレースケール変換・ファイル保存・メタデータ埋め込みを集約した最終出力ノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE (optional) | 画像ソース（`image` 未接続時）兼メタデータ供給元 |
| `image` | IMAGE (optional) | 処理対象画像。未接続の場合は `pipe.images` を使用 |
| `save` | Boolean | `True` で保存実行。`False` でプレビューのみ（シャープ化・グレースケールは適用される） |
| `output_dir` | String | 保存先ディレクトリ。テンプレート変数使用可。空欄 = `ComfyUI/output/` |
| `filename_template` | String | ファイル名テンプレート。テンプレート変数使用可 |
| `filename_index` | Int (0〜999999) | ファイル名インデックスの開始値。実行ごとに自動カウントアップ |
| `index_digits` | Int (1〜6) | インデックスのゼロパディング桁数（例: 3 → `001`） |
| `index_position` | Combo | `prefix`（ファイル名先頭）/ `suffix`（末尾） |
| `format` | Combo | `webp` / `png` |
| `webp_quality` | Int (1〜100) | WebP 品質（`lossless=True` の場合は無効） |
| `webp_lossless` | Boolean | WebP ロスレス保存 |
| `sharpen_strength` | Float (0.0〜2.0) | Unsharp Mask シャープ強度（0.0 = 無効） |
| `sharpen_sigma` | Float (0.1〜5.0) | シャープカーネル幅。小さいほどエッジ・細部に作用 |
| `grayscale` | Boolean | ITU-R BT.709 グレースケール変換 |
| `prompt_text` | String (optional) | メタデータに埋め込むプロンプトテキスト。SAX Prompt の `POPULATED_TEXT` を接続推奨 |

**出力**: `IMAGE`

#### ファイル名の構成

```
[index_]filename_template[_index].format
```

- `index_position=prefix` → `001_20260320_153045.webp`
- `index_position=suffix` → `20260320_153045_001.webp`
- バッチ複数枚の場合はバッチ内位置（`_00`, `_01` ...）を自動付加

#### filename_index の動作

- 実行ごとに +1 カウントアップし、ウィジェット値が自動更新される
- `save=False` の場合はカウントアップしない

#### テンプレート変数

`output_dir` と `filename_template` の両方で同じ記法が使用できます。

**記法**: `{変数}` または `{変数:フォーマット}`

| 変数 | デフォルト出力 | フォーマット指定例 | 出力例 |
|------|--------------|-----------------|--------|
| `{date}` | `20260320` | `{date:%Y-%m-%d}` | `2026-03-20` |
| `{time}` | `153045` | `{time:%H-%M-%S}` | `15-30-45` |
| `{datetime}` | `20260320_153045` | `{datetime:%Y%m%d_%H%M%S}` | `20260320_153045` |
| `{seed}` | `12345` | `{seed:08d}` | `00012345` |
| `{model}` | checkpoint 名（拡張子なし） | — | — |
| `{steps}` | ステップ数 | — | — |
| `{cfg}` | CFG 値 | — | — |

日付・時刻のフォーマットは [Python strftime](https://docs.python.org/ja/3/library/datetime.html#strftime-and-strptime-format-codes) 仕様、数値は [Python format 仕様](https://docs.python.org/ja/3/library/string.html#format-specification-mini-language) に準拠します。

**出力例（batch=1, デフォルト設定）:**
```
output/2026-03-20/001_20260320_153045.webp
```

**出力例（batch=2）:**
```
output/2026-03-20/001_20260320_153045_00.webp
output/2026-03-20/001_20260320_153045_01.webp
```

---

### SAX Image Preview

`SAX_Bridge_Image_Preview` — IMAGE バッチを比較プレビュー表示する終端ノードです。メインビューに選択画像を並べて表示し、トグル式のサムネイルグリッドでプレビュー対象を絞り込めます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `cell_w` | Int (64〜512) | メインビュー各セルの幅 (px)。高さはアスペクト比から自動計算 |
| `max_cols` | Int (1〜8) | 同時表示列数。ノード幅は `cell_w × max_cols` から自動確定 |
| `preview_quality` | Combo | プレビュー解像度。`low`=512px / `medium`=1024px / `high`=フルサイズ |
| `images` | IMAGE (optional) | 表示対象の IMAGE バッチ。SAX Image Collector と組み合わせて使用 |

**出力**: なし（終端ノード）

#### UI 操作

| 操作 | 動作 |
|------|------|
| **メインシークバー** | 選択画像数が `max_cols` を超えた場合のみ操作可能。ページをスライドで切り替え |
| **▼ Grid トグル** | サムネイルグリッドの表示／非表示を切り替え |
| **サムネイルクリック** | 画像の選択トグル（赤枠でハイライト）。選択画像のみメインビューに表示 |
| **◀ / ▶ ボタン** | グリッドのページ切り替え（3行/ページ固定） |

#### 表示仕様

- **メインビュー**: 幅埋め contain-fit 表示（クロップなし）。セル高さは全画像の中で最も縦長なアスペクト比に合わせて自動計算されるため、横黒帯は原理的に発生しない
- **グリッド非表示時**: 全画像を自動選択した状態でメインビューに表示
- **サムネイル**: 32×32px 均一（長辺基準のリサイズ）

#### プレビュー品質とエンコード時間の目安

| quality | 長辺上限 | 2048px 画像 40 枚の目安 |
|---------|---------|----------------------|
| `low` | 512px | ≈ 2 秒 |
| `medium` | 1024px | ≈ 9 秒 |
| `high` | フルサイズ | ≈ 35 秒（品質検査用途向け） |

> temp ディレクトリへの保存形式は WebP lossy (quality=85)。実行ごとに前回ファイルを自動削除するためディスク圧迫は起きない。

---

## Collect

### SAX Image Collector

`SAX_Bridge_Image_Collector` — 複数ソースノードの IMAGE 出力を収集してバッチ結合するノードです。SAX Image Preview と組み合わせて比較プレビューワークフローを構築できます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `slot_0` 〜 `slot_63` | ANY (optional) | 収集対象の IMAGE 出力を接続。64 スロット対応 |

**出力**

| 出力 | 型 | 説明 |
|-----|-----|------|
| `images` | IMAGE | 全スロットの画像をバッチ結合した IMAGE テンソル |

#### 動作仕様

- **基準サイズ**: 最初に接続された IMAGE のサイズ（H × W）を基準とする
- **リサイズ**: 他サイズの画像はアスペクト比維持 bilinear リサイズ + letterbox/pillarbox で基準サイズに統一
- **チャンネル正規化**: グレースケール (1ch)・RGBA (4ch) → RGB (3ch) に自動変換
- **上限**: 収集枚数が 100 枚を超えた場合は先頭 100 枚に制限（警告ログ出力）

---

### SAX Cache

`SAX_Bridge_Cache` — Pipe 内のモデルに DeepCache / TGate をワンタッチ適用し、後段の KSampler・Detailer 全体を高速化するノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `enabled` | Boolean | `False` でキャッシュを適用せずそのまま返す |
| `deepcache_interval` | Int (1〜10) | N ステップに 1 回だけ深層計算し残りをキャッシュで代替（1 = DeepCache 無効） |
| `deepcache_start_percent` | Float (0.0〜1.0) | DeepCache を開始するデノイジング進行割合。序盤は品質維持のため通常計算 |
| `tgate_enabled` | Boolean (optional) | `True` で TGate（cross-attention キャッシュ）も適用 |
| `tgate_gate_step` | Float (0.0〜1.0, optional) | TGate キャッシュ開始の境界パーセント（0.5 = 50% 以降でキャッシュ） |

**出力**: `PIPE`

> **配置位置**: SAX Loader の直後（KSampler・Detailer より前）に挿入することで全処理に一括適用できます。
> **注意**: 蒸留モデル（DMD2 等）との組み合わせでは品質劣化が顕著になる場合があります。

---

### SAX Node Collector

`SAX_Bridge_Node_Collector` — 複数のノードを「ソース」として登録し、それらのすべての出力を集約して下流ノードへ転送します。中継ノードを挟まずにワークフローを論理的に分割できます。

> **実行に参加**: Set/Get ノードと異なり実際の配線で接続するため、ComfyUI の通常の実行グラフに乗ります。ソースとの接続ワイヤーは非表示にできます。

#### 主な機能

**複数ソースの管理**
- `＋ ソース追加` ボタンでピッカーを開き、複数のノードを順番に選択・追加
- 各ソースを独立して削除可能（[✕] ボタン）
- ソースリストはウィジェットに表示され、ソース情報（ノード名・スロット数）が可視化
- 複数ソースのスロットが順序を保ったまま結合される（最大 32 スロット）

**スロットの自動管理**
- 各ソースの出力数に合わせて入出力スロットが自動で増減
- 出力スロット名・型はソースから自動継承
- ソース間でスロット配置が重ならないよう自動計算

**ワイヤー表示制御**
- Show links pill トグルでソースとの接続ワイヤーを表示 / 非表示
- 非表示状態はワークフロー保存・復元後も維持

**自動追従**
- ソースノードが削除された場合、該当ソースをウィジェットから自動削除
- ソースノードのタイトル変更を自動検知して表示を更新
- ソースのスロット追加・削除・リネームを自動検知して入出力スロットを再同期（下流接続を維持）

**ワークフロー操作との互換性**
- コピー＆ペースト後にソースとの接続を自動復元
- ワークフロー保存・読み込みで入出力スロット数・名称・接続を完全復元

#### 操作方法

| 操作 | 動作 |
|------|------|
| `＋ ソース追加` / `ソースを選択…` クリック | ソース選択ピッカーを開く |
| ソース行の [✕] クリック | 該当ソースを削除 |
| ソース行の ▲ / ▼ クリック | ソースの並び替え |
| ソース名ラベルクリック | ソースノードへキャンバス移動 |
| Show links pill クリック | ソースとの接続ワイヤーの表示 / 非表示を切り替え |

#### ピッカー

- サブグラフ / ノードの順に分類表示（出力スロットを持つノードのみ）
- インクリメンタルサーチ対応
- 各行の 📍 ボタンでキャンバス上の位置へジャンプ＋ハイライト
- 「↩ Return to picker」ボタンでピッカーに復帰
- 現在選択中のソースは ✓ でハイライト

---

### SAX Pipe Collector

`SAX_Bridge_Pipe_Collector` — 複数の PIPE_LINE 出力を持つノードをソースとして登録し、先頭から走査して最初に見つかった非 None の PIPE を返します。

> **優先順位による切り替え**: ソースリストの先頭から順に評価し、実行済みの有効な PIPE を返します。全スロットが None の場合は下流でエラーになります（設計不備として意図的）。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `slot_0` 〜 `slot_15` | ANY (optional) | 収集対象の PIPE_LINE 出力を接続。16 スロット対応 |

**出力**

| 出力 | 型 | 説明 |
|-----|-----|------|
| `pipe` | PIPE_LINE | 最初に見つかった非 None の PIPE |

#### 主な機能

**複数ソースの管理**
- `＋ ソース追加` ボタンでピッカーを開き、PIPE_LINE 出力を持つノードを選択・追加
- 1 ソース = 1 スロット固定（PIPE_LINE 出力 1 本のみ接続）
- 各ソースを独立して削除可能（[✕] ボタン）
- ソースの並び替えで優先順位を変更（最大 16 ソース）

**ワイヤー表示制御**
- Show links pill トグルでソースとの接続ワイヤーを表示 / 非表示

**自動追従**
- ソースノードが削除された場合、該当ソースをウィジェットから自動削除
- ソースノードのタイトル変更・出力変更を自動検知して再同期

#### 操作方法

| 操作 | 動作 |
|------|------|
| `＋ ソース追加` / `ソースを選択…` クリック | ソース選択ピッカーを開く（PIPE_LINE 出力を持つノードのみ） |
| ソース行の [✕] クリック | 該当ソースを削除 |
| ソース行の ▲ / ▼ クリック | ソースの優先順位を変更 |
| ソース名ラベルクリック | ソースノードへキャンバス移動 |
| Show links pill クリック | ソースとの接続ワイヤーの表示 / 非表示を切り替え |

---

## Utility

### SAX Toggle Manager

`SAX_Bridge_Toggle_Manager` — グループ・サブグラフ・ノード・Boolean ウィジェットの bypass / 値をシーン単位で一括管理するコントロールノードです。配線不要でワークフロー上のあらゆる要素をトグル制御できます。

> **実行不要**: シーン切り替えとトグル操作はすべてフロントエンドで即時反映されます。キューへの追加は不要です。

#### 主な機能

**シーン管理**
- 複数シーンを定義し、◀▶ ボタンまたはキーボードで瞬時に切り替え
- シーンごとに各アイテムの ON/OFF 状態を独立保存
- ⚙ メニューからシーンの追加・削除・リネーム・並び替えが可能
- シーン設定はワークフローファイルに保存され、セッションをまたいで保持

**アイテム管理**
- 管理対象はピッカー（+ Node ボタン）で選択 — 接続不要・タイトルベース
- 対応アイテム種別:
  - `▦` **グループ** — グループ内の全ノードを一括 bypass
  - `▣` **サブグラフ** — サブグラフノードを bypass
  - `◈` **ノード** — 個別ノードを bypass
  - `⊞` **Boolean ウィジェット** — ノード上の boolean 値をトグル
- ⟳ Rescan で存在しなくなったアイテムを一括削除（確認ダイアログあり）

**ピッカー**
- グループ / サブグラフ / ノード の順に分類表示
- インクリメンタルサーチ対応
- 各アイテム行の 📍 ボタンでキャンバス上の位置へジャンプ＋ハイライト
- 「↩ Return to picker」ボタンでピッカーに復帰
- 同名アイテムが複数ある場合は座標 `(x, y)` を表示して区別

**ナビゲーション**
- トグル行のラベルエリアをクリックするとそのアイテムの位置へキャンバスが移動
- **↩ Back ボタン** — 常時表示の固定ボタン。押すと Manager ノードへ即ジャンプ
  - 表示位置は 6 種類から選択（Top/Bottom × Left/Middle/Right）、Hidden も可
  - ⚙ Settings から位置を変更すると即時反映
- **Back キー** — キーボードショートカットで同じ動作（デフォルト: `M`）
  - ⚙ Settings の「Back key」欄で任意のキーに変更可能
  - 設定はワークフロー単位で保存されるため、複数ワークフローで異なるキーを設定可能
- サブグラフ内にいる場合、Back 操作でルートグラフへ自動脱出してから移動

#### 操作方法

| 操作 | 動作 |
|------|------|
| トグル pill クリック | アイテムの ON/OFF 切り替え |
| ラベルエリアクリック（⌖） | アイテムの位置へキャンバス移動 |
| ◀ / ▶ クリック | 前後のシーンへ切り替え |
| ⚙ クリック | シーン管理・設定ポップアップを開く |
| + Node クリック | アイテム追加ピッカーを開く |
| ⟳ Rescan クリック | 存在しないアイテムを削除 |
| ▲ / ▼ クリック | アイテムの並び替え |
| ✕ クリック | アイテムを削除 |
| ↩ Back ボタン | Manager ノードへ移動 |
| Back キー（デフォルト: M） | Manager ノードへ移動 |

---

## 典型的なワークフロー

### 基本構成

```
SAX Loader
  ↓ PIPE
SAX Lora Loader（追加 LoRA がある場合）
  ↓ PIPE
SAX Prompt / SAX Prompt Concat
  ↓ PIPE（Conditioning 更新済み）
KSampler（標準ノード）
  ↓ LATENT
VAE Decode
  ↓ IMAGE → PIPE に格納
SAX Detailer（マスク領域の精細化）
  ↓ IMAGE
SAX Output
```

### アップスケール構成

```
SAX Loader
  ↓ PIPE
SAX Prompt
  ↓ PIPE
KSampler → VAE Decode
  ↓ IMAGE → PIPE に格納
SAX Upscaler（全体リサイズ、オプションで i2i）
  ↓ PIPE
SAX Detailer（マスク領域の精細化）
  ↓ IMAGE
SAX Output
```

### キャッシュ高速化構成

```
SAX Loader
  ↓ PIPE
SAX Cache（DeepCache / TGate 適用）
  ↓ PIPE（キャッシュ適用済みモデル）
SAX Prompt
  ↓ PIPE
KSampler → VAE Decode → SAX Detailer
  ↓ IMAGE
SAX Output
```

### バッチ比較プレビュー構成

複数の生成結果（異なるシード・CFG・LoRA 等）を並べて比較するワークフロー。

```
KSampler A → VAE Decode ─┐
KSampler B → VAE Decode ─┤ IMAGE
KSampler C → VAE Decode ─┘
                          ↓
                 SAX Image Collector
                          ↓ IMAGE（バッチ結合）
                 SAX Image Preview
```

- グリッドでサムネイル一覧を確認 → クリックで比較対象を選択 → メインビューで並列比較
- `preview_quality=high` でフルサイズ確認、`low` で高速プレビューを使い分け

---

## インストール

```bash
cd custom_nodes
git clone https://github.com/so16tm/SAX_Bridge.git
```

## 依存関係

**必須**
- [ComfyUI-Impact-Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) — Wildcard 展開・LoRA エンジン（未インストール時は SAX Prompt のプロンプト処理でエラー）

**任意（インストール時に互換機能が有効化）**
- [ComfyUI-Easy-Use](https://github.com/yolain/ComfyUI-Easy-Use) — `PIPE_LINE` 型を共有しているため、Easy Use の Pipe ノードと相互接続が可能
- `sam3` package — SAX SAM3 Loader / SAX SAM3 Multi Segmenter ノードを使用する場合に必要（`pip install sam3`）

## ライセンス

MIT License
