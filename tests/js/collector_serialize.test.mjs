/**
 * Collector serialize/deserialize テスト
 *
 * L1: データ構造の検証、スロット調整、v1→v2 マイグレーション
 * L2: LiteGraph モックを使った接続復元
 *
 * 実行: node --test tests/js/collector_serialize.test.mjs
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// LiteGraph ノードモック
// ---------------------------------------------------------------------------

function createMockNode({ inputs = [], outputs = [], id = 1 } = {}) {
    const node = {
        id,
        inputs: [...inputs],
        outputs: [...outputs],
        widgets: [],
        _remoteSources: undefined,
        _remoteLinksVisible: undefined,
        size: [280, 200],

        addInput(name, type) {
            const slot = { name, type, link: null };
            this.inputs.push(slot);
            return this.inputs.length - 1;
        },
        removeInput(idx) {
            this.inputs.splice(idx, 1);
        },
        addOutput(name, type) {
            const slot = { name, type, links: [] };
            this.outputs.push(slot);
            return this.outputs.length - 1;
        },
        removeOutput(idx) {
            this.outputs.splice(idx, 1);
        },
        connect: mock.fn(),
    };
    return node;
}

function createSourceNode({ id, title, type, outputs }) {
    return {
        id,
        title,
        type,
        outputs: outputs.map(o => ({
            name: o.name,
            type: o.type,
            label: o.label ?? o.name,
            links: [],
        })),
        subgraph: null,
        connect: mock.fn(),
    };
}

// ---------------------------------------------------------------------------
// テスト用の serialize/configure ロジック抽出
// （現行コードと同一ロジック。移行後にこのテストが通ることを確認する）
// ---------------------------------------------------------------------------

// --- 共通ユーティリティ ---

function sourceSignature(srcNode) {
    return (srcNode.outputs ?? [])
        .map(o => `${o.label ?? o.name ?? ""}:${o.type ?? ""}`).join(",");
}

// --- Image Collector ---

const ImageCollector = {
    SERIALIZE_KEY: "sax_collector",

    getSources(node) {
        return node._remoteSources ?? [];
    },

    getOffset(node, srcIdx) {
        const sources = this.getSources(node);
        let offset = 0;
        for (let i = 0; i < srcIdx; i++) {
            offset += sources[i].slotCount ?? 0;
        }
        return offset;
    },

    getTotalSlotCount(node) {
        return this.getSources(node).reduce((sum, s) => sum + (s.slotCount ?? 0), 0);
    },

    serialize(node) {
        const data = {};
        data[this.SERIALIZE_KEY] = {
            sources: this.getSources(node),
            linksVisible: node._remoteLinksVisible ?? false,
        };
        return data;
    },

    configure(node, data) {
        const saved = data[this.SERIALIZE_KEY];
        if (!saved) return;

        node._remoteSources = saved.sources ?? [];
        node._remoteLinksVisible = saved.linksVisible ?? false;

        const total = this.getTotalSlotCount(node);
        const curIn = node.inputs?.length ?? 0;
        for (let i = curIn - 1; i >= total; i--) node.removeInput(i);
        for (let i = curIn; i < total; i++) node.addInput(`slot_${i}`, "*");
    },
};

// --- Pipe Collector ---

const PipeCollector = {
    SERIALIZE_KEY: "sax_pipe_collector",

    getSources(node) {
        return node._remoteSources ?? [];
    },

    getOffset(_node, srcIdx) {
        return srcIdx;
    },

    getTotalSlotCount(node) {
        return this.getSources(node).length;
    },

    serialize(node) {
        const data = {};
        data[this.SERIALIZE_KEY] = {
            sources: this.getSources(node),
            linksVisible: node._remoteLinksVisible ?? false,
        };
        return data;
    },

    configure(node, data) {
        const saved = data[this.SERIALIZE_KEY];
        if (!saved) return;

        node._remoteSources = saved.sources ?? [];
        node._remoteLinksVisible = saved.linksVisible ?? false;

        const total = this.getTotalSlotCount(node);
        const curIn = node.inputs?.length ?? 0;
        for (let i = curIn - 1; i >= total; i--) node.removeInput(i);
        for (let i = curIn; i < total; i++) node.addInput(`slot_${i}`, "*");
    },
};

// --- Node Collector ---

const NodeCollector = {
    SERIALIZE_KEY: "sax_node_collector",

    getSources(node) {
        return node._remoteSources ?? [];
    },

    getOffset(node, srcIdx) {
        const sources = this.getSources(node);
        let offset = 0;
        for (let i = 0; i < srcIdx; i++) {
            const src = sources[i];
            offset += src.enabledSlots?.length ?? src.slotCount ?? 0;
        }
        return offset;
    },

    getTotalSlotCount(node) {
        return this.getSources(node).reduce(
            (sum, s) => sum + (s.enabledSlots?.length ?? s.slotCount ?? 0), 0
        );
    },

    migrateData(saved) {
        let sources;
        if (saved.sources) {
            sources = saved.sources;
        } else if (saved.sourceId != null) {
            sources = [{
                sourceId: saved.sourceId,
                sourceTitle: saved.sourceTitle ?? "",
                slotCount: saved.slotCount ?? 0,
                enabledSlots: null,
                slotNames: saved.slotNames ?? [],
                slotTypes: saved.slotTypes ?? [],
                sig: "",
            }];
        } else {
            sources = [];
        }

        for (const src of sources) {
            if (!src.enabledSlots) {
                src.enabledSlots = Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
            }
        }
        return sources;
    },

    serialize(node) {
        const data = {};
        data[this.SERIALIZE_KEY] = {
            sources: this.getSources(node),
            linksVisible: node._remoteLinksVisible ?? false,
        };
        return data;
    },

    configure(node, data) {
        const saved = data[this.SERIALIZE_KEY];
        if (!saved) return;

        const sources = this.migrateData(saved);
        node._remoteSources = sources;
        node._remoteLinksVisible = saved.linksVisible ?? false;

        const total = this.getTotalSlotCount(node);
        const curOut = node.outputs?.length ?? 0;
        const curIn = node.inputs?.length ?? 0;
        for (let i = curOut - 1; i >= total; i--) node.removeOutput(i);
        for (let i = curOut; i < total; i++) node.addOutput(`out_${i}`, "*");
        for (let i = curIn - 1; i >= total; i--) node.removeInput(i);
        for (let i = curIn; i < total; i++) node.addInput(`slot_${i}`, "*");
    },
};

// ===========================================================================
// テストデータ（スナップショット）
// ===========================================================================

const SNAPSHOTS = {
    imageCollector: {
        twoSources: {
            sax_collector: {
                sources: [
                    {
                        sourceId: 10,
                        sourceTitle: "KSampler",
                        imageSlotIndices: [0],
                        slotCount: 1,
                        sig: "IMAGE:IMAGE",
                        isSub: false,
                    },
                    {
                        sourceId: 20,
                        sourceTitle: "LoadImage",
                        imageSlotIndices: [0, 1],
                        slotCount: 2,
                        sig: "image:IMAGE,mask:MASK",
                        isSub: false,
                    },
                ],
                linksVisible: true,
            },
        },
        empty: {
            sax_collector: {
                sources: [],
                linksVisible: false,
            },
        },
    },

    pipeCollector: {
        twoSources: {
            sax_pipe_collector: {
                sources: [
                    {
                        sourceId: 30,
                        sourceTitle: "SAX Loader",
                        pipeSlotIndex: 0,
                        slotCount: 1,
                        sig: "pipe:PIPE_LINE",
                        isSub: false,
                    },
                    {
                        sourceId: 40,
                        sourceTitle: "SAX Sampler",
                        pipeSlotIndex: 1,
                        slotCount: 1,
                        sig: "pipe:PIPE_LINE,images:IMAGE",
                        isSub: false,
                    },
                ],
                linksVisible: false,
            },
        },
    },

    nodeCollector: {
        v2TwoSources: {
            sax_node_collector: {
                sources: [
                    {
                        sourceId: 50,
                        sourceTitle: "KSampler",
                        slotCount: 3,
                        enabledSlots: [0, 2],
                        slotNames: ["latent", "info", "image"],
                        slotTypes: ["LATENT", "STRING", "IMAGE"],
                        sig: "latent:LATENT,info:STRING,image:IMAGE",
                        isSub: false,
                    },
                    {
                        sourceId: 60,
                        sourceTitle: "VAEDecode",
                        slotCount: 1,
                        enabledSlots: [0],
                        slotNames: ["image"],
                        slotTypes: ["IMAGE"],
                        sig: "image:IMAGE",
                        isSub: false,
                    },
                ],
                linksVisible: true,
            },
        },
        v1SingleSource: {
            sax_node_collector: {
                sourceId: 50,
                sourceTitle: "KSampler",
                slotCount: 3,
                slotNames: ["latent", "info", "image"],
                slotTypes: ["LATENT", "STRING", "IMAGE"],
            },
        },
        v1Empty: {
            sax_node_collector: {},
        },
    },
};

// ===========================================================================
// L1: serialize データ構造の検証
// ===========================================================================

describe("L1: Image Collector serialize", () => {
    it("serialize で正しいデータ構造を生成する", () => {
        const node = createMockNode();
        node._remoteSources = SNAPSHOTS.imageCollector.twoSources.sax_collector.sources;
        node._remoteLinksVisible = true;

        const data = ImageCollector.serialize(node);

        assert.deepEqual(data.sax_collector.sources, SNAPSHOTS.imageCollector.twoSources.sax_collector.sources);
        assert.equal(data.sax_collector.linksVisible, true);
    });

    it("ソースがない場合の serialize", () => {
        const node = createMockNode();
        const data = ImageCollector.serialize(node);

        assert.deepEqual(data.sax_collector.sources, []);
        assert.equal(data.sax_collector.linksVisible, false);
    });
});

describe("L1: Image Collector configure（同期処理）", () => {
    it("2ソース（計3スロット）を復元してスロットを追加する", () => {
        const node = createMockNode();

        ImageCollector.configure(node, SNAPSHOTS.imageCollector.twoSources);

        assert.equal(node._remoteSources.length, 2);
        assert.equal(node._remoteLinksVisible, true);
        assert.equal(node.inputs.length, 3); // 1 + 2 = 3
    });

    it("既存スロットが多い場合は削除する", () => {
        const node = createMockNode({
            inputs: [
                { name: "slot_0", type: "*", link: null },
                { name: "slot_1", type: "*", link: null },
                { name: "slot_2", type: "*", link: null },
                { name: "slot_3", type: "*", link: null },
                { name: "slot_4", type: "*", link: null },
            ],
        });

        ImageCollector.configure(node, SNAPSHOTS.imageCollector.twoSources);
        assert.equal(node.inputs.length, 3);
    });

    it("空ソースの場合はスロットを全て削除する", () => {
        const node = createMockNode({
            inputs: [{ name: "slot_0", type: "*", link: null }],
        });

        ImageCollector.configure(node, SNAPSHOTS.imageCollector.empty);
        assert.equal(node.inputs.length, 0);
        assert.equal(node._remoteSources.length, 0);
    });

    it("データが存在しない場合は何もしない", () => {
        const node = createMockNode();
        ImageCollector.configure(node, {});
        assert.equal(node._remoteSources, undefined);
    });
});

describe("L1: Image Collector getOffset", () => {
    it("各ソースの先頭オフセットを正しく計算する", () => {
        const node = createMockNode();
        node._remoteSources = SNAPSHOTS.imageCollector.twoSources.sax_collector.sources;

        assert.equal(ImageCollector.getOffset(node, 0), 0);
        assert.equal(ImageCollector.getOffset(node, 1), 1); // 1st source has slotCount=1
    });
});

// ---------------------------------------------------------------------------

describe("L1: Pipe Collector serialize", () => {
    it("serialize で正しいデータ構造を生成する", () => {
        const node = createMockNode();
        node._remoteSources = SNAPSHOTS.pipeCollector.twoSources.sax_pipe_collector.sources;
        node._remoteLinksVisible = false;

        const data = PipeCollector.serialize(node);

        assert.deepEqual(
            data.sax_pipe_collector.sources,
            SNAPSHOTS.pipeCollector.twoSources.sax_pipe_collector.sources,
        );
        assert.equal(data.sax_pipe_collector.linksVisible, false);
    });
});

describe("L1: Pipe Collector configure（同期処理）", () => {
    it("2ソース（各1スロット）を復元する", () => {
        const node = createMockNode();

        PipeCollector.configure(node, SNAPSHOTS.pipeCollector.twoSources);

        assert.equal(node._remoteSources.length, 2);
        assert.equal(node.inputs.length, 2);
    });
});

describe("L1: Pipe Collector getOffset", () => {
    it("offset = srcIdx（常に1スロット/ソース）", () => {
        const node = createMockNode();
        node._remoteSources = SNAPSHOTS.pipeCollector.twoSources.sax_pipe_collector.sources;

        assert.equal(PipeCollector.getOffset(node, 0), 0);
        assert.equal(PipeCollector.getOffset(node, 1), 1);
    });
});

// ---------------------------------------------------------------------------

describe("L1: Node Collector serialize", () => {
    it("serialize で正しいデータ構造を生成する", () => {
        const node = createMockNode();
        node._remoteSources = SNAPSHOTS.nodeCollector.v2TwoSources.sax_node_collector.sources;
        node._remoteLinksVisible = true;

        const data = NodeCollector.serialize(node);

        assert.deepEqual(
            data.sax_node_collector.sources,
            SNAPSHOTS.nodeCollector.v2TwoSources.sax_node_collector.sources,
        );
    });
});

describe("L1: Node Collector configure（同期処理）", () => {
    it("v2 フォーマットを復元し入出力スロットを構築する", () => {
        const node = createMockNode();

        NodeCollector.configure(node, SNAPSHOTS.nodeCollector.v2TwoSources);

        assert.equal(node._remoteSources.length, 2);
        // enabledSlots: [0,2] (2) + [0] (1) = 3
        assert.equal(node.inputs.length, 3);
        assert.equal(node.outputs.length, 3);
    });

    it("既存スロットが多い場合は削除する", () => {
        const node = createMockNode({
            inputs: Array.from({ length: 5 }, (_, i) => ({ name: `slot_${i}`, type: "*", link: null })),
            outputs: Array.from({ length: 5 }, (_, i) => ({ name: `out_${i}`, type: "*", links: [] })),
        });

        NodeCollector.configure(node, SNAPSHOTS.nodeCollector.v2TwoSources);
        assert.equal(node.inputs.length, 3);
        assert.equal(node.outputs.length, 3);
    });
});

describe("L1: Node Collector v1→v2 マイグレーション", () => {
    it("v1 単一ソースを v2 sources[] に変換する", () => {
        const saved = SNAPSHOTS.nodeCollector.v1SingleSource.sax_node_collector;
        const sources = NodeCollector.migrateData(saved);

        assert.equal(sources.length, 1);
        assert.equal(sources[0].sourceId, 50);
        assert.equal(sources[0].sourceTitle, "KSampler");
        assert.equal(sources[0].slotCount, 3);
        assert.deepEqual(sources[0].enabledSlots, [0, 1, 2]); // 全有効
        assert.deepEqual(sources[0].slotNames, ["latent", "info", "image"]);
        assert.deepEqual(sources[0].slotTypes, ["LATENT", "STRING", "IMAGE"]);
    });

    it("v1 空データを空配列に変換する", () => {
        const saved = SNAPSHOTS.nodeCollector.v1Empty.sax_node_collector;
        const sources = NodeCollector.migrateData(saved);

        assert.equal(sources.length, 0);
    });

    it("v2 データはそのまま通過する", () => {
        const saved = SNAPSHOTS.nodeCollector.v2TwoSources.sax_node_collector;
        const sources = NodeCollector.migrateData(saved);

        assert.equal(sources.length, 2);
        assert.deepEqual(sources[0].enabledSlots, [0, 2]);
    });

    it("enabledSlots が null のエントリは全有効にフォールバックする", () => {
        const saved = {
            sources: [{
                sourceId: 99,
                sourceTitle: "Test",
                slotCount: 4,
                enabledSlots: null,
                slotNames: ["a", "b", "c", "d"],
                slotTypes: ["A", "B", "C", "D"],
                sig: "",
                isSub: false,
            }],
        };
        const sources = NodeCollector.migrateData(saved);

        assert.deepEqual(sources[0].enabledSlots, [0, 1, 2, 3]);
    });
});

describe("L1: Node Collector getOffset", () => {
    it("enabledSlots ベースでオフセットを計算する", () => {
        const node = createMockNode();
        node._remoteSources = SNAPSHOTS.nodeCollector.v2TwoSources.sax_node_collector.sources;

        // Source 0: enabledSlots=[0,2] → length=2
        // Source 1: enabledSlots=[0]   → length=1
        assert.equal(NodeCollector.getOffset(node, 0), 0);
        assert.equal(NodeCollector.getOffset(node, 1), 2);
    });
});

// ===========================================================================
// L2: LiteGraph モックを使った接続復元テスト
// ===========================================================================

describe("L2: Image Collector 接続復元", () => {
    it("setTimeout 後にソースノードへの connect が呼ばれる", async () => {
        const node = createMockNode();
        const srcNode1 = createSourceNode({
            id: 10,
            title: "KSampler",
            type: "KSampler",
            outputs: [{ name: "IMAGE", type: "IMAGE" }],
        });
        const srcNode2 = createSourceNode({
            id: 20,
            title: "LoadImage",
            type: "LoadImage",
            outputs: [
                { name: "image", type: "IMAGE" },
                { name: "mask", type: "MASK" },
            ],
        });

        const getNodeById = (id) => {
            if (id === 10) return srcNode1;
            if (id === 20) return srcNode2;
            return null;
        };

        ImageCollector.configure(node, SNAPSHOTS.imageCollector.twoSources);

        // setTimeout 相当の非同期処理をシミュレート
        const sources = ImageCollector.getSources(node);
        for (let si = 0; si < sources.length; si++) {
            const src = sources[si];
            const srcNode = getNodeById(src.sourceId);
            if (!srcNode) continue;
            const offset = ImageCollector.getOffset(node, si);
            for (let li = 0; li < src.imageSlotIndices.length; li++) {
                const gi = src.imageSlotIndices[li];
                if (node.inputs[offset + li]?.link == null) {
                    srcNode.connect(gi, node, offset + li);
                }
            }
            src.sig = sourceSignature(srcNode);
        }

        assert.equal(srcNode1.connect.mock.calls.length, 1);
        assert.deepEqual(srcNode1.connect.mock.calls[0].arguments, [0, node, 0]);

        assert.equal(srcNode2.connect.mock.calls.length, 2);
        assert.deepEqual(srcNode2.connect.mock.calls[0].arguments, [0, node, 1]);
        assert.deepEqual(srcNode2.connect.mock.calls[1].arguments, [1, node, 2]);
    });

    it("既にリンクがある場合は connect をスキップする", () => {
        const node = createMockNode({
            inputs: [
                { name: "slot_0", type: "IMAGE", link: 100 },
                { name: "slot_1", type: "IMAGE", link: null },
                { name: "slot_2", type: "IMAGE", link: null },
            ],
        });

        // configure でスロット数を合わせるが、既存 inputs を保持するように手動設定
        node._remoteSources = SNAPSHOTS.imageCollector.twoSources.sax_collector.sources;

        const srcNode1 = createSourceNode({
            id: 10, title: "KSampler", type: "KSampler",
            outputs: [{ name: "IMAGE", type: "IMAGE" }],
        });

        const sources = ImageCollector.getSources(node);
        const src = sources[0];
        const srcNode = srcNode1;
        const offset = ImageCollector.getOffset(node, 0);
        for (let li = 0; li < src.imageSlotIndices.length; li++) {
            const gi = src.imageSlotIndices[li];
            if (node.inputs[offset + li]?.link == null) {
                srcNode.connect(gi, node, offset + li);
            }
        }

        // link=100 があるのでスキップ
        assert.equal(srcNode1.connect.mock.calls.length, 0);
    });
});

describe("L2: Node Collector 接続復元", () => {
    it("enabledSlots に基づいて正しいスロットに connect する", () => {
        const node = createMockNode();
        NodeCollector.configure(node, SNAPSHOTS.nodeCollector.v2TwoSources);

        const srcNode1 = createSourceNode({
            id: 50,
            title: "KSampler",
            type: "KSampler",
            outputs: [
                { name: "latent", type: "LATENT" },
                { name: "info", type: "STRING" },
                { name: "image", type: "IMAGE" },
            ],
        });
        const srcNode2 = createSourceNode({
            id: 60,
            title: "VAEDecode",
            type: "VAEDecode",
            outputs: [{ name: "image", type: "IMAGE" }],
        });

        const getNodeById = (id) => {
            if (id === 50) return srcNode1;
            if (id === 60) return srcNode2;
            return null;
        };

        const sources = NodeCollector.getSources(node);
        for (let si = 0; si < sources.length; si++) {
            const src = sources[si];
            const srcNode = getNodeById(src.sourceId);
            if (!srcNode) continue;
            const offset = NodeCollector.getOffset(node, si);
            const enabled = src.enabledSlots ?? Array.from({ length: src.slotCount ?? 0 }, (_, i) => i);
            for (let li = 0; li < enabled.length; li++) {
                if (node.inputs[offset + li]?.link == null) {
                    srcNode.connect(enabled[li], node, offset + li);
                }
            }
        }

        // Source 0: enabledSlots=[0,2] → connect(0, node, 0), connect(2, node, 1)
        assert.equal(srcNode1.connect.mock.calls.length, 2);
        assert.deepEqual(srcNode1.connect.mock.calls[0].arguments, [0, node, 0]);
        assert.deepEqual(srcNode1.connect.mock.calls[1].arguments, [2, node, 1]);

        // Source 1: enabledSlots=[0] → connect(0, node, 2)
        assert.equal(srcNode2.connect.mock.calls.length, 1);
        assert.deepEqual(srcNode2.connect.mock.calls[0].arguments, [0, node, 2]);
    });
});

describe("L2: Pipe Collector 接続復元", () => {
    it("pipeSlotIndex に基づいて connect する", () => {
        const node = createMockNode();
        PipeCollector.configure(node, SNAPSHOTS.pipeCollector.twoSources);

        const srcNode1 = createSourceNode({
            id: 30, title: "SAX Loader", type: "SAX_Bridge_Loader",
            outputs: [{ name: "pipe", type: "PIPE_LINE" }],
        });
        const srcNode2 = createSourceNode({
            id: 40, title: "SAX Sampler", type: "SAX_Bridge_Sampler",
            outputs: [
                { name: "pipe", type: "PIPE_LINE" },
                { name: "images", type: "IMAGE" },
            ],
        });

        const getNodeById = (id) => {
            if (id === 30) return srcNode1;
            if (id === 40) return srcNode2;
            return null;
        };

        const sources = PipeCollector.getSources(node);
        for (let si = 0; si < sources.length; si++) {
            const src = sources[si];
            const srcNode = getNodeById(src.sourceId);
            if (!srcNode) continue;
            const gi = src.pipeSlotIndex;
            if (node.inputs[si]?.link == null) {
                srcNode.connect(gi, node, si);
            }
        }

        assert.equal(srcNode1.connect.mock.calls.length, 1);
        assert.deepEqual(srcNode1.connect.mock.calls[0].arguments, [0, node, 0]);

        assert.equal(srcNode2.connect.mock.calls.length, 1);
        assert.deepEqual(srcNode2.connect.mock.calls[0].arguments, [1, node, 1]);
    });
});

// ===========================================================================
// L1: serialize → configure ラウンドトリップ
// ===========================================================================

describe("L1: ラウンドトリップ（serialize → configure で同一状態に復元）", () => {
    it("Image Collector", () => {
        const original = createMockNode();
        original._remoteSources = SNAPSHOTS.imageCollector.twoSources.sax_collector.sources;
        original._remoteLinksVisible = true;

        const data = ImageCollector.serialize(original);

        const restored = createMockNode();
        ImageCollector.configure(restored, data);

        assert.deepEqual(restored._remoteSources, original._remoteSources);
        assert.equal(restored._remoteLinksVisible, original._remoteLinksVisible);
        assert.equal(restored.inputs.length, 3);
    });

    it("Pipe Collector", () => {
        const original = createMockNode();
        original._remoteSources = SNAPSHOTS.pipeCollector.twoSources.sax_pipe_collector.sources;
        original._remoteLinksVisible = false;

        const data = PipeCollector.serialize(original);

        const restored = createMockNode();
        PipeCollector.configure(restored, data);

        assert.deepEqual(restored._remoteSources, original._remoteSources);
        assert.equal(restored.inputs.length, 2);
    });

    it("Node Collector", () => {
        const original = createMockNode();
        original._remoteSources = SNAPSHOTS.nodeCollector.v2TwoSources.sax_node_collector.sources;
        original._remoteLinksVisible = true;

        const data = NodeCollector.serialize(original);

        const restored = createMockNode();
        NodeCollector.configure(restored, data);

        assert.deepEqual(restored._remoteSources, original._remoteSources);
        assert.equal(restored.inputs.length, 3);
        assert.equal(restored.outputs.length, 3);
    });
});
