// ComfyUI-Custom-Scripts の辞書・設定を共有し、カタログの本文入力にも補完を提供する。
let modulePromise;
const attachments = new WeakMap();

async function loadAutoComplete() {
    if (!modulePromise) {
        modulePromise = (async () => {
            for (const path of [
                "/extensions/pysssss/js/common/autocomplete.js",
                "/extensions/ComfyUI-Custom-Scripts/js/common/autocomplete.js",
            ]) {
                try {
                    const mod = await import(path);
                    if (mod?.TextAreaAutoComplete) return mod.TextAreaAutoComplete;
                } catch { /* 未導入または別の配信パスなら次の候補へ進む。 */ }
            }
            return null;
        })();
    }
    return modulePromise;
}

export async function attachAutoComplete(textarea) {
    if (attachments.has(textarea)) return;
    const attachment = {};
    attachments.set(textarea, attachment);
    const AutoComplete = await loadAutoComplete();
    if (!AutoComplete || !textarea.isConnected || attachments.get(textarea) !== attachment) {
        if (attachments.get(textarea) === attachment) attachments.delete(textarea);
        return;
    }
    try {
        // インスタンスだけに区切りを指定し、他ノードのグローバル設定は変更しない。
        const instance = new AutoComplete(textarea, null, AutoComplete.globalSeparator || ", ");
        attachment.instance = instance;
        // pysssss は Escape を keyup で処理するため、先に dialog の keydown へ伝えない。
        attachment.onKeyDown = event => {
            if (event.key === "Escape" && instance.dropdown?.parentElement) event.stopPropagation();
        };
        textarea.addEventListener("keydown", attachment.onKeyDown);
        // カタログはキャンバス外のダイアログなので、ズーム倍率を適用しない。
        if (instance.helper) {
            instance.helper.getScale = () => 1;
            // pysssss の選択後タイマーが、閉じたエディタの候補を再表示しないようにする。
            const getBeforeCursor = instance.helper.getBeforeCursor;
            if (getBeforeCursor) instance.helper.getBeforeCursor = () =>
                textarea.isConnected && attachments.get(textarea) === attachment
                    ? getBeforeCursor.call(instance.helper) : null;
        }
        if (instance.dropdown) instance.dropdown.style.zIndex = "10001";
    } catch {
        attachments.delete(textarea);
    }
}

export function detachAutoComplete(textarea) {
    const attachment = attachments.get(textarea);
    attachment?.instance?.dropdown?.remove();
    if (attachment?.onKeyDown) textarea.removeEventListener("keydown", attachment.onKeyDown);
    attachments.delete(textarea);
}
