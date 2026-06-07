/**
 * sax_litegraph_helpers テスト
 *
 * sax_litegraph_helpers.js は app.js を import する経路に含まれるため
 * テスト環境から直接 import できない。同等ロジックをここで再実装して検証する。
 *
 * 実行: node --test tests/js/litegraph_helpers.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// モックグラフ
// ---------------------------------------------------------------------------

let mockNodes = [];
let mockGroups = [];

const app = {
    graph: {
        get _nodes()  { return mockNodes; },
        get _groups() { return mockGroups; },
    },
};

// ---------------------------------------------------------------------------
// テスト用ロジック再実装（sax_litegraph_helpers.js と同一実装）
// ---------------------------------------------------------------------------

function getNodesInGroup(group) {
    if (group._children?.size > 0) {
        return Array.from(group._children).filter(c => c?.id != null && typeof c.mode === "number");
    }
    const x1 = group.pos[0];
    const y1 = group.pos[1];
    const x2 = x1 + group.size[0];
    const y2 = y1 + group.size[1];
    return (app.graph._nodes ?? []).filter(n =>
        n.pos[0] >= x1 && n.pos[0] < x2 &&
        n.pos[1] >= y1 && n.pos[1] < y2
    );
}

function findGroup(item) {
    const groups = app.graph._groups ?? [];
    if (item.pos == null) return groups.find(g => g.title === item.title) ?? null;
    const exact = groups.find(g =>
        g.title === item.title &&
        Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8
    );
    if (exact) return exact;
    const byPos = groups.find(g =>
        Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8
    );
    if (byPos) return byPos;
    return groups.find(g => g.title === item.title) ?? null;
}

function matchGroup(group, item) {
    if (item.pos == null) return group.title === item.title;
    const posMatch = Math.abs(group.pos[0] - item.pos[0]) <= 8 && Math.abs(group.pos[1] - item.pos[1]) <= 8;
    return posMatch || group.title === item.title;
}

// ---------------------------------------------------------------------------
// getNodesInGroup テスト
// ---------------------------------------------------------------------------

describe("getNodesInGroup", () => {
    it("_children が存在する場合は _children から取得する", () => {
        const nodeA = { id: 1, mode: 0 };
        const nodeB = { id: 2, mode: 0 };
        const group = {
            pos: [0, 0], size: [100, 100],
            _children: new Set([nodeA, nodeB]),
        };
        mockNodes = [];
        const result = getNodesInGroup(group);
        assert.equal(result.length, 2);
        assert.ok(result.includes(nodeA));
        assert.ok(result.includes(nodeB));
    });

    it("_children に id 未定義の要素が混入した場合は除外する", () => {
        const validNode  = { id: 1, mode: 0 };
        const invalidNode = { mode: 0 }; // id なし
        const group = {
            pos: [0, 0], size: [100, 100],
            _children: new Set([validNode, invalidNode]),
        };
        mockNodes = [];
        const result = getNodesInGroup(group);
        assert.equal(result.length, 1);
        assert.ok(result.includes(validNode));
    });

    it("_children に mode 未定義の要素が混入した場合は除外する", () => {
        const validNode   = { id: 1, mode: 0 };
        const invalidNode = { id: 2 }; // mode なし
        const group = {
            pos: [0, 0], size: [100, 100],
            _children: new Set([validNode, invalidNode]),
        };
        mockNodes = [];
        const result = getNodesInGroup(group);
        assert.equal(result.length, 1);
        assert.ok(result.includes(validNode));
    });

    it("_children が空の場合はバウンディングボックスフォールバックを使う", () => {
        const group = {
            pos: [100, 100], size: [200, 200],
            _children: new Set(),
        };
        const inside  = { id: 1, mode: 0, pos: [150, 150] };
        const outside = { id: 2, mode: 0, pos: [0, 0] };
        mockNodes = [inside, outside];
        const result = getNodesInGroup(group);
        assert.equal(result.length, 1);
        assert.ok(result.includes(inside));
    });

    it("_children が undefined の場合はバウンディングボックスフォールバックを使う", () => {
        const group = {
            pos: [0, 0], size: [100, 100],
        };
        const inside  = { id: 1, mode: 0, pos: [50, 50] };
        const outside = { id: 2, mode: 0, pos: [200, 200] };
        mockNodes = [inside, outside];
        const result = getNodesInGroup(group);
        assert.equal(result.length, 1);
        assert.ok(result.includes(inside));
    });

    it("バウンディングボックス境界: pos[0] === x2 のノードは含まない（< x2 条件）", () => {
        const group = { pos: [0, 0], size: [100, 100] };
        const onEdge = { id: 1, mode: 0, pos: [100, 50] }; // x2 = 100, pos[0] = 100 → 除外
        mockNodes = [onEdge];
        const result = getNodesInGroup(group);
        assert.equal(result.length, 0);
    });
});

// ---------------------------------------------------------------------------
// findGroup テスト
// ---------------------------------------------------------------------------

describe("findGroup", () => {
    it("title + pos 両方一致（完全一致）を最優先で返す", () => {
        const g1 = { title: "Group A", pos: [100, 100] };
        const g2 = { title: "Group A", pos: [500, 500] };
        mockGroups = [g1, g2];
        const result = findGroup({ title: "Group A", pos: [100, 100] });
        assert.equal(result, g1);
    });

    it("title + pos 8px tolerance 内は完全一致扱い", () => {
        const g = { title: "Group B", pos: [100, 100] };
        mockGroups = [g];
        const result = findGroup({ title: "Group B", pos: [107, 103] }); // 7px + 3px 差
        assert.equal(result, g);
    });

    it("exact なし → pos のみ一致で返す（title が異なっても）", () => {
        const g = { title: "Renamed", pos: [100, 100] };
        mockGroups = [g];
        const result = findGroup({ title: "Old Name", pos: [100, 100] });
        assert.equal(result, g);
    });

    it("exact なし, pos なし → title のみ一致で返す", () => {
        const g = { title: "Group C", pos: [999, 999] };
        mockGroups = [g];
        const result = findGroup({ title: "Group C", pos: [0, 0] }); // pos 大きく離れている
        assert.equal(result, g);
    });

    it("item.pos が null の場合は title のみで検索する", () => {
        const g = { title: "Group D", pos: [100, 100] };
        mockGroups = [g];
        const result = findGroup({ title: "Group D", pos: null });
        assert.equal(result, g);
    });

    it("一致なし → null を返す", () => {
        mockGroups = [{ title: "Other", pos: [999, 999] }];
        const result = findGroup({ title: "Missing", pos: [0, 0] });
        assert.equal(result, null);
    });

    it("グラフにグループが存在しない → null を返す", () => {
        mockGroups = [];
        const result = findGroup({ title: "Any", pos: [0, 0] });
        assert.equal(result, null);
    });
});

// ---------------------------------------------------------------------------
// matchGroup テスト
// ---------------------------------------------------------------------------

describe("matchGroup", () => {
    it("pos が null の場合: title 一致で true", () => {
        const g = { title: "G", pos: [100, 100] };
        assert.equal(matchGroup(g, { title: "G", pos: null }), true);
    });

    it("pos が null の場合: title 不一致で false", () => {
        const g = { title: "G", pos: [100, 100] };
        assert.equal(matchGroup(g, { title: "X", pos: null }), false);
    });

    it("pos が存在し 8px 以内に一致 → true", () => {
        const g = { title: "G", pos: [100, 100] };
        assert.equal(matchGroup(g, { title: "Other", pos: [105, 98] }), true);
    });

    it("pos が存在し 8px を超えて離れている → title 一致で true", () => {
        const g = { title: "G", pos: [100, 100] };
        assert.equal(matchGroup(g, { title: "G", pos: [200, 200] }), true);
    });

    it("pos が存在し 8px を超えて離れており title も不一致 → false", () => {
        const g = { title: "G", pos: [100, 100] };
        assert.equal(matchGroup(g, { title: "X", pos: [200, 200] }), false);
    });

    it("pos ちょうど 8px 差は tolerance 内 → true", () => {
        const g = { title: "G", pos: [100, 100] };
        assert.equal(matchGroup(g, { title: "Other", pos: [108, 108] }), true);
    });

    it("pos が 9px 差は tolerance 外 → pos 不一致（title 一致があれば true）", () => {
        const g = { title: "G", pos: [100, 100] };
        // pos 不一致、title 一致 → true
        assert.equal(matchGroup(g, { title: "G", pos: [109, 100] }), true);
        // pos 不一致、title 不一致 → false
        assert.equal(matchGroup(g, { title: "X", pos: [109, 100] }), false);
    });
});
