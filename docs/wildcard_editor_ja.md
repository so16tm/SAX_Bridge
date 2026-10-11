# SAX Wildcard Editor（Autocomplete++ 用）

SAX_Bridge の **SAX Wildcard Editor** ノードは、Autocomplete++ が読み込める `.txt` ワイルドカードを編集するための独立した管理画面を開きます。SAX Text Catalog V2 のデータ・UI には依存しません。ノードの実行は不要です。

1. `SAX/Bridge/Utility → SAX Wildcard Editor` を追加。
2. **ワイルドカードを編集** で画面を開き、左側から既存ファイルを選択（ファイル名検索可能）、または **＋ 新規作成** を押します。
3. 右側で保存先とファイル名（例: `clothing/dresses`）を指定。ファイル名に `.txt` を付けなくても保存時に付与されます。
4. 候補は **1行に1つ** 記述します。追加・行削除・上下移動やテキストエリアでの複数行編集ができます。**保存** で反映されます。
5. **？ 書式ヘルプ** またはノード上の **書式ヘルプ** から短い実例を確認できます。詳しい仕様は [Autocomplete++ 公式説明](https://github.com/michikora/ComfyUI-Autocomplete-Plus-Plus/blob/main/README_jp.md)。

## ファイル形式

```text
# outfits
red dress
blue dress
{3::white dress | 1::black dress}
__style/casual__
```

ファイルを `clothing/dresses.txt` として保存した場合、プロンプト中の `__clothing/dresses__` から参照します。空行・`#` コメント行は抽選対象から除かれます。改行・コメントは編集で保持され、保存時に自動削除されません。

保存先として選べるのは、Autocomplete++ が探索する `ComfyUI/wildcards/`、既存の `custom_nodes/*/wildcards/`、Autocomplete++ の `tags/wildcards/` です。任意の OS 絶対パスへの書き込みは安全上許可しません。保存先内部の相対パスとファイル名は選べます。

- 別名保存は元ファイルを残します。既にある別名ファイルを知らずに上書きすることはありません。
- 他の編集による同時変更をハッシュで検出します。保存時に衝突した場合は勝手に上書きしません。
- 同名ファイルが複数の検索先に存在すると優先順位の高い方が使用されるため、一覧と保存完了時に警告します。
- UTF-8テキストのみ、1ファイル最大2 MiB、一覧は最大10,000ファイルです。
- ブラウザー側のAutocomplete++が既にファイル内容をキャッシュしている場合は、ファイル保存後にComfyUIブラウザーのリロードが必要なことがあります。
