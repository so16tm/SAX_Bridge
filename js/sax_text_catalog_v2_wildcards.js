import { loadWildcardList, showFilePicker } from "./sax_ui_base.js";

const active = new WeakMap();

export function normalizeWildcardName(value) {
    if (typeof value !== "string") return null;
    let name = value.replace(/[\x00-\x1f\x7f]/g, "").trim().replace(/\\/g, "/");
    if (name.startsWith("__") && name.endsWith("__")) name = name.slice(2, -2);
    if (!name || [...name].length > 252) return null;
    return `__${name}__`;
}

/** Insert a literal token; expansion belongs to the existing prompt pipeline. */
export function insertWildcardToken(textarea, token, range) {
    const safe = normalizeWildcardName(token); if (!safe) return false;
    const value = textarea.value;
    // If typing continued while loading, use the current caret rather than an obsolete range.
    const start = Math.min(value.length, range.value === value ? range.start : textarea.selectionStart ?? value.length);
    const end = Math.min(value.length, range.value === value ? range.end : textarea.selectionEnd ?? start);
    const before = value.slice(0, start);
    const prefix = before && !/[\s,]$/.test(before) ? ", " : "";
    const insertion = prefix + safe;
    if (typeof textarea.setRangeText === "function") textarea.setRangeText(insertion, start, end, "end");
    else { textarea.value = value.slice(0, start) + insertion + value.slice(end); textarea.selectionStart = textarea.selectionEnd = start + insertion.length; }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
}

/** Caller keeps the inline row pinned until onClose, including during list loading. */
export function openWildcardPicker(textarea, { onInsert, onError, onClose, isCurrent = () => true } = {}) {
    if (active.has(textarea)) return active.get(textarea);
    const range = { start: textarea.selectionStart ?? textarea.value.length, end: textarea.selectionEnd ?? textarea.value.length, value: textarea.value };
    let finished = false;
    const finish = () => { if (finished) return; finished = true; active.delete(textarea); onClose?.(); };
    const report = message => { try { onError?.(message); } finally { finish(); } };
    const current = () => textarea.isConnected && isCurrent();
    const pending = (async () => {
        try {
            const list = await loadWildcardList({ forceRefresh: true, maxItems: 10000, maxNameLength: 256 });
            if (!current()) { finish(); return null; }
            const items = [...new Set(list.map(normalizeWildcardName).filter(Boolean))];
            if (!items.length) { report("ワイルドカードファイルを取得できませんでした。Autocomplete++の導入状態とファイルの登録を確認してください。"); return null; }
            return showFilePicker({
                items,
                title: "ワイルドカードを本文へ挿入",
                placeholder: "ファイル名・フォルダー名を検索…",
                mode: "single",
                className: "__sax_text_catalog_v2_wc_picker",
                displayName: name => name,
                filterFn: (name, query) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                onSelect(name) {
                    if (!current()) return;
                    if (insertWildcardToken(textarea, name, range)) onInsert?.();
                },
                // Common picker closes before calling onSelect. Delay release until insertion is complete.
                onClose: () => queueMicrotask(finish),
            });
        } catch (error) { report(error.message); return null; }
    })();
    active.set(textarea, pending);
    return pending;
}
