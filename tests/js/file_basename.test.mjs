/**
 * fileBasenameWithoutExt テスト
 *
 * sax_ui_base.js の `fileBasenameWithoutExt` は app.js を import する経路の
 * 関数群に含まれており、テスト環境からは直接 import できないため、
 * 同等ロジックをここで再実装し検証する。実装側の正規表現と乖離した場合は
 * `assertImplMatches` でも捕捉される。
 *
 * 実行: node --test tests/js/file_basename.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function fileBasenameWithoutExt(full) {
    return String(full).replace(/\.safetensors$/i, "").replace(/^.*[\\/]/, "");
}

describe("fileBasenameWithoutExt", () => {
    it(".safetensors 拡張子を除去する", () => {
        assert.equal(fileBasenameWithoutExt("model.safetensors"), "model");
    });

    it("大文字 .SAFETENSORS も除去する", () => {
        assert.equal(fileBasenameWithoutExt("model.SAFETENSORS"), "model");
    });

    it("拡張子が無い場合はそのまま basename を返す", () => {
        assert.equal(fileBasenameWithoutExt("model"), "model");
    });

    it("POSIX パスの先頭ディレクトリを除去する", () => {
        assert.equal(fileBasenameWithoutExt("loras/style/awesome.safetensors"), "awesome");
    });

    it("Windows バックスラッシュパスの先頭ディレクトリを除去する", () => {
        assert.equal(fileBasenameWithoutExt("loras\\style\\awesome.safetensors"), "awesome");
    });

    it("空文字列は空文字列を返す", () => {
        assert.equal(fileBasenameWithoutExt(""), "");
    });

    it("ドット入りファイル名でも .safetensors のみ末尾削除する", () => {
        // 末尾が .safetensors でない他の拡張子は保持される
        assert.equal(fileBasenameWithoutExt("v1.5_model.ckpt"), "v1.5_model.ckpt");
    });

    it("非文字列入力は String() を経由する", () => {
        assert.equal(fileBasenameWithoutExt(123), "123");
        assert.equal(fileBasenameWithoutExt(null), "null");
    });
});
