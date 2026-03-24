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
| `sam3` | SAX SAM3 系ノード | SAM3 使用時のみ |

> SAX SAM3 系ノードを使用しない場合、sam3 のインストールは不要です。

sam3 のインストール：

```bash
pip install git+https://github.com/facebookresearch/sam3.git
```

[↑ トップへ](#sax_bridge)

---

## ライセンス

[MIT License](LICENSE) © 2026 so16tm

[↑ トップへ](#sax_bridge)
