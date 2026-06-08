/**
 * showConfirmDialog / showPromptDialog / showAlertDialog API テスト
 *
 * sax_ui_base.js は app.js を import するため Node 側から import できない。
 * 本テストは sax_ui_base.js のソース文字列上で API export が宣言されていること、
 * Promise を返すシグネチャに準拠していることを静的検証する。
 * DOM 操作の挙動はブラウザ実機テスト (MANUAL_TEST.md) に委ねる。
 *
 * 実行: node --test tests/js/dialog_apis.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
    join(__dirname, "..", "..", "js", "sax_ui_base.js"),
    "utf-8",
);

describe("dialog APIs (sax_ui_base.js exports)", () => {
    it("showConfirmDialog が export されている", () => {
        assert.match(SOURCE, /export\s+function\s+showConfirmDialog\s*\(/);
    });

    it("showPromptDialog が export されている", () => {
        assert.match(SOURCE, /export\s+function\s+showPromptDialog\s*\(/);
    });

    it("showAlertDialog が export されている", () => {
        assert.match(SOURCE, /export\s+function\s+showAlertDialog\s*\(/);
    });

    it("showConfirmDialog は Promise を返す (return new Promise)", () => {
        const m = SOURCE.match(
            /export\s+function\s+showConfirmDialog[\s\S]{0,400}?return\s+new\s+Promise/,
        );
        assert.ok(m, "showConfirmDialog は Promise を返すべき");
    });

    it("showPromptDialog は Promise を返す", () => {
        const m = SOURCE.match(
            /export\s+function\s+showPromptDialog[\s\S]{0,400}?return\s+new\s+Promise/,
        );
        assert.ok(m, "showPromptDialog は Promise を返すべき");
    });

    it("showAlertDialog は Promise を返す", () => {
        const m = SOURCE.match(
            /export\s+function\s+showAlertDialog[\s\S]{0,400}?return\s+new\s+Promise/,
        );
        assert.ok(m, "showAlertDialog は Promise を返すべき");
    });

    it("showDialog の戻り値に overlay / hide / show を付与している", () => {
        assert.match(SOURCE, /close\.overlay\s*=\s*overlay/);
        assert.match(SOURCE, /close\.hide\s*=/);
        assert.match(SOURCE, /close\.show\s*=/);
    });

    it("applySourceListLifecycle が export されている", () => {
        assert.match(SOURCE, /export\s+function\s+applySourceListLifecycle\s*\(/);
    });
});
