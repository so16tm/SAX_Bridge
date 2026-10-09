/**
 * スロット上限拡大 (Text Catalog items 32→256 / relations 32) 後の
 * Coordinator mutation コストと 1 フレーム描画コストの実測ベンチ。
 *
 * 実行:
 *   node --import ./tests/bench/register.mjs tests/bench/slot_scaling.bench.mjs
 *
 * 計測するもの:
 *   1. TextCatalog ウィジェットの 1 フレーム draw (relations 行 × catalog items 件数)
 *   2. syncOutputSlots (Coordinator の syncSlotStructure 本体)
 *   3. DynamicSlotCoordinator.applyAfterCapture (capture → mutate → sync → restore)
 *   4. 空グラフから relations を 1 件ずつ MAX まで積む累積コスト
 *
 * 計測しないもの:
 *   ブラウザのラスタライズ / レイアウト / GPU コスト。canvas ctx は no-op スタブで、
 *   数値は「フレームごとに走る SAX_Bridge 自前 JS」の時間を表す。
 */
import {
    installDomStub, captureElements, makeCtxStub, makeGraph, makeNode, makeTargetNode,
    bench, fmt, row,
} from "./env.mjs";
import { app } from "./stubs/comfy_app.js";

installDomStub();

const MAX_RELATIONS = 32;

await import("../../js/sax_text_catalog.js");

const ext = app.extensions.find(e => e.name === "SAX.TextCatalog");
if (!ext) throw new Error("SAX.TextCatalog extension not registered");

const nodeType = function TextCatalogNode() {};
nodeType.prototype = {};
await ext.beforeRegisterNodeDef(nodeType, { name: "SAX_Bridge_Text_Catalog" });

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** タグ語彙。実運用の Text Catalog を想定し、item あたり 0-3 タグを配る。 */
const TAG_VOCAB = Array.from({ length: 24 }, (_, i) => `tag${i}`);

function makeCatalogItems(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: `item-${i}`,
        name: `Preset ${i}`,
        text: `masterpiece, best quality, sample text for item ${i}`,
        tags: TAG_VOCAB.slice(i % 8, (i % 8) + (i % 4)),
    }));
}

/** relations は catalog 全体に散らばるよう等間隔で item を参照させる。 */
function makeRelations(relationCount, itemCount) {
    return Array.from({ length: relationCount }, (_, i) => ({
        item_id: itemCount === 0 ? null : `item-${Math.floor((i * itemCount) / relationCount)}`,
        on: true,
    }));
}

function makeItemsJson(relationCount, itemCount) {
    return JSON.stringify({
        version: 1,
        catalog: {
            items: makeCatalogItems(itemCount),
            tag_definitions: TAG_VOCAB,
            favorite_tags: TAG_VOCAB.slice(0, 3),
        },
        relations: makeRelations(relationCount, itemCount),
    });
}

/**
 * onConfigure 経由で本番と同じ手順の TextCatalog ノードを組み立てる。
 * 戻り値の widget は addCustomWidget されたカスタムウィジェット (draw を持つ)。
 */
function buildCatalogNode({ relationCount, itemCount, id = 1, graph = makeGraph() }) {
    const node = makeNode({ id, graph });
    node.widgets = [
        { name: "items_json", type: "text", value: makeItemsJson(relationCount, itemCount) },
        { name: "select_to_add_lora", type: "combo", value: "", options: { values: [] } },
        { name: "select_to_add_wildcard", type: "combo", value: "", options: { values: [] } },
    ];
    nodeType.prototype.onConfigure.call(node, {});
    const widget = node.widgets.find(w => w.name === "__sax_text_catalog_widget");
    return { node, widget, graph };
}

/** relations の各出力ピンに下流ノードを 1 本ずつ繋ぐ (capture/restore を実測対象にする)。 */
function wireDownstream(node, graph) {
    for (let i = 0; i < node.outputs.length; i++) {
        const target = makeTargetNode(1000 + i, graph);
        node.connect(i, target, 0);
    }
}

// ---------------------------------------------------------------------------
// 1. 1 フレーム draw コスト
// ---------------------------------------------------------------------------

const ctx = makeCtxStub();
const ITEM_COUNTS = [0, 32, 64, 128, 256];

console.log("=".repeat(120));
console.log("1. TextCatalog ウィジェット 1 フレーム draw  (relations = 32 行固定, catalog items を変化)");
console.log("=".repeat(120));

const drawResults = [];
for (const itemCount of ITEM_COUNTS) {
    const { node, widget } = buildCatalogNode({ relationCount: MAX_RELATIONS, itemCount });
    const stat = bench(() => widget.draw(ctx, node, 280, 0), { iterations: 500, warmup: 100 });
    drawResults.push({ itemCount, stat });
    console.log(row(`  catalog items = ${String(itemCount).padStart(3)}`, stat));
}
const drawBase = drawResults[1].stat.median;   // items=32 (拡大前の上限)
const drawMax  = drawResults.at(-1).stat.median;
console.log(`  → items 32 → 256 で 1 フレームあたり ${(drawMax / drawBase).toFixed(2)}x`
    + `  (${fmt(drawBase)} → ${fmt(drawMax)});  60fps 換算の CPU 占有率 ${(drawMax * 60 / 1000 * 100).toFixed(2)}%`);

// ---------------------------------------------------------------------------
// 2. syncOutputSlots (syncSlotStructure) 単体
// ---------------------------------------------------------------------------

console.log();
console.log("=".repeat(120));
console.log("2. syncOutputSlots  (Coordinator.applySaveOnly = capture なし sync のみ, relations = 32)");
console.log("=".repeat(120));

for (const itemCount of ITEM_COUNTS) {
    const { node } = buildCatalogNode({ relationCount: MAX_RELATIONS, itemCount });
    const coordinator = node._saxCoordinator;
    const relations = node._textCatalogState.relations;
    const stat = bench(() => coordinator.applySaveOnly(relations), { iterations: 300, warmup: 50 });
    console.log(row(`  catalog items = ${String(itemCount).padStart(3)}`, stat));
}

// ---------------------------------------------------------------------------
// 3. applyAfterCapture (capture → mutate → sync → restore)
// ---------------------------------------------------------------------------

console.log();
console.log("=".repeat(120));
console.log("3. Coordinator.applyAfterCapture  (relation 1 件追加 / 全出力に下流リンクあり)");
console.log("=".repeat(120));

for (const relationCount of [8, 16, 32]) {
    for (const itemCount of [32, 256]) {
        let node, coordinator;
        const setup = () => {
            const graph = makeGraph();
            const built = buildCatalogNode({ relationCount, itemCount, graph });
            node = built.node;
            wireDownstream(node, graph);
            coordinator = node._saxCoordinator;
            coordinator.captureFromExisting();
        };
        const stat = bench(() => {
            const next = [...node._textCatalogState.relations, { item_id: "item-0", on: true }];
            coordinator.applyAfterCapture(next);
        }, { iterations: 200, warmup: 30, setup });
        console.log(row(`  relations = ${String(relationCount).padStart(2)}, catalog items = ${String(itemCount).padStart(3)}`, stat));
    }
}

// ---------------------------------------------------------------------------
// 4. 空 → MAX まで 1 件ずつ積む累積コスト (UI 上の「+ Add Relation」連打相当)
// ---------------------------------------------------------------------------

console.log();
console.log("=".repeat(120));
console.log("4. relations を 0 → 32 まで 1 件ずつ追加する累積時間 (Add Relation 32 連打相当)");
console.log("=".repeat(120));

for (const itemCount of [32, 256]) {
    const stat = bench(() => {
        const graph = makeGraph();
        const { node } = buildCatalogNode({ relationCount: 0, itemCount, graph });
        const coordinator = node._saxCoordinator;
        for (let i = 0; i < MAX_RELATIONS; i++) {
            coordinator.captureFromExisting();
            coordinator.applyAfterCapture([
                ...node._textCatalogState.relations,
                { item_id: `item-${i % itemCount}`, on: true },
            ]);
        }
    }, { iterations: 60, warmup: 10 });
    console.log(row(`  catalog items = ${String(itemCount).padStart(3)}`, stat));
}

console.log();

// ---------------------------------------------------------------------------
// 5. Manage Texts ダイアログ: 初回オープン & 検索 1 打鍵あたりの再描画
//
//    renderAll() は検索ボックスの 1 打鍵ごと / アイテム 1 クリックごとに走る。
//    DOM スタブのため実ブラウザのレイアウト・ペイントは含まず、SAX_Bridge 側の
//    JS (フィルタ / タグソート / 参照カウント / 行生成) のみを計測する。
// ---------------------------------------------------------------------------

console.log("=".repeat(120));
console.log("5. Manage Texts ダイアログ  (オープン = 初回 renderAll, 打鍵 = 検索入力 1 回の renderAll)");
console.log("=".repeat(120));

for (const itemCount of ITEM_COUNTS.filter(n => n > 0)) {
    const { node } = buildCatalogNode({ relationCount: MAX_RELATIONS, itemCount });

    const openStat = bench(() => node._openTextCatalogManager(), { iterations: 80, warmup: 20 });

    // build() 中に生成された要素を掴み、UI 操作 (検索入力 / 行クリック) を再現する。
    const created = captureElements(() => node._openTextCatalogManager());
    const searchInput = created.find(el => el.tagName === "input" && el.placeholder.startsWith("Search by name"));
    if (!searchInput) throw new Error("search input not found");
    // アイテム行は click + mouseenter リスナを持つ div。
    // 同じ行を連打すると「選択が変わらない」経路になるため、2 行を交互にクリックする。
    const itemRows = created.filter(el => el.tagName === "div" && el._listeners.has("click") && el._listeners.has("mouseenter"));
    if (itemRows.length < 2) throw new Error("item rows not found");
    let clickTurn = 0;
    const clickStat = bench(() => itemRows[clickTurn++ % 2].fire("click"), { iterations: 200, warmup: 40 });

    let n = 0;
    const keyStat = bench(() => {
        // 1 文字入力直後 (ほぼ全件ヒット) = 打鍵中の最悪ケース
        searchInput.value = n++ % 2 === 0 ? "P" : "p";
        searchInput.fire("input");
    }, { iterations: 200, warmup: 40 });

    console.log(row(`  items = ${String(itemCount).padStart(3)}  ダイアログ オープン`, openStat));
    console.log(row(`  items = ${String(itemCount).padStart(3)}  アイテム 1 クリック (renderAll)`, clickStat));
    console.log(row(`  items = ${String(itemCount).padStart(3)}  検索 1 打鍵 (renderAll)`, keyStat));
}

console.log();
