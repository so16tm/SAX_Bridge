<a id="top"></a>

# SAX_Bridge ノードリファレンス

[← README に戻る](../README_ja.md)

> このページのノード ID・表示名・カテゴリ・**入力**（ウィジェット）一覧は、
> `tests/python/test_docs_schema_sync.py` が各ノードの `define_schema()` と CI で突き合わせています。
> 実装を変えたらこのページと `docs/nodes_en.md` も合わせて更新してください。

---

## カテゴリ一覧

| カテゴリ | 概要 | ノード |
|---------|------|--------|
| [Loader](#loader) | モデル・LoRA の読み込み | [SAX Loader](#sax-loader) / [SAX Diffusion Loader](#sax-diffusion-loader) / [SAX MiniMax H3 Loader](#sax-minimax-h3-loader) / [SAX Lora Loader](#sax-lora-loader) |
| [Sampler](#sampler) | KSampler | [SAX KSampler](#sax-ksampler) / [SAX MiniMax H3 Sampler](#sax-minimax-h3-sampler) |
| [Pipe](#pipe) | Pipe の構築・切替 | [SAX Pipe](#sax-pipe) / [SAX Pipe Switcher](#sax-pipe-switcher) |
| [Prompt](#prompt) | プロンプトのエンコード・結合 | [SAX Prompt](#sax-prompt) / [SAX Prompt Concat](#sax-prompt-concat) / [SAX Qwen Image Prompt](#sax-qwen-image-prompt) |
| [Enhance](#enhance) | Guidance / Detailer / Upscaler / Finisher | [SAX Guidance](#sax-guidance) / [SAX Detailer](#sax-detailer) / [SAX Enhanced Detailer](#sax-enhanced-detailer) / [SAX Upscaler](#sax-upscaler) / [SAX Finisher](#sax-finisher) |
| [Control](#control) | ControlNet 構造拘束 | [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) |
| [Option](#option) | 独立ユーティリティ（ノイズ注入等） | [SAX Image Noise](#sax-image-noise) / [SAX Latent Noise](#sax-latent-noise) |
| [Segment](#segment) | SAM3 によるセグメンテーション | [SAX SAM3 Loader](#sax-sam3-loader) / [SAX SAM3 Multi Segmenter](#sax-sam3-multi-segmenter) |
| [Mask](#mask) | マスクの後処理 | [SAX Mask Adjust](#sax-mask-adjust) |
| [Output](#output) | 出力・プレビュー | [SAX Output](#sax-output) / [SAX Image Preview](#sax-image-preview) |
| [Collect](#collect) | ノード・画像・Pipe の集約 | [SAX Image Collector](#sax-image-collector) / [SAX Node Collector](#sax-node-collector) / [SAX Pipe Collector](#sax-pipe-collector) |
| [Debug](#debug) | デバッグ・テスト用 | [SAX Debug Controller](#sax-debug-controller) / [SAX Assert](#sax-assert) / [SAX Assert Pipe](#sax-assert-pipe) / [SAX Debug Inspector](#sax-debug-inspector) / [SAX Debug Text](#sax-debug-text) |
| [Utility](#utility) | Pipe 内部ヘルパー | [SAX Primitive Store](#sax-primitive-store) / [SAX Text Catalog](#sax-text-catalog) / [SAX Text Catalog V2](#sax-text-catalog-v2) / [SAX Cache](#sax-cache) / [SAX Toggle Manager](#sax-toggle-manager) |

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

### SAX Diffusion Loader

`SAX_Bridge_Loader_Diffusion` — UNET（diffusion model）単体・CLIP（text encoder）単体・VAE を個別フォルダから読み込み、`PIPE_LINE` コンテキストを初期化します。Checkpoint に model/clip/vae が baked されていない分割配布モデル（Anima・Krea 2・Qwen-Image 2.1 など）向けです。出力 pipe は SAX Loader と同一構造のため、下流ノードは無改修で利用できます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `unet_name` | Combo | diffusion model ファイル選択（`diffusion_models` フォルダ） |
| `weight_dtype` | Combo | UNET 重み dtype（`default` / `fp8_e4m3fn` / `fp8_e4m3fn_fast` / `fp8_e5m2`） |
| `clip_name` | Combo | text encoder ファイル選択（`text_encoders` フォルダ） |
| `vae_name` | Combo | VAE ファイル選択（`vae` フォルダ。常に外部 VAE） |
| `lora_name` | Combo | LoRA 選択（`None` でスキップ） |
| `lora_model_strength` | Float (-10.0〜10.0) | LoRA のモデル適用強度 |
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
- `model` は `load_diffusion_model` で `diffusion_models` から、`clip` は `load_clip` で `text_encoders` から、`vae` は `vae` フォルダからそれぞれ個別にロードする
- `clip_type` は UNET の model_config から自動判別される（Krea 2 → `KREA2`、Qwen-Image / Qwen-Image 2.1 → `QWEN_IMAGE`、未登録モデルは `STABLE_DIFFUSION` フォールバック）。Anima の Qwen3 0.6B は text encoder の state_dict から判別される。
- 空 latent は 4ch・1/8 で生成し、KSampler 側の `fix_empty_latent_channels` がモデルの latent_channels / latent_dimensions / 縮小率へ自動適応する（16ch・3次元モデル、64ch・1/16 の Qwen-Image 2.1 も追加設定不要）
- `weight_dtype` の fp8 指定は ComfyUI 本体 UNETLoader と同一の dtype マッピングを適用する
- `lora_model_strength` は LoRA の model strength と clip strength の両方に同じ値を適用する
- SAX Loader と異なり `clip_skip` / `v_pred` は持たない（diffusion model の flow 系サンプリング・非 CLIP テキストエンコーダに非該当のため）

**Krea 2 対応**:
- 必要ファイル: `diffusion_models/krea2_*.safetensors` + `text_encoders/qwen3vl_4b_*.safetensors` + `vae/qwen_image_vae.safetensors`
- text encoder は **Qwen3VL-4B が必須**（それ以外は本体の KREA2 専用エンコーダ分岐に入らず conditioning が不正になる）
- 非対応機能: `structure_control`（SDXL 専用）/ `ays_sd1`・`ays_sdxl` スケジューラ（SD1/SDXL 専用）/ SAX_Cache の TGate・DeepCache（UNet 前提のため DiT 非対応）

[↑ トップへ](#top)

---

### SAX MiniMax H3 Loader

`SAX_Bridge_Loader_MiniMax_H3` — MiniMax H3（動画＋音声を同時生成するモデル）の diffusion model・text encoder・映像 VAE・音声 VAE を 1 ノードで読み込みます。[MiniMaxH3-Director](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director) の入力へそのまま繋げる個別出力と、SAX MiniMax H3 Sampler 用の `PIPE_LINE` を出力します。ComfyUI 0.30.0 以降が必要です。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `unet_name` | Combo | FL2VA checkpoint（t2v・先頭／末尾フレーム指定の i2v。Director の Refs OFF 用）。`None` で読み込まない |
| `lora_name` | Combo | FL2VA 用 LoRA（turbo 4-step / 8-step LoRA 等）。`None` でスキップ。steps を 4 / 8 に合わせる |
| `ref_unet_name` | Combo | REF2VA checkpoint（参照画像・動画・音声。Director の Refs ON 用）。既定は `None`。選ぶと約 20GB のモデルをもう 1 つ読み込む |
| `ref_lora_name` | Combo | REF2VA 用 LoRA（REF2V turbo 4-step LoRA 等）。`None` でスキップ |
| `lora_strength` | Float (-10.0〜10.0) | LoRA の強度（両方に同じ値を適用） |
| `clip_name` | Combo | text encoder（Qwen3-VL 32B）。`text_encoders` フォルダ |
| `vae_name` | Combo | 映像 VAE。`vae` フォルダ |
| `audio_vae_name` | Combo | 音声 VAE。`vae` フォルダ（映像 VAE と取り違えると映像にノイズが乗る） |
| `seed` | Int | シード値 |
| `steps` | Int | サンプリングステップ数（既定 20） |
| `sampler_name` | Combo | サンプラー選択（既定 `res_multistep`） |
| `scheduler_name` | Combo | スケジューラー選択（既定 `simple`） |

**出力**: `PIPE`, `MODEL`, `MODEL_REF2VA`, `CLIP`, `VAE`, `AUDIO_VAE`

**動作**:
- 各 Combo の初期値は、ファイル名に `fl2va` / `qwen3vl` + `minimax` / `video_vae` / `audio_vae` を含む最初の候補が自動で選ばれる（配置しただけで設定済みになる）
- text encoder の種別（CLIPLoader の `type=minimax`）は自動で設定する
- `unet_name` と `ref_unet_name` はどちらか一方だけでも使える。両方 `None` はエラー
- `MODEL` / `MODEL_REF2VA` / `CLIP` / `VAE` / `AUDIO_VAE` を Director の同名入力へ繋ぐ。未選択の model は `None` を出力する
- `PIPE` の `model` は `MODEL`（なければ `MODEL_REF2VA`）、`audio_vae` は音声 VAE。サンプリング設定は `loader_settings` に格納する（`cfg` は H3 公式設定の 1.0 固定、`denoise` は 1.0）
- 解像度・長さ・latent・conditioning は Director が決めるため、この Loader には `width` / `height` / `batch_size` を持たない
- LoRA は model のみに適用する。`lora_name` は FL2VA、`ref_lora_name` は REF2VA の model にだけ掛かる（取り違えると効かない）。対応する model が `None` のときはエラー
- turbo LoRA を使うときは `steps` を LoRA に合わせて 4 / 8 にし、必要なら Director の `shift_video` も調整する

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

### SAX MiniMax H3 Sampler

`SAX_Bridge_Sampler_MiniMax_H3` — MiniMaxH3-Director の出力（`model` / `positive` / `latent`）をサンプリングし、映像と音声を復号して `VIDEO` まで仕上げます。標準ワークフローの RandomNoise → KSamplerSelect → BasicScheduler → BasicGuider → SamplerCustomAdvanced → VAEDecode / VAEDecodeAudio → CreateVideo を 1 ノードに畳んだものです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | SAX MiniMax H3 Loader の PIPE（VAE・音声 VAE・シード・サンプリング設定を使う） |
| `model` | MODEL | Director の `model` 出力（sigma shift 適用済み） |
| `positive` | CONDITIONING | Director の `positive` 出力 |
| `latent` | LATENT | Director の `latent` 出力 |
| `fps` | Float (1〜240, optional) | 動画のフレームレート。既定 24（H3 は 24fps 固定で、Director の `fps` も常に 24） |

**出力**: `PIPE`, `VIDEO`, `IMAGE`, `AUDIO`

**動作**:
- サンプリングと動画化は ComfyUI 本体のノード（`comfy_extras.nodes_custom_sampler` / `nodes_audio` / `nodes_video`）に委ねる
- `seed` / `steps` / `sampler_name` / `scheduler` は pipe の設定を使い、ガイダンスは BasicGuider（CFG なし）、denoise は 1.0 固定
- 映像と音声は同じ joint latent から、映像 VAE と音声 VAE でそれぞれ復号する
- 出力 `PIPE` の `samples` / `images` を更新し、`loader_settings` の `clip_width` / `clip_height` を実際のフレームサイズに更新する

```
SAX MiniMax H3 Loader → MiniMax H3 Director → SAX MiniMax H3 Sampler → Save Video
```

Loader の `MODEL` / `MODEL_REF2VA` / `CLIP` / `VAE` / `AUDIO_VAE` を Director へ、Loader の `PIPE` と Director の `model` / `positive` / `latent` を Sampler へ繋ぐ。

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
| `select_to_add_lora` | Combo | LoRA ピッカー。選ぶと `wildcard_text` の末尾へ `<lora:名前>` を挿入する（値自体は実行に使われない） |
| `select_to_add_wildcard` | Combo | Wildcard ピッカー。選ぶと `wildcard_text` の末尾へ `__タグ__` を挿入する（値自体は実行に使われない） |

**出力**: `PIPE`, `POPULATED_TEXT`（展開後テキスト）

**動作**:
1. Pipe から継承したシードに基づき Wildcard トークンをランダム展開
2. LoRA タグを抽出し、Model・CLIP に適用
3. `BREAK` でテキストをチャンク分割し、各チャンクを CLIP エンコード → `ConditioningConcat` で結合

> Wildcard 機能は `comfyui-impact-pack` がインストールされている場合のみ有効です。

[↑ トップへ](#top)

---

### SAX Prompt Concat

`SAX_Bridge_Prompt_Concat` — 複数のテキスト入力（最大 32 ポート）を連結して一括処理します。

**入力**: `pipe`, `target_positive` (Boolean), `texts`（Autogrow。`text1` から最大 32 ポートまで自動増減）

**出力**: `PIPE`, `CONDITIONING`, `POPULATED_TEXT`

`target_positive` で Positive / Negative のどちらに結果を格納するか選択します。

[↑ トップへ](#top)

---

### SAX Qwen Image Prompt

`SAX_Bridge_Prompt_Qwen_Image` — Qwen-Image 2.1 専用のプロンプトノード。参照画像を繋がなければ t2i、繋げば i2i（最大 10 枚の複数画像編集）として動作します。positive / negative を同時にエンコードして Pipe に格納します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | SAX Diffusion Loader で Qwen-Image 2.1 を読み込んだ Pipe |
| `wildcard_text` | String | プロンプト／編集指示。参照画像は `<image1>`, `<image2>` … で指す。Wildcard・LoRA 構文対応 |
| `negative_text` | String | ネガティブプロンプト（cfg=1 の公式設定では効果なし） |
| `resolution` | Int (0〜4096, 32 刻み) | 参照画像を約 resolution × resolution ピクセルへ縮小（縦横比維持・32 の倍数）。0 は元サイズのまま |
| `images` | Autogrow | 参照画像（`image_1` から最大 10 ポートまで自動増減）。`image_1` が編集対象 |

**出力**: `PIPE`, `POPULATED_TEXT`

**動作**:
- エンコードは ComfyUI 本体の `TextEncodeQwenImage21` に委ねる（Qwen-Image 2.1 対応版の ComfyUI が必要）
- 参照画像なし: latent は Loader の `width` / `height` のまま（t2i）
- 参照画像あり: latent を `image_1` の縮小後サイズに置き換え、Loader の `batch_size` 枚ぶん用意する（別サイズだと編集結果がずれるため）
- LoRA 構文は `wildcard_text` 側だけを適用する（`negative_text` 内の LoRA タグは除去のみ）

**推奨設定**（公式ワークフロー準拠）: SAX Diffusion Loader で `cfg=1`、`sampler_name=euler`、`scheduler_name=simple`、`steps=25`〜`50`。

```
t2i: SAX Diffusion Loader → SAX Qwen Image Prompt → SAX KSampler → SAX Output
i2i: 同上。SAX Qwen Image Prompt の image_1, image_2 … に画像を繋ぐだけ
```

[↑ トップへ](#top)

---

## Enhance

### SAX Guidance

`SAX_Bridge_Guidance` — Pipe 内のモデルに AGC / FDG / PAG のガイダンス強化を適用するノードです。KSampler・Detailer・Upscaler より前に挿入して使います。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `mode` | Combo | `off` / `agc` / `fdg` / `agc+fdg`（既定）/ `post_fdg` |
| `strength` | Float (0.0〜1.0) | AGC / FDG の効き。`0.0` で無効、`0.5` で標準、`1.0` で最大 |
| `pag_strength` | Float (0.0〜1.0) | PAG (Perturbed Attention Guidance) の強度。`0.0` で無効。`mode` と併用可能 |

**出力**: `PIPE`（model を差し替え）

**mode 一覧**

| mode | 適用フック | 用途 |
|------|-----------|------|
| `off` | — | ガイダンス無効（`pag_strength` のみ適用可能） |
| `agc` | `sampler_cfg_function` | 高 CFG のスパイクを tanh でソフトクリップして破綻を抑える |
| `fdg` | `sampler_cfg_function` | 帯域分離して高域ゲインを上げ、ディテールを強調（高 CFG 向け） |
| `agc+fdg` | `sampler_cfg_function` | 上記の併用 |
| `post_fdg` | `sampler_post_cfg_function` | 低 CFG・低ステップ LoRA でも効く帯域分離 |

**動作**:
- `mode` が `off` か `strength` が `0.0` で、かつ `pag_strength` も `0.0` の場合は Pipe をそのまま返す
- Pipe に `model` が無い場合もそのまま返す（エラーにしない）
- PAG は post_cfg_function として追加されるため、`mode` のガイダンスと同時に使える
- PAG 有効時は 1 ステップあたり 1 回分の追加 forward が発生する

[↑ トップへ](#top)

---

### SAX Detailer

`SAX_Bridge_Detailer` — マスク領域をクロップして i2i 再描画し、元画像にブレンドして合成します。Differential Diffusion を内蔵しており、境界の自然な馴染みを実現します。複数 cycle 実行時は VAE encode/decode を各 1 回に抑え、cycle 間は latent を保持して反復します。

**入力**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|-----------|------|
| `pipe` | PIPE_LINE | — | 入力パイプ（Model, VAE, Conditioning を使用） |
| `denoise` | Float (0.0〜1.0) | 0.45 | i2i のデノイズ強度 |
| `cycle` | Int (1〜10) | 1 | 繰り返し回数 |
| `crop_factor` | Float (1.0〜10.0) | 3.0 | バウンディングボックス拡張倍率 |
| `noise_mask_feather` | Int (0〜100) | 5 | Latent 空間でのマスク境界ぼかし量（Differential Diffusion） |
| `blend_feather` | Int (0〜100) | 5 | 画像空間でのブレンド境界ぼかし量 |
| `mask` | MASK (optional) | — | 詳細化対象マスク（未指定時は全画像） |
| `steps_override` | Int (0〜200, optional) | 0 | i2i の steps 上書き（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0, optional) | 0.0 | i2i の CFG 上書き（0.0 = Loader 設定を継承） |
| `guidance_mode` | Combo (optional) | `off` | CFG ガイダンス強化（`agc` / `fdg` / `agc+fdg` / `post_fdg`） |
| `guidance_strength` | Float (0.0〜1.0, optional) | 0.5 | ガイダンス効果強度 |
| `pag_strength` | Float (0.0〜1.0, optional) | 0.0 | Perturbed Attention Guidance 強度（任意 CFG で動作。1 ステップ毎に追加 forward pass） |
| `positive_prompt` | String (optional) | — | Positive プロンプト上書き |

**出力**: `PIPE`, `IMAGE`

> `negative` が Pipe に存在しない場合、CLIP で空文字列をエンコードして自動補完します。

> **構造拘束**: 上流の [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) ノードの設定が pipe にあれば透過的に消費します。

[↑ トップへ](#top)

---

### SAX Enhanced Detailer

`SAX_Bridge_Detailer_Enhanced` — SAX Detailer の全機能に加え、`denoise_decay`・Shadow Enhancement・Edge Enhancement・Latent Noise 注入・Context Blur を追加したエンハンスト版です。

画像領域の前処理（`shadow_enhance` / `edge_weight` / `context_blur_sigma`）は VAE encode 直前に 1 回のみ適用されます。`latent_noise_intensity` は cycle 毎に独立加算され、`denoise_decay` と連動して各 cycle で減衰します。

**入力**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|-----------|------|
| `pipe` | PIPE_LINE | — | 入力パイプ |
| `denoise` | Float (0.0〜1.0) | 0.45 | i2i のデノイズ強度 |
| `denoise_decay` | Float (0.0〜1.0) | 0.0 | 繰り返しごとのデノイズ減衰率（`latent_noise_intensity` も連動） |
| `cycle` | Int (1〜10) | 1 | 繰り返し回数 |
| `crop_factor` | Float (1.0〜10.0) | 3.0 | バウンディングボックス拡張倍率 |
| `noise_mask_feather` | Int (0〜100) | 5 | Latent 空間でのマスク境界ぼかし量 |
| `blend_feather` | Int (0〜100) | 5 | 画像空間でのブレンド境界ぼかし量 |
| `shadow_enhance` | Float (0.0〜1.0) | 0.0 | 暗部への陰影描き込み強度（初回 encode 直前に 1 回適用） |
| `edge_weight` | Float (0.0〜1.0) | 0.0 | エッジ鮮鋭化強度（Unsharp Mask、初回 encode 直前に 1 回適用） |
| `edge_blur_sigma` | Float (0.1〜10.0) | 1.0 | Unsharp Mask 用ガウスカーネル幅 |
| `latent_noise_intensity` | Float (0.0〜2.0) | 0.1 | Latent ノイズ注入強度（cycle 毎に独立加算、`denoise_decay` で減衰） |
| `noise_type` | Combo | `gaussian` | `gaussian` / `uniform` |
| `context_blur_sigma` | Float (0.0〜64.0) | 0.0 | マスク境界近傍のコンテキスト領域ぼかし強度（0 = 無効。初回 encode 直前に 1 回適用） |
| `context_blur_radius` | Int (0〜256) | 48 | コンテキストぼかし対象のリング幅 px（0 = 全コンテキスト） |
| `mask` | MASK (optional) | — | 詳細化対象マスク |
| `steps_override` | Int (0〜200, optional) | 0 | i2i の steps 上書き |
| `cfg_override` | Float (0.0〜100.0, optional) | 0.0 | i2i の CFG 上書き |
| `guidance_mode` | Combo (optional) | `off` | CFG ガイダンス強化 |
| `guidance_strength` | Float (0.0〜1.0, optional) | 0.5 | ガイダンス効果強度 |
| `pag_strength` | Float (0.0〜1.0, optional) | 0.0 | Perturbed Attention Guidance 強度 |
| `positive_prompt` | String (optional) | — | Positive プロンプト上書き |

**出力**: `PIPE`, `IMAGE`

> **構造拘束**: 上流の [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) ノードの設定が pipe にあれば透過的に消費します。

**denoise_decay 計算式**:

各サイクル `i`（0 始まり）における実効 denoise と latent noise 強度は次式で算出します。

```
decay_factor(i) = max(0.0, 1.0 - i * denoise_decay / cycle)
effective_denoise(i) = denoise * decay_factor(i)
effective_noise_intensity(i) = latent_noise_intensity * decay_factor(i)
```

例: `cycle=3`, `denoise=1.0`, `denoise_decay=0.9` のとき → `[1.0, 0.7, 0.4]`

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
| `guidance_mode` | Combo (optional) | i2i パスの CFG ガイダンス強化（`off` / `agc` / `fdg` / `agc+fdg` / `post_fdg`） |
| `guidance_strength` | Float (0.0〜1.0) | ガイダンス効果強度 |
| `pag_strength` | Float (0.0〜1.0) | Perturbed Attention Guidance 強度（任意 CFG で動作。1 ステップ毎に追加 forward pass） |
| `positive_prompt` | String (optional) | i2i パスの Positive プロンプト上書き（`denoise > 0` 時のみ有効） |

**出力**: `PIPE`, `IMAGE`

**動作**:
- `upscale_model_name` が `None` 以外の場合、ESRGAN 系モデルでアップスケール後、`scale_by` の目標サイズへリサイズ
- `denoise > 0` の場合、アップスケール後に KSampler (i2i) を実行してテクスチャを補完
- `negative` が Pipe に存在しない場合、CLIP で空文字列をエンコードして自動補完

> ESRGAN 系モデルは実写・圧縮画像の復元に効果的。AI 生成アニメ調画像には `4x-AnimeSharp` 等のアニメ特化モデルを推奨。

> **構造拘束**: 上流の [SAX Structure Lock (SDXL)](#sax-structure-lock-sdxl) ノードの設定が pipe にあれば i2i パスで透過的に消費します。

[↑ トップへ](#top)

---

### SAX Finisher

`SAX_Bridge_Finisher` — 最終画像にポストエフェクトと画質調整を適用する仕上げノードです。Detailer / Upscaler の後、Output の前に配置します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `reference_image` | IMAGE (optional) | `color_correction` の参照画像。未接続なら色補正はスキップ |
| `color_correction` | Float (0.0〜1.0) | 参照画像との mean/std マッチングによる色分布補正（0 = 無効） |
| `smooth` | Float (0.0〜1.0) | 高周波抑制（ジャギー・過剰エッジの低減）。0 = 無効 |
| `sharpen_strength` | Float (0.0〜2.0) | Unsharp Mask シャープ強度。0 = 無効 |
| `sharpen_sigma` | Float (0.1〜5.0) | シャープカーネル幅 |
| `bloom` | Float (0.0〜1.0) | 明部から滲む光の強度。0 = 無効 |
| `bloom_threshold` | Float (0.0〜1.0) | 抽出する明度の閾値（低いほど広範囲が光る） |
| `bloom_radius` | Float (1.0〜32.0) | ブルームの広がり半径（ガウスシグマ） |
| `vignette` | Float (0.0〜1.0) | 周辺減光の強度。0 = 無効 |
| `color_temp` | Float (-1.0〜+1.0) | 色温度シフト。正値 = 暖色 / 負値 = 寒色 |
| `grayscale` | Boolean | ITU-R BT.709 グレースケール変換（最終段で適用） |

**出力**: `PIPE`, `IMAGE`

**適用順**:

```
color_correction → smooth → sharpen → bloom → vignette → color_temp → grayscale
```

すべての効果が無効値（0 / False）かつ `reference_image` 未接続なら、入力 pipe をそのまま返してパススルーします。Finisher の出力は `pipe.images` にも反映されるため、後段ノードに加工済み画像が伝播します。

[↑ トップへ](#top)

---

## Control

### SAX Structure Lock (SDXL)

`SAX_Bridge_Structure_Lock` — ControlNet 構造拘束の設定を pipe に載せるノードです。下流の Detailer / Upscaler が処理対象画像（Detailer はクロップ済み領域、Upscaler はアップスケール後のフル画像）から構造ヒントを内部生成して ControlNet を適用し、i2i での人体広域破綻（臍・胸・四肢・構図崩れ）を防止します。

**入力**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|-----------|------|
| `pipe` | PIPE_LINE | — | 入力パイプ |
| `controlnet_name` | Combo | `None` | 構造拘束用 ControlNet モデル。Union ControlNet (SDXL) 推奨（xinsir Union ProMax 等）。`None` のまま実行するとエラー |
| `mode` | Combo | `tile` | 構造ヒント種別。`tile` = ぼかし構造ロック（追加依存なし）/ `depth` = 深度ロック / `openpose` = 骨格ロック / `lineart` = 線画ロック |
| `strength` | Float (0.0〜1.5) | 0.6 | 構造拘束強度 |
| `start_percent` | Float (0.0〜1.0, optional) | 0.0 | ControlNet 適用開始ステップ比率 |
| `end_percent` | Float (0.0〜1.0, optional) | 1.0 | ControlNet 適用終了ステップ比率 |

**出力**: `PIPE`

**動作**:
- ノード配置 = 有効、未配置 = 完全無効（`off` オプションは存在しない）
- fail-fast: `controlnet_name=None`・CN ロード失敗・不正 `mode`・全ヒント生成失敗はエラーで停止（黙ってスキップしない）
- `depth` / `openpose` / `lineart` は `controlnet_aux` 依存。未導入・検出失敗時はフォールバック連鎖で劣化継続（warning ログ。`openpose` → `depth` → `tile`、`depth` → `tile`、`lineart` → `tile`）
- ControlNet の適用は各消費ノードのローカル処理で、pipe の `positive` へは書き戻しません（下流への二重適用なし）

> Union ControlNet モデル（xinsir Union ProMax 等）を事前に `ComfyUI/models/controlnet/` へ配置してください。

> **Upscaler の限界**: 全画像一括 i2i + 構造拘束は広域破綻防止用。極端な高倍率では Detailer の併用を推奨。

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

**出力**: `SAMPLES` (LATENT)

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

**出力**: `SAM3_MODEL`（型: `CSAM3_MODEL`）

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

## Mask

### SAX Mask Adjust

`SAX_Bridge_Mask_Adjust` — 入力 MASK に対して **拡張・収縮 → ぼかし → 二値化** の順で後処理を適用する単機能ノード。SAM3 出力や手描きマスクを用途別に再加工する目的で使用します。

**入力**

| パラメータ | 型 | デフォルト | 範囲 | 説明 |
|-----------|-----|------|------|------|
| `mask` | MASK | - | - | 加工対象マスク |
| `invert` | Boolean | `False` | - | True で入力マスクを反転（`1 - mask`）してから後続処理を適用 |
| `grow` | Int | `0` | `-256`〜`256` | 正値=拡張（dilation） / 負値=収縮（erosion）。単位 px |
| `blur` | Float | `0.0` | `0.0`〜`64.0` | ガウシアンぼかしの σ（px）。`0` で無効 |
| `threshold` | Float | `0.0` | `0.0`〜`1.0` | blur 後の二値化閾値。`0` でソフトマスクのまま出力 |

**出力**: `MASK`

**適用順序**: `invert → grow → blur → threshold`

#### invert の使いどころ

「白く塗った領域 = 加工対象」を「白く塗った領域 = **保護対象**」に切り替えます。SAM3 で顔を検出した後、Detailer に「顔以外」を渡したい場合などに使用します。

| シナリオ | 設定 |
|---|---|
| 顔だけを保護して背景を Detailer | SAM3(face) → MaskAdjust(invert=on) → Detailer |
| SAM3 が背景を返してしまった | MaskAdjust(invert=on) で即座に反転 |
| 保護領域を少し外側まで広げる | MaskAdjust(invert=on, grow=+8) |

invert は適用順序の **先頭** で実行されるため、以降の grow/blur/threshold は反転後マスクを「対象領域」として扱います。

#### 使い分けのコツ

| 設定例 | 効果 |
|---|---|
| `grow=+8` | エッジが角張った膨張（最速） |
| `grow=0, blur=3.0, threshold=0.1` | 滑らかに膨張した二値マスク（ジャギなし） |
| `grow=0, blur=3.0, threshold=0.9` | 滑らかに収縮した二値マスク |
| `grow=0, blur=3.0, threshold=0.0` | ソフトマスク（境界羽化のみ） |

#### `SAX SAM3 Multi Segmenter` の `mask_grow` との関係

両者は **加算的に効きます**。後段で用途別に分岐したい場合は、SAM3 側 `mask_grow=0` にして本ノードで調整するのが分かりやすい設計です。

```
SAM3(mask_grow=0) ──┬─→ MaskAdjust(grow=+8) → Detailer (大きめ)
                    └─→ MaskAdjust(grow=-2) → NoiseInjector (小さめ)
```

[↑ トップへ](#top)

---

## Output

### SAX Output

`SAX_Bridge_Output` — ファイル保存・メタデータ埋め込みに専念した最終出力ノードです。シャープ化・グレースケール等の画質調整は [SAX Finisher](#sax-finisher) で行います。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE (optional) | 画像ソース（`image` 未接続時）兼メタデータ供給元 |
| `image` | IMAGE (optional) | 保存対象画像。未接続の場合は `pipe.images` を使用 |
| `save` | Boolean | `True` で保存実行。`False` でプレビューのみ |
| `output_dir` | String | 保存先ディレクトリ。テンプレート変数使用可。空欄 = `ComfyUI/output/` |
| `filename_template` | String | ファイル名テンプレート。テンプレート変数使用可 |
| `filename_index` | Int (0〜999999) | ファイル名インデックスの開始値。実行ごとに自動カウントアップ |
| `index_digits` | Int (1〜6) | インデックスのゼロパディング桁数（例: 3 → `001`） |
| `index_position` | Combo | `prefix`（ファイル名先頭）/ `suffix`（末尾） |
| `format` | Combo | `webp` / `png` |
| `webp_quality` | Int (1〜100) | WebP 品質（`lossless=True` の場合は無効） |
| `webp_lossless` | Boolean | WebP ロスレス保存 |
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

**入力**: `slot_0` 〜 `slot_31` (ANY, optional) — 登録したソースの出力が順に接続される（スロットは UI が自動管理）

**出力**: `out_0` 〜 `out_31` (ANY) — 同じ番号の入力スロットの値をそのまま下流へ転送

#### 主な機能

- `+ Add Source` ボタンでピッカーを開き、複数のノードを選択・追加（最大 32 スロット）
- ソースのスロット追加・削除・リネームを自動検知して入出力スロットを再同期（下流接続を維持）
- 上流ノードの出力スロットを改名 / 並べ替えても、同一の論理スロットへ接続を維持する
- 上流ノードを実削除した場合のみ該当 source エントリを自動クリーンアップ。貼付け / undo / サブグラフ折畳の過渡では削除しない
- ソースのスロット選択変更 / 並べ替え / 追加・削除を行っても、後続ノード（`SAX Prompt Concat` 等の動的入力ノードを含む）への接続は維持される。切れるのは選択を外したスロットと削除したソースの分だけ
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

## Debug

### SAX Debug Controller

`SAX_Bridge_Debug_Controller` — ワークフロー内の全 SAX ノードの実行記録をレポート出力するデバッグスイッチです。ワークフローのどこかに 1 つ置いて ON にするだけで使えます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `enabled` | Boolean (ON / OFF) | `ON` でこのワークフロー分のレポート出力を要求する |

**出力**: なし（ノード UI に `Debug logging: ON` / `OFF` を表示）

**動作**:
- 全 SAX ノードの execute は常にラップされて実行記録を蓄積しており、このノードは「その記録をレポートとして出すかどうか」だけを切り替える。そのため Controller の実行順序に関係なく、ワークフロー内の全ノードの記録が取れる
- ワークフロー完了時にフローレポートをログへ出力し、併せて JSONL を `sax_debug/sax_debug_<UTC時刻>.jsonl` に書き出す（HTTP 非公開の system user ディレクトリ配下。最大 20 ファイルを保持）
- `OFF` にするとレポート出力の取り下げに加え、記録の蓄積自体を停止する
- キャッシュを常に外して毎回 execute されるため、トグルの状態が必ず反映される

[↑ トップへ](#top)

### SAX Debug Inspector

`SAX_Bridge_Debug_Inspector` — `PIPE_LINE` の内部フィールド（model/clip/vae の有無、seed、loader_settings の各値、images/samples の shape、applied_loras 等）を整形してノード UI に表示するデバッグノードです。

**入力**: `pipe` (PIPE_LINE)

**出力**: なし（ノード UI にテキスト表示）

**表示例**:
```
model: present
clip: present
vae: present
seed: 42
loader_settings.steps: 20
loader_settings.cfg: 8.0
loader_settings.sampler_name: euler
images: shape=(1, 512, 512, 3)
samples.samples: shape=(1, 4, 64, 64)
applied_loras: {'lora_a'} (1 entries)
```

[↑ トップへ](#top)

### SAX Debug Text

`SAX_Bridge_Debug_Text` — 任意の文字列値をノード UI に表示するノードです。`POPULATED_TEXT` の確認や、中間プロンプト・メタデータ・任意の文字列値の確認に利用します。

**入力**: `value` (ANY)

**出力**: なし（ノード UI にテキスト表示）

[↑ トップへ](#top)

### SAX Assert

`SAX_Bridge_Assert` — 任意の値が期待条件を満たすかを検証するノードです。検証結果をノード UI とログへ表示します。失敗や評価エラーでもワークフローは停止しません。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `value` | ANY | 検証対象の値 |
| `mode` | Combo | assertion モード（下表参照） |
| `expected` | String | 期待値（mode に応じて自動パース） |
| `label` | String | UI 表示用ラベル |

**出力**: なし（ノード UI に PASS/FAIL 表示、PASS=緑 / FAIL=赤 / ERROR=橙の枠線）

**assertion モード一覧**

| mode | 期待値フォーマット | 動作 |
|------|------------------|------|
| `not_none` | — | `value is not None` |
| `is_none` | — | `value is None` |
| `equals` | 任意（自動パース） | `value == expected` |
| `not_equals` | 任意 | `value != expected` |
| `contains` | 文字列 | `str(expected) in str(value)` |
| `not_contains` | 文字列 | `str(expected) not in str(value)` |
| `matches` | 正規表現 | `re.search(expected, str(value))` |
| `startswith` / `endswith` | 文字列 | 文字列前方・後方一致 |
| `greater_than` / `less_than` | 数値 | 数値比較 |
| `in_range` | "min,max" | `min <= value <= max` |
| `shape_equals` | "B,C,H,W" | tensor の shape 一致 |
| `length_equals` | 整数 | `len(value) == N` |
| `has_key` | 文字列 | `key in value`（dict） |
| `has_item` | 任意 | `item in value`（list/set） |

**期待値の自動パース順序**: int → float → bool(`true`/`false`) → None(`null`/`none`) → list/tuple（カンマ区切り）→ str fallback

[↑ トップへ](#top)

### SAX Assert Pipe

`SAX_Bridge_Assert_Pipe` — `PIPE_LINE`（または任意の dict/object）内のフィールドを、ドット区切りパスで取り出して検証するノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `value` | ANY | 対象（通常は PIPE_LINE） |
| `path` | String | ドット区切りパス（例: `loader_settings.steps`） |
| `mode` / `expected` / `label` | — | SAX Assert と同一 |

**path 解決ルール**: 各セグメントを `dict[key]` → `getattr` → `value[int(seg)]`（インデックス）の順に試行。解決失敗時は available keys/attrs を含む ERROR を UI とログへ表示します。

**出力**: なし（ノード UI に PASS/FAIL 表示）

[↑ トップへ](#top)

---

## Utility

### SAX Primitive Store

`SAX_Bridge_Primitive_Store` — ワークフロー内で利用する共通プリミティブ変数を一か所で定義・管理するノードです。アイテムを追加するたびに出力スロットが増え、下流ノードへ値を配布します。

**入力**: `items_json` (String, hidden) — アイテム定義の JSON 配列。ノード UI が自動管理

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

### SAX Text Catalog

`SAX_Bridge_Text_Catalog` — 名前付きテキスト（プロンプト等）をノード内のカタログとして保管し、Relation 経由で出力スロットに割り当てるノードです。複数のプロンプトをバインダー的に管理し、ワークフロー側を書き換えずに切替できます。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `items_json` | String (hidden) | Catalog と Relation の JSON。Manager Dialog / ノード UI が自動管理 |
| `select_to_add_lora` | Combo (hidden) | Manager Editor の LoRA ピッカーが選択肢ソースとして参照する。実行では未使用 |
| `select_to_add_wildcard` | Combo (hidden) | Manager Editor の Wildcard ピッカーが選択肢ソースとして参照する。実行では未使用 |
| `merge_outputs` | Boolean | `individual`: Relation ごとに出力 / `merged`: 有効な Relation のテキストを改行結合して単一出力 |

**出力**: `individual` は Relation ごとの STRING、`merged` は単一の `merged` STRING

#### 4 要素モデル

| 要素 | 役割 | 編集場所 |
|------|------|---------|
| **Catalog** | Item の保管庫 | Manager Dialog |
| **Item** | 名前付きテキスト 1 件（`id` / `name` / `text` / `tags`） | Manager Dialog |
| **Relation** | Catalog.Item と Slot の紐づけ | ノード本体ウィジェット |
| **Slot** | ComfyUI 出力ピン（Relation 配列から自動生成） | （直接操作不可） |

#### 主な機能

**ノード本体ウィジェット**
- `📖 Manage Texts...` ボタン / 右クリックメニューで Manager Dialog を起動
- `[+ Add Relation]` で Relation を追加すると同時に出力 Slot も増える
- `merge_outputs` を `merged` にすると、ON の Relation テキストを strip → 空文字除外 → 改行結合し、単一の `merged` 出力へ集約する
- Relation を追加 / 削除 / 並べ替えしても、後続ノード（`SAX Prompt Concat` 等の動的入力ノードを含む）への接続は維持される
- 各 Relation 行に行頭トグル（pill）/ `[✎]`（Item 選択）/ `[↑↓]`（並び替え）/ `[×]`（削除）
- Relation 行のラベル部分をクリックすると、その Item を選択した状態で Manager が開き、そのまま編集できる（`(unset)` / `<orphan>` の行は Item 選択を開く）
- 行頭トグルを OFF にすると、Item 割当を残したまま Slot 出力を空文字にできる（一時的に出力を止める用途）
- OFF 状態の Relation はテキストが半透明表示になる
- 未割当 Relation は `(unset)` を灰色で表示（スロットは残存し、接続していれば維持される）
- 削除済み Item を参照する Relation は `<orphan>` を警告色で表示（スロットは残存し、接続していれば維持される）
- `merge_outputs` トグル（`individual` / `merged`）で出力形態を切替。`merged` にすると有効な全 Relation のテキストを改行結合した単一 `merged` ピンだけを出力する（`SAX Prompt Concat` の動的入力が 11 本以上に増えると発生する ComfyUI フロントエンドの入力スロット並び順崩れを、入力 1 本化で回避する用途）。切替時は出力形態が変わるため下流接続を切断する

**Manager Dialog（テキスト管理）**
- 左ペイン：Item 一覧（検索、タグフィルタ、参照中 Relation 数 `×N` 表示）
- 右ペイン：選択中 Item の Name / Tags / Text を編集（テキスト入力エリアは大きく確保）
- `[+ New]` で新規 Item 追加、`[Duplicate]` / `[Delete]` で複製・削除
- 参照中の Item を削除する場合は確認ダイアログ表示。削除後の `[Save]` でも当該 Relation の下流接続は維持される（スロットは `(unset)` 表示で残存）
- `[Manage Tags]` でお気に入りタグ管理サブダイアログを開く
- フッター：`[Close]`（未保存時は確認）/ `[Save]`（反映、Dialog 継続）

**Item ピッカー（Relation 編集）**
- Manager と同じ検索 + タグフィルタ UI
- 「(unset)」を最上部に常時表示（未割当に戻すため）
- AND 条件で絞り込み（検索クエリ + 選択タグ全て一致）
- ピッカーで Item を変更しても当該 Relation の下流接続は維持される

**タグ機能**
- ハイブリッド入力：既存タグ候補から選択 + 自由入力（自動で `tag_definitions` に追加）
- 自動正規化：`trim()` + 小文字化（`"Positive  "` → `"positive"`）
- お気に入りタグ：`[★/☆]` トグルで指定、Manage Tags 内で `[↑↓]` 並び替え
- タグフィルタは 1 行固定、件数超過時は `[Show all]` ボタンで別ダイアログ展開

**Text 編集エリアのオートコンプリート（オプション）**
- [pythongosssss/ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) が導入されていれば、Item Text 編集 textarea で danbooru タグ補完が有効になる
- カテゴリ別の色分け、エイリアス対応、↑↓ Enter/Tab で確定など、pyssss 標準動作をそのまま継承
- カンマ区切り（`globalSeparator = ", "`）を自動付与
- 未導入時は何もしない（手動入力にフォールバック）

**LoRA / Wildcard ピッカー**
- Item Text 編集エリアの直下に `[+ LoRA]` `[+ Wildcard]` ボタンを配置
- `[+ LoRA]`：ComfyUI の LoRA 一覧からピッカーモーダルで選択 → カーソル位置に `<lora:NAME>` を挿入（拡張子のみ除去、サブディレクトリは保持して同名衝突を防ぐ。例: `<lora:style/foo>`）
- `[+ Wildcard]`：Impact-Pack の Wildcard 一覧から選択 → カーソル位置に Wildcard 名を挿入（既存テキストとの間に `, ` を自動付与）
- LoRA が 0 件 or Impact-Pack 未導入時は対応するボタンを無効化（ツールチップで理由表示）

**並び順仕様**
- タグ：お気に入り（コンテキスト連動）→ アイテム数降順 → アルファベット順
- アイテム：タグ順序に基づくタプル辞書順（タグなしは末尾）
- Item 内タグ表示：タグトグル並びと連動

#### 制約値

| 項目 | 値 |
|------|-----|
| 最大 Item 数 | 256 |
| 最大 Relation 数 | 32 |
| Item あたりタグ数 | 8 |
| Item id 最大長 | 128 文字（DoS 対策） |

#### 出力契約

| ケース | 出力値 |
|--------|--------|
| Relation が ON かつ Item を正しく参照 | `Item.text` |
| Relation が OFF（行頭トグル OFF） | `""` |
| Relation が未割当（`item_id: null`） | `""` |
| Relation が削除済み Item を参照 | `""` |

下流ノード（`SAX Prompt Concat` 等）の空文字スキップ実装と整合します。

`merge_outputs` を ON（`merged`）にすると、残ったテキストを `strip()` し、空文字を除外して改行で結合します。バックエンドでは `out_0` に結合結果、`out_1..31` に空文字を返し、フロントエンドは単一の `merged` ピンを表示します。これは `SAX Prompt Concat` の正規化と等価で、BREAK 構文も独立して処理されます。

> **互換性**: 旧ワークフロー（`on` フィールドが存在しない `items_json`）は ON 扱いで読み込まれます（後方互換）。

> **データ保管範囲**: ノード単位（items_json でワークフローに含まれる）。グローバル共有はしません。
> **接続したいプロンプトが複数ある場合**: 1 つの Item を複数 Relation から参照することもできます。

[↑ トップへ](#top)

---

### SAX Text Catalog V2

`SAX_Bridge_Text_Catalog_V2` — 名前付きテキストを明示的な候補と組合せレシピで選び、固定文とランダム選択を再現可能に結合する独立ノードです。V1 の `SAX_Bridge_Text_Catalog` と同じワークフローで併用できます。V1 のデータを置き換えたり、自動移行したりはしません。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `config_json` | String (hidden, optional) | カタログ、レシピ、グループを格納する version 2 JSON。入力を省略した場合は空モデルを使い、ノード UI が自動管理。空文字や不正な JSON はエラー |
| `seed` | Int (0〜9007199254740991) | 抽選シード。ComfyUI の control after generate で実行ごとに更新可能 |

**出力**: `text` STRING（空文字を除き、前後の空白を除去して改行結合） / `selection_json` STRING（実行時の選択記録）

#### JSON 契約

```json
{
  "version": 2,
  "catalog": { "items": [{ "id": "item-1", "name": "quality", "text": "high quality", "tags": ["quality"] }] },
  "recipes": [{ "id": "default", "name": "Default", "groups": [{ "id": "fixed", "name": "Fixed", "mode": "all", "item_ids": ["item-1"], "count": 1, "on": true }] }],
  "active_recipe_id": "default"
}
```

- `all` は候補配列の順にすべてを選択します。`random` は `count` 件を重複なしで選び、結果は候補配列の順に出力します。`count: 0` は有効です。候補が不足すると実行エラーになります。
- 抽選は `seed`・recipe ID・group ID からグループごとに独立して決まります。ほかのグループの有効状態や順番を変えても抽選結果は変わりません。同じ Item を複数グループで選ぶことはできます。
- 同じ `seed` と設定なら選択は再現されます。実行ごとに結果を変える場合は ComfyUI の control after generate を `randomize` または `increment` にします。
- 候補は明示的に選択します。タグで絞り込んだ素材から複数候補を追加できます。
- 不正 JSON、未知の schema version、孤立した参照、上限超過はエラーになります。上限は Items 10,000、Recipes 32、Recipe あたり Groups 32、Group あたり候補 10,000、`count` 0〜10,000、Item あたり Tags 8、ID 128 文字、名前 256 文字、テキスト 65,536 文字、`config_json` 32 MiB、結合出力 32 MiB です。

#### UI と編集

- ノード上で保存済みの組み合わせを切り替え、各グループの ON/OFF とランダム選択数を変更できます。グループは 8 件ずつ表示します。seed と実行後の seed 更新設定もノード上で操作します。
- 「管理・編集」で大量のアイテム管理・本文編集・組み合わせ構成の画面を開きます。通常の組み合わせ切り替えや有効化に、この画面を開く必要はありません。
- 操作画面を「ライブラリ」「アイテム編集」「組み合わせ」に分けています。
- 「ライブラリ」は画面全幅の一覧です。名前・タグ・本文抜粋・使用数を確認し、名前・本文・タグ検索、並べ替え、Shift による範囲選択、検索結果の全選択、一括タグ操作・削除で大量の素材を管理します。
- 一覧は仮想化し、10,000 件を読み込んでも可視範囲だけを描画します。本文エディタを一覧の下へ押し込まず、それぞれの操作に画面の広さを使います。
- 「アイテム編集」は選択した素材の名前・タグ・本文を編集する専用画面です。大きな本文欄を使い、一覧を隠して編集に集中することもできます。
- 「組み合わせ」は素材の参照を構成する画面です。Recipe の複製・切り替え、固定またはランダム Group、候補・選択数・ON/OFF・順番を操作します。アイテム本文の編集欄は表示しません。
- 組み合わせは元アイテムを ID で参照するため、アイテム編集はすべての参照先に反映されます。独立した本文が必要な場合はアイテム編集で素材を複製し、組み合わせでそのコピーを候補に選びます。
- 編集はノードへ自動反映され、Undo / Redo と実行後の結果表示に対応します。

> **データ保管範囲**: ノード単位（`config_json` に保存され、ワークフローに含まれます）。V1 のデータとは独立しています。

[↑ トップへ](#top)

---

### SAX Cache

`SAX_Bridge_Cache` — Pipe 内のモデルに DeepCache をワンタッチ適用し、後段の KSampler・Detailer 全体を高速化するノードです。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `enabled` | Boolean | `False` でキャッシュを適用せずそのまま返す |
| `deepcache_interval` | Int (1〜10) | N ステップに 1 回だけ深層計算し残りをキャッシュで代替（1 = DeepCache 無効） |
| `deepcache_start_percent` | Float (0.0〜1.0) | DeepCache を開始するデノイジング進行割合 |

**出力**: `PIPE`

> **配置位置**: SAX Loader の直後（KSampler・Detailer より前）に挿入することで全処理に一括適用できます。
> **対応モデル**: DeepCache は UNet 系モデル（SD1.5 / SDXL / Illustrious / Pony）専用です。FLUX・SD3.5・Qwen-Image・Chroma・Wan などの DiT 系モデルに挿した場合はキャッシュを適用せず、警告をログに出して Pipe をそのまま通します。
> **注意**: 蒸留モデル（DMD2 等）との組み合わせでは品質劣化が顕著になる場合があります。

[↑ トップへ](#top)

---

### SAX Toggle Manager

`SAX_Bridge_Toggle_Manager` — グループ・サブグラフ・ノード・Boolean ウィジェットの bypass / 値をシーン単位で一括管理するコントロールノードです。

> **実行不要**: シーン切り替えとトグル操作はすべてフロントエンドで即時反映されます。キューへの追加は不要です。

**入力**: `config_json` (String, hidden) — シーン設定の JSON。JS が管理するため直接編集は不要

**出力**: なし（フロントエンド専用のコントロールノード）

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
