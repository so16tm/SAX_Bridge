/**
 * Collector 接続維持/削除マトリクス (入力側) のロジックテスト
 *
 * docs/plans/20260613-dynamic-slot-disconnect-permanent-fix.md
 * 「確定: 接続の維持/削除マトリクス」入力側全行を node:test で検証する。
 *
 * app 非依存に切り出した sax_collector_link.js の関数を直接組み合わせて、
 * 各シナリオで「入力接続が維持/削除されるべきか」をロジックレベルで検証する。
 * Canvas 描画・LiteGraph 実接続は MANUAL_TEST.md / onConfigure スモークに委ねる。
 *
 * 実行: node --test tests/js/collector_disconnect_matrix.test.mjs
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
    sourceSignature,
    buildInputAnchors,
    resolveAnchorsToOutputSlots,
    reconcileRemoval,
    reconcileAllRemoved,
    partitionLiveSources,
} from "../../js/sax_collector_link.js";

function srcNode({ id = 1, outputs = [] } = {}) {
    return {
        id,
        outputs: outputs.map(o => ({ name: o.name, type: o.type, label: o.label, links: [] })),
    };
}

// ===========================================================================
// 入力側マトリクス
// ===========================================================================

describe("入力側マトリクス: 上流スロット改名/並べ替え/増減 → 維持 (B2)", () => {
    it("並べ替え: 元 index 1 の image が index 0 に来ても同一論理スロットへ", () => {
        const before = srcNode({ outputs: [
            { name: "latent", type: "LATENT" },
            { name: "image",  type: "IMAGE" },
        ] });
        const anchors = buildInputAnchors(before, [1]);  // image をアンカー保存

        const after = srcNode({ outputs: [
            { name: "image",  type: "IMAGE" },
            { name: "latent", type: "LATENT" },
        ] });
        const resolved = resolveAnchorsToOutputSlots(after, anchors);
        assert.equal(resolved[0].slotIndex, 0);  // image の新位置
    });

    it("改名 (name 変更・位置維持): originalSlotIndex で解決", () => {
        const before = srcNode({ outputs: [{ name: "image", type: "IMAGE" }] });
        const anchors = buildInputAnchors(before, [0]);

        const after = srcNode({ outputs: [{ name: "img_out", type: "IMAGE" }] });
        const resolved = resolveAnchorsToOutputSlots(after, anchors);
        // name 変わったが type 一致で段階解決 or 位置解決のいずれかで維持される
        assert.notEqual(resolved[0], null);
        assert.equal(resolved[0].slotIndex, 0);
    });

    it("増加: 上流に出力が追加されても既存アンカーは維持解決", () => {
        const before = srcNode({ outputs: [{ name: "image", type: "IMAGE" }] });
        const anchors = buildInputAnchors(before, [0]);

        const after = srcNode({ outputs: [
            { name: "new",   type: "X" },
            { name: "image", type: "IMAGE" },
        ] });
        const resolved = resolveAnchorsToOutputSlots(after, anchors);
        assert.equal(resolved[0].slotIndex, 1);
    });

    it("減少: アンカー対象が消えたら null (=接続スキップ・誤接続しない)", () => {
        const before = srcNode({ outputs: [
            { name: "image", type: "IMAGE" },
            { name: "mask",  type: "MASK" },
        ] });
        const anchors = buildInputAnchors(before, [1]);  // mask

        const after = srcNode({ outputs: [{ name: "image", type: "IMAGE" }] });
        const resolved = resolveAnchorsToOutputSlots(after, anchors);
        assert.equal(resolved[0], null);
    });
});

describe("入力側マトリクス: 一時 null → 維持 (B1)", () => {
    it("getNodeById が一旦 null → 復帰: 削除候補に含まれない", () => {
        const sources = [{ sourceId: 10 }];
        // 削除イベント時点では null だが、遅延再確認で復帰
        const getNodeById = (id) => ({ id });  // 再確認時には生存
        assert.deepEqual(reconcileRemoval(10, sources, getNodeById), []);
    });

    it("sig rebuild の一時 null: missing は温存対象 (live のみ再構築)", () => {
        const sources = [{ sourceId: 10 }, { sourceId: 20 }];
        const getNodeById = (id) => (id === 20 ? null : { id });
        const { live, missing } = partitionLiveSources(sources, getNodeById);
        assert.deepEqual(live.map(s => s.sourceId), [10]);
        assert.deepEqual(missing.map(s => s.sourceId), [20]);  // input 温存対象
    });
});

describe("入力側マトリクス: 上流ノード座標変更 → 無反応・維持", () => {
    it("座標変更では sig 不変 → rebuild がトリガされない", () => {
        const n = srcNode({ outputs: [{ name: "image", type: "IMAGE" }] });
        const sigBefore = sourceSignature(n);
        n.pos = [500, 500];
        assert.equal(sourceSignature(n), sigBefore);
    });
});

describe("入力側マトリクス: 上流ノード実削除 (遅延再確認後も null) → 削除", () => {
    it("削除イベント + 遅延後も null: 当該 source を掃除", () => {
        const sources = [{ sourceId: 10 }, { sourceId: 20 }];
        const getNodeById = (id) => (id === 10 ? null : { id });
        assert.deepEqual(reconcileRemoval(10, sources, getNodeById), [0]);
    });
});

describe("複合: 同一上流を複数 Collector/source が参照", () => {
    it("同 sourceId を持つ複数 source は実削除時に全て掃除される", () => {
        const sources = [
            { sourceId: 10, sourceTitle: "A" },
            { sourceId: 10, sourceTitle: "B" },
            { sourceId: 30 },
        ];
        const getNodeById = (id) => (id === 10 ? null : { id });
        assert.deepEqual(reconcileRemoval(10, sources, getNodeById), [1, 0]);  // 降順
    });
});

describe("複合: 複数上流ノードの同時削除 (H-2 全 source 走査)", () => {
    it("同フレームで 2 件以上の上流が削除されても全ゾンビを掃除 (取りこぼさない)", () => {
        // 旧実装の単一 pendingTimer + 早期 return では 2 件目の removedId を捨てていた。
        // controller は reconcileAllRemoved で全 source を走査するため全件掃除される。
        const sources = [
            { sourceId: 10 },
            { sourceId: 20 },
            { sourceId: 30 },
        ];
        // 10 と 30 が同時削除、20 は生存
        const getNodeById = (id) => (id === 20 ? { id: 20 } : null);
        assert.deepEqual(reconcileAllRemoved(sources, getNodeById), [2, 0]);
    });

    it("一部が遅延再確認で復帰した場合は復帰分のみ温存", () => {
        const sources = [{ sourceId: 10 }, { sourceId: 20 }];
        // 10 は復帰、20 は恒久 null
        const getNodeById = (id) => (id === 10 ? { id: 10 } : null);
        assert.deepEqual(reconcileAllRemoved(sources, getNodeById), [1]);  // 20 のみ
    });
});

describe("Pipe 複数 PIPE_LINE 出力 → 正しい出力へ (先頭固定でない) (B2)", () => {
    it("2 つ目の PIPE_LINE を選んだアンカーが並べ替え後も維持される", () => {
        const before = srcNode({ outputs: [
            { name: "PIPE_A", type: "PIPE_LINE" },
            { name: "other",  type: "X" },
            { name: "PIPE_B", type: "PIPE_LINE" },
        ] });
        // 2 つ目の PIPE (global index 2) をアンカー
        const anchors = buildInputAnchors(before, [2]);
        assert.equal(anchors[0].originalSlotIndex, 2);

        // 並べ替え: PIPE_B が先頭へ
        const after = srcNode({ outputs: [
            { name: "PIPE_B", type: "PIPE_LINE" },
            { name: "PIPE_A", type: "PIPE_LINE" },
            { name: "other",  type: "X" },
        ] });
        const resolved = resolveAnchorsToOutputSlots(after, anchors);
        assert.equal(resolved[0].slotIndex, 0);  // PIPE_B の新位置 (先頭固定でなく name 解決)
    });
});
