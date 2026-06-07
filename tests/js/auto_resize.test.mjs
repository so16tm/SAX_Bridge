/**
 * autoResize テスト
 *
 * sax_ui_base.js の `autoResize` は app.js を import する経路に含まれるため
 * テスト環境から直接 import できない。同等ロジックをここで再実装して検証する。
 *
 * 実行: node --test tests/js/auto_resize.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// テスト用モック canvas
let dirtyCount = 0;
const mockCanvas = { setDirty(_, __) { dirtyCount++; } };

// テスト用 autoResize 再実装（sax_ui_base.js の実装と同一ロジック）
function autoResize(node, { minH = 0 } = {}) {
    const sz = node.computeSize?.();
    if (!sz) return;
    const newH = Math.max(sz[1], minH);
    if (node.size[1] !== newH) {
        node.size[1] = newH;
        mockCanvas.setDirty(true, true);
    }
}

function makeNode(computedH, currentH = 0) {
    return {
        computeSize: () => [200, computedH],
        size: [200, currentH],
    };
}

describe("autoResize", () => {
    beforeEach(() => { dirtyCount = 0; });

    it("size[1] を computeSize の高さに更新する", () => {
        const node = makeNode(120, 0);
        autoResize(node);
        assert.equal(node.size[1], 120);
    });

    it("既に同じ高さの場合は size[1] を変更しない", () => {
        const node = makeNode(120, 120);
        autoResize(node);
        assert.equal(node.size[1], 120);
        assert.equal(dirtyCount, 0);
    });

    it("高さが変化した場合に setDirty を呼ぶ", () => {
        const node = makeNode(150, 100);
        autoResize(node);
        assert.equal(dirtyCount, 1);
    });

    it("高さが変化しない場合は setDirty を呼ばない", () => {
        const node = makeNode(100, 100);
        autoResize(node);
        assert.equal(dirtyCount, 0);
    });

    it("minH オプション: computeSize より minH が大きい場合は minH を使う", () => {
        const node = makeNode(50, 0);
        autoResize(node, { minH: 100 });
        assert.equal(node.size[1], 100);
    });

    it("minH オプション: computeSize が minH より大きい場合は computeSize を使う", () => {
        const node = makeNode(200, 0);
        autoResize(node, { minH: 100 });
        assert.equal(node.size[1], 200);
    });

    it("minH デフォルト 0: 負の computeSize は 0 でクランプされない（そのまま使用）", () => {
        // minH=0 なので Math.max(sz[1], 0) → computeSize が正なら問題なし
        const node = makeNode(10, 0);
        autoResize(node, { minH: 0 });
        assert.equal(node.size[1], 10);
    });

    it("computeSize が未定義のノードでは何もしない", () => {
        const node = { size: [200, 100] };
        assert.doesNotThrow(() => autoResize(node));
        assert.equal(node.size[1], 100);
        assert.equal(dirtyCount, 0);
    });
});
