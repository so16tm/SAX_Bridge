/**
 * sax_collector_link.js — Collector 入力リンク維持の app 非依存ロジック直接テスト (B1/B2/B3)
 *
 * 旧来の「実装コピー再現」方式 (D11/C14) を脱し、app 非依存に切り出した実関数を
 * 直接 import してテストする。これにより実装変更にテストが追従する。
 *
 * 検証対象 (docs/plans/20260613-dynamic-slot-disconnect-permanent-fix.md):
 *   - B1: ノード削除イベント駆動 + 遅延再確認 (一時 null では削除しない)
 *   - B2: 入力リンク再接続を位置 index から identity アンカーへ
 *   - B3: NodeCollector 出力 resolver の identity アンカー化
 *   - sig 変化 rebuild の一時 null 経路 (input 温存)
 *   - _sourceSignature が座標非依存であること
 *
 * 実行: node --test tests/js/collector_link.test.mjs
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
    sourceSignature,
    buildInputAnchors,
    resolveAnchorToOutputSlot,
    resolveAnchorsToOutputSlots,
    reconcileRemoval,
    reconcileAllRemoved,
    partitionLiveSources,
    mergeSourceAnchors,
} from "../../js/sax_collector_link.js";

// ---------------------------------------------------------------------------
// 最小ノードモック (app 非依存)
// ---------------------------------------------------------------------------

function srcNode({ id = 1, outputs = [] } = {}) {
    return {
        id,
        outputs: outputs.map(o => ({
            name:  o.name,
            type:  o.type,
            label: o.label,  // 明示 undefined を許容 (label 未設定ケース)
            links: [],
        })),
    };
}

// 回数で挙動が変わる getNodeById スタブ (一時 null → 復帰 等のシミュレート)
function scriptedGetNodeById(script) {
    let call = 0;
    return (id) => {
        const frame = script[Math.min(call, script.length - 1)];
        call++;
        return frame[id] ?? null;
    };
}

// ===========================================================================
// sourceSignature — 座標非依存・出力構造依存
// ===========================================================================

describe("sourceSignature", () => {
    it("出力の label:type を結合した文字列を返す", () => {
        const n = srcNode({ outputs: [
            { name: "a", type: "IMAGE", label: "Image" },
            { name: "b", type: "MASK" },
        ] });
        assert.equal(sourceSignature(n), "Image:IMAGE,b:MASK");
    });

    it("座標 (pos) 変更では sig が変わらない", () => {
        const n = srcNode({ outputs: [{ name: "a", type: "IMAGE" }] });
        const before = sourceSignature(n);
        n.pos = [100, 200];
        const after = sourceSignature(n);
        assert.equal(before, after);
    });

    it("出力スロット改名で sig が変わる", () => {
        const n = srcNode({ outputs: [{ name: "a", type: "IMAGE" }] });
        const before = sourceSignature(n);
        n.outputs[0].label = "renamed";
        assert.notEqual(before, sourceSignature(n));
    });

    it("outputs 未定義でも throw しない", () => {
        assert.equal(sourceSignature({ id: 1 }), "");
    });
});

// ===========================================================================
// buildInputAnchors — (name, type, originalSlotIndex) 複合アンカー生成
// ===========================================================================

describe("buildInputAnchors", () => {
    it("指定 globalSlotIndex の出力から複合アンカーを生成する", () => {
        const n = srcNode({ outputs: [
            { name: "latent", type: "LATENT" },
            { name: "image",  type: "IMAGE", label: "Image" },
            { name: "mask",   type: "MASK" },
        ] });
        const anchors = buildInputAnchors(n, [1, 2]);
        assert.deepEqual(anchors, [
            { name: "Image", type: "IMAGE", originalSlotIndex: 1 },
            { name: "mask",  type: "MASK",  originalSlotIndex: 2 },
        ]);
    });

    it("label 優先・なければ name を採用する", () => {
        const n = srcNode({ outputs: [{ name: "raw", type: "IMAGE" }] });
        assert.equal(buildInputAnchors(n, [0])[0].name, "raw");
    });

    it("範囲外 index は除外する", () => {
        const n = srcNode({ outputs: [{ name: "a", type: "IMAGE" }] });
        assert.deepEqual(buildInputAnchors(n, [0, 5]), [
            { name: "a", type: "IMAGE", originalSlotIndex: 0 },
        ]);
    });
});

// ===========================================================================
// resolveAnchorToOutputSlot — 段階解決 (name+type → name → originalSlotIndex)
// ===========================================================================

describe("resolveAnchorToOutputSlot", () => {
    it("段階1: name+type 一致で解決 (並べ替え後も同一論理スロット)", () => {
        // 上流が並べ替えられた: 元 index 1 の image が index 0 へ移動
        const n = srcNode({ outputs: [
            { name: "image", type: "IMAGE" },
            { name: "latent", type: "LATENT" },
        ] });
        const anchor = { name: "image", type: "IMAGE", originalSlotIndex: 1 };
        const r = resolveAnchorToOutputSlot(n, anchor);
        assert.equal(r.slotIndex, 0);
        assert.equal(r.fallback, "name+type");
    });

    it("段階2: type 改名時は name のみ一致で解決", () => {
        // type が変わったが name は同じ
        const n = srcNode({ outputs: [
            { name: "latent", type: "LATENT" },
            { name: "image",  type: "IMAGE_V2" },
        ] });
        const anchor = { name: "image", type: "IMAGE", originalSlotIndex: 0 };
        const r = resolveAnchorToOutputSlot(n, anchor);
        assert.equal(r.slotIndex, 1);
        assert.equal(r.fallback, "name");
    });

    it("段階3: name 改名時は originalSlotIndex 位置で解決", () => {
        // name も type も変わったが、位置は維持
        const n = srcNode({ outputs: [
            { name: "latent",  type: "LATENT" },
            { name: "renamed", type: "IMG" },
        ] });
        const anchor = { name: "image", type: "IMAGE", originalSlotIndex: 1 };
        const r = resolveAnchorToOutputSlot(n, anchor);
        assert.equal(r.slotIndex, 1);
        assert.equal(r.fallback, "position");
    });

    it("解決不能 (位置も範囲外) は null を返す", () => {
        const n = srcNode({ outputs: [{ name: "x", type: "X" }] });
        const anchor = { name: "image", type: "IMAGE", originalSlotIndex: 5 };
        assert.equal(resolveAnchorToOutputSlot(n, anchor), null);
    });

    it("アンカー欠落 (null) では null を返す", () => {
        const n = srcNode({ outputs: [{ name: "x", type: "X" }] });
        assert.equal(resolveAnchorToOutputSlot(n, null), null);
    });

    it("name+type が複数一致する場合 originalSlotIndex に最も近いものを選ぶ", () => {
        const n = srcNode({ outputs: [
            { name: "image", type: "IMAGE" },
            { name: "image", type: "IMAGE" },
        ] });
        const anchor = { name: "image", type: "IMAGE", originalSlotIndex: 1 };
        const r = resolveAnchorToOutputSlot(n, anchor);
        assert.equal(r.slotIndex, 1);  // originalSlotIndex 1 に一致する方を優先
    });
});

describe("resolveAnchorsToOutputSlots", () => {
    it("複数アンカーを一括解決し、解決順を保つ", () => {
        const n = srcNode({ outputs: [
            { name: "mask",  type: "MASK" },
            { name: "image", type: "IMAGE" },
        ] });
        const anchors = [
            { name: "image", type: "IMAGE", originalSlotIndex: 0 },
            { name: "mask",  type: "MASK",  originalSlotIndex: 1 },
        ];
        const r = resolveAnchorsToOutputSlots(n, anchors);
        assert.deepEqual(r.map(x => x?.slotIndex), [1, 0]);
    });

    it("一部解決不能でも他は解決する (null 混在)", () => {
        const n = srcNode({ outputs: [{ name: "image", type: "IMAGE" }] });
        const anchors = [
            { name: "image",   type: "IMAGE", originalSlotIndex: 0 },
            { name: "missing", type: "X",     originalSlotIndex: 9 },
        ];
        const r = resolveAnchorsToOutputSlots(n, anchors);
        assert.equal(r[0].slotIndex, 0);
        assert.equal(r[1], null);
    });
});

// ===========================================================================
// reconcileRemoval — B1 遅延再確認 (削除イベント後も null の source のみ掃除)
// ===========================================================================

describe("reconcileRemoval", () => {
    const sources = [
        { sourceId: 10, sourceTitle: "A" },
        { sourceId: 20, sourceTitle: "B" },
        { sourceId: 10, sourceTitle: "A2" },  // 同一上流を 2 つの source が参照
    ];

    it("削除イベント後も null の source インデックスを (降順で) 返す", () => {
        // id 10 は依然 null、id 20 は生存
        const getNodeById = (id) => (id === 20 ? { id: 20 } : null);
        const removed = reconcileRemoval(10, sources, getNodeById);
        assert.deepEqual(removed, [2, 0]);  // 降順 (splice 安全)
    });

    it("同 id が即復活した場合 (undo/redo/折畳) は何も返さない", () => {
        const getNodeById = (id) => ({ id });  // 全て生存
        const removed = reconcileRemoval(10, sources, getNodeById);
        assert.deepEqual(removed, []);
    });

    it("削除 id を参照しない source は対象外", () => {
        const getNodeById = () => null;
        const removed = reconcileRemoval(20, sources, getNodeById);
        assert.deepEqual(removed, [1]);  // id 20 の source のみ (index 1)
    });

    it("対象 source が無ければ空配列", () => {
        const getNodeById = () => null;
        assert.deepEqual(reconcileRemoval(999, sources, getNodeById), []);
    });

    it("sources が空でも throw しない", () => {
        assert.deepEqual(reconcileRemoval(10, [], () => null), []);
    });
});

// ===========================================================================
// reconcileAllRemoved — H-2 複数同時削除を網羅する全 source 走査
// ===========================================================================

describe("reconcileAllRemoved", () => {
    it("複数の異なる上流が同時に消えても全ゾンビを (降順で) 返す", () => {
        const sources = [
            { sourceId: 10 },
            { sourceId: 20 },
            { sourceId: 30 },
        ];
        // 10 と 30 が削除済み、20 は生存
        const getNodeById = (id) => (id === 20 ? { id: 20 } : null);
        assert.deepEqual(reconcileAllRemoved(sources, getNodeById), [2, 0]);
    });

    it("同一上流を複数 source が参照する場合も全て掃除", () => {
        const sources = [{ sourceId: 10 }, { sourceId: 10 }, { sourceId: 99 }];
        const getNodeById = (id) => (id === 99 ? { id: 99 } : null);
        assert.deepEqual(reconcileAllRemoved(sources, getNodeById), [1, 0]);
    });

    it("全 source 生存なら空配列", () => {
        const sources = [{ sourceId: 10 }, { sourceId: 20 }];
        assert.deepEqual(reconcileAllRemoved(sources, () => ({ id: 1 })), []);
    });

    it("sources が空 / null でも throw しない", () => {
        assert.deepEqual(reconcileAllRemoved([], () => null), []);
        assert.deepEqual(reconcileAllRemoved(null, () => null), []);
    });

    it("null 要素を含んでも throw しない", () => {
        const sources = [null, { sourceId: 10 }];
        assert.deepEqual(reconcileAllRemoved(sources, () => null), [1]);
    });
});

// ===========================================================================
// mergeSourceAnchors — H-1 rebuild 時の identity アンカー引継ぎ
// ===========================================================================

describe("mergeSourceAnchors", () => {
    it("旧 source が無い (初回 addSource) なら fresh をそのまま返す", () => {
        const fresh = { inputAnchors: [{ name: "a", type: "IMAGE", originalSlotIndex: 0 }] };
        const merged = mergeSourceAnchors(null, fresh);
        assert.deepEqual(merged.inputAnchors, [{ name: "a", type: "IMAGE", originalSlotIndex: 0 }]);
    });

    it("既存 index は旧アンカーを保持する (rebuild で fresh に上書きされない)", () => {
        // 旧: 初回接続時の identity (name="orig")
        const oldSrc = { inputAnchors: [{ name: "orig", type: "IMAGE", originalSlotIndex: 0 }] };
        // fresh: 上流が改名された後の現状から作った新アンカー (name="renamed")
        const fresh  = { inputAnchors: [{ name: "renamed", type: "IMAGE", originalSlotIndex: 0 }] };
        const merged = mergeSourceAnchors(oldSrc, fresh);
        // 旧アンカー (改名前の identity) が保持される → 改名追従の基準が消えない
        assert.equal(merged.inputAnchors[0].name, "orig");
    });

    it("M-4 上流スロット増加: 既存分は旧保持・増分は fresh", () => {
        const oldSrc = { inputAnchors: [{ name: "a", type: "IMAGE", originalSlotIndex: 0 }] };
        const fresh  = {
            inputAnchors: [
                { name: "a2", type: "IMAGE", originalSlotIndex: 0 },
                { name: "b",  type: "MASK",  originalSlotIndex: 1 },
            ],
        };
        const merged = mergeSourceAnchors(oldSrc, fresh);
        assert.equal(merged.inputAnchors.length, 2);
        assert.equal(merged.inputAnchors[0].name, "a");  // 既存分は旧保持
        assert.equal(merged.inputAnchors[1].name, "b");  // 増分は fresh
    });

    it("上流スロット減少: fresh の長さ (現スロット数) に切り詰める", () => {
        const oldSrc = {
            inputAnchors: [
                { name: "a", type: "IMAGE", originalSlotIndex: 0 },
                { name: "b", type: "MASK",  originalSlotIndex: 1 },
            ],
        };
        const fresh  = { inputAnchors: [{ name: "a2", type: "IMAGE", originalSlotIndex: 0 }] };
        const merged = mergeSourceAnchors(oldSrc, fresh);
        assert.equal(merged.inputAnchors.length, 1);
        assert.equal(merged.inputAnchors[0].name, "a");  // 既存分は旧保持
    });

    it("NodeCollector slotNames/slotTypes も同規則で引き継ぐ", () => {
        const oldSrc = {
            slotNames: ["latent", "image"],
            slotTypes: ["LATENT", "IMAGE"],
        };
        const fresh = {
            slotNames: ["latent_renamed", "image_renamed", "mask"],
            slotTypes: ["LATENT", "IMAGE", "MASK"],
        };
        const merged = mergeSourceAnchors(oldSrc, fresh);
        // 既存分は旧名保持、増分は fresh
        assert.deepEqual(merged.slotNames, ["latent", "image", "mask"]);
        assert.deepEqual(merged.slotTypes, ["LATENT", "IMAGE", "MASK"]);
    });

    it("newSource を in-place 更新して返す (Coordinator entity identity 維持)", () => {
        const oldSrc = { inputAnchors: [{ name: "a", type: "IMAGE", originalSlotIndex: 0 }] };
        const fresh  = { inputAnchors: [{ name: "b", type: "IMAGE", originalSlotIndex: 0 }] };
        const merged = mergeSourceAnchors(oldSrc, fresh);
        assert.strictEqual(merged, fresh);  // 同一参照
    });

    it("newSource 不在では throw せず newSource をそのまま返す", () => {
        assert.equal(mergeSourceAnchors({ inputAnchors: [] }, null), null);
        assert.equal(mergeSourceAnchors({ inputAnchors: [] }, undefined), undefined);
    });

    it("旧に slotNames が無く新にある場合は fresh を採用", () => {
        const oldSrc = { inputAnchors: [] };
        const fresh  = { inputAnchors: [], slotNames: ["a"], slotTypes: ["X"] };
        const merged = mergeSourceAnchors(oldSrc, fresh);
        assert.deepEqual(merged.slotNames, ["a"]);
        assert.deepEqual(merged.slotTypes, ["X"]);
    });
});

// ===========================================================================
// partitionLiveSources — sig rebuild 時の一時 null 温存 (B1 拡張)
// ===========================================================================

describe("partitionLiveSources", () => {
    const sources = [
        { sourceId: 10 },
        { sourceId: 20 },
        { sourceId: 30 },
    ];

    it("getNodeById が null の source を nullSources、生存を liveSources に分割", () => {
        const getNodeById = (id) => (id === 20 ? null : { id });
        const { live, missing } = partitionLiveSources(sources, getNodeById);
        assert.deepEqual(live.map(s => s.sourceId),    [10, 30]);
        assert.deepEqual(missing.map(s => s.sourceId), [20]);
    });

    it("全 source 生存なら missing は空", () => {
        const { live, missing } = partitionLiveSources(sources, (id) => ({ id }));
        assert.equal(live.length, 3);
        assert.equal(missing.length, 0);
    });

    it("全 source null なら live は空 (削除はしない=呼出側で温存)", () => {
        const { live, missing } = partitionLiveSources(sources, () => null);
        assert.equal(live.length, 0);
        assert.equal(missing.length, 3);
    });
});
