/**
 * PrimitiveStore ワークフロー JSON 互換性テスト (Phase 1.0)
 *
 * Phase 1.0 適用前後で PrimitiveStore のワークフロー JSON が読み込み互換であることを検証する。
 * 子プラン完了基準 3 (互換性確認) に対応。
 *
 * 検証アプローチ:
 *   - tests/workflows/11_primitive_store.json (現行版) と
 *     tests/workflows/legacy-fixture/11_primitive_store.json (凍結版) の
 *     構造ダンプを比較する。
 *   - シリアライズキー (`items_json`) の値、出力スロット形状、ノード基本属性を
 *     パースして同一であることを確認する。
 *   - 実際のロードは LiteGraph 必須のため Node.js 単体では行わず、
 *     パース結果の同型性で代替する。
 *
 * 実行: node --test tests/integration/primitive_store_compat.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "..", "workflows");

function loadWorkflow(relPath) {
    const full = join(WORKFLOWS_DIR, relPath);
    return JSON.parse(readFileSync(full, "utf8"));
}

function getPrimitiveNode(workflow) {
    return workflow.nodes.find(n => n.type === "SAX_Bridge_Primitive_Store");
}

function parseItemsJson(node) {
    const raw = node.widgets_values?.[0];
    if (!raw) return [];
    return JSON.parse(raw);
}

describe("PrimitiveStore ワークフロー JSON: 現行版 vs legacy-fixture", () => {
    it("nodes / outputs / widgets_values の構造が同一", () => {
        const current = loadWorkflow("11_primitive_store.json");
        const legacy  = loadWorkflow("legacy-fixture/11_primitive_store.json");

        const curNode = getPrimitiveNode(current);
        const legNode = getPrimitiveNode(legacy);

        assert.ok(curNode, "現行版に PrimitiveStore ノードが存在");
        assert.ok(legNode, "legacy-fixture に PrimitiveStore ノードが存在");

        assert.equal(curNode.type, legNode.type, "ノード type 一致");
        assert.deepEqual(
            curNode.outputs.map(o => ({ name: o.name, type: o.type })),
            legNode.outputs.map(o => ({ name: o.name, type: o.type })),
            "outputs 構造一致",
        );
        assert.equal(curNode.widgets_values?.[0], legNode.widgets_values?.[0],
            "items_json (widgets_values[0]) 一致");
    });

    it("items_json はパース可能で同じスキーマを持つ", () => {
        const current = loadWorkflow("11_primitive_store.json");
        const legacy  = loadWorkflow("legacy-fixture/11_primitive_store.json");

        const curItems = parseItemsJson(getPrimitiveNode(current));
        const legItems = parseItemsJson(getPrimitiveNode(legacy));

        assert.equal(curItems.length, legItems.length, "アイテム数一致");
        for (let i = 0; i < curItems.length; i++) {
            assert.equal(curItems[i].name, legItems[i].name, `item[${i}].name 一致`);
            assert.equal(curItems[i].type, legItems[i].type, `item[${i}].type 一致`);
        }
    });
});

describe("PrimitiveStore items_json: Phase 1.0 で _links が混入していないこと", () => {
    it("シリアライズデータに _links キーが含まれない (シリアライズ汚染防止)", () => {
        const current = loadWorkflow("11_primitive_store.json");
        const items = parseItemsJson(getPrimitiveNode(current));
        for (const item of items) {
            assert.equal(item._links, undefined,
                `item.${item.name}: _links は items_json に含まれてはならない`);
        }
    });
});

describe("PrimitiveStore ワークフロー JSON: スキーマ互換性", () => {
    it("最小構造 (id / type / outputs / widgets_values) が必須キーとして存在", () => {
        const wf = loadWorkflow("11_primitive_store.json");
        const node = getPrimitiveNode(wf);
        assert.ok(node.id != null);
        assert.ok(node.type === "SAX_Bridge_Primitive_Store");
        assert.ok(Array.isArray(node.outputs));
        assert.ok(Array.isArray(node.widgets_values));
        assert.equal(typeof node.widgets_values[0], "string",
            "widgets_values[0] は items_json 文字列");
    });
});
