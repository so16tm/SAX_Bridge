import { test } from "node:test";
import assert from "node:assert/strict";
import { attachAutoComplete, detachAutoComplete } from "../../js/sax_text_autocomplete.js";

const styles = [];
globalThis.document = {
    getElementById: id => styles.find(s => s.id === id),
    createElement: () => ({}),
    head: { appendChild: style => styles.push(style) },
};
function textarea(isConnected = true) {
    return { isConnected, listeners: new Map(),
        addEventListener(type, handler) { this.listeners.set(type, handler); },
        removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); },
    };
}

test("Autocomplete++未導入でも入力を妨げず、二重接続と重複CSSを避ける", async () => {
    const input = textarea();
    await attachAutoComplete(input);
    const listener = input.listeners.get("keydown");
    await attachAutoComplete(input);
    assert.equal(input.listeners.get("keydown"), listener);
    await attachAutoComplete(textarea());
    assert.equal(styles.length, 1);
    assert.match(styles[0].textContent, /tagcomplete-popup-container.*10001/);
    detachAutoComplete(input);
    assert.equal(input.listeners.size, 0);
});

test("補完が消費したEscapeだけをモーダルへ伝えない", async () => {
    const input = textarea();
    await attachAutoComplete(input);
    let stopped = 0;
    const dispatch = defaultPrevented => input.listeners.get("keydown")({ key: "Escape", defaultPrevented, stopPropagation() { stopped++; } });
    dispatch(false); assert.equal(stopped, 0);
    dispatch(true); assert.equal(stopped, 1);
});

test("閉じた本文の候補だけを消し、他ノードの候補と切断済み入力を保護", async () => {
    const input = textarea();
    let hidden = 0;
    globalThis.window = { tagCompleteEngine: { target: input, hide() { hidden++; } } };
    await attachAutoComplete(input);
    detachAutoComplete(input);
    assert.equal(hidden, 1);
    window.tagCompleteEngine.target = textarea();
    detachAutoComplete(input);
    assert.equal(hidden, 1);
    const disconnected = textarea(false);
    await attachAutoComplete(disconnected);
    assert.equal(disconnected.listeners.size, 0);
    delete globalThis.window;
});

test("作成直後はDOM外のtextareaにも接続し、接続前に閉じたものは復活しない", async () => {
    const input = textarea(false);
    const pending = attachAutoComplete(input);
    input.isConnected = true;
    await pending;
    assert.ok(input.listeners.has("keydown"));
    const closed = textarea();
    const attaching = attachAutoComplete(closed);
    detachAutoComplete(closed);
    await attaching;
    assert.equal(closed.listeners.size, 0);
});
