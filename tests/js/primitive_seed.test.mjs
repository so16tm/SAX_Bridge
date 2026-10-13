/**
 * Primitive Store の SEED 更新ロジック (increment / random / fixed) の契約テスト
 *
 * 実行: node --test tests/js/primitive_seed.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SEED_MAX, advanceSeeds, nextSeedMode } from "../../js/sax_primitive_seed.js";

const seed = (extra) => ({ type: "SEED", name: "s", value: 10, min: 0, max: SEED_MAX, step: 1, mode: "increment", timing: "before", ...extra });
const EVENTS = ["queue-before", "queue-after", "executed"];
const changedEvents = (item) => EVENTS.filter(ev => advanceSeeds([{ ...item }], ev) > 0);

describe("increment のタイミング", () => {
    it("Before はキュー登録の直前に 1 加算し、他のイベントでは動かさない", () => {
        assert.deepEqual(changedEvents(seed({ timing: "before" })), ["queue-before"]);
        const item = seed({ timing: "before" });
        advanceSeeds([item], "queue-before");
        assert.equal(item.value, 11);
    });

    it("After はキュー登録の直後に 1 加算し、他のイベントでは動かさない", () => {
        assert.deepEqual(changedEvents(seed({ timing: "after" })), ["queue-after"]);
        const item = seed({ timing: "after" });
        advanceSeeds([item], "queue-after");
        assert.equal(item.value, 11);
    });

    it("連続登録で毎回異なる値になる (Before / After とも)", () => {
        for (const timing of ["before", "after"]) {
            const item = seed({ timing, value: 0 });
            for (let i = 0; i < 3; i++) {
                advanceSeeds([item], "queue-before");
                advanceSeeds([item], "queue-after");
                advanceSeeds([item], "executed");
            }
            assert.equal(item.value, 3, timing);
        }
    });

    it("timing 未設定は Before 扱い", () => {
        assert.deepEqual(changedEvents(seed({ timing: undefined })), ["queue-before"]);
    });

    it("Max を超えず、step は 1 未満にならない", () => {
        const item = seed({ value: 99, max: 100 });
        advanceSeeds([item], "queue-before");
        advanceSeeds([item], "queue-before");
        assert.equal(item.value, 100);
        const small = seed({ step: 0.1 });
        advanceSeeds([small], "queue-before");
        assert.equal(small.value, 11);
    });
});

describe("既存モードの互換", () => {
    it("fixed は動かさない", () => {
        assert.deepEqual(changedEvents(seed({ mode: "fixed" })), []);
        assert.deepEqual(changedEvents(seed({ mode: undefined })), []);
    });

    it("random Before はキュー登録前と実行完了、After は実行完了のみ", () => {
        assert.deepEqual(changedEvents(seed({ mode: "random", timing: "before" })), ["queue-before", "executed"]);
        assert.deepEqual(changedEvents(seed({ mode: "random", timing: "after" })), ["executed"]);
    });

    it("random は 0〜Max の範囲", () => {
        const item = seed({ mode: "random", max: 5 });
        for (let i = 0; i < 50; i++) {
            advanceSeeds([item], "executed");
            assert.ok(Number.isInteger(item.value) && item.value >= 0 && item.value <= 5);
        }
    });

    it("SEED 以外のアイテムは変更しない", () => {
        const items = [{ type: "INT", value: 3, mode: "increment" }, null];
        assert.equal(advanceSeeds(items, "queue-before"), 0);
        assert.equal(items[0].value, 3);
    });
});

describe("モード切替", () => {
    it("fixed → random → increment → fixed と巡回し、未知の値は fixed に戻る", () => {
        assert.equal(nextSeedMode("fixed"), "random");
        assert.equal(nextSeedMode("random"), "increment");
        assert.equal(nextSeedMode("increment"), "fixed");
        assert.equal(nextSeedMode(undefined), "fixed");
    });
});
