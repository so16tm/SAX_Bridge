/**
 * TextCatalog の性能最適化に伴う不変条件テスト
 *
 * MAX_ITEMS を 32 → 256 に引き上げた際の描画・更新コスト改善として導入した
 * 3 つのキャッシュ / 差分描画が、挙動を変えていないことを検証する。
 *
 *   1. serializeState の catalog 断片キャッシュ (_catalogJsonCache)
 *      → 出力が従来実装とバイト単位で一致し、catalog 差し替えに追随すること
 *   2. findItemById の id 索引 (_itemIndexCache)
 *      → ラベル / status (ok / unset / orphan) の解決結果が変わらないこと
 *   3. Manager Dialog の選択変更 fast path
 *      → 行のハイライトと Editor だけが更新され、リスト内容が保たれること
 *
 * js/sax_text_catalog.js は `../../scripts/app.js` (ComfyUI 本体) を import するため、
 * tests/bench/hooks.mjs の resolve フックでスタブに差し替えてから動的 import する。
 *
 * 実行: node --test tests/js/text_catalog_perf_invariants.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { installDomStub, captureElements, makeCtxStub, makeGraph, makeNode } from "../bench/env.mjs";

register("../bench/hooks.mjs", import.meta.url);
installDomStub();

const { app } = await import("../bench/stubs/comfy_app.js");
await import("../../js/sax_text_catalog.js");

const SCHEMA_VERSION = 1;
const TAG_VOCAB = ["style", "quality", "camera", "light", "mood"];

const nodeType = function TextCatalogNode() {};
nodeType.prototype = {};

before(async () => {
    const ext = app.extensions.find(e => e.name === "SAX.TextCatalog");
    assert.ok(ext, "SAX.TextCatalog extension registered");
    await ext.beforeRegisterNodeDef(nodeType, { name: "SAX_Bridge_Text_Catalog" });
});

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

function makeItems(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: `item-${i}`,
        name: `Preset ${i}`,
        text: `text body ${i}`,
        tags: TAG_VOCAB.slice(i % 3, (i % 3) + (i % 3)),
    }));
}

function makeStatePayload({ itemCount, relations }) {
    return {
        version: SCHEMA_VERSION,
        catalog: {
            items: makeItems(itemCount),
            tag_definitions: TAG_VOCAB,
            favorite_tags: TAG_VOCAB.slice(0, 2),
        },
        relations,
    };
}

/** 最適化前の serializeState と同じ手順で JSON を組む参照実装。 */
function referenceSerialize(state) {
    return JSON.stringify({
        version: SCHEMA_VERSION,
        catalog: {
            items: state.catalog.items.map(({ id, name, text, tags }) => ({
                id, name, text, tags: [...(tags ?? [])],
            })),
            tag_definitions: [...state.catalog.tag_definitions],
            favorite_tags: [...(state.catalog.favorite_tags ?? [])],
        },
        relations: state.relations.map(({ item_id, on }) => ({
            item_id,
            on: on !== undefined ? Boolean(on) : true,
        })),
    });
}

function buildNode({ itemCount, relations, id = 1 }) {
    const graph = makeGraph();
    const node = makeNode({ id, graph });
    node.widgets = [
        { name: "items_json", type: "text", value: JSON.stringify(makeStatePayload({ itemCount, relations })) },
        { name: "select_to_add_lora", type: "combo", value: "", options: { values: [] } },
        { name: "select_to_add_wildcard", type: "combo", value: "", options: { values: [] } },
    ];
    nodeType.prototype.onConfigure.call(node, {});
    return { node, graph };
}

const itemsJsonOf = node => node.widgets.find(w => w.name === "items_json").value;

// ---------------------------------------------------------------------------

describe("TextCatalog: serializeState の catalog 断片キャッシュ", () => {
    it("出力が従来実装とバイト単位で一致する", () => {
        const relations = [
            { item_id: "item-0", on: true },
            { item_id: "item-7", on: false },
            { item_id: null, on: true },
        ];
        const { node } = buildNode({ itemCount: 16, relations });
        assert.equal(itemsJsonOf(node), referenceSerialize(node._textCatalogState));
    });

    it("relations を変えても catalog 部分が壊れず、毎回 relations だけ更新される", () => {
        const { node } = buildNode({ itemCount: 32, relations: [{ item_id: "item-1", on: true }] });
        const coordinator = node._saxCoordinator;

        coordinator.applyAfterCapture([
            ...node._textCatalogState.relations,
            { item_id: "item-2", on: false },
        ]);

        const json = itemsJsonOf(node);
        assert.equal(json, referenceSerialize(node._textCatalogState));
        const parsed = JSON.parse(json);
        assert.equal(parsed.catalog.items.length, 32);
        assert.deepEqual(parsed.relations, [
            { item_id: "item-1", on: true },
            { item_id: "item-2", on: false },
        ]);
    });

    it("catalog を差し替えるとキャッシュが追随する (stale にならない)", () => {
        const { node } = buildNode({ itemCount: 4, relations: [{ item_id: "item-0", on: true }] });
        const before = JSON.parse(itemsJsonOf(node));
        assert.equal(before.catalog.items[0].name, "Preset 0");

        // Manager Save と同じく catalog を新しいオブジェクトへ差し替える。
        node._textCatalogState = {
            ...node._textCatalogState,
            catalog: {
                items: [{ id: "item-0", name: "renamed", text: "t", tags: [] }],
                tag_definitions: [],
                favorite_tags: [],
            },
        };
        node._saxCoordinator.applySaveOnly(node._textCatalogState.relations);

        const after = JSON.parse(itemsJsonOf(node));
        assert.equal(after.catalog.items.length, 1);
        assert.equal(after.catalog.items[0].name, "renamed");
        assert.equal(itemsJsonOf(node), referenceSerialize(node._textCatalogState));
    });

    it("`on` 欠損は true に正規化される (parseState と対称)", () => {
        const { node } = buildNode({ itemCount: 2, relations: [{ item_id: "item-0" }] });
        assert.deepEqual(JSON.parse(itemsJsonOf(node)).relations, [{ item_id: "item-0", on: true }]);
    });
});

describe("TextCatalog: findItemById の id 索引", () => {
    it("出力スロット名が item 名 / (unset) / <orphan> に正しく解決される", () => {
        const { node } = buildNode({
            itemCount: 8,
            relations: [
                { item_id: "item-3", on: true },
                { item_id: null, on: true },
                { item_id: "item-missing", on: true },
            ],
        });
        assert.deepEqual(node.outputs.map(o => o.name), ["Preset 3", "(unset)", "(unset)"]);
        // 存在しない item_id は onConfigure の自動修復で null 化されるため (unset) になる。
        assert.deepEqual(node.outputs.map(o => o._textCatalogStatus), ["ok", "unset", "unset"]);
    });

    it("catalog から item を消すと <orphan> になる", () => {
        const { node } = buildNode({ itemCount: 4, relations: [{ item_id: "item-2", on: true }] });
        assert.equal(node.outputs[0].name, "Preset 2");

        node._textCatalogState = {
            ...node._textCatalogState,
            catalog: { ...node._textCatalogState.catalog, items: makeItems(2) },
        };
        node._saxCoordinator.applySaveOnly(node._textCatalogState.relations);

        assert.equal(node.outputs[0].name, "<orphan>");
        assert.equal(node.outputs[0]._textCatalogStatus, "orphan");
    });

    it("同じ catalog を何度引いても結果が変わらない (キャッシュの副作用なし)", () => {
        const { node } = buildNode({ itemCount: 64, relations: [{ item_id: "item-63", on: true }] });
        const ctx = makeCtxStub();
        const widget = node.widgets.find(w => w.name === "__sax_text_catalog_widget");
        for (let i = 0; i < 5; i++) widget.draw(ctx, node, 280, 0);
        assert.equal(node.outputs[0].name, "Preset 63");
        node._saxCoordinator.applySaveOnly(node._textCatalogState.relations);
        assert.equal(node.outputs[0].name, "Preset 63");
    });
});

describe("TextCatalog: Manager Dialog の選択変更 fast path", () => {
    /** ダイアログを開き、生成された要素から検索欄とアイテム行を取り出す。 */
    function openManager(node) {
        const created = captureElements(() => node._openTextCatalogManager());
        const rows = created.filter(el => el.tagName === "div"
            && el._listeners.has("click") && el._listeners.has("mouseenter"));
        const searchInput = created.find(el => el.tagName === "input"
            && el.placeholder.startsWith("Search by name"));
        return { created, rows, searchInput };
    }

    it("行クリックでハイライトが移り、リストの行 DOM は作り直されない", () => {
        const { node } = buildNode({ itemCount: 10, relations: [{ item_id: "item-0", on: true }] });
        const { rows } = openManager(node);
        assert.ok(rows.length >= 2, "アイテム行が 2 行以上ある");

        // 初期選択はリスト先頭。2 行目をクリックするとハイライトが移動する。
        assert.notEqual(rows[0].style.background, "");
        rows[1].fire("click");
        assert.equal(rows[0].style.background, "");
        assert.notEqual(rows[1].style.background, "");

        // 元の行に戻せる (fast path が双方向に働く)。
        rows[0].fire("click");
        assert.notEqual(rows[0].style.background, "");
        assert.equal(rows[1].style.background, "");
    });

    it("同じ行を再クリックしても状態が変わらない", () => {
        const { node } = buildNode({ itemCount: 6, relations: [] });
        const { rows } = openManager(node);
        rows[1].fire("click");
        const bg = rows[1].style.background;
        rows[1].fire("click");
        assert.equal(rows[1].style.background, bg);
        assert.equal(rows[0].style.background, "");
    });

    it("検索で絞り込むとリストは作り直され、新しい行がクリックできる", () => {
        const { node } = buildNode({ itemCount: 20, relations: [] });
        const { searchInput } = openManager(node);
        assert.ok(searchInput, "検索欄が存在する");

        const rebuilt = captureElements(() => {
            searchInput.value = "Preset 1";
            searchInput.fire("input");
        }).filter(el => el.tagName === "div"
            && el._listeners.has("click") && el._listeners.has("mouseenter"));

        // "Preset 1", "Preset 1x" の 11 件がヒットする。
        assert.equal(rebuilt.length, 11);
        rebuilt[2].fire("click");
        assert.notEqual(rebuilt[2].style.background, "");
    });
});
