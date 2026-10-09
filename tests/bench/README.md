# Bench (Level 1b: 性能計測)

ComfyUI 本体なしで、Node 上から `js/*.js` を**本番コードのまま**動かして所要時間を測るための一式。

```
tests/bench/
├── README.md
├── register.mjs          # `--import` で読ませる resolve フック登録
├── hooks.mjs             # `../../scripts/app.js` → stubs/comfy_app.js に差し替え
├── stubs/comfy_app.js    # ComfyUI `app` の最小スタブ
├── env.mjs               # DOM / canvas ctx / LiteGraph モックと計測ユーティリティ
└── slot_scaling.bench.mjs
```

## 実行方法

```bash
cd projects/SAX_Bridge
node --import ./tests/bench/register.mjs tests/bench/slot_scaling.bench.mjs
```

## 計測するもの / しないもの

計測されるのは **SAX_Bridge 自身の JS** だけ。canvas ctx は no-op スタブ、DOM は
プレーンオブジェクトのスタブなので、ブラウザの実レイアウト・ペイント・GPU コストは
含まれない。したがって

- 「1 フレームで走る自前 JS の時間」「1 操作あたりの更新ロジックの時間」の比較には使える
- 実ブラウザの体感時間の絶対値としては**下限**にあたる（実際はこれより必ず遅い）

DOM 要素の生成回数そのものが支配的な経路（アイテム行の全再生成など）では、
スタブ上の数値の差はブラウザ上ではさらに大きく開く。

## 数値の読み方

各行は同一処理を warmup 後に反復し、`median` / `mean` / `p95` を出す。GC の影響で
`mean` と `p95` は跳ねやすいので、**比較には median を使う**こと。

## slot_scaling.bench.mjs

Text Catalog のスロット上限拡大（catalog items 32 → 256 / relations 32）後の
更新・描画コストを測る。

1. ウィジェットの 1 フレーム draw
2. `syncOutputSlots`（Coordinator の `syncSlotStructure` 本体）
3. `DynamicSlotCoordinator.applyAfterCapture`（capture → mutate → sync → restore）
4. `+ Add Relation` を 32 回押したときの累積
5. Manage Texts ダイアログのオープン / アイテムクリック / 検索 1 打鍵
