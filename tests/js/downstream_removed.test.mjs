/**
 * _captureDownstream / _restoreDownstream 削除確認テスト
 *
 * Phase A (g)/(h) で削除した内部関数が sax_ui_base.js から復活しないことを
 * 保証する。後続リファクタで誤って戻された場合を CI で捕捉する。
 *
 * 実行: node --test tests/js/downstream_removed.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAX_UI_BASE = resolve(__dirname, "..", "..", "js", "sax_ui_base.js");

describe("_captureDownstream / _restoreDownstream 削除確認", () => {
    const src = readFileSync(SAX_UI_BASE, "utf8");

    it("sax_ui_base.js に function _captureDownstream の定義が存在しない", () => {
        assert.equal(/function\s+_captureDownstream\s*\(/.test(src), false);
    });

    it("sax_ui_base.js に function _restoreDownstream の定義が存在しない", () => {
        assert.equal(/function\s+_restoreDownstream\s*\(/.test(src), false);
    });

    it("sax_ui_base.js に _captureDownstream の呼出が存在しない", () => {
        assert.equal(/_captureDownstream\s*\(/.test(src), false);
    });

    it("sax_ui_base.js に _restoreDownstream の呼出が存在しない", () => {
        assert.equal(/_restoreDownstream\s*\(/.test(src), false);
    });
});
