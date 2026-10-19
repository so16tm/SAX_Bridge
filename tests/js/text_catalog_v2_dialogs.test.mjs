import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { installDomStub } from "../bench/env.mjs";

register("../bench/hooks.mjs", import.meta.url);
installDomStub();
const { isTopmostOverlay } = await import("../../js/sax_text_catalog_v2_dialogs.js");

// showDialog は同じ z-index の overlay を body へ積む。後ろに表示中の overlay があれば、前面にあるのはそちら。
const overlay = (zIndex = "10000", display = "flex") => ({ isConnected: true, style: { zIndex, display }, nextElementSibling: null });
const stack = (...items) => { items.forEach((item, index) => { item.nextElementSibling = items[index + 1] ?? null; }); return items; };

test("最前面のダイアログだけがEscなどのキー操作を受ける", () => {
    const [editor, picker] = stack(overlay(), overlay());
    assert.equal(isTopmostOverlay(picker), true);
    assert.equal(isTopmostOverlay(editor), false, "後ろに別のダイアログがあれば前面ではない");
    picker.style.display = "none"; assert.equal(isTopmostOverlay(editor), true, "非表示のダイアログは数えない");
    assert.equal(isTopmostOverlay(picker), false, "自分が非表示なら対象外");
    const [other, unrelated] = stack(overlay(), overlay("5"));
    assert.equal(isTopmostOverlay(other), true, "別種の要素は数えない");
    assert.equal(isTopmostOverlay({ ...overlay(), isConnected: false }), false, "閉じたダイアログは対象外");
    assert.equal(isTopmostOverlay(null), false);
    void unrelated;
});
