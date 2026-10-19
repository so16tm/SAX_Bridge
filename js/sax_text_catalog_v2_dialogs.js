import { showDialog } from "./sax_ui_base.js";
import { searchTokens, normalizeSearch } from "./sax_text_catalog_v2_model.js";

const PICKER_STYLE = `
.sax-picker{display:grid;gap:6px;min-width:0}
.sax-picker input{font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:6px 8px;min-width:0}
.sax-picker-list{max-height:50vh;overflow:auto;display:grid;gap:4px;align-content:start}
.sax-picker-list button{font:inherit;color:inherit;background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:6px 8px;text-align:left;cursor:pointer;display:flex;gap:8px;justify-content:space-between;min-width:0}
.sax-picker-list button>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sax-picker-list button>span+span{opacity:.65;font-size:11px;flex:none}
.sax-picker-list button[aria-selected=true]{border-color:var(--primary-background,#5686d6)}
.sax-picker-list button[data-active=true]{background:color-mix(in srgb,var(--primary-background,#5686d6) 22%,var(--comfy-input-bg,#242426))}
.sax-picker :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:1px}
.sax-picker-empty{opacity:.65;padding:8px}
`;

/**
 * 他のダイアログが前面にないときだけ true。showDialog は同じ z-index の overlay を body へ積むため、
 * 後ろに続く overlay があれば前面にあるのはそちら。Esc などのキー処理は必ずこれを通す。
 */
export function isTopmostOverlay(overlay) {
    if (!overlay?.isConnected || overlay.style.display === "none") return false;
    for (let next = overlay.nextElementSibling; next; next = next.nextElementSibling) if (next.style?.zIndex === "10000" && next.style.display !== "none") return false;
    return true;
}

/**
 * 検索付きの選択リスト。空白区切りの AND 検索（全角半角・大文字小文字は区別しない）。
 * 検索欄で ↑↓ で移動し Enter で決定、リストのボタンはクリックまたは Enter／Space で決定する。
 * entries は [{ id, name, hint? }]。並び順は呼び出し側で決める。
 */
export function buildPickerList(entries, { onPick, current = null, label = "候補を検索", emptyText = "一致する項目がありません" } = {}) {
    const root = document.createElement("div"); root.className = "sax-picker";
    const style = document.createElement("style"); style.textContent = PICKER_STYLE;
    const search = document.createElement("input"); search.placeholder = "検索（空白区切りで AND）"; search.setAttribute("aria-label", label);
    const list = document.createElement("div"); list.className = "sax-picker-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label);
    root.append(style, search, list);
    const keys = entries.map(entry => normalizeSearch(entry.name || "無題"));
    let shown = [], active = 0;
    const paintActive = () => { shown.forEach((entry, index) => { entry.button.dataset.active = String(index === active); }); shown[active]?.button.scrollIntoView?.({ block: "nearest" }); };
    const paint = () => {
        const tokens = searchTokens(search.value);
        list.replaceChildren(); shown = [];
        entries.forEach((entry, index) => {
            if (!tokens.every(token => keys[index].includes(token))) return;
            const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "option");
            button.setAttribute("aria-selected", String(entry.id === current));
            const name = document.createElement("span"); name.textContent = entry.name || "無題"; name.title = entry.name || "無題"; button.append(name);
            if (entry.hint) { const hint = document.createElement("span"); hint.textContent = entry.hint; button.append(hint); }
            button.addEventListener("click", () => onPick(entry.id));
            list.append(button); shown.push({ entry, button });
        });
        active = Math.max(0, shown.findIndex(value => value.entry.id === current));
        if (!shown.length) { const empty = document.createElement("div"); empty.className = "sax-picker-empty"; empty.textContent = emptyText; list.append(empty); }
        paintActive();
    };
    search.addEventListener("input", () => { paint(); active = 0; paintActive(); });
    search.addEventListener("keydown", event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); if (!shown.length) return;
            active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; paintActive();
        } else if (event.key === "Enter") {
            event.preventDefault(); if (shown[active]) onPick(shown[active].entry.id);
        }
    });
    paint();
    return { root, search, setCurrent(id) { current = id; for (const { entry, button } of shown) button.setAttribute("aria-selected", String(entry.id === id)); } };
}

/**
 * 検索付きピッカーを開き、選ばれた id を返す。閉じたときは null。
 * ダイアログを開く前にフォーカスしていた要素へ、閉じたあとフォーカスを戻す。
 */
export function choosePicker({ title, entries, current = null, emptyText }) {
    return new Promise(resolve => {
        const opener = document.activeElement;
        let chosen = null, overlay = null, onKey = null;
        const close = showDialog({ title, width: 440, className: "sax-picker-dialog", build(dialog, end) {
            const picker = buildPickerList(entries, { current, label: title, emptyText, onPick: id => { chosen = id; end(); } });
            dialog.append(picker.root); queueMicrotask(() => picker.search.focus());
        }, onClose() {
            if (onKey) document.removeEventListener("keydown", onKey); onKey = null;
            resolve(chosen); if (opener?.isConnected) opener.focus?.({ preventScroll: true });
        } });
        overlay = close.overlay;
        onKey = event => { if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && isTopmostOverlay(overlay)) { event.preventDefault(); close(); } };
        document.addEventListener("keydown", onKey);
    });
}
