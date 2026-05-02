/**
 * makeSourceListWidget テスト
 *
 * ファクトリ関数のバリデーション、onSerialize/onConfigure、下流リンク復元ロジックのテスト。
 * app.graph 依存部分はモックで対応する。
 *
 * 実行: node --test tests/js/make_source_list_widget.test.mjs
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// app モック（makeSourceListWidget が import する app を差し替え）
// ---------------------------------------------------------------------------

const mockGraph = {
    _nodes: {},
    getNodeById(id) { return this._nodes[id] ?? null; },
    links: {},
    removeLink() {},
    setDirtyCanvas() {},
};

const mockCanvas = { setDirty() {} };

// makeSourceListWidget は "../../scripts/app.js" から app を import するため、
// 直接 import できない。テスト対象のロジックを抽出してテストする。

// ---------------------------------------------------------------------------
// テスト用の最小 spec（必須コールバックを全て満たす）
// ---------------------------------------------------------------------------

function minimalSpec(overrides = {}) {
    return {
        widgetName: "__test_widget",
        serializeKey: "test_key",
        filterSourceNode: () => true,
        buildSource: () => ({ sourceId: 1, sourceTitle: "Test", slotCount: 1, sig: "" }),
        connectSource: () => {},
        showAddPicker: () => {},
        ...overrides,
    };
}

// ===========================================================================
// バリデーションテスト（app 非依存 — ファクトリ内の throw を直接テスト）
//
// makeSourceListWidget を直接 import できないため、バリデーションロジックを
// 抽出して再現する。移行後はこのテストが makeSourceListWidget の import で
// 動作することを確認する。
// ===========================================================================

function validateSpec(spec) {
    const {
        widgetName = "__test",
        filterSourceNode,
        buildSource,
        connectSource,
        showAddPicker,
        hasOutputSlots = false,
        buildOutputSlots = null,
    } = spec;

    if (typeof filterSourceNode !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: filterSourceNode は必須です`);
    }
    if (typeof buildSource !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: buildSource は必須です`);
    }
    if (typeof connectSource !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: connectSource は必須です`);
    }
    if (typeof showAddPicker !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: showAddPicker は必須です`);
    }
    if (hasOutputSlots && typeof buildOutputSlots !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: hasOutputSlots=true の場合 buildOutputSlots は必須です`);
    }
}

describe("必須コールバック バリデーション", () => {
    it("filterSourceNode 未指定で throw", () => {
        assert.throws(
            () => validateSpec({ ...minimalSpec(), filterSourceNode: undefined }),
            /filterSourceNode は必須/,
        );
    });

    it("buildSource 未指定で throw", () => {
        assert.throws(
            () => validateSpec({ ...minimalSpec(), buildSource: undefined }),
            /buildSource は必須/,
        );
    });

    it("connectSource 未指定で throw", () => {
        assert.throws(
            () => validateSpec({ ...minimalSpec(), connectSource: undefined }),
            /connectSource は必須/,
        );
    });

    it("showAddPicker 未指定で throw", () => {
        assert.throws(
            () => validateSpec({ ...minimalSpec(), showAddPicker: undefined }),
            /showAddPicker は必須/,
        );
    });

    it("hasOutputSlots=true + buildOutputSlots 未指定で throw (R2)", () => {
        assert.throws(
            () => validateSpec({ ...minimalSpec(), hasOutputSlots: true, buildOutputSlots: null }),
            /hasOutputSlots=true の場合 buildOutputSlots は必須/,
        );
    });

    it("hasOutputSlots=true + buildOutputSlots 指定で正常", () => {
        assert.doesNotThrow(
            () => validateSpec({ ...minimalSpec(), hasOutputSlots: true, buildOutputSlots: () => {} }),
        );
    });

    it("全必須コールバック指定で正常", () => {
        assert.doesNotThrow(() => validateSpec(minimalSpec()));
    });
});

// ===========================================================================
// migrateData テスト (R3)
// ===========================================================================

function simulateOnConfigure(saved, migrateData) {
    let sources = null;
    if (migrateData) {
        try {
            sources = migrateData(saved);
        } catch (e) {
            sources = [];
        }
    }
    if (sources == null) sources = saved.sources ?? [];
    return sources;
}

describe("migrateData エラーハンドリング (R3)", () => {
    it("migrateData が配列を返す場合はそれを使用", () => {
        const result = simulateOnConfigure(
            { sources: [{ id: 1 }] },
            (saved) => [{ id: 99, migrated: true }],
        );
        assert.equal(result.length, 1);
        assert.equal(result[0].id, 99);
    });

    it("migrateData が null を返す場合は saved.sources にフォールバック", () => {
        const result = simulateOnConfigure(
            { sources: [{ id: 1 }] },
            () => null,
        );
        assert.equal(result.length, 1);
        assert.equal(result[0].id, 1);
    });

    it("migrateData が例外を投げる場合は空配列", () => {
        const result = simulateOnConfigure(
            { sources: [{ id: 1 }] },
            () => { throw new Error("migration failed"); },
        );
        assert.deepEqual(result, []);
    });

    it("migrateData 未指定の場合は saved.sources にフォールバック", () => {
        const result = simulateOnConfigure(
            { sources: [{ id: 1 }, { id: 2 }] },
            null,
        );
        assert.equal(result.length, 2);
    });

    it("migrateData 未指定 + saved.sources 未定義の場合は空配列", () => {
        const result = simulateOnConfigure({}, null);
        assert.deepEqual(result, []);
    });
});

// ===========================================================================
// _restoreDownstream 3段階フォールバック テスト (D2)
// ===========================================================================

function restoreDownstream(downstream, sources, getOffset) {
    const results = [];
    for (const ds of downstream) {
        const si = sources.findIndex(s => s.sourceId === ds.sourceId);
        if (si < 0) { results.push(null); continue; }
        const src = sources[si];

        let resolvedLocalSlot = -1;
        if (ds.outName != null && src.slotNames) {
            const nameIdx = src.slotNames.indexOf(ds.outName);
            if (nameIdx >= 0) {
                const localIdx = (src.enabledSlots ?? []).indexOf(nameIdx);
                if (localIdx >= 0) resolvedLocalSlot = localIdx;
            }
        }
        if (resolvedLocalSlot < 0 && ds.globalSlotIdx != null && src.enabledSlots) {
            const localIdx = src.enabledSlots.indexOf(ds.globalSlotIdx);
            if (localIdx >= 0) resolvedLocalSlot = localIdx;
        }
        if (resolvedLocalSlot < 0) { results.push({ si, skipped: true }); continue; }

        const newAbsIdx = getOffset(si) + resolvedLocalSlot;
        results.push({ si, absIdx: newAbsIdx });
    }
    return results;
}

describe("_restoreDownstream 3段階フォールバック (D2)", () => {
    const sources = [{
        sourceId: 50,
        slotCount: 4,
        enabledSlots: [0, 2, 3],
        slotNames: ["latent", "info", "image", "mask"],
    }];
    const getOffset = () => 0;

    it("段階1: outName で正しいスロットに解決", () => {
        const ds = [{
            sourceId: 50,
            outName: "image",      // slotNames[2] → enabledSlots.indexOf(2) = 1
            globalSlotIdx: 0,      // 使われない
            localSlot: 99,         // 使われない
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sources, getOffset);
        assert.equal(results[0].absIdx, 1);  // enabledSlots[1] = 2 = "image"
        assert.equal(results[0].skipped, undefined);
    });

    it("段階2: outName 解決失敗 → globalSlotIdx で解決", () => {
        const ds = [{
            sourceId: 50,
            outName: "nonexistent",  // slotNames に存在しない
            globalSlotIdx: 3,        // enabledSlots.indexOf(3) = 2
            localSlot: 99,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sources, getOffset);
        assert.equal(results[0].absIdx, 2);  // enabledSlots[2] = 3
        assert.equal(results[0].skipped, undefined);
    });

    it("段階1・2 とも解決失敗 → スキップ（無効化スロットの接続はドロップ）", () => {
        const ds = [{
            sourceId: 50,
            outName: "nonexistent",
            globalSlotIdx: 99,       // enabledSlots に存在しない
            localSlot: 1,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sources, getOffset);
        assert.equal(results[0].skipped, true);
    });

    it("outName が null の場合は段階1をスキップして globalSlotIdx で解決", () => {
        const ds = [{
            sourceId: 50,
            outName: null,
            globalSlotIdx: 2,        // enabledSlots.indexOf(2) = 1
            localSlot: 99,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sources, getOffset);
        assert.equal(results[0].absIdx, 1);
        assert.equal(results[0].skipped, undefined);
    });

    it("slotNames がない場合は段階1をスキップ", () => {
        const sourcesNoNames = [{
            sourceId: 50,
            slotCount: 3,
            enabledSlots: [0, 1, 2],
        }];
        const ds = [{
            sourceId: 50,
            outName: "image",
            globalSlotIdx: 1,        // enabledSlots.indexOf(1) = 1
            localSlot: 99,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sourcesNoNames, getOffset);
        assert.equal(results[0].absIdx, 1);
        assert.equal(results[0].skipped, undefined);
    });

    it("enabledSlots がない場合は段階1・2 とも解決失敗 → スキップ", () => {
        const sourcesNoEnabled = [{
            sourceId: 50,
            slotCount: 3,
            slotNames: ["a", "b", "c"],
        }];
        const ds = [{
            sourceId: 50,
            outName: "b",            // slotNames[1] → enabledSlots が null なので indexOf 失敗
            globalSlotIdx: 1,
            localSlot: 0,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sourcesNoEnabled, getOffset);
        assert.equal(results[0].skipped, true);
    });

    it("sourceId が見つからない場合は null", () => {
        const ds = [{
            sourceId: 999,
            outName: "image",
            globalSlotIdx: 0,
            localSlot: 0,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sources, getOffset);
        assert.equal(results[0], null);
    });

    it("名前解決で enabledSlots に含まれないスロットは段階2へフォールバック", () => {
        // enabledSlots=[0,2,3] で slotNames[1]="info" は有効化されていない
        const ds = [{
            sourceId: 50,
            outName: "info",         // slotNames[1] → enabledSlots.indexOf(1) = -1
            globalSlotIdx: 3,        // enabledSlots.indexOf(3) = 2
            localSlot: 99,
            targetId: 100,
            targetSlot: 0,
        }];
        const results = restoreDownstream(ds, sources, getOffset);
        assert.equal(results[0].absIdx, 2);  // globalSlotIdx=3 → enabledSlots[2]
        assert.equal(results[0].skipped, undefined);
    });
});
