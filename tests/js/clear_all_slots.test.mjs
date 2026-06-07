/**
 * clearAllSlots テスト
 *
 * sax_ui_base.js は app.js を import する経路上で直接 import 不可のため、
 * 同等ロジックを再実装して検証する。
 *
 * 実行: node --test tests/js/clear_all_slots.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function clearAllSlots(node, { inputs = true, outputs = true } = {}) {
    if (outputs) {
        for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) {
            node.removeOutput(i);
        }
    }
    if (inputs) {
        for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
            node.removeInput(i);
        }
    }
}

function makeMockNode(initInputs, initOutputs) {
    return {
        inputs: [...initInputs],
        outputs: [...initOutputs],
        removeInput(i) { this.inputs.splice(i, 1); },
        removeOutput(i) { this.outputs.splice(i, 1); },
    };
}

describe("clearAllSlots", () => {
    it("デフォルトで inputs と outputs の両方を末尾から削除する", () => {
        const node = makeMockNode([{ name: "in0" }, { name: "in1" }], [{ name: "out0" }]);
        clearAllSlots(node);
        assert.deepEqual(node.inputs, []);
        assert.deepEqual(node.outputs, []);
    });

    it("inputs: false で outputs のみ削除する", () => {
        const node = makeMockNode([{ name: "in0" }], [{ name: "out0" }, { name: "out1" }]);
        clearAllSlots(node, { inputs: false });
        assert.deepEqual(node.inputs, [{ name: "in0" }]);
        assert.deepEqual(node.outputs, []);
    });

    it("outputs: false で inputs のみ削除する", () => {
        const node = makeMockNode([{ name: "in0" }, { name: "in1" }], [{ name: "out0" }]);
        clearAllSlots(node, { outputs: false });
        assert.deepEqual(node.inputs, []);
        assert.deepEqual(node.outputs, [{ name: "out0" }]);
    });

    it("inputs/outputs が空配列でも安全に動作する", () => {
        const node = makeMockNode([], []);
        clearAllSlots(node);
        assert.deepEqual(node.inputs, []);
        assert.deepEqual(node.outputs, []);
    });

    it("inputs/outputs が undefined でも安全に動作する", () => {
        const node = {
            removeInput() {},
            removeOutput() {},
        };
        // throw しないこと
        clearAllSlots(node);
    });

    it("削除は末尾から実行される (順序確認)", () => {
        const callOrder = [];
        const node = {
            inputs: [{ name: "in0" }, { name: "in1" }, { name: "in2" }],
            outputs: [{ name: "out0" }, { name: "out1" }],
            removeInput(i) { callOrder.push(`in:${i}`); this.inputs.pop(); },
            removeOutput(i) { callOrder.push(`out:${i}`); this.outputs.pop(); },
        };
        clearAllSlots(node);
        assert.deepEqual(callOrder, ["out:1", "out:0", "in:2", "in:1", "in:0"]);
    });
});
