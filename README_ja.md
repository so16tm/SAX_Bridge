# SAX_Bridge

[EN](README.md) | [主な機能](#主な機能) | [インストール](#インストール) | [依存関係](#依存関係) | [ノードリファレンス](docs/nodes_ja.md) | [MIT License](#ライセンス)

**少ないノードで高度な生成を。管理ノードで試行錯誤をスマートに。**

SAX_Bridge は、ComfyUI のワークフローに「足りなかったピース」を補うカスタムノード集です。
Checkpoint・CLIP・LoRA のロードからプロンプト処理・サンプリング・詳細化・出力までを少数のノードで完結させ、複雑な構成を組まずに高品質な生成を実現します。
また、ノードやグループをシーン単位で一括管理する独自のコントロール機能により、設定の切り替えや比較を素早く行い、試行錯誤のサイクルを短縮します。

---

## 主な機能

<a id="detailer"></a>

### 高度な画質向上を1ノードで — Detailer

<img src="docs/images/workflow_overview.png" width="800">

> **SAX Loader → SAX Prompt → SAX KSampler → SAX Upscaler → SAX Enhanced Detailer → SAX Output**
> 5ノードで生成・アップスケール・詳細化・保存まで完結。
> *(checkpoint: ZUKI anime ILL)*

マスク領域のクロップ・i2i 再描画・元画像へのブレンドを **1ノードで完結**します。
Differential Diffusion を内蔵しているため、境界の馴染みを別途調整する必要がありません。
顔・手・テキストなど細部が甘くなりがちな箇所を、ワークフローの末尾に挿入するだけで自動的に精細化します。

さらなる品質が必要な場合は **SAX Enhanced Detailer** を選択することで、Shadow Enhancement・Edge Enhancement・Latent Noise 注入も加えられます。

両 Detailer ノードにはオプションの **CFG Guidance Enhancement** 機能を搭載しています。モードを選択し強度を調整するだけで、ディテール描写を改善できます。

| モード | 対象 | 効果 |
|---|---|---|
| `agc` | 高 CFG (5+) | tanh ソフトクリッピングで色飽和スパイクを抑制 |
| `fdg` | 高 CFG (5+) | 帯域分離によるディテール強調 |
| `agc+fdg` | 高 CFG (5+) | 上記両方 |
| `post_fdg` | 低 CFG (1–3) | 低ステップ LoRA（DMD2 等）向けディテール強調 |

> **SAX Guidance** をスタンドアロンノードとして SAX KSampler や SAX Upscaler の前に配置することもできます。
> Guidance は CFG スケールに依存しない **PAG（Perturbed Attention Guidance）** にも対応しています。

### 最終仕上げを1ノードで — Finisher

**SAX Finisher** は最終画像にポストエフェクトと画質調整を適用する仕上げノードです。Detailer と Output の間に配置します。

| 効果 | パラメータ | 説明 |
|---|---|---|
| 色補正 | `color_correction` | 参照画像に色分布を合わせる |
| スムージング | `smooth` | 帯域選択でジャギー・過剰エッジを抑制 |
| シャープ化 | `sharpen_strength` / `sharpen_sigma` | Unsharp Mask によるエッジ強調 |
| ブルーム | `bloom` | 明部からの光の滲みで空気感を演出 |
| ビネット | `vignette` | 画面端を暗くして視線を中央に集める |
| 色温度 | `color_temp` | 暖色（+）/ 寒色（−）にシフト |
| グレースケール | `grayscale` | ITU-R BT.709 によるモノクロ変換（最終段で適用） |

すべてのパラメータはデフォルト 0 / False（無効）です。値を設定すると上から順に適用されます。

[↑ トップへ](#sax_bridge)

---

<a id="toggle-manager"></a>

### ワークフロー全体をシーンで管理 — Toggle Manager

| シーン: KSampler + Grayscale | シーン: Upscaler + Detailer + Save |
|:---:|:---:|
| <img src="docs/images/toggle_manager_scene1.png" width="100%"> | <img src="docs/images/toggle_manager_scene2.png" width="100%"> |

> **SAX Toggle Manager** でシーンを1クリック切り替え。
> 「グループの有効/無効」「ウィジェット値（grayscale・save）」を同時に制御。
> クイックプレビュー → 本番品質への切り替えも瞬時に。

グループ・サブグラフ・ノード・Boolean ウィジェットを **配線なし・実行なし** で一括制御するコントロールノードです。
状態をシーンとして複数保存でき、◀▶ボタン1クリックでワークフロー全体の構成を瞬時に切り替えられます。
「LoRA あり / なし」「アップスケールあり / なし」「キャッシュ有効 / 無効」といった比較パターンを事前に登録しておけば、設定変更のための手作業が不要になります。

[↑ トップへ](#sax_bridge)

---

<a id="sam3-segmenter"></a>

### テキストで切り抜いて即比較 — SAM3 Segmenter × Image Preview

<img src="docs/images/segmenter_detailer.png" width="800">

> 「hair（positive）」で広めにマスキングし、「肌部分（negative）」で差分をとることで髪だけを精密に切り抜き。
> **SAX Enhanced Detailer** × 2 に渡して髪色バリエーションを並列生成。
> **SAX Image Collector + SAX Image Preview** で結果を一覧比較。

**SAX SAM3 Multi Segmenter** は、テキストプロンプトで対象物を指定してマスクを生成します。
positive で広めに対象を捉え、negative で不要な領域を除外する組み合わせにより、手動マスクや選択ツールなしで高精度なセグメンテーションを実現します。
複数条件を重ね合わせるほど精度が上がるため、髪・顔・耳・手といった部位ごとの細かい制御も1ノードで行えます。

生成したマスクを **SAX Detailer** に渡して詳細化し、元画像・マスク・結果を **SAX Image Preview** に並べて比較することで、パラメータ調整のフィードバックループを素早く回せます。

[↑ トップへ](#sax_bridge)

---

<a id="text-catalog"></a>

### プロンプトをバインダー的に管理 — Text Catalog

**SAX Text Catalog** は名前付きテキスト（プロンプト・ネガティブ・断片）をノード内のカタログに保管し、Relation 経由で出力スロットに割り当てるノードです。シーン違いの切替、共通ネガティブの使い回し、タグによる整理など、ワークフロー側を書き換えずにテキストを切替できます。

- **Catalog → Item → Relation → Slot** の 4 要素モデルでテキスト保管と出力経路を分離
- **Manager Dialog** に検索・タグフィルタ・広いテキスト編集エリアを集約
- **タグはハイブリッド入力**（候補 + 自由入力、自動正規化）。お気に入りタグは先頭に固定可
- **タグ連動ソート** で関連 Item をグループ化し、タグトグル並びと一致させる
- 未割当 / 削除済み Item 参照は空文字を出力 — `SAX Prompt Concat` 等の空文字スキップと整合
- [pythongosssss/ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) が導入されていれば Text 編集エリアで **danbooru タグオートコンプリート** が利用可能（未導入時は手動入力）

詳細は [ノードリファレンス: SAX Text Catalog](docs/nodes_ja.md#sax-text-catalog) を参照してください。

[↑ トップへ](#sax_bridge)

---

<a id="collector"></a>

### 複雑な配線をまとめる — Collector

**SAX Node Collector** は複数ノードの出力をひとつに集約し、下流への配線をシンプルに保ちます。
ソースのスロット追加・削除・リネームを自動検知して再同期するため、ワークフロー編集中に接続が崩れることがありません。

**SAX Pipe Collector** は複数の Pipe 経路から有効な Pipe を選択するスイッチとして機能し、条件分岐を配線だけで表現できます。
**SAX Image Collector** は複数の IMAGE 出力をバッチ結合し、SAX Image Preview に渡すことで生成結果の一括比較を実現します。

[↑ トップへ](#sax_bridge)

---

## インストール

### ComfyUI Manager（推奨）

ComfyUI Manager の「Install via Git URL」から以下を入力してください：

```
https://github.com/so16tm/SAX_Bridge
```

### 手動インストール

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/so16tm/SAX_Bridge
```

[↑ トップへ](#sax_bridge)

---

## 依存関係

| 依存 | 用途 | 必須 |
|---|---|---|
| ComfyUI | 実行環境 | ✅ |
| `comfyui-impact-pack` | Wildcard 機能（SAX Prompt） | オプション |
| `ComfyUI-Custom-Scripts` (pyssss) | SAX Text Catalog の danbooru タグ補完 | オプション |
| `sam3` | SAX SAM3 系ノード | SAM3 使用時のみ |

> SAX SAM3 系ノードを使用しない場合、sam3 のインストールは不要です。

sam3 のインストール：

```bash
pip install git+https://github.com/facebookresearch/sam3.git
```

#### Windows 環境では triton が必要

sam3 は [triton](https://github.com/triton-lang/triton) に依存します。triton は従来 Linux 専用でしたが、Windows でも以下のいずれかを **sam3 のインストール前に** 導入することで利用できます。

| 環境 | コマンド |
|---|---|
| PyTorch 2.7 以降 + CUDA 12.8 以降 | `pip install triton` |
| それ以前の PyTorch / CUDA | `pip install triton-windows` |

`triton-windows` は Windows 向けの互換 wheel で、TinyCC と最小 CUDA toolchain を同梱しているため追加セットアップは不要です。詳細は [triton-lang/triton-windows](https://github.com/triton-lang/triton-windows) を参照してください。

SAM3 のロードに失敗した場合、SAX_Bridge は元の `ImportError`（例: `No module named 'triton'`）をそのまま表示するため、不足している依存を切り分けられます。

[↑ トップへ](#sax_bridge)

---

## ライセンス

[MIT License](LICENSE) © 2026 so16tm

[↑ トップへ](#sax_bridge)
