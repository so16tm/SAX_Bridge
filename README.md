# SAX_Bridge

ComfyUI のワークフローを補完・拡張する統合ブリッジモジュールです。Pipe 形式によるコンテキスト管理、Wildcard/LoRA 対応プロンプト処理、高精度な Detailer、マスク付きノイズ注入の 4 機能を提供します。

## ノード一覧

| Node ID | 表示名 | カテゴリ |
|---------|--------|----------|
| `SAX_Bridge_Pipe_Loader` | SAX Loader | SAX/Bridge/Pipe |
| `SAX_Bridge_Pipe` | SAX Pipe | SAX/Bridge/Pipe |
| `SAX_Bridge_Prompt` | SAX Prompt | SAX/Bridge/Prompt |
| `SAX_Bridge_Prompt_Concat` | SAX Prompt Concat | SAX/Bridge/Prompt |
| `SAX_Bridge_Detailer` | SAX Detailer | SAX/Bridge/Detailer |
| `SAX_Bridge_Detailer_Enhanced` | SAX Enhanced Detailer | SAX/Bridge/Detailer |
| `SAX_Bridge_Noise_Image` | SAX Image Noise | SAX/Bridge/Noise |
| `SAX_Bridge_Noise_Latent` | SAX Latent Noise | SAX/Bridge/Noise |

---

## ノード詳細

### SAX Loader (`SAX_Bridge_Pipe_Loader`)

Checkpoint・VAE・LoRA を一括ロードし、`PIPE_LINE` コンテキストを初期化します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `ckpt_name` | Combo | Checkpoint ファイル選択 |
| `clip_skip` | Int (-24〜-1) | CLIP レイヤースキップ数 |
| `vae_name` | Combo | VAE 選択（`Baked VAE` でモデル内蔵 VAE を使用） |
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

**出力**: `PIPE` (PipeLine), `SEED`

---

### SAX Pipe (`SAX_Bridge_Pipe`)

`PIPE_LINE` から任意の要素を抽出・上書き・再構成します。入力が `None` の場合は Pipe 内の値を保持するため、部分的な上書きが可能です。

**入力**: `pipe` (optional) + `model`, `pos`, `neg`, `latent`, `vae`, `clip`, `image`, `seed`, `steps`, `cfg`, `sampler`, `scheduler`, `denoise`, `optional_sampler`, `optional_sigmas`（すべて optional）

**出力**: `PIPE`, `MODEL`, `POS`, `NEG`, `LATENT`, `VAE`, `CLIP`, `IMAGE`, `SEED`, `STEPS`, `CFG`, `SAMPLER`, `SCHEDULER`, `DENOISE`

---

### SAX Prompt (`SAX_Bridge_Prompt`)

Wildcard 展開・LoRA タグ抽出・`BREAK` 構文による分割エンコードをまとめて処理します。

**入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `pipe` | PIPE_LINE | 入力パイプ |
| `wildcard_text` | String (multiline) | プロンプトテキスト。Wildcard (`__tag__`)・LoRA タグ (`<lora:name:weight>`)・`BREAK` 構文に対応 |
| `seed` | Int | Wildcard 展開用シード |

**出力**: `PIPE` (更新済み), `POPULATED_TEXT` (展開後テキスト)

**動作**:
1. Wildcard トークンをシードに基づきランダム展開
2. LoRA タグを抽出し、Model・CLIP に適用
3. `BREAK` でテキストをチャンク分割し、各チャンクを CLIP エンコード → `ConditioningConcat` で結合

---

### SAX Prompt Concat (`SAX_Bridge_Prompt_Concat`)

複数のテキスト入力（最大 10 ポート）を連結して一括処理します。

**入力**: `pipe`, `target_positive` (Boolean), `seed`, `text_1`〜`text_N`（可変、最大 10）

**出力**: `PIPE`, `CONDITIONING`, `POPULATED_TEXT`

`target_positive` で Positive / Negative のどちらに結果を格納するか選択します。

---

### SAX Detailer (`SAX_Bridge_Detailer`)

マスク領域をクロップして i2i 再描画し、元画像にブレンドして合成します。Differential Diffusion を内蔵しており、境界の自然な馴染みを実現します。

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

**出力**: `PIPE`, `IMAGE`

---

### SAX Enhanced Detailer (`SAX_Bridge_Detailer_Enhanced`)

SAX Detailer の全機能に加え、Shadow Enhancement・Edge Enhancement・Latent Noise 注入を追加したエンハンスト版です。

**追加入力**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `latent_noise_intensity` | Float (0.0〜2.0) | Latent ノイズ注入強度（i2i ディテール補強） |
| `noise_type` | Combo | `gaussian` / `uniform` |
| `shadow_enhance` | Float (0.0〜1.0) | 暗部への陰影描き込み強度 |
| `shadow_decay` | Float (0.0〜1.0) | 繰り返しごとの Shadow 強度減衰率 |
| `edge_weight` | Float (0.0〜1.0) | エッジ鮮鋭化強度（Unsharp Mask） |
| `edge_blur_sigma` | Float (0.1〜10.0) | Unsharp Mask 用ガウスカーネル幅 |

---

### SAX Image Noise (`SAX_Bridge_Noise_Image`)

画像領域（またはマスク領域）にノイズを注入します。

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

### SAX Latent Noise (`SAX_Bridge_Noise_Latent`)

Latent 領域にノイズを注入します。i2i での質感復元・ディテール補強に使用します。

**入力**: `samples` (LATENT), `intensity`, `noise_type` (`gaussian` / `uniform`), `seed`, `mask` (optional), `mask_shrink`, `mask_blur`

**出力**: `LATENT`

---

## 典型的なワークフロー

```
SAX Loader
  ↓ PIPE
SAX Prompt / SAX Prompt Concat
  ↓ PIPE (Conditioning 更新済み)
KSampler（標準ノード）
  ↓ LATENT
VAE Decode
  ↓ IMAGE
SAX Detailer または SAX Enhanced Detailer（マスク領域の精細化）
  ↓ IMAGE（最終出力）
```

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

## ライセンス

MIT License
