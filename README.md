# SAX_Bridge

ComfyUI のワークフローを補完・拡張する統合ブリッジモジュールです。Pipe 形式によるコンテキスト管理、Wildcard/LoRA 対応プロンプト処理、高精度な Detailer、画像アップスケール、推論高速化キャッシュ、マスク付きノイズ注入の 6 機能を提供します。

## ノード一覧

| Node ID | 表示名 | カテゴリ |
|---------|--------|----------|
| `SAX_Bridge_Pipe_Loader` | SAX Loader | SAX/Bridge/Pipe |
| `SAX_Bridge_Pipe` | SAX Pipe | SAX/Bridge/Pipe |
| `SAX_Bridge_Prompt` | SAX Prompt | SAX/Bridge/Prompt |
| `SAX_Bridge_Prompt_Concat` | SAX Prompt Concat | SAX/Bridge/Prompt |
| `SAX_Bridge_Detailer` | SAX Detailer | SAX/Bridge/Detailer |
| `SAX_Bridge_Detailer_Enhanced` | SAX Enhanced Detailer | SAX/Bridge/Detailer |
| `SAX_Bridge_Pipe_Upscaler` | SAX Pipe Upscaler | SAX/Bridge/Upscaler |
| `SAX_Bridge_Pipe_Cache` | SAX Pipe Cache | SAX/Bridge/Cache |
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
| `steps_override` | Int (0〜200, optional) | i2i の steps 上書き（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0, optional) | i2i の CFG 上書き（0.0 = Loader 設定を継承） |

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
| `steps_override` | Int (0〜200, optional) | i2i の steps 上書き（0 = Loader 設定を継承） |
| `cfg_override` | Float (0.0〜100.0, optional) | i2i の CFG 上書き（0.0 = Loader 設定を継承） |

---

### SAX Pipe Upscaler (`SAX_Bridge_Pipe_Upscaler`)

Pipe 内の画像をアップスケールし、オプションで軽量 i2i を適用するノードです。

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
- `upscale_model_name` が `None` 以外の場合、ESRGAN 系モデルでアップスケール後、`scale_by` の目標サイズへ lanczos でリサイズ
- `upscale_model_name` が `None` の場合、`method` で指定したピクセル補間のみ
- `scale_by=1.0` かつモデルなしの場合、リサイズ処理をスキップ
- `denoise > 0` の場合、アップスケール後に KSampler (i2i) を実行してテクスチャを補完

> **アップスケールモデルの選択について**: ESRGAN 系モデルは実写・圧縮画像の復元に効果的。AI 生成アニメ調画像には `4x-AnimeSharp` 等のアニメ特化モデルを推奨。

---

### SAX Pipe Cache (`SAX_Bridge_Pipe_Cache`)

Pipe 内のモデルに DeepCache / TGate をワンタッチ適用し、後段の KSampler・Detailer 全体を高速化するノードです。

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

### 基本構成

```
SAX Loader
  ↓ PIPE
SAX Prompt / SAX Prompt Concat
  ↓ PIPE (Conditioning 更新済み)
KSampler（標準ノード）
  ↓ LATENT
VAE Decode
  ↓ IMAGE → PIPE に格納
SAX Detailer（マスク領域の精細化）
  ↓ IMAGE（最終出力）
```

### アップスケール構成

```
SAX Loader
  ↓ PIPE
SAX Prompt
  ↓ PIPE
KSampler → VAE Decode
  ↓ IMAGE → PIPE に格納
SAX Pipe Upscaler（全体リサイズ、オプションで i2i）
  ↓ PIPE
SAX Detailer（マスク領域の精細化）
  ↓ IMAGE（最終出力）
```

### キャッシュ高速化構成

```
SAX Loader
  ↓ PIPE
SAX Pipe Cache（DeepCache / TGate 適用）
  ↓ PIPE（キャッシュ適用済みモデル）
SAX Prompt
  ↓ PIPE
KSampler → VAE Decode → SAX Detailer
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
