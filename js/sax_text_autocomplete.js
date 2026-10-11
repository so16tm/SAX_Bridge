// Autocomplete++ の DOM observer が本文 textarea を検出する。独自の補完インスタンスは作らない。
const attachments = new WeakMap();

export async function attachAutoComplete(textarea) {
    if (attachments.has(textarea)) return;
    const attachment = {};
    attachments.set(textarea, attachment);
    // V1/V2 は textarea を作成してからモーダルへ append する。
    await Promise.resolve();
    if (!textarea.isConnected || attachments.get(textarea) !== attachment) {
        if (attachments.get(textarea) === attachment) attachments.delete(textarea);
        return;
    }
    const onKeyDown = event => {
        if (event.key === "Escape" && event.defaultPrevented) event.stopPropagation();
    };
    textarea.addEventListener("keydown", onKeyDown);
    attachment.onKeyDown = onKeyDown;
    // SAX のモーダルと同じ z-index では、先に生成された候補が裏へ隠れる。
    if (!document.getElementById("sax-autocomplete-layer")) {
        const style = document.createElement("style");
        style.id = "sax-autocomplete-layer";
        style.textContent = "#tagcomplete-popup-container{z-index:10001!important}";
        document.head.appendChild(style);
    }
}

export function detachAutoComplete(textarea) {
    const listener = attachments.get(textarea)?.onKeyDown;
    if (listener) textarea.removeEventListener("keydown", listener);
    const engine = globalThis.window?.tagCompleteEngine;
    // 閉じたエディタの候補だけを消し、他ノードの補完には触れない。
    if (engine?.target === textarea) engine.hide();
    attachments.delete(textarea);
}
