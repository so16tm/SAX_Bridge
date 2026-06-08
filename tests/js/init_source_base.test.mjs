/**
 * initSourceBase テスト
 *
 * sax_ui_base.js は app.js を import する経路上で直接 import 不可のため、
 * 同等ロジックを再実装して検証する。3 Collector の buildSource で共通化された
 * sourceId / sourceTitle / isSub / sig 初期化ロジック。
 *
 * 実行: node --test tests/js/init_source_base.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function initSourceBase(srcNode) {
    return {
        sourceId:    srcNode.id,
        sourceTitle: srcNode.title || srcNode.type || `Node#${srcNode.id}`,
        isSub:       srcNode.subgraph != null,
        sig:         "",
    };
}

describe("initSourceBase", () => {
    it("title 優先で sourceTitle を解決する", () => {
        const node = { id: 5, title: "My Node", type: "FooNode" };
        const base = initSourceBase(node);
        assert.equal(base.sourceTitle, "My Node");
    });

    it("title が無ければ type を使う", () => {
        const node = { id: 5, type: "FooNode" };
        const base = initSourceBase(node);
        assert.equal(base.sourceTitle, "FooNode");
    });

    it("title も type も無ければ Node#<id> フォールバック", () => {
        const node = { id: 12 };
        const base = initSourceBase(node);
        assert.equal(base.sourceTitle, "Node#12");
    });

    it("空文字 title は falsy として type にフォールバック", () => {
        const node = { id: 3, title: "", type: "BarNode" };
        const base = initSourceBase(node);
        assert.equal(base.sourceTitle, "BarNode");
    });

    it("subgraph 非 null なら isSub: true", () => {
        const node = { id: 1, type: "T", subgraph: { _nodes: [] } };
        assert.equal(initSourceBase(node).isSub, true);
    });

    it("subgraph 未定義なら isSub: false", () => {
        const node = { id: 1, type: "T" };
        assert.equal(initSourceBase(node).isSub, false);
    });

    it("subgraph null なら isSub: false", () => {
        const node = { id: 1, type: "T", subgraph: null };
        assert.equal(initSourceBase(node).isSub, false);
    });

    it("sourceId は node.id をそのまま反映", () => {
        assert.equal(initSourceBase({ id: 42, type: "X" }).sourceId, 42);
        assert.equal(initSourceBase({ id: "abc", type: "X" }).sourceId, "abc");
    });

    it("sig は常に空文字列で初期化", () => {
        const base = initSourceBase({ id: 1, type: "X" });
        assert.equal(base.sig, "");
    });

    it("Collector 側で spread して固有プロパティを追加できる", () => {
        const node = { id: 7, type: "ImageSrc" };
        const src = {
            ...initSourceBase(node),
            slotCount: 3,
            imageSlotIndices: [0, 1, 2],
        };
        assert.deepEqual(src, {
            sourceId: 7,
            sourceTitle: "ImageSrc",
            isSub: false,
            sig: "",
            slotCount: 3,
            imageSlotIndices: [0, 1, 2],
        });
    });

    it("固有プロパティで sig を上書きできる (onConfigure 経路)", () => {
        const node = { id: 1, type: "X" };
        const src = { ...initSourceBase(node), sig: "computed-hash" };
        assert.equal(src.sig, "computed-hash");
    });
});
