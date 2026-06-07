/**
 * stripInternal テスト
 *
 * sax_ui_base.js は app.js を import する経路上で直接 import 不可のため、
 * 同等ロジックを再実装して検証する。
 *
 * 実行: node --test tests/js/strip_internal.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function stripInternal(items) {
    return items.map(({ _links, ...rest }) => rest);
}

describe("stripInternal", () => {
    it("_links プロパティを除去する", () => {
        const items = [
            { id: "a", value: 1, _links: [{ targetId: 10, targetSlot: 0 }] },
            { id: "b", value: 2, _links: [] },
        ];
        const result = stripInternal(items);
        assert.deepEqual(result, [
            { id: "a", value: 1 },
            { id: "b", value: 2 },
        ]);
    });

    it("_links が無いアイテムも他プロパティをそのまま保持する", () => {
        const items = [{ id: "x", value: 42 }];
        const result = stripInternal(items);
        assert.deepEqual(result, [{ id: "x", value: 42 }]);
    });

    it("空配列は空配列を返す", () => {
        assert.deepEqual(stripInternal([]), []);
    });

    it("元配列を変更しない (immutable)", () => {
        const items = [{ id: "a", _links: [1, 2] }];
        const snapshot = JSON.parse(JSON.stringify(items));
        stripInternal(items);
        assert.deepEqual(items, snapshot);
    });

    it("ネストされたオブジェクトはシャローコピー (参照保持)", () => {
        const inner = { foo: "bar" };
        const items = [{ id: "a", payload: inner, _links: [] }];
        const result = stripInternal(items);
        assert.equal(result[0].payload, inner);
    });
});
