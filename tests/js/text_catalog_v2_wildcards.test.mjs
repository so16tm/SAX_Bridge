import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub } from "../bench/env.mjs";

register("../bench/hooks.mjs", import.meta.url);
installDomStub();
const { normalizeWildcardName, insertWildcardToken } = await import("../../js/sax_text_catalog_v2_wildcards.js");

function area(value, start, end = start) {
    return { value, selectionStart: start, selectionEnd: end, events: [], dispatchEvent(event) { this.events.push(event.type); } };
}

test("Wildcardはサブフォルダーを保持したリテラルトークンになる", () => {
    assert.equal(normalizeWildcardName("__folder/name__"), "__folder/name__");
    assert.equal(normalizeWildcardName("folder\\name"), "__folder/name__");
    assert.equal(normalizeWildcardName(" __folder/na\nme__ "), "__folder/name__");
    assert.equal(normalizeWildcardName(""), null);
    assert.equal(normalizeWildcardName("____"), null);
    assert.equal(normalizeWildcardName("x".repeat(253)), null);
    assert.equal(normalizeWildcardName({}), null);
});

test("選択範囲を置換して本文末尾とinput通知を保持する", () => {
    const text = area("quality, old, lighting", 9, 12);
    assert.equal(insertWildcardToken(text, "__people/traveler__", { value: text.value, start: 9, end: 12 }), true);
    assert.equal(text.value, "quality, __people/traveler__, lighting");
    assert.equal(text.selectionStart, "quality, __people/traveler__".length);
    assert.deepEqual(text.events, ["input"]);
});

test("読み込み中の追加入力がある場合は現在のカーソルを使う", () => {
    const text = area("quality, added", 14);
    insertWildcardToken(text, "style/paint", { value: "quality", start: 7, end: 7 });
    assert.equal(text.value, "quality, added, __style/paint__");
});

test("空本文・改行直後は余分な区切りを追加せず、無効名では変更しない", () => {
    const blank = area("", 0); insertWildcardToken(blank, "one", { value: "", start: 0, end: 0 }); assert.equal(blank.value, "__one__");
    const newline = area("first\n", 6); insertWildcardToken(newline, "two", { value: newline.value, start: 6, end: 6 }); assert.equal(newline.value, "first\n__two__");
    const invalid = area("preserved", 4); assert.equal(insertWildcardToken(invalid, "", { value: invalid.value, start: 4, end: 4 }), false); assert.equal(invalid.value, "preserved"); assert.deepEqual(invalid.events, []);
});
