import { showDialog, showConfirmDialog } from "./sax_ui_base.js";
import { newId, parseTags } from "./sax_text_catalog_v2_model.js";
import { attachAutoComplete, detachAutoComplete } from "./sax_text_autocomplete.js";
import { openWildcardPicker } from "./sax_text_catalog_v2_wildcards.js";

const preferences = new WeakMap();
const openEditors = new WeakMap();
const STYLE = `
.sax-shared-editor *{box-sizing:border-box}.sax-shared-editor [hidden]{display:none!important}.sax-shared-editor .se-mobile-tags{display:none}.sax-shared-editor>div{width:97vw!important;height:94vh;max-height:97vh!important;padding:16px!important;border-radius:12px!important;font-family:system-ui,sans-serif}
.sax-shared-editor button,.sax-shared-editor input,.sax-shared-editor select,.sax-shared-editor textarea{font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:7px 9px;min-width:0}.sax-shared-editor button{cursor:pointer}.sax-shared-editor button:disabled{opacity:.45;cursor:default}.sax-shared-editor :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:2px}.sax-shared-editor textarea{width:100%;resize:vertical;line-height:1.7;min-height:160px}.sax-shared-editor input[type=checkbox]{width:16px;height:16px;accent-color:var(--primary-background,#5686d6)}
.sax-shared-editor .se-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sax-shared-editor .se-grow{flex:1;min-width:110px}.sax-shared-editor .se-muted{opacity:.68;font-size:12px}.sax-shared-editor .se-error{color:var(--error-text,#ed9494);white-space:pre-wrap}.sax-shared-editor .se-status{min-height:18px}.sax-shared-editor .se-scroll{flex:1;min-height:0;overflow:auto;position:relative;scrollbar-gutter:stable;overflow-anchor:none}.sax-shared-editor .se-canvas{position:relative}.sax-shared-editor .se-record{position:absolute;left:0;right:0;display:grid;grid-template-columns:24px minmax(130px,.8fr) minmax(260px,3fr) minmax(120px,.7fr) 72px;gap:12px;padding:10px 6px;border-bottom:1px solid var(--border-color,#45454b);align-items:start}.sax-shared-editor .se-cell{border:0;background:transparent;text-align:left;cursor:text;line-height:1.7;padding:3px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--se-lines,3)}.sax-shared-editor .se-cell:hover{background:color-mix(in srgb,var(--primary-background,#5686d6) 12%,transparent);border-radius:5px}.sax-shared-editor .se-cell:empty:before{content:attr(data-placeholder);opacity:.45}.sax-shared-editor .se-record input:not([type=checkbox]){width:100%}.sax-shared-editor .se-record textarea{resize:none;min-height:200px}.sax-shared-editor .se-record[data-editing=true]{background:color-mix(in srgb,var(--primary-background,#5686d6) 8%,transparent)}.sax-shared-editor .se-tools{display:flex;flex-direction:column;gap:6px}.sax-shared-editor .se-section{position:absolute;left:0;right:0;padding:12px 8px;background:var(--comfy-input-bg,#242426);border-radius:6px;display:flex;align-items:center;gap:12px;overflow:hidden}.sax-shared-editor .se-section strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-shared-editor .se-empty{padding:24px;opacity:.7}.sax-shared-editor .se-columns{display:grid;grid-template-columns:24px minmax(130px,.8fr) minmax(260px,3fr) minmax(120px,.7fr) 72px;gap:12px;padding:0 6px;font-size:12px;opacity:.65}.sax-shared-editor .se-layout{display:grid;grid-template-columns:minmax(240px,1fr) minmax(320px,1.4fr);gap:16px;flex:1;min-height:0}.sax-shared-editor .se-pane{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}.sax-shared-editor .se-card{padding:12px;border:1px solid var(--border-color,#45454b);border-radius:8px;margin-bottom:10px}.sax-shared-editor .se-card[data-off=true]{opacity:.55}.sax-shared-editor .se-card>.se-row{margin-bottom:8px}.sax-shared-editor .se-candidate{position:absolute;left:0;right:0;height:40px;display:flex;align-items:center;gap:10px;padding:6px;border-bottom:1px solid var(--border-color,#45454b)}.sax-shared-editor .se-candidate span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-shared-editor .se-primary{background:var(--primary-background,#386cb8);color:#fff}.sax-shared-editor .se-result-text{flex:1;min-height:0;resize:none!important}.sax-shared-editor .se-badge{font-size:11px;color:var(--primary-background,#80adf2);display:block}.sax-shared-editor .se-conflict{padding:8px;border:1px solid var(--error-text,#ed9494);border-radius:6px}.sax-shared-editor details>summary{cursor:pointer}
@media(max-width:760px){.sax-shared-editor>div{padding:10px!important}.sax-shared-editor .se-layout{grid-template-columns:1fr;grid-template-rows:minmax(180px,.7fr) minmax(220px,1fr)}.sax-shared-editor .se-record,.sax-shared-editor .se-columns{grid-template-columns:20px minmax(75px,.7fr) minmax(140px,2fr) 65px;gap:6px}.sax-shared-editor .se-tags{display:none}.sax-shared-editor .se-row{gap:5px}.sax-shared-editor .se-row button{padding:6px}.sax-shared-editor .se-section .se-muted{display:none}}
@media(max-width:760px){.sax-shared-editor .se-mobile-tags{display:block}}
.sax-shared-editor>div{padding:10px!important;gap:6px!important}.sax-shared-editor .se-header{flex-wrap:nowrap;gap:5px;min-width:0}.sax-shared-editor .se-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:12px}.sax-shared-editor .se-header button,.sax-shared-editor .se-filterbar button,.sax-shared-editor .se-filterbar input,.sax-shared-editor .se-filterbar select{padding:3px 7px;height:28px;font-size:12px}.sax-shared-editor .se-header .se-status{flex:none;max-width:180px;min-height:0;gap:4px;font-size:11px}.sax-shared-editor .se-status>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}.sax-shared-editor .se-list-view{gap:5px}.sax-shared-editor .se-filterbar{gap:5px}.sax-shared-editor .se-filterbar select{max-width:180px}.sax-shared-editor .se-filterbar .se-grow{min-width:140px}.sax-shared-editor .se-wildcard{font-size:11px;padding:3px 6px;margin-top:5px}.sax-shared-editor .se-columns{line-height:18px}.sax-shared-editor .se-error-message{font-size:12px;white-space:pre-wrap}
@media(max-width:760px){.sax-shared-editor .se-header{flex-wrap:wrap}.sax-shared-editor .se-header strong{flex-basis:100%}.sax-shared-editor .se-header .se-status{margin-left:auto;max-width:130px}.sax-shared-editor .se-filterbar select{flex:1;max-width:none;min-width:80px}.sax-shared-editor .se-filterbar .se-grow{flex-basis:100%}}
.sax-shared-expanded>div{width:min(1000px,96vw)!important}.sax-shared-expanded textarea{width:100%;font:13px/1.7 sans-serif;background:var(--comfy-input-bg,#242426);color:var(--input-text,#ddd);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:8px}.sax-shared-expanded button{font:inherit;padding:4px 8px;background:var(--comfy-input-bg,#242426);color:var(--input-text,#ddd);border:1px solid var(--border-color,#45454b);border-radius:6px;cursor:pointer}.sax-shared-expanded .se-row{display:flex;gap:8px;align-items:center}.sax-shared-expanded .se-grow{flex:1}
.sax-shared-editor .se-set-view{gap:6px}
.sax-shared-editor .se-set-view button,.sax-shared-editor .se-set-view input:not([type=checkbox]),.sax-shared-editor .se-set-view select{height:28px;padding:3px 7px;font-size:12px}
.sax-shared-editor .se-set-meta{flex-wrap:nowrap}.sax-shared-editor .se-set-meta>select{max-width:220px;flex:1}.sax-shared-editor .se-set-meta>input{flex:2;width:0}
.sax-shared-editor .se-layout{grid-template-columns:minmax(320px,1.2fr) minmax(320px,1fr);gap:12px}
.sax-shared-editor .se-card{padding:6px 8px;margin-bottom:5px;border-radius:5px}
.sax-shared-editor .se-card[data-editing=true]{border-color:var(--primary-background,#5686d6)}
.sax-shared-editor .se-card>.se-row{gap:5px;margin-bottom:0;flex-wrap:nowrap;min-width:0}
.sax-shared-editor .se-card>.se-row+ .se-row{margin-top:4px}
.sax-shared-editor .se-card input.se-grow{min-width:60px;width:0}
.sax-shared-editor .se-group-icon{width:26px;padding:0!important;flex:none}
.sax-shared-editor .se-group-preview{flex:1;min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:11px}
.sax-shared-editor .se-candidate{height:48px;gap:8px;padding:4px 6px;cursor:pointer}
.sax-shared-editor .se-candidate[data-selected=true]{background:color-mix(in srgb,var(--primary-background,#5686d6) 13%,transparent)}
.sax-shared-editor .se-candidate-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sax-shared-editor .se-candidate-copy>span{display:block;line-height:17px;font-size:12px}
.sax-shared-editor .se-candidate-copy>.se-muted{font-size:11px}
.sax-shared-editor .se-candidate-tags{max-width:25%;font-size:11px}
.sax-shared-editor .se-selectionbar{font-size:12px;gap:6px}
.sax-shared-editor .se-selectionbar .se-muted{margin-left:auto;font-size:11px}
.sax-shared-editor .se-order-scroll{height:240px;flex:none;margin-top:6px;border-top:1px solid var(--border-color,#45454b)}
.sax-shared-editor .se-order-item{position:absolute;left:0;right:0;height:42px;display:flex;align-items:center;gap:5px;padding:4px 0;border-bottom:1px solid var(--border-color,#45454b)}
.sax-shared-editor .se-order-item>input{width:54px;flex:none}.sax-shared-editor .se-order-item .se-candidate-copy>span{font-size:11px}
.sax-shared-editor .se-order-handle{cursor:grab}.sax-shared-editor .se-order-item[data-drop=true]{outline:1px solid var(--primary-background,#5686d6)}
@media(max-width:760px){.sax-shared-editor .se-layout{grid-template-columns:1fr}.sax-shared-editor .se-set-meta{flex-wrap:wrap}.sax-shared-editor .se-set-meta>input{min-width:160px}.sax-shared-editor .se-candidate-tags{display:none}}
`;

function el(tag, cls = "", text = "") { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; }
function row(...children) { const n = el("div", "se-row"); n.append(...children); return n; }
function btn(text, fn, cls = "") { const n = el("button", cls, text); n.type = "button"; n.addEventListener("click", fn); return n; }
function input(value, callback, type = "text") { const n = el("input"); n.type = type; n.value = value; n.addEventListener("input", () => callback(n.value)); return n; }
function select(options, value, fn) { const n = el("select"); for (const [id, name] of options) { const o = el("option", "", name); o.value = id; n.append(o); } n.value = value; n.addEventListener("change", () => fn(n.value)); return n; }
function check(value, fn) { const n = el("input"); n.type = "checkbox"; n.checked = value; n.addEventListener("change", () => fn(n.checked)); return n; }
function label(text, control) { const n = el("label", "se-row"); n.append(control, document.createTextNode(text)); return n; }

// Prefix sums support expanded editing rows without rendering the entire catalog.
export class VariableRowIndex {
    constructor(heights = []) { this.reset(heights); }
    reset(heights) { this.heights = heights; this.offsets = [0]; for (const h of heights) this.offsets.push(this.offsets.at(-1) + h); }
    get total() { return this.offsets.at(-1); }
    at(y) { let lo = 0, hi = this.heights.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.offsets[mid + 1] <= y) lo = mid + 1; else hi = mid; } return lo; }
    window(top, height, overscan = 300) { return [this.at(Math.max(0, top - overscan)), Math.min(this.heights.length, this.at(top + height + overscan) + 1)]; }
}

class VirtualRows {
    constructor(scroll, create, dispose = () => {}) {
        this.scroll = scroll; this.create = create; this.dispose = dispose; this.canvas = el("div", "se-canvas"); this.nodes = new Map(); this.heights = new Map(); this.entries = []; this.pinned = null;
        scroll.append(this.canvas); this.onScroll = () => this.paint(); scroll.addEventListener("scroll", this.onScroll);
        this.observer = typeof ResizeObserver === "function" ? new ResizeObserver(records => {
            let changed = false;
            for (const record of records) { const key = record.target.dataset.key; const height = Math.ceil(record.borderBoxSize?.[0]?.blockSize ?? record.target.getBoundingClientRect().height); if (height > 0 && this.heights.get(key) !== height) { this.heights.set(key, height); changed = true; } }
            if (changed) this.reindex();
        }) : null;
        this.viewportObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.paint()) : null; this.viewportObserver?.observe(scroll);
    }
    set(entries, refresh = false) {
        this.entries = entries;
        const valid = new Set(entries.map(e => e.key));
        for (const [key, node] of this.nodes) if (!valid.has(key) || (refresh && key !== this.pinned)) this.remove(key, node);
        this.reindex();
    }
    reindex() { this.index = new VariableRowIndex(this.entries.map(e => this.heights.get(e.key) ?? e.height)); this.canvas.style.height = `${this.index.total}px`; if (this.scroll.scrollTop > Math.max(0, this.index.total - this.scroll.clientHeight)) this.scroll.scrollTop = Math.max(0, this.index.total - this.scroll.clientHeight); this.paint(); }
    remove(key, node) { this.observer?.unobserve(node); this.dispose(node); node.remove(); this.nodes.delete(key); }
    paint() {
        if (!this.index) return;
        const [start, end] = this.index.window(this.scroll.scrollTop, this.scroll.clientHeight || 600); const visible = new Set(this.entries.slice(start, end).map(e => e.key)); if (this.pinned) visible.add(this.pinned);
        for (const [key, node] of this.nodes) if (!visible.has(key)) this.remove(key, node);
        for (let i = start; i < end; i++) this.materialize(i);
        if (this.pinned) { const i = this.entries.findIndex(e => e.key === this.pinned); if (i >= 0) this.materialize(i); }
    }
    materialize(i) { const entry = this.entries[i]; let n = this.nodes.get(entry.key); if (!n) { n = this.create(entry); n.dataset.key = entry.key; this.nodes.set(entry.key, n); this.canvas.append(n); this.observer?.observe(n); } n.style.top = `${this.index.offsets[i]}px`; }
    destroy() { this.scroll.removeEventListener("scroll", this.onScroll); this.observer?.disconnect(); this.viewportObserver?.disconnect(); for (const [key, n] of this.nodes) this.remove(key, n); }
}

export function openSharedEditor(session, options = {}) {
    const existing = openEditors.get(session); if (existing) { existing.open(options); return existing.close; }
    let pref = preferences.get(session); if (!pref) { pref = { query: "", tag: "", recipeFilter: "", lines: 3, scroll: 0, recipeId: null, sort: "name" }; preferences.set(session, pref); }
    let mode = options.mode ?? "items", result = options.result ?? null;
    if (options.recipeId) { if (mode === "items") { pref.recipeFilter = options.recipeId; pref.query = ""; pref.tag = ""; pref.scroll = 0; } else pref.recipeId = options.recipeId; }
    let content, status, conflict, errorMessage, close, virtual = null, active = null, unsubscribe, localError = "", saveTimer, refreshing = false;
    let itemMap = new Map(), selected = new Set(), candidateSelection = new Set(), candidateGroup = null, candidateQuery = "", candidateTag = "", resultRecipe = "", outputTab = false, selectionAnchor = null;
    let candidatesOnly = false, candidateAnchor = null;
    const setScroll = { candidates: 0, groups: 0 };
    let orderGroup = null, orderScroll = 0;
    const orderLists = [];
    const showCandidates = new Set();
    const doc = () => session.document;
    function sortItems(values, resolve = value => value) {
        const ranks = pref.sort === "catalog" ? new Map(doc().catalog.items.map((item, index) => [item.id, index])) : null;
        const counts = new Map();
        if (pref.sort === "usage") for (const r of doc().recipes) for (const g of r.groups) for (const id of g.item_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
        return values.sort((a, b) => {
            const left = resolve(a), right = resolve(b);
            if (ranks) { const difference = (ranks.get(left.id) ?? Infinity) - (ranks.get(right.id) ?? Infinity); if (difference) return difference; }
            if (pref.sort === "usage") { const difference = (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0); if (difference) return difference; }
            return left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id);
        });
    }
    const sortControl = onChange => {
        const control = select([["catalog", "登録順"], ["name", "名前順"], ["usage", "利用数順"]], pref.sort, value => { releaseActive(); pref.sort = value; onChange(); });
        control.setAttribute("aria-label", "アイテムの並び順"); return control;
    };
    const recipe = () => doc().recipes.find(r => r.id === pref.recipeId) ?? doc().recipes[0];
    const mutate = (operations, historyKey) => { try { session.mutate(operations, historyKey ? { historyKey } : undefined); localError = ""; updateStatus(); return true; } catch (error) { localError = error.message; updateStatus(); return false; } };
    const putItem = (id, patch, historyKey) => {
        const current = doc().catalog.items.find(i => i.id === id);
        if (!current || Object.entries(patch).every(([key, value]) => Array.isArray(value)
            ? Array.isArray(current[key]) && value.length === current[key].length && value.every((entry, index) => entry === current[key][index])
            : value === current[key])) return;
        mutate([{ type: "item.put", item: { ...current, ...patch } }], historyKey);
    };
    const putRecipe = next => mutate([{ type: "recipe.put", recipe: next }]);
    function updateStatus() { if (!status) return; const messages = { saved: "保存済み", pending: "保存中…", saving: "保存中…", error: "保存に失敗", conflict: "編集が競合" }; const message = localError || session.error?.message || ""; status.firstChild.textContent = message ? "エラー" : messages[session.status] || session.status || "保存済み"; status.title = message || "共有カタログへ自動保存"; status.classList.toggle("se-error", Boolean(message) || session.conflict); conflict.hidden = !session.conflict; status.lastChild.hidden = !session.error || session.conflict; errorMessage.textContent = message; errorMessage.hidden = !message || session.conflict; }
    async function safeAsync(fn) { try { await fn(); localError = ""; } catch (error) { localError = error.message; } updateStatus(); }
    function dispose(n) { for (const t of n.querySelectorAll("textarea")) detachAutoComplete(t); }
    function releaseActive() { if (!active) return; active.commit?.(); active = null; if (virtual) virtual.pinned = null; }
    function refresh() {
        if (refreshing) return;
        itemMap = new Map(doc().catalog.items.map(i => [i.id, i])); updateStatus();
        if (virtual && (mode === "items" || mode === "results")) { virtual.set(entries(), true); syncBadges(); }
        else if (mode === "sets" && !content.contains(document.activeElement)) render();
    }
    function scheduleRefresh() { clearTimeout(saveTimer); saveTimer = setTimeout(refresh, 80); }
    function wildcardButton(area, { commit, current, inline = false } = {}) {
        const control = btn("＋ ワイルドカード", async () => {
            const target = inline ? active : null;
            if (inline && target?.edit !== area) return;
            if (target) target.picker = true;
            await openWildcardPicker(area, {
                isCurrent: () => area.isConnected && (!inline || active === target) && current(),
                onInsert: () => { commit(); updateStatus(); },
                onError: message => { localError = message; updateStatus(); },
                onClose: () => { if (target) target.picker = false; if (area.isConnected && (!inline || active === target)) area.focus({ preventScroll: true }); },
            });
        }, "se-wildcard");
        control.title = "ワイルドカードファイルを検索してカーソル位置へ挿入";
        control.addEventListener("pointerdown", event => event.preventDefault());
        if (inline) control.addEventListener("blur", event => {
            if (active?.edit === area && !active.picker && event.relatedTarget !== area) { releaseActive(); refresh(); }
        });
        return control;
    }
    function entries() {
        if (mode === "items") {
            let ids = null; const r = doc().recipes.find(r => r.id === pref.recipeFilter); if (r) ids = new Set(r.groups.flatMap(g => g.item_ids));
            const q = pref.query.trim().toLocaleLowerCase();
            const values = doc().catalog.items.filter(i => (!ids || ids.has(i.id)) && (!pref.tag || i.tags.includes(pref.tag)) && (!q || `${i.name}\n${i.text}\n${i.tags.join(" ")}`.toLocaleLowerCase().includes(q)));
            return sortItems(values).map(i => ({ key: i.id, itemId: i.id, height: Math.max(76, 28 + pref.lines * 23) }));
        }
        const list = []; const q = pref.query.trim().toLocaleLowerCase();
        for (const [ri, r] of (result?.rows ?? []).entries()) {
            if (resultRecipe && r.recipe_id !== resultRecipe) continue;
            list.push({ key: `r:${ri}`, section: true, title: r.name, subtitle: r.on ? "テキストセット" : "無効・出力なし", height: 52 });
            for (const [gi, g] of (r.groups ?? []).entries()) {
                const key = `g:${ri}:${gi}`; const snapshots = g.items ?? []; const chosen = new Set(g.item_ids ?? snapshots.map(i => i.id));
                list.push({ key, section: true, title: g.name || "構成要素", subtitle: !r.on || !g.on ? "無効・出力なし" : g.mode === "random" ? `ランダム・候補${g.candidate_ids?.length ?? 0}件から${snapshots.length}件選択` : `すべて使用・${snapshots.length}件`, candidates: g, height: 52 });
                const values = snapshots.map((snapshot, i) => ({ key: `${key}:${i}`, itemId: snapshot.id, snapshot, height: Math.max(90, 28 + pref.lines * 23) }));
                if (showCandidates.has(key)) for (const id of g.candidate_ids ?? []) if (!chosen.has(id)) { const item = itemMap.get(id); if (item) values.push({ key: `${key}:candidate:${id}`, itemId: id, candidate: true, height: 90 }); }
                list.push(...sortItems(values.filter(e => { const i = itemMap.get(e.itemId) ?? e.snapshot; return (!pref.tag || i?.tags?.includes(pref.tag)) && (!q || `${i?.name ?? ""}\n${i?.text ?? ""}`.toLocaleLowerCase().includes(q)); }), e => itemMap.get(e.itemId) ?? e.snapshot));
            }
        }
        return list;
    }
    function syncBadges() { if (!virtual) return; for (const [key, n] of virtual.nodes) { const entry = virtual.entries.find(e => e.key === key); if (!entry?.snapshot) continue; const current = itemMap.get(entry.itemId); const badge = n.querySelector(".se-badge"); if (badge) badge.textContent = !current ? "削除済み・編集できません" : current.text !== entry.snapshot.text || current.name !== entry.snapshot.name ? "編集済み・次回実行に反映" : "実行時の内容"; } }
    function expandedEditor(id) {
        const item = itemMap.get(id); if (!item) return;
        let area;
        showDialog({ title: `${item.name || "アイテム"} — 本文編集`, className: "sax-shared-expanded", width: 1000, maxHeight: "90vh", build(dlg, end) {
            area = el("textarea"); area.style.height = "65vh"; area.value = item.text; area.setAttribute("aria-label", "アイテム本文（拡大）"); const historyKey = newId(); let composing = false; area.addEventListener("compositionstart", () => { composing = true; }); area.addEventListener("input", () => { if (!composing) putItem(id, { text: area.value }, historyKey); }); area.addEventListener("compositionend", () => { composing = false; putItem(id, { text: area.value }, historyKey); }); attachAutoComplete(area);
            dlg.append(row(el("span", "se-muted se-grow", "共有カタログへ自動保存"), wildcardButton(area, { commit: () => putItem(id, { text: area.value }, historyKey), current: () => doc().catalog.items.some(i => i.id === id) })), area, btn("閉じる", end)); queueMicrotask(() => area.focus());
        }, onClose() { detachAutoComplete(area); refresh(); } });
    }
    function itemRow(entry) {
        if (entry.section) {
            const n = el("div", "se-section"); n.append(el("strong", "", entry.title), el("span", "se-muted", entry.subtitle));
            if (entry.candidates) n.append(btn(showCandidates.has(entry.key) ? "候補を隠す" : "候補を表示", () => { releaseActive(); if (showCandidates.has(entry.key)) showCandidates.delete(entry.key); else showCandidates.add(entry.key); virtual.set(entries(), true); }));
            return n;
        }
        const current = itemMap.get(entry.itemId); const shown = current ?? entry.snapshot;
        const n = el("div", "se-record"); n.dataset.itemId = entry.itemId; n.style.setProperty("--se-lines", pref.lines);
        const selection = mode === "items" ? check(selected.has(entry.itemId), yes => { if (yes) selected.add(entry.itemId); else selected.delete(entry.itemId); updateBulk(); }) : el("span", "se-muted", entry.candidate ? "候補" : ""); selection.setAttribute("aria-label", `${shown?.name || "アイテム"}を一括操作用に選択`); n.append(selection);
        if (mode === "items") selection.addEventListener("click", e => { if (e.shiftKey && selectionAnchor) { const ids = virtual.entries.map(v => v.itemId), from = ids.indexOf(selectionAnchor), to = ids.indexOf(entry.itemId); if (from >= 0 && to >= 0) { for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) { if (selection.checked) selected.add(id); else selected.delete(id); } for (const [key, node] of virtual.nodes) { const checkbox = node.querySelector("input[type=checkbox]"); if (checkbox) checkbox.checked = selected.has(key); } updateBulk(); } } selectionAnchor = entry.itemId; });
        function cell(field, value, cls = "") {
            const c = el("div", `se-cell ${cls}`, value); c.dataset.placeholder = field === "text" ? "本文をクリックして入力" : field === "name" ? "名前" : "タグを入力";
            if (current) { c.tabIndex = 0; c.setAttribute("role", "button"); c.setAttribute("aria-label", `${field === "text" ? "本文" : field === "name" ? "名前" : "タグ"}を編集`); c.addEventListener("click", () => begin()); c.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); begin(); } }); }
            function begin() {
                releaseActive(); virtual.pinned = entry.key; n.dataset.editing = "true";
                const latest = itemMap.get(entry.itemId); if (!latest) return;
                const edit = field === "text" ? el("textarea") : el("input"); edit.setAttribute("aria-label", field === "text" ? "アイテム本文" : field === "name" ? "アイテム名" : "アイテムタグ"); edit.value = field === "tags" ? latest.tags.join(", ") : latest[field]; if (field === "name") edit.maxLength = 256;
                const historyKey = newId(); const commit = () => { let next = edit.value; try { if (field === "tags") next = parseTags(next); putItem(entry.itemId, { [field]: next }, historyKey); } catch (error) { localError = error.message; updateStatus(); } };
                let composing = false; edit.addEventListener("compositionstart", () => { composing = true; }); edit.addEventListener("compositionend", () => { composing = false; commit(); }); edit.addEventListener("input", () => { if (!composing) commit(); });
                edit.addEventListener("keydown", e => { if (e.defaultPrevented) return; if ((e.key === "Enter" && field !== "text") || (e.key === "Escape" && !composing)) { e.preventDefault(); edit.blur(); } });
                let pickerButton;
                edit.addEventListener("blur", event => { if (active?.edit !== edit || active.picker || event.relatedTarget === pickerButton) return; commit(); active = null; virtual.pinned = null; refresh(); });
                c.replaceWith(edit); active = { edit, commit, picker: false };
                if (field === "text") {
                    attachAutoComplete(edit);
                    pickerButton = wildcardButton(edit, { commit, inline: true, current: () => doc().catalog.items.some(i => i.id === entry.itemId) });
                    edit.after(pickerButton);
                }
                edit.focus(); edit.setSelectionRange?.(edit.value.length, edit.value.length);
            }
            return c;
        }
        n.append(cell("name", shown?.name ?? ""));
        const textWrap = el("div"); textWrap.append(cell("text", shown?.text ?? ""));
        if (entry.snapshot) { textWrap.append(el("span", "se-badge", !current ? "削除済み・編集できません" : current.text !== entry.snapshot.text || current.name !== entry.snapshot.name ? "編集済み・次回実行に反映" : "実行時の内容")); const details = el("details"); details.append(el("summary", "se-muted", "実行時の本文"), el("div", "se-cell", entry.snapshot.text)); textWrap.append(details); }
        n.append(textWrap, cell("tags", shown?.tags?.join(", ") ?? "", "se-tags"));
        const tools = el("div", "se-tools"); if (current) { tools.append(btn("拡大", () => { releaseActive(); expandedEditor(entry.itemId); })); const tags = btn("タグ", () => { const value = input(current.tags.join(", "), () => {}); value.setAttribute("aria-label", "アイテムタグ"); showDialog({ title: "タグを編集", build(dlg, end) { dlg.append(value, btn("反映", () => { try { putItem(entry.itemId, { tags: parseTags(value.value) }); end(); } catch (error) { localError = error.message; updateStatus(); } })); } }); }); tags.classList.add("se-mobile-tags"); tools.append(tags); } n.append(tools); return n;
    }
    let bulkBar, selectAllControl;
    function updateBulk() {
        if (bulkBar) { bulkBar.firstChild.textContent = `${selected.size}件選択`; bulkBar.hidden = !selected.size; }
        if (selectAllControl && virtual) { const ids = virtual.entries.map(e => e.itemId); const count = ids.filter(id => selected.has(id)).length; selectAllControl.checked = Boolean(ids.length) && count === ids.length; selectAllControl.indeterminate = count > 0 && count < ids.length; }
    }
    function filters() {
        const q = input(pref.query, value => { pref.query = value; releaseActive(); scheduleRefresh(); }); q.placeholder = "名前・本文を検索"; q.className = "se-grow";
        const tags = [...new Set(doc().catalog.items.flatMap(i => i.tags))].sort(); const tag = select([["", "タグ：すべて"], ...tags.map(t => [t, t])], pref.tag, value => { pref.tag = value; releaseActive(); refresh(); });
        const sets = [["", "セット：すべて"], ...doc().recipes.map(r => [r.id, r.name])];
        const set = select(sets, mode === "results" ? resultRecipe : pref.recipeFilter, value => { releaseActive(); if (mode === "results") resultRecipe = value; else pref.recipeFilter = value; refresh(); });
        const lines = select([["1", "本文1行"], ["3", "本文3行"], ["6", "本文6行"]], String(pref.lines), value => { releaseActive(); pref.lines = Number(value); virtual.heights.clear(); refresh(); });
        const bar = row(q, tag, set, lines, sortControl(refresh)); bar.classList.add("se-filterbar"); return bar;
    }
    function renderList() {
        const filterBar = filters(); content.append(filterBar);
        if (mode === "items") {
            const newItem = btn("＋ アイテム", () => { const item = { id: newId(), name: "新しいアイテム", text: "", tags: [] }; if (mutate([{ type: "item.put", item }])) { pref.query = ""; pref.tag = ""; pref.recipeFilter = ""; render(); const index = virtual.entries.findIndex(e => e.itemId === item.id); virtual.scroll.scrollTop = virtual.index.offsets[index]; virtual.paint(); virtual.nodes.get(item.id)?.querySelector('[aria-label="名前を編集"]')?.click(); } });
            const tagEdit = input("", () => {}); tagEdit.placeholder = "一括操作するタグ";
            filterBar.append(newItem);
            bulkBar = row(el("span", "se-muted", `${selected.size}件選択`), btn("選択解除", () => { selected.clear(); virtual.set(entries(), true); updateBulk(); }), tagEdit,
                btn("タグ追加", () => bulkTags(tagEdit.value, true)), btn("タグ削除", () => bulkTags(tagEdit.value, false)), btn("削除", async () => { if (!selected.size) return; if (await showConfirmDialog({ title: "アイテムを削除", message: `${selected.size}件を削除します。すべてのセットの候補からも除かれます。`, danger: true, okLabel: "削除" })) { mutate([...selected].map(id => ({ type: "item.delete", id }))); selected.clear(); refresh(); updateBulk(); } }));
            bulkBar.hidden = !selected.size;
            content.append(bulkBar);
        } else {
            const meta = el("div", "se-muted", result ? `カタログ改訂 ${result.revision ?? result.catalog_revision ?? "—"} · Seed ${result.seed ?? "—"} · 本文の修正は次回実行に反映` : "まだ実行結果がありません。ワークフローを実行してください。");
            content.append(row(meta, btn(outputTab ? "アイテム一覧" : "出力テキスト", () => { outputTab = !outputTab; render(); })));
            if (outputTab) { const text = el("textarea", "se-result-text"); text.readOnly = true; text.value = result?.text ?? ""; content.append(text, btn("コピー", async () => { try { await navigator.clipboard.writeText(text.value); } catch { text.focus(); text.select(); localError = "選択したテキストをCtrl+Cでコピーしてください"; updateStatus(); } })); return; }
        }
        const columns = el("div", "se-columns"); for (const [name, cls] of [["", ""], ["名前", ""], ["本文（クリックして編集）", ""], ["タグ", "se-tags"], ["", ""]]) columns.append(el("span", cls, name)); content.append(columns);
        selectAllControl = null;
        if (mode === "items") { selectAllControl = check(false, yes => { selected = yes ? new Set(entries().map(e => e.itemId)) : new Set(); virtual.set(entries(), true); updateBulk(); }); selectAllControl.setAttribute("aria-label", "表示中のアイテムを全選択"); columns.firstChild.replaceWith(selectAllControl); }
        const scroll = el("div", "se-scroll"); content.append(scroll); virtual = new VirtualRows(scroll, itemRow, dispose); virtual.set(entries()); scroll.scrollTop = pref.scroll; scroll.addEventListener("scroll", () => { pref.scroll = scroll.scrollTop; }); virtual.paint();
        if (!virtual.entries.length) virtual.canvas.append(el("div", "se-empty", mode === "items" ? "該当するアイテムがありません。検索・絞り込みを変更するか、アイテムを追加してください。" : "表示する実行結果がありません。"));
        updateBulk();
    }
    function bulkTags(value, add) { try { const tags = parseTags(value); mutate([...selected].map(id => itemMap.get(id)).filter(Boolean).map(item => ({ type: "item.put", item: { ...item, tags: add ? [...new Set([...item.tags, ...tags])] : item.tags.filter(t => !tags.includes(t)) } }))); } catch (error) { localError = error.message; updateStatus(); } }
    function editGroup(groupId, change) { const r = recipe(); if (!r) return; const next = structuredClone(r); const g = next.groups.find(g => g.id === groupId); if (!g) return; change(g, next); putRecipe(next); }
    function renderSets() {
        const r = recipe(); if (r) pref.recipeId = r.id;
        const setSelect = select(doc().recipes.map(s => [s.id, s.name]), r?.id ?? "", value => { pref.recipeId = value; candidateGroup = null; candidateSelection.clear(); candidatesOnly = false; candidateAnchor = null; render(); });
        const create = () => { const next = { id: newId(), name: "新しいテキストセット", groups: [] }; if (putRecipe(next)) { pref.recipeId = next.id; render(); } };
        content.append(row(el("strong", "", "テキストセット"), setSelect, btn("＋ 作成", create), btn("コピー", () => { if (!r) return; const next = structuredClone(r); next.id = newId(); next.name += " コピー"; for (const g of next.groups) g.id = newId(); if (putRecipe(next)) { pref.recipeId = next.id; render(); } }), btn("削除", async () => { if (r && await showConfirmDialog({ title: "テキストセットを削除", message: `${r.name}を共有カタログから削除します。参照しているワークフローではセットの選び直しが必要です。`, danger: true, okLabel: "削除" })) { mutate([{ type: "recipe.delete", id: r.id }]); pref.recipeId = null; render(); } })));
        if (!r) { content.append(el("div", "se-empty", "「＋ 作成」でテキストセットを作成してください。")); return; }
        const name = input(r.name, value => { const next = structuredClone(recipe()); next.name = value; putRecipe(next); }); name.maxLength = 256; name.className = "se-grow"; name.setAttribute("aria-label", "セット名");
        const meta = content.lastChild; meta.classList.add("se-set-meta"); meta.insertBefore(name, meta.children[2]);
        const layout = el("div", "se-layout"), left = el("div", "se-pane"), right = el("div", "se-pane"); layout.append(left, right); content.append(layout);
        left.append(el("strong", "", candidateGroup ? `「${r.groups.find(g => g.id === candidateGroup)?.name || "構成要素"}」の候補を変更` : "追加するアイテムを選択"));
        const q = input(candidateQuery, value => { candidateQuery = value; renderCandidates(); }); q.placeholder = "名前・本文・タグを検索"; q.className = "se-grow";
        const tag = select([["", "タグ：すべて"], ...[...new Set(doc().catalog.items.flatMap(i => i.tags))].sort().map(t => [t, t])], candidateTag, value => { candidateTag = value; renderCandidates(); });
        const filter = row(q, tag, sortControl(() => renderCandidates())); filter.classList.add("se-filterbar"); left.append(filter);
        const scroll = el("div", "se-scroll se-candidate-scroll"); left.append(scroll);
        function chooseCandidate(id, yes, range = false) {
            const entries = candidateVirtual.entries;
            const from = entries.findIndex(e => e.itemId === candidateAnchor), to = entries.findIndex(e => e.itemId === id);
            const ids = range && from >= 0 && to >= 0 ? entries.slice(Math.min(from, to), Math.max(from, to) + 1).map(e => e.itemId) : [id];
            for (const itemId of ids) { if (yes) candidateSelection.add(itemId); else candidateSelection.delete(itemId); }
            candidateAnchor = id; renderCandidates();
        }
        const candidateVirtual = new VirtualRows(scroll, entry => {
            const i = itemMap.get(entry.itemId), n = el("div", "se-candidate"); n.dataset.itemId = i.id;
            const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = candidateSelection.has(i.id); checkbox.setAttribute("aria-label", `${i.name}を候補に選択`);
            checkbox.addEventListener("click", event => chooseCandidate(i.id, checkbox.checked, event.shiftKey));
            n.dataset.selected = String(candidateSelection.has(i.id));
            const copy = el("div", "se-candidate-copy"), title = el("span", "", i.name), body = el("span", "se-muted", i.text.replace(/\s+/g, " "));
            title.title = i.name; body.title = i.text; copy.append(title, body);
            const tags = el("span", "se-muted se-candidate-tags", i.tags.join(", ")); tags.title = tags.textContent;
            n.append(checkbox, copy, tags); n.addEventListener("click", event => { if (!event.target.closest("input")) chooseCandidate(i.id, !candidateSelection.has(i.id), event.shiftKey); });
            return n;
        });
        virtual = candidateVirtual;
        const renderCandidates = () => {
            const query = candidateQuery.trim().toLocaleLowerCase();
            candidateVirtual.set(sortItems(doc().catalog.items.filter(i => (!candidatesOnly || candidateSelection.has(i.id)) && (!candidateTag || i.tags.includes(candidateTag)) && (!query || `${i.name} ${i.text} ${i.tags.join(" ")}`.toLocaleLowerCase().includes(query)))).map(i => ({ key: i.id, itemId: i.id, height: 48 })));
            for (const [id, n] of candidateVirtual.nodes) { n.querySelector("input").checked = candidateSelection.has(id); n.dataset.selected = String(candidateSelection.has(id)); }
            count.textContent = `${candidateSelection.size}件選択`; matched.textContent = `${candidateVirtual.entries.length}件一致`;
        };
        const count = el("strong"), matched = el("span", "se-muted"); count.title = "Shift+クリックで範囲選択。検索・タグを変更しても選択は保持されます";
        const selectionbar = row(count, label("選択済みだけ", check(candidatesOnly, yes => { candidatesOnly = yes; renderCandidates(); })), matched); selectionbar.classList.add("se-selectionbar"); left.insertBefore(selectionbar, scroll);
        const selectAll = btn("一覧を全選択", () => { for (const e of candidateVirtual.entries) candidateSelection.add(e.itemId); renderCandidates(); }); selectAll.title = "検索・タグに一致する全件を選択（画面外の行も含む）";
        left.append(row(selectAll, btn("一覧の選択を解除", () => { for (const e of candidateVirtual.entries) candidateSelection.delete(e.itemId); renderCandidates(); }), btn("すべて解除", () => { candidateSelection.clear(); renderCandidates(); })));
        let chosenMode = "all", chosenCount = 1; const edited = r.groups.find(g => g.id === candidateGroup); if (edited) { chosenMode = edited.mode; chosenCount = edited.count; }
        const unit = el("span", "se-muted", "件");
        const modeSelect = select([["all", "すべて使う"], ["random", "ランダム"]], chosenMode, value => { chosenMode = value; number.hidden = unit.hidden = value !== "random"; }); const number = input(chosenCount, value => { chosenCount = Number(value); }, "number"); number.min = "0"; number.max = "10000"; number.step = "1"; number.style.width = "60px"; number.hidden = unit.hidden = chosenMode !== "random";
        left.append(row(modeSelect, number, unit, btn(candidateGroup ? "候補を更新" : "選んだアイテムを追加", () => {
            if (!candidateSelection.size) { localError = "候補アイテムを選択してください"; updateStatus(); return; }
            if (chosenMode === "random" && (!Number.isSafeInteger(chosenCount) || chosenCount < 0 || chosenCount > candidateSelection.size)) { localError = "ランダム件数は候補数以下の整数にしてください"; updateStatus(); return; }
            const next = structuredClone(recipe());
            const previous = next.groups.find(g => g.id === candidateGroup)?.item_ids ?? [];
            const ids = previous.filter(id => candidateSelection.has(id));
            const included = new Set(ids);
            for (const item of doc().catalog.items) if (candidateSelection.has(item.id) && !included.has(item.id)) ids.push(item.id);
            if (candidateGroup) { const g = next.groups.find(g => g.id === candidateGroup); if (g) Object.assign(g, { item_ids: ids, mode: chosenMode, count: chosenCount }); }
            else next.groups.push({ id: newId(), name: "構成要素", on: true, mode: chosenMode, count: chosenCount, item_ids: ids });
            if (putRecipe(next)) { candidateSelection.clear(); candidateGroup = null; candidatesOnly = false; candidateAnchor = null; render(); }
        }, "se-primary"), ...(candidateGroup ? [btn("キャンセル", () => { candidateGroup = null; candidateSelection.clear(); candidatesOnly = false; render(); })] : [])));
        right.append(el("strong", "", `構成要素 ${r.groups.length}件（上から出力）`)); const groups = el("div", "se-scroll se-group-scroll"); right.append(groups);
        let dragged = null;
        for (const [index, g] of r.groups.entries()) {
            const card = el("div", "se-card"); card.dataset.off = !g.on; card.draggable = true; card.addEventListener("dragstart", e => { if (e.target.closest("input,select,button")) { e.preventDefault(); return; } dragged = g.id; }); card.addEventListener("dragover", e => e.preventDefault()); card.addEventListener("drop", e => { e.preventDefault(); if (!dragged || dragged === g.id) return; const next = structuredClone(recipe()); const from = next.groups.findIndex(v => v.id === dragged), to = next.groups.findIndex(v => v.id === g.id); const [moved] = next.groups.splice(from, 1); next.groups.splice(to, 0, moved); putRecipe(next); render(); });
            const groupName = input(g.name, value => editGroup(g.id, next => { next.name = value; })); groupName.className = "se-grow"; groupName.maxLength = 256;
            card.dataset.editing = String(candidateGroup === g.id);
            groupName.setAttribute("aria-label", `構成要素 ${index + 1}の名前`);
            const icon = (text, title, fn) => { const control = btn(text, fn, "se-group-icon"); control.title = title; control.setAttribute("aria-label", title); return control; };
            const enabled = check(g.on, yes => { editGroup(g.id, next => { next.on = yes; }); card.dataset.off = !yes; }); enabled.setAttribute("aria-label", `構成要素 ${index + 1}を使用`);
            card.append(row(el("span", "se-muted", "≡"), enabled, groupName, icon("↑", "構成要素を上へ", () => moveGroup(g.id, -1)), icon("↓", "構成要素を下へ", () => moveGroup(g.id, 1)), icon("×", "構成要素を削除", () => { const next = structuredClone(recipe()); next.groups = next.groups.filter(v => v.id !== g.id); putRecipe(next); render(); })));
            const groupMode = select([["all", "すべて使う"], ["random", "ランダム"]], g.mode, value => { editGroup(g.id, next => { next.mode = value; }); render(); });
            const amount = input(g.count, value => { const count = Number(value); if (Number.isSafeInteger(count) && count >= 0 && count <= g.item_ids.length) editGroup(g.id, next => { next.count = count; }); else { localError = "ランダム件数は候補数以下の整数にしてください"; updateStatus(); } }, "number"); amount.style.width = "52px"; amount.min = "0"; amount.max = String(g.item_ids.length); amount.step = "1"; amount.hidden = g.mode !== "random"; amount.setAttribute("aria-label", `構成要素 ${index + 1}のランダム件数`);
            const preview = el("span", "se-muted se-group-preview", g.item_ids.slice(0, 4).map(id => itemMap.get(id)?.name ?? "削除済み").join("、"));
            preview.title = "候補を変更で全候補を一覧表示";
            const orderButton = btn("出力順", () => { orderGroup = orderGroup === g.id ? null : g.id; orderScroll = 0; render(); }); orderButton.setAttribute("aria-expanded", String(orderGroup === g.id)); orderButton.title = "候補アイテムの出力順を並び替え";
            card.append(row(groupMode, amount, el("span", "se-muted", `${g.item_ids.length}候補`), preview, orderButton, btn("候補を変更", () => { candidateGroup = g.id; candidateSelection = new Set(g.item_ids); candidatesOnly = true; candidateAnchor = null; candidateQuery = ""; candidateTag = ""; render(); })));
            if (orderGroup === g.id) renderOrder(card, g);
            card.setAttribute("aria-label", `構成要素 ${index + 1}`); groups.append(card);
        }
        if (!r.groups.length) groups.append(el("div", "se-empty", "左側でアイテムを選び、「選んだアイテムを追加」で構成要素を作ります。")); renderCandidates();
        scroll.scrollTop = setScroll.candidates; candidateVirtual.paint(); groups.scrollTop = setScroll.groups;
    }
    function moveCandidate(groupId, itemId, target) {
        const keyboard = document.activeElement?.classList.contains("se-order-handle");
        const next = structuredClone(recipe()), group = next.groups.find(g => g.id === groupId);
        if (!group || !Number.isSafeInteger(target)) return;
        const from = group.item_ids.indexOf(itemId), to = Math.max(0, Math.min(group.item_ids.length - 1, target));
        if (from < 0 || from === to) return;
        const [id] = group.item_ids.splice(from, 1); group.item_ids.splice(to, 0, id);
        if (putRecipe(next)) {
            render();
            if (keyboard) {
                const scroll = content.querySelector(".se-order-scroll"), list = orderLists[0];
                if (scroll && list) {
                    if (to * 42 < scroll.scrollTop || (to + 1) * 42 > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = to * 42;
                    list.paint(); list.nodes.get(itemId)?.querySelector(".se-order-handle")?.focus({ preventScroll: true });
                }
            }
        }
    }
    function renderOrder(card, group) {
        const scroll = el("div", "se-scroll se-order-scroll"); scroll.style.height = `${Math.min(240, group.item_ids.length * 42)}px`; card.append(scroll);
        let dragged = null;
        const list = new VirtualRows(scroll, entry => {
            const item = itemMap.get(entry.itemId), n = el("div", "se-order-item"); n.dataset.itemId = entry.itemId;
            const control = (text, title, callback) => { const b = btn(text, callback, "se-group-icon"); b.title = title; b.setAttribute("aria-label", title); return b; };
            const handle = control("≡", "アイテムをドラッグで並び替え", () => {}); handle.classList.add("se-order-handle"); handle.draggable = true;
            handle.addEventListener("dragstart", event => { event.stopPropagation(); dragged = entry.itemId; list.pinned = entry.itemId; event.dataTransfer?.setData("text/plain", entry.itemId); });
            handle.addEventListener("dragend", () => { dragged = null; list.pinned = null; for (const row of list.nodes.values()) delete row.dataset.drop; });
            handle.addEventListener("keydown", event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveCandidate(group.id, entry.itemId, entry.index + (event.key === "ArrowUp" ? -1 : 1)); } });
            n.addEventListener("dragover", event => { if (!dragged) return; event.preventDefault(); n.dataset.drop = "true"; });
            n.addEventListener("dragleave", () => { delete n.dataset.drop; });
            n.addEventListener("drop", event => { if (!dragged) return; event.preventDefault(); event.stopPropagation(); const id = dragged; dragged = null; moveCandidate(group.id, id, entry.index); });
            const position = el("input"); position.type = "number"; position.min = "1"; position.max = String(group.item_ids.length); position.value = entry.index + 1; position.setAttribute("aria-label", `${item?.name || "削除済みアイテム"}の出力位置`);
            const commit = () => { const target = Number(position.value); if (position.value && Number.isSafeInteger(target) && target >= 1 && target <= group.item_ids.length) moveCandidate(group.id, entry.itemId, target - 1); else position.value = entry.index + 1; };
            position.addEventListener("change", commit); position.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); commit(); } });
            const copy = el("div", "se-candidate-copy"), name = el("span", "", item?.name || "削除済みアイテム"), text = el("span", "se-muted", item?.text.replace(/\s+/g, " ") || ""); name.title = item?.name || entry.itemId; text.title = item?.text || ""; copy.append(name, text);
            const up = control("↑", "アイテムを上へ", () => moveCandidate(group.id, entry.itemId, entry.index - 1)), down = control("↓", "アイテムを下へ", () => moveCandidate(group.id, entry.itemId, entry.index + 1));
            up.disabled = entry.index === 0; down.disabled = entry.index === group.item_ids.length - 1;
            n.append(handle, position, copy, up, down); return n;
        });
        orderLists.push(list); list.set(group.item_ids.map((id, index) => ({ key: id, itemId: id, index, height: 42 })));
        scroll.addEventListener("dragover", event => { if (!dragged) return; event.preventDefault(); const bounds = scroll.getBoundingClientRect(); if (event.clientY < bounds.top + 28) scroll.scrollTop -= 20; else if (event.clientY > bounds.bottom - 28) scroll.scrollTop += 20; list.paint(); });
        scroll.scrollTop = orderScroll; list.paint();
    }
    function moveGroup(id, offset) { const next = structuredClone(recipe()); const from = next.groups.findIndex(g => g.id === id), to = from + offset; if (to < 0 || to >= next.groups.length) return; [next.groups[from], next.groups[to]] = [next.groups[to], next.groups[from]]; putRecipe(next); render(); }
    function render() {
        const order = content.querySelector(".se-order-scroll"); if (order) orderScroll = order.scrollTop;
        for (const list of orderLists.splice(0)) list.destroy();
        if (mode === "sets") {
            const candidates = content.querySelector(".se-candidate-scroll"), groups = content.querySelector(".se-group-scroll");
            if (candidates) setScroll.candidates = candidates.scrollTop;
            if (groups) setScroll.groups = groups.scrollTop;
        }
        refreshing = true; releaseActive(); virtual?.destroy(); virtual = null; bulkBar = null; selectAllControl = null; content.replaceChildren(); itemMap = new Map(doc().catalog.items.map(i => [i.id, i]));
        content.classList.toggle("se-list-view", mode !== "sets");
        content.classList.toggle("se-set-view", mode === "sets");
        if (mode === "sets") renderSets(); else renderList(); updateStatus(); refreshing = false;
    }
    const switchMode = next => { releaseActive(); pref.scroll = 0; pref.query = ""; pref.tag = ""; mode = next; render(); };
    close = showDialog({ title: `SAX Text Catalog V2 — ${doc().name}`, width: 1200, maxHeight: "97vh", className: "sax-shared-editor", onClose() {
        for (const list of orderLists.splice(0)) list.destroy();
        releaseActive(); clearTimeout(saveTimer); unsubscribe?.(); virtual?.destroy(); for (const t of content?.querySelectorAll("textarea") ?? []) detachAutoComplete(t); openEditors.delete(session); void session.flush().catch(() => {});
    }, build(dlg, end) {
        dlg.children[0].style.display = "none";
        const style = el("style"); style.textContent = STYLE; dlg.append(style);
        status = row(el("span"), btn("保存を再試行", () => safeAsync(() => session.retry()))); status.classList.add("se-status", "se-muted");
        const title = el("strong", "", doc().name); title.title = `SAX Text Catalog V2 — ${doc().name}`;
        const header = row(title, btn("アイテム", () => switchMode("items")), btn("テキストセット", () => switchMode("sets")), ...(result ? [btn("前回の実行結果", () => switchMode("results"))] : []), status, btn("元に戻す", () => { releaseActive(); session.undo(); render(); }), btn("やり直す", () => { releaseActive(); session.redo(); render(); }), btn("閉じる", end)); header.classList.add("se-header");
        errorMessage = el("div", "se-error se-error-message"); errorMessage.setAttribute("role", "alert"); errorMessage.hidden = true;
        conflict = row(el("span", "", "他の編集と競合しています。編集内容を保持しています。"), btn("最新を読み込み", async () => { if (await showConfirmDialog({ title: "最新データを読み込み", message: "この画面の未保存の編集を取り消し、保存済みの最新データを読み込みます。", okLabel: "読み込み" })) await safeAsync(() => session.reload()); render(); }), btn("最新に編集を再適用", () => safeAsync(() => session.reapply()))); conflict.classList.add("se-conflict"); conflict.hidden = true;
        dlg.append(header, errorMessage, conflict); content = el("div", "se-pane"); content.style.flex = "1"; dlg.append(content); render();
    } });
    unsubscribe = session.subscribe(() => { updateStatus(); scheduleRefresh(); });
    openEditors.set(session, { close, open(next) { if (next.result) result = next.result; if (next.recipeId) { if (next.mode === "items") { pref.recipeFilter = next.recipeId; pref.query = ""; pref.tag = ""; pref.scroll = 0; } else pref.recipeId = next.recipeId; } if (next.mode && next.mode !== mode) { pref.query = ""; pref.tag = ""; pref.scroll = 0; } mode = next.mode ?? mode; render(); close.show(); } });
    return close;
}
