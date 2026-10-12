import { api } from "../../scripts/api.js";
import { invalidateWildcardListCache } from "./sax_ui_base.js";

let pending = null;

function expanderUrl(value) {
    try {
        const url = new URL(value, location.origin);
        if (url.origin === location.origin && url.pathname.startsWith("/extensions/") && /autocomplete.*plus.*plus/i.test(url.pathname) && url.pathname.endsWith("/prompt-expander.js")) { url.search = ""; url.hash = ""; return url.href; }
    } catch { /* 別オリジンや不正なURLは使用しない。 */ }
    return null;
}

async function findExpander() {
    // main.jsの相対import先を使う。ComfyUIが別途付けたqueryのmoduleは別キャッシュになる。
    for (const resource of performance.getEntriesByType("resource")) {
        const url = expanderUrl(resource.name); if (url) return import(url);
    }
    const response = await api.fetchApi("/extensions", {cache:"no-store"});
    if (!response.ok) throw new Error("拡張機能の一覧を取得できません");
    const extensions = await response.json();
    if (!Array.isArray(extensions)) throw new Error("拡張機能の一覧が不正です");
    const url = extensions.map(expanderUrl).find(Boolean);
    if (!url) throw new Error("Autocomplete++の展開モジュールが見つかりません");
    return import(url);
}

export function refreshAutocompleteWildcards() {
    if (pending) return pending;
    pending = (async () => {
        const module = await findExpander(), engine = globalThis.window?.tagCompleteEngine;
        if (!(module.wildcardContentMap instanceof Map) || !engine || !Array.isArray(engine.wildcards) || !(engine.wildcardCache instanceof Map)) throw new Error("このAutocomplete++では自動更新を利用できません");
        const response = await api.fetchApi("/autocomplete-plus-plus/wildcards/all-data", {cache:"no-store"});
        if (!response.ok) throw new Error("最新のワイルドカードを取得できません");
        const data = await response.json();
        if (!data?.success || !data.wildcards || typeof data.wildcards !== "object" || Array.isArray(data.wildcards)) throw new Error("ワイルドカードの取得結果が不正です");
        const next = new Map(), names = [];
        for (const [name, lines] of Object.entries(data.wildcards)) {
            if (!Array.isArray(lines) || lines.some(line => typeof line !== "string")) throw new Error("ワイルドカードの本文が不正です");
            names.push(name); next.set(name.toLowerCase(), lines); next.set(name.toLowerCase().replace(/\\/g,"/"), lines);
        }
        // 全件取得・検証後に置換し、失敗時は最後に正常取得したデータを残す。
        module.wildcardContentMap.clear();
        for (const [name, lines] of next) module.wildcardContentMap.set(name, lines);
        engine.wildcards = names; engine.wildcardCache.clear(); engine.hide?.();
        invalidateWildcardListCache();
        return names.length;
    })().finally(() => { pending = null; });
    return pending;
}
