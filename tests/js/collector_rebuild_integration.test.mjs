/**
 * Collector buildSource → rebuild merge 統合経路テスト (H-1 / H-3 / M-4)
 *
 * 今回の検出漏れ (buildSource 内 `src?.` 未宣言変数で identity アンカー保持が無効)
 * の再発防止。純粋関数単体ではなく、「buildSource (fresh 生成) → rebuildLiveSources
 * (旧 source からアンカー引継ぎ) → resolveAnchorsToOutputSlots (現上流へ再接続解決)」の
 * 統合経路を app 非依存で通し、以下を検証する:
 *   - rebuild 後もアンカーが (初回接続時の identity として) 保持される
 *   - 上流改名/並べ替え後も正しい出力スロットへ再接続される
 *   - H-3: 一時 null (missing) があっても live の rebuild が進む / missing は温存される
 *   - M-4: 上流スロット追加でアンカー保持 + 増分のみ fresh
 *
 * buildSource は app を import する Collector 本体から直接呼べないため、修正後の
 * 各 Collector buildSource の「fresh 生成」セマンティクスを忠実に再現したフィクスチャを
 * 使う (修正方針: buildSource は常に現在の srcNode から fresh に anchors を構築し、
 * 旧 source 引継ぎは rebuild 側の mergeSourceAnchors が担う)。
 *
 * 実行: node --test tests/js/collector_rebuild_integration.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildInputAnchors,
    resolveAnchorsToOutputSlots,
    rebuildLiveSources,
} from "../../js/sax_collector_link.js";

// ---------------------------------------------------------------------------
// ノードモック
// ---------------------------------------------------------------------------

function srcNode({ id = 1, outputs = [] } = {}) {
    return {
        id,
        outputs: outputs.map(o => ({ name: o.name, type: o.type, label: o.label, links: [] })),
    };
}

// 修正後の Image Collector buildSource を再現 (常に fresh アンカー生成)。
function imageBuildSource(srcNode) {
    const imageOutputs = (srcNode.outputs ?? [])
        .map((o, gi) => ({ gi, out: o }))
        .filter(({ out }) => out.type === "IMAGE");
    if (imageOutputs.length === 0) return null;
    const imageSlotIndices = imageOutputs.map(({ gi }) => gi);
    return {
        sourceId:    srcNode.id,
        sourceTitle: srcNode.title || `Node#${srcNode.id}`,
        imageSlotIndices,
        inputAnchors: buildInputAnchors(srcNode, imageSlotIndices),  // 常に fresh
        slotCount:   imageSlotIndices.length,
    };
}

const imageSlotCount = (src) => src.slotCount ?? 0;

// scripted getNodeById (回数で挙動が変わる: 一時 null → 復帰)
function scriptedGetNodeById(framesById) {
    let call = 0;
    return (id) => {
        const frame = framesById[Math.min(call, framesById.length - 1)];
        call++;
        return frame[id] ?? null;
    };
}

// ===========================================================================
// H-1: rebuild 後もアンカーが初回 identity として保持される
// ===========================================================================

describe("H-1 統合: rebuild でアンカーが上書きされず初回 identity を保持", () => {
    it("上流改名後も rebuild 後アンカーは改名前 name を保持 → 正しい出力へ再接続", () => {
        // 初回: 上流に image (index 0)
        const before = srcNode({ id: 5, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [imageBuildSource(before)];
        assert.equal(saved[0].inputAnchors[0].name, "image");

        // 上流が改名された (image → renamed_img, 位置は維持)
        const after = srcNode({ id: 5, outputs: [{ name: "renamed_img", type: "IMAGE" }] });
        const getNodeById = (id) => (id === 5 ? after : null);

        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn),
            getSlotCount: imageSlotCount,
        });

        assert.equal(rebuilt.length, 1);
        // H-1 の核心: rebuild 後もアンカー name は改名前 "image" のまま (fresh の "renamed_img" で上書きされない)
        const mergedAnchor = rebuilt[0].source.inputAnchors[0];
        assert.equal(mergedAnchor.name, "image");

        // 改名後の現上流に対し段階解決 → originalSlotIndex 位置 (0) で維持再接続
        const resolved = resolveAnchorsToOutputSlots(after, rebuilt[0].source.inputAnchors);
        assert.equal(resolved[0].slotIndex, 0);
    });

    it("上流並べ替え後も保存アンカーで正しい出力へ再接続 (位置依存でない)", () => {
        // 初回: image は index 1
        const before = srcNode({ id: 7, outputs: [
            { name: "latent", type: "LATENT" },
            { name: "image",  type: "IMAGE" },
        ] });
        // image だけを参照する source (imageSlotIndices=[1])
        const saved = [imageBuildSource(before)];
        assert.equal(saved[0].inputAnchors[0].originalSlotIndex, 1);

        // 並べ替え: image が index 0 へ移動
        const after = srcNode({ id: 7, outputs: [
            { name: "image",  type: "IMAGE" },
            { name: "latent", type: "LATENT" },
        ] });
        const getNodeById = (id) => (id === 7 ? after : null);

        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn),
            getSlotCount: imageSlotCount,
        });

        const resolved = resolveAnchorsToOutputSlots(after, rebuilt[0].source.inputAnchors);
        // name+type 一致で image の新位置 0 へ (先頭固定/位置固定でない)
        assert.equal(resolved[0].slotIndex, 0);
    });
});

// ===========================================================================
// M-4: 上流スロット追加でアンカー保持 + 増分のみ fresh
// ===========================================================================

describe("M-4 統合: 上流スロット増加で既存アンカー保持・増分 fresh", () => {
    it("IMAGE 出力が 1 → 2 に増えても既存アンカーは維持、増分のみ追加", () => {
        const before = srcNode({ id: 9, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [imageBuildSource(before)];

        // 上流に 2 つ目の IMAGE が追加 (既存 image は改名)
        const after = srcNode({ id: 9, outputs: [
            { name: "image_renamed", type: "IMAGE" },
            { name: "image2",        type: "IMAGE" },
        ] });
        const getNodeById = (id) => (id === 9 ? after : null);

        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn),
            getSlotCount: imageSlotCount,
        });

        const anchors = rebuilt[0].source.inputAnchors;
        assert.equal(anchors.length, 2);
        assert.equal(anchors[0].name, "image");    // 既存分: 改名前 identity 保持
        assert.equal(anchors[1].name, "image2");   // 増分: fresh
    });
});

// ===========================================================================
// H-3: missing があっても live が rebuild される / missing は温存
// ===========================================================================

describe("H-3 統合: 一時 null があっても live の rebuild を凍結しない", () => {
    it("source A=live / B=一時null: A は再構築、B は missing として温存", () => {
        const a = srcNode({ id: 1, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [imageBuildSource(a), { sourceId: 2, slotCount: 1, inputAnchors: [] }];

        // B (id 2) は恒久 null、A (id 1) は live
        const getNodeById = (id) => (id === 1 ? a : null);

        const { rebuilt, missing } = rebuildLiveSources({
            savedSources: saved,
            getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn),
            getSlotCount: imageSlotCount,
        });

        assert.equal(rebuilt.length, 1);
        assert.equal(rebuilt[0].source.sourceId, 1);  // live A は rebuild される (凍結しない)
        assert.equal(missing.length, 1);
        assert.equal(missing[0].sourceId, 2);          // missing B は温存
    });

    it("live のみで offset が詰められる (missing は offset に寄与しない)", () => {
        const a = srcNode({ id: 1, outputs: [{ name: "image", type: "IMAGE" }] });
        const c = srcNode({ id: 3, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [
            imageBuildSource(a),
            { sourceId: 2, slotCount: 1, inputAnchors: [] },  // missing
            imageBuildSource(c),
        ];
        const getNodeById = (id) => (id === 1 ? a : id === 3 ? c : null);

        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn),
            getSlotCount: imageSlotCount,
        });

        assert.equal(rebuilt.length, 2);
        assert.equal(rebuilt[0].offset, 0);  // A
        assert.equal(rebuilt[1].offset, 1);  // C は missing B を飛ばして offset=1 (詰める)
    });

    it("一時 null → 復帰 (scripted): 復帰後の rebuild で live 扱いになる", () => {
        const a = srcNode({ id: 1, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [imageBuildSource(a)];
        // 1 回目 null → 2 回目復帰
        const getNodeById = scriptedGetNodeById([{ 1: null }, { 1: a }]);

        const first = rebuildLiveSources({
            savedSources: saved, getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn), getSlotCount: imageSlotCount,
        });
        assert.equal(first.rebuilt.length, 0);
        assert.equal(first.missing.length, 1);  // 温存 (削除しない)

        const second = rebuildLiveSources({
            savedSources: saved, getNodeById,
            buildSourceFn: (sn) => imageBuildSource(sn), getSlotCount: imageSlotCount,
        });
        assert.equal(second.rebuilt.length, 1);  // 復帰後は rebuild される
        assert.equal(second.missing.length, 0);
    });
});

// ===========================================================================
// buildSourceFn が null/例外を返しても他 live は継続
// ===========================================================================

describe("rebuildLiveSources 堅牢性", () => {
    it("buildSourceFn が例外を投げても他の live は継続", () => {
        const a = srcNode({ id: 1, outputs: [{ name: "image", type: "IMAGE" }] });
        const b = srcNode({ id: 2, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [imageBuildSource(a), imageBuildSource(b)];
        const getNodeById = (id) => (id === 1 ? a : b);

        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById,
            buildSourceFn: (sn) => {
                if (sn.id === 1) throw new Error("boom");
                return imageBuildSource(sn);
            },
            getSlotCount: imageSlotCount,
        });
        assert.equal(rebuilt.length, 1);          // id 2 のみ
        assert.equal(rebuilt[0].source.sourceId, 2);
    });

    it("buildSourceFn が null を返した source はスキップ", () => {
        const a = srcNode({ id: 1, outputs: [{ name: "image", type: "IMAGE" }] });
        const saved = [imageBuildSource(a)];
        const { rebuilt } = rebuildLiveSources({
            savedSources: saved,
            getNodeById: () => a,
            buildSourceFn: () => null,
            getSlotCount: imageSlotCount,
        });
        assert.equal(rebuilt.length, 0);
    });
});
