<a id="top"></a>

# SAX_Bridge ノードリファレンス

[← README に戻る](../README_ja.md)

---

## カテゴリ一覧

| カテゴリ | 概要 | ノード |
|---------|------|--------|
| [Loader](#loader) | モデル・LoRA の読み込み | [SAX Loader](#sax-loader) / [SAX Lora Loader](#sax-lora-loader) |
| [Sampler](#sampler) | KSampler | [SAX KSampler](#sax-ksampler) |
| [Pipe](#pipe) | Pipe の構築・切替 | [SAX Pipe](#sax-pipe) / [SAX Pipe Switcher](#sax-pipe-switcher) |
| [Prompt](#prompt) | プロンプトのエンコード・結合 | [SAX Prompt](#sax-prompt) / [SAX Prompt Concat](#sax-prompt-concat) |
| [Enhance](#enhance) | Detailer / Upscaler / ガイダンス | [SAX Detailer](#sax-detailer) / [SAX Enhanced Detailer](#sax-enhanced-detailer) / [SAX Upscaler](#sax-upscaler) |
| [Option](#option) | 独立ユーティリティ（ノイズ注入等） | [SAX Image Noise](#sax-image-noise) / [SAX Latent Noise](#sax-latent-noise) |
| [Segment](#segment) | SAM3 によるセグメンテーション | [SAX SAM3 Loader](#sax-sam3-loader) / [SAX SAM3 Multi Segmenter](#sax-sam3-multi-segmenter) |
| [Output](#output) | 出力・プレビュー | [SAX Output](#sax-output) / [SAX Image Preview](#sax-image-preview) |
| [Collect](#collect) | ノード・画像・Pipe の集約 | [SAX Image Collector](#sax-image-collector) / [SAX Node Collector](#sax-node-collector) / [SAX Pipe Collector](#sax-pipe-collector) |
| [Utility](#utility) | Pipe 内部ヘルパー | [SAX Primitive Store](#sax-primitive-store) / [SAX Cache](#sax-cache) / [SAX Toggle Manager](#sax-toggle-manager) |

---

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
| `width` / `height` | Int | 生成解像度（8px 単位） |
| `batch_size` | Int | バッチサイズ |

**出力**: `PIPE`, `SEED`

**動作**:
- 構築される pipe dict の初期フィールド:
  - `model`, `clip`, `vae`, `samples`, `seed` — 生成した値を格納
  - `positive`: `None`（下流の Prompt ノードが設定）
  - `negative`: `None`（下流の Prompt ノードが設定。KSampler 側で自動補完も可能）
  - `images`: `None`（下流の VAE Decode / Sampler で設定）
  - `loader_settings`: `steps` / `cfg` / `sampler_name` / `scheduler` / `denoise` を格納する dict
- `clip_skip` は model の clip_skip を設定する
- `lora_model_strength` は LoRA の model strength と clip strength の両方に同じ値を適用する（1スライダー制御）

[↑ トップへ](#top)

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
| `+ Add Item` クリック | LoRA エントリを追加（最大 10 本） |

> **クリップ強度**: モデル強度と常に連動（1スライダー制御）。

**動作**:
- LoRA 読み込みに失敗した場合、警告ログを出力してそのエントリをスキップし、残りの LoRA 適用を継続する
- `strength=0.0` のエントリはスキップする
- `on` キーが欠落しているエントリは `True`（有効）として扱う

[↑ トップへ](#top)

---

## Sampler

### SAX KSampler

`SAX_Bridge_KSampler` — Pipe を受け取り、KSampler を実行して Pipe を返すノードです。サンプリングパラメータは Pipe 内の `loader_settings` から自動取得します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ（model・positive・latent・seed を使用） |
| `decode_vae` | Boolean | `decode`（True）で VAE Decode まで実行して IMAGE を出力。`latent only`（False）で Latent のみ更新 |

**出力**: `PIPE`, `IMAGE`

**動作**:
- Pipe から `model`, `positive`, `latent`, `vae`, `seed` を取得
- `negative` が Pipe に存在しない場合、CLIP で空文字列をエンコードして自動補完
- サンプリング設定（`steps`, `cfg`, `sampler_name`, `scheduler`, `denoise`）は `loader_settings` から継承
- `decode_vae=False` の場合、`IMAGE` 出力は `None`

**loader_settings フォールバック仕様**:

通常フローでは Loader → Pipe → KSampler の経路で `loader_settings` が常に populated されますが、カスタム経路で pipe に `loader_settings` が存在しない／一部キーが欠落している場合は以下のデフォルト値を使用します。

| キー | デフォルト値 |
|-----|-----------|
| `steps` | `20` |
| `cfg` | `8.0` |
| `sampler_name` | `"euler"` |
| `scheduler` | `"normal"` |
| `denoise` | `1.0` |
| `seed`（`pipe.seed`） | `0` |

[↑ トップへ](#top)

---

## Pipe

### SAX Pipe

`SAX_Bridge_Pipe` — `PIPE_LINE` から任意の要素を抽出・上書き・再構成します。入力が `None` の場合は Pipe 内の値を保持するため、部分的な上書きが可能です。

**入力**: `pipe` (optional) + `model`, `pos`, `neg`, `latent`, `vae`, `clip`, `image`, `seed`, `steps`, `cfg`, `sampler`, `scheduler`, `denoise`, `optional_sampler`, `optional_sigmas`（すべて optional）

**出力**: `PIPE`, `MODEL`, `POS`, `NEG`, `LATENT`, `VAE`, `CLIP`, `IMAGE`, `SEED`, `STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`, `DENOISE`, `OPTIONAL_SAMPLER`, `OPTIONAL_SIGMAS`

[↑ トップへ](#top)

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
2. 指定スロットが None、または `slot` が 1〜5 の範囲外（`0` および 5 超）の場合、`pipe1` → `pipe5` の順にスキャンして最初の非 None を採用（`slot=0` は自動スキャンモードとして扱う）
3. 全スロットが None の場合、空 Pipe として安全に展開

[↑ トップへ](#top)

---

## Prompt

### SAX Prompt

`SAX_Bridge_Prompt` — Wildcard 展開・LoRA タグ抽出・`BREAK` 構文による分割エンコードをまとめて処理します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `wildcard_text` | String (multiline) | プロンプトテキスト。Wildcard (`__tag__`)・LoRA タグ (`<lora:name:weight>`)・`BREAK` 構文に対応 |

**出力**: `PIPE`, `POPULATED_TEXT`（展開後テキスト）

**動作**:
1. Pipe から継承したシードに基づき Wildcard トークンをランダム展開
2. LoRA タグを抽出し、Model・CLIP に適用
3. `BREAK` でテキストをチャンク分割し、各チャンクを CLIP エンコード → `ConditioningConcat` で結合

> Wildcard 機能は `comfyui-impact-pack` がインストールされている場合のみ有効です。

[↑ トップへ](#top)

---

### SAX Prompt Concat

`SAX_Bridge_Prompt_Concat` — 複数のテキスト入力（最大 10 ポート）を連結して一括処理します。

**入力**: `pipe`, `target_positive` (Boolean), `text_1`〜`text_N`（可変、最大 10）

**出力**: `PIPE`, `CONDITIONING`, `POPULATED_TEXT`

`target_positive` で Positive / Negative のどちらに結果を格納するか選択します。

[↑ トップへ](#top)

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
| `context_blur_sigma` | Float (0.0〜64.0) | マスク境界近傍のコンテキスト領域ぼかし強度（0 = 無効） |
| `context_blur_radius` | Int (0〜256) | コンテキストぼかし対象のリング幅 px（0 = 全コンテキスト） |
| `positive_prompt` | String (optional) | Positive プロンプト上書き |
| `steps_override` | Int (0〜200, optional) | i2i の steps 上書き（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0, optional) | i2i の CFG 上書き（0.0 = Loader 設定を継承） |

**出力**: `PIPE`, `IMAGE`

> `negative` が Pipe に存在しない場合、CLIP で空文字列をエンコードして自動補完します。

**denoise_decay 計算式**:

各サイクル `i`（0 始まり）における実効 denoise は次式で算出します。

```
effective_denoise(i) = denoise * max(0.0, 1.0 - i * denoise_decay / cycle)
```

例: `cycle=3`, `denoise=1.0`, `denoise_decay=0.9` のとき → `[1.0, 0.7, 0.4]`

[↑ トップへ](#top)

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

**出力**: `PIPE`, `IMAGE`

[↑ トップへ](#top)

---

### SAX Upscaler

`SAX_Bridge_Upscaler` — Pipe 内の画像をアップスケールし、オプションで軽量 i2i を適用するノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `upscale_model_name` | Combo | アップスケールモデル選択（`None` = ピクセル補間のみ） |
| `method` | Combo | ピクセル補間メソッド（`lanczos` / `bilinear` / `bicubic` / `nearest-exact`） |
| `scale_by` | Float (0.25〜8.0) | 元解像度に対する拡大倍率 |
| `denoise` | Float (0.0〜1.0) | 0 = アップスケールのみ。0 より大きい値でアップスケール後に軽量 i2i を実行 |
| `steps_override` | Int (0〜200) | i2i 時の steps（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0) | i2i 時の CFG（0.0 = Loader 設定を継承） |

**出力**: `PIPE`, `IMAGE`

**動作**:
- `upscale_model_name` が `None` 以外の場合、ESRGAN 系モデルでアップスケール後、`scale_by` の目標サイズへリサイズ
- `denoise > 0` の場合、アップスケール後に KSampler (i2i) を実行してテクスチャを補完
- `negative` が Pipe に存在しない場合、CLIP で空文字列をエンコードして自動補完

> ESRGAN 系モデルは実写・圧縮画像の復元に効果的。AI 生成アニメ調画像には `4x-AnimeSharp` 等のアニメ特化モデルを推奨。

[↑ トップへ](#top)

---

## Option

### SAX Image Noise

`SAX_Bridge_Noise_Image` — 画像領域（またはマスク領域）にノイズを注入します。

> **用途**: 素の KSampler や他のカスタムノードと組み合わせて使う standalone ユーティリティです。SAX Detailer 内でのノイズ注入には `SAX Enhanced Detailer` の `latent_noise_intensity` を使用してください。

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

[↑ トップへ](#top)

---

### SAX Latent Noise

`SAX_Bridge_Noise_Latent` — Latent 領域にノイズを注入します。i2i での質感復元・ディテール補強に使用します。

> **用途**: 素の KSampler や他のカスタムノードと組み合わせて使う standalone ユーティリティです。SAX Detailer 内でのノイズ注入には `SAX Enhanced Detailer` の `latent_noise_intensity` を使用してください。

**入力**: `samples` (LATENT), `intensity`, `noise_type` (`gaussian` / `uniform`), `seed`, `mask` (optional), `mask_shrink`, `mask_blur`

**出力**: `LATENT`

> **値域クランプなし**: Latent 空間のノイズ注入は値域クランプを行いません（画像空間の `SAX Image Noise` は `[0, 1]` にクランプします）。強い `intensity` では latent 値が ±1.0 を超える場合がありますが、これは設計上の意図です。

[↑ トップへ](#top)

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

[↑ トップへ](#top)

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

**出力**: `MASK`, `PREVIEW_IMAGE`

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
| `+ Add Item` | クリック | エントリーを追加（最大 20 件） |

#### エントリーパラメータ

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `prompt` | `"person"` | 検出対象のテキストプロンプト |
| `threshold` | `0.2` | 検出信頼度の閾値（小さいほど広く検出） |
| `presence_weight` | `0.5` | presence_score の影響度。`0.0` = 範囲優先 / `1.0` = 精度優先 |
| `mask_grow` | `0` | マスクの拡張（正値）または縮小（負値）ピクセル数 |

[↑ トップへ](#top)

---

## Output

### SAX Output

`SAX_Bridge_Output` — シャープ化・グレースケール変換・ファイル保存・メタデータ埋め込みを集約した最終出力ノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE (optional) | 画像ソース（`image` 未接続時）兼メタデータ供給元 |
| `image` | IMAGE (optional) | 処理対象画像。未接続の場合は `pipe.images` を使用 |
| `save` | Boolean | `True` で保存実行。`False` でプレビューのみ |
| `output_dir` | String | 保存先ディレクトリ。テンプレート変数使用可。空欄 = `ComfyUI/output/` |
| `filename_template` | String | ファイル名テンプレート。テンプレート変数使用可 |
| `filename_index` | Int (0〜999999) | ファイル名インデックスの開始値。実行ごとに自動カウントアップ |
| `index_digits` | Int (1〜6) | インデックスのゼロパディング桁数（例: 3 → `001`） |
| `index_position` | Combo | `prefix`（ファイル名先頭）/ `suffix`（末尾） |
| `format` | Combo | `webp` / `png` |
| `webp_quality` | Int (1〜100) | WebP 品質（`lossless=True` の場合は無効） |
| `webp_lossless` | Boolean | WebP ロスレス保存 |
| `sharpen_strength` | Float (0.0〜2.0) | Unsharp Mask シャープ強度（0.0 = 無効） |
| `sharpen_sigma` | Float (0.1〜5.0) | シャープカーネル幅 |
| `grayscale` | Boolean | ITU-R BT.709 グレースケール変換 |
| `prompt_text` | String (optional) | メタデータに埋め込むプロンプトテキスト |

**出力**: `IMAGE`

#### テンプレート変数

| 変数 | デフォルト出力 | フォーマット指定例 | 出力例 |
|------|--------------|-----------------|--------|
| `{date}` | `20260320` | `{date:%Y-%m-%d}` | `2026-03-20` |
| `{time}` | `153045` | `{time:%H-%M-%S}` | `15-30-45` |
| `{datetime}` | `20260320_153045` | `{datetime:%Y%m%d_%H%M%S}` | `20260320_153045` |
| `{seed}` | `12345` | `{seed:08d}` | `00012345` |
| `{model}` | checkpoint 名（拡張子なし） | — | — |
| `{steps}` | ステップ数 | — | — |
| `{cfg}` | CFG 値 | — | — |

**出力例（batch=1、デフォルト設定）:**
```
output/2026-03-20/001_20260320_153045.webp
```

[↑ トップへ](#top)

---

### SAX Image Preview

`SAX_Bridge_Image_Preview` — IMAGE バッチを比較プレビュー表示する終端ノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `cell_w` | Int (64〜512) | メインビュー各セルの幅 (px) |
| `max_cols` | Int (1〜8) | 同時表示列数 |
| `preview_quality` | Combo | `low`=512px / `medium`=1024px / `high`=フルサイズ |
| `images` | IMAGE (optional) | 表示対象の IMAGE バッチ |

**出力**: なし（終端ノード）

#### UI 操作

| 操作 | 動作 |
|------|------|
| **▼ Grid トグル** | サムネイルグリッドの表示／非表示を切り替え |
| **サムネイルクリック** | 画像の選択トグル（選択画像のみメインビューに表示） |
| **メインシークバー** | 選択画像数が `max_cols` を超えた場合にページをスライドで切り替え |
| **◀ / ▶ ボタン** | グリッドのページ切り替え（3行/ページ固定） |

| quality | 長辺上限 | 2048px 画像 40 枚の目安 |
|---------|---------|----------------------|
| `low` | 512px | ≈ 2 秒 |
| `medium` | 1024px | ≈ 9 秒 |
| `high` | フルサイズ | ≈ 35 秒（品質検査用途向け） |

[↑ トップへ](#top)

---

## Collect

### SAX Image Collector

`SAX_Bridge_Image_Collector` — 複数ソースノードの IMAGE 出力を収集してバッチ結合するノードです。SAX Image Preview と組み合わせて比較プレビューワークフローを構築できます。

**入力**: `slot_0` 〜 `slot_63` (ANY, optional) — 収集対象の IMAGE 出力を接続

**出力**: `images` (IMAGE) — 全スロットの画像をバッチ結合した IMAGE テンソル

**動作仕様**:
- 最初に接続された IMAGE のサイズ（H × W）を基準として他サイズをリサイズ
- グレースケール (1ch)・RGBA (4ch) → RGB (3ch) に自動変換
- 収集枚数が 100 枚を超えた場合は先頭 100 枚に制限

[↑ トップへ](#top)

---

### SAX Node Collector

`SAX_Bridge_Node_Collector` — 複数のノードを「ソース」として登録し、それらのすべての出力を集約して下流ノードへ転送します。

> Set/Get ノードと異なり実際の配線で接続するため、ComfyUI の通常の実行グラフに乗ります。

#### 主な機能

- `+ Add Source` ボタンでピッカーを開き、複数のノードを選択・追加（最大 32 スロット）
- ソースのスロット追加・削除・リネームを自動検知して入出力スロットを再同期（下流接続を維持）
- Show links pill トグルでソースとの接続ワイヤーを表示 / 非表示
- コピー＆ペースト後にソースとの接続を自動復元

#### 操作方法

| 操作 | 動作 |
|------|------|
| `+ Add Source` クリック | ソース選択ピッカーを開く |
| ソース行の [✕] クリック | 該当ソースを削除 |
| ソース行の ▲ / ▼ クリック | ソースの並び替え |
| ソース名ラベルクリック | ソースノードへキャンバス移動 |
| Show links pill クリック | 接続ワイヤーの表示 / 非表示を切り替え |

[↑ トップへ](#top)

---

### SAX Pipe Collector

`SAX_Bridge_Pipe_Collector` — 複数の PIPE_LINE 出力を持つノードをソースとして登録し、先頭から走査して最初に見つかった非 None の PIPE を返します。

**入力**: `slot_0` 〜 `slot_15` (ANY, optional)

**出力**: `pipe` (PIPE_LINE) — 最初に見つかった非 None の PIPE

- ソースリストの並び順が優先順位になります（最大 16 ソース）
- 全スロットが None の場合は下流でエラー（設計として意図的）

[↑ トップへ](#top)

---

## Utility

### SAX Primitive Store

`SAX_Bridge_Primitive_Store` — ワークフロー内で利用する共通プリミティブ変数を一か所で定義・管理するノードです。アイテムを追加するたびに出力スロットが増え、下流ノードへ値を配布します。

**出力**: アイテムごとに動的生成（INT / FLOAT / STRING / BOOLEAN）

#### 対応型

| バッジ | 型 | 値の操作 |
|-------|----|---------|
| `INT` | Integer | ドラッグで増減 / クリックで Value・Min・Max・Step を編集 |
| `FLT` | Float | ドラッグで増減 / クリックで Value・Min・Max・Step を編集 |
| `STR` | String | クリックでテキスト入力ダイアログ |
| `BOL` | Boolean | クリックで即トグル（ON / OFF） |

> 名前変更は非対応です。名前を変えたい場合は削除して再追加してください。

[↑ トップへ](#top)

---

### SAX Cache

`SAX_Bridge_Cache` — Pipe 内のモデルに DeepCache / TGate をワンタッチ適用し、後段の KSampler・Detailer 全体を高速化するノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `enabled` | Boolean | `False` でキャッシュを適用せずそのまま返す |
| `deepcache_interval` | Int (1〜10) | N ステップに 1 回だけ深層計算し残りをキャッシュで代替（1 = DeepCache 無効） |
| `deepcache_start_percent` | Float (0.0〜1.0) | DeepCache を開始するデノイジング進行割合 |
| `tgate_enabled` | Boolean (optional) | `True` で TGate（cross-attention キャッシュ）も適用 |
| `tgate_gate_step` | Float (0.0〜1.0, optional) | TGate キャッシュ開始の境界パーセント |

**出力**: `PIPE`

> **配置位置**: SAX Loader の直後（KSampler・Detailer より前）に挿入することで全処理に一括適用できます。
> **注意**: 蒸留モデル（DMD2 等）との組み合わせでは品質劣化が顕著になる場合があります。

[↑ トップへ](#top)

---

### SAX Toggle Manager

`SAX_Bridge_Toggle_Manager` — グループ・サブグラフ・ノード・Boolean ウィジェットの bypass / 値をシーン単位で一括管理するコントロールノードです。

> **実行不要**: シーン切り替えとトグル操作はすべてフロントエンドで即時反映されます。キューへの追加は不要です。

#### 主な機能

**シーン管理**
- 複数シーンを定義し、◀▶ ボタンまたはキーボードで瞬時に切り替え
- シーンごとに各アイテムの ON/OFF 状態を独立保存
- ⚙ メニューからシーンの追加・削除・リネーム・並び替えが可能

**アイテム管理**

| 種別 | アイコン | 動作 |
|------|---------|------|
| グループ | `▦` | グループ内の全ノードを一括 bypass |
| サブグラフ | `▣` | サブグラフノードを bypass |
| ノード | `◈` | 個別ノードを bypass |
| Boolean ウィジェット | `⊞` | ノード上の boolean 値をトグル |

**ナビゲーション**
- トグル行のラベルエリアをクリックするとそのアイテムの位置へキャンバスが移動
- **↩ Back ボタン** — Manager ノードへ即ジャンプ（表示位置は 6 種類から選択可能）
- **Back キー** — キーボードショートカット（デフォルト: `M`、⚙ Settings で変更可能）
- サブグラフ内にいる場合、Back 操作でルートグラフへ自動脱出してから移動

#### 操作方法

| 操作 | 動作 |
|------|------|
| `+ Node` クリック | アイテム選択ピッカーを開く |
| ⟳ Rescan | 存在しなくなったアイテムを一括削除（確認ダイアログあり） |
| ◀ / ▶ ボタン | シーンを切り替え |
| アイテム行のトグル | 現在シーンの ON/OFF を即時切り替え |
| アイテム名クリック | 対象アイテムへキャンバス移動 |

[↑ トップへ](#top)
