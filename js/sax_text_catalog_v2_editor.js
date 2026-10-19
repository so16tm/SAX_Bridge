import { showDialog, showConfirmDialog } from "./sax_ui_base.js";
import { LIMITS, candidateWeight, parseSelectionWeight, parseRandomCount, formatRandomCount, sortedNamedOptions, newId, parseTags, itemTagSortKeys, compareItemTagKeys, walkGroups, groupItemIds, itemUsage, deletionImpact, normalizeSearch, searchTokens, matchesSearch, tagsError } from "./sax_text_catalog_v2_model.js";
import { attachAutoComplete, detachAutoComplete } from "./sax_text_autocomplete.js";
import { openWildcardPicker } from "./sax_text_catalog_v2_wildcards.js";

const preferences = new WeakMap();
const openEditors = new WeakMap();

function locateGroup(groups, id, parentId = "") {
    for (const [index, group] of groups.entries()) {
        if (group.id === id) return { group, siblings: groups, index, parentId };
        if (group.kind === "nested") { const found = locateGroup(group.groups, id, group.id); if (found) return found; }
    }
    return null;
}

function visibleGroups(groups, collapsed = new Set(), depth = 0) {
    return groups.flatMap(group => [{ group, depth }, ...(group.kind === "nested" && !collapsed.has(group.id) ? visibleGroups(group.groups, collapsed, depth + 1) : [])]);
}
const STYLE = `
.sax-shared-affix input{width:100%;font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:6px 8px}.sax-shared-affix label{display:flex;flex-direction:column;gap:4px;font-size:12px}.sax-shared-affix pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:8px;border:1px solid var(--border-color,#45454b);border-radius:6px;max-height:140px;overflow:auto}
.sax-shared-editor *{box-sizing:border-box}.sax-shared-editor [hidden]{display:none!important}.sax-shared-editor .se-mobile-tags{display:none}.sax-shared-editor>div{width:97vw!important;height:94vh;max-height:97vh!important;padding:16px!important;border-radius:12px!important;font-family:system-ui,sans-serif}
.sax-shared-editor button,.sax-shared-editor input,.sax-shared-editor select,.sax-shared-editor textarea{font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:7px 9px;min-width:0}.sax-shared-editor button{cursor:pointer}.sax-shared-editor button:disabled{opacity:.45;cursor:default}.sax-shared-editor :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:2px}.sax-shared-editor textarea{width:100%;resize:vertical;line-height:1.7;min-height:160px}.sax-shared-editor input[type=checkbox]{width:16px;height:16px;accent-color:var(--primary-background,#5686d6)}
.sax-shared-editor .se-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sax-shared-editor .se-grow{flex:1;min-width:110px}.sax-shared-editor .se-muted{opacity:.68;font-size:12px}.sax-shared-editor .se-error{color:var(--error-text,#ed9494);white-space:pre-wrap}.sax-shared-editor .se-status{min-height:18px}.sax-shared-editor .se-scroll{flex:1;min-height:0;overflow:auto;position:relative;scrollbar-gutter:stable;overflow-anchor:none}.sax-shared-editor .se-canvas{position:relative}.sax-shared-editor .se-record{position:absolute;left:0;right:0;display:grid;grid-template-columns:24px minmax(130px,.8fr) minmax(260px,3fr) minmax(120px,.7fr) 96px;gap:12px;padding:10px 6px;border-bottom:1px solid var(--border-color,#45454b);align-items:start}.sax-shared-editor .se-cell{border:0;background:transparent;text-align:left;cursor:text;line-height:1.7;padding:3px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--se-lines,3)}.sax-shared-editor .se-cell:hover{background:color-mix(in srgb,var(--primary-background,#5686d6) 12%,transparent);border-radius:5px}.sax-shared-editor .se-cell:empty:before{content:attr(data-placeholder);opacity:.45}.sax-shared-editor .se-record input:not([type=checkbox]){width:100%}.sax-shared-editor .se-record textarea{resize:none;min-height:200px}.sax-shared-editor .se-record[data-editing=true]{background:color-mix(in srgb,var(--primary-background,#5686d6) 8%,transparent)}.sax-shared-editor .se-tools{display:flex;flex-direction:column;gap:6px}.sax-shared-editor .se-section{position:absolute;left:0;right:0;padding:12px 8px;background:var(--comfy-input-bg,#242426);border-radius:6px;display:flex;align-items:center;gap:12px;overflow:hidden}.sax-shared-editor .se-section strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-shared-editor .se-empty{padding:24px;opacity:.7}.sax-shared-editor .se-columns{display:grid;grid-template-columns:24px minmax(130px,.8fr) minmax(260px,3fr) minmax(120px,.7fr) 96px;gap:12px;padding:0 6px;font-size:12px;opacity:.65}.sax-shared-editor .se-layout{display:grid;grid-template-columns:minmax(240px,1fr) minmax(320px,1.4fr);gap:16px;flex:1;min-height:0}.sax-shared-editor .se-pane{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}.sax-shared-editor .se-card{padding:12px;border:1px solid var(--border-color,#45454b);border-radius:8px;margin-bottom:10px}.sax-shared-editor .se-card[data-off=true]{opacity:.55}.sax-shared-editor .se-card>.se-row{margin-bottom:8px}.sax-shared-editor .se-candidate{position:absolute;left:0;right:0;height:40px;display:flex;align-items:center;gap:10px;padding:6px;border-bottom:1px solid var(--border-color,#45454b)}.sax-shared-editor .se-candidate span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-shared-editor .se-primary{background:var(--primary-background,#386cb8);color:#fff}.sax-shared-editor .se-result-text{flex:1;min-height:0;resize:none!important}.sax-shared-editor .se-badge{font-size:11px;color:var(--primary-background,#80adf2);display:block}.sax-shared-editor .se-conflict{padding:8px;border:1px solid var(--error-text,#ed9494);border-radius:6px}.sax-shared-editor details>summary{cursor:pointer}
@media(max-width:760px){.sax-shared-editor>div{padding:10px!important}.sax-shared-editor .se-layout{grid-template-columns:1fr;grid-template-rows:minmax(180px,.7fr) minmax(220px,1fr)}.sax-shared-editor .se-record,.sax-shared-editor .se-columns{grid-template-columns:20px minmax(75px,.7fr) minmax(140px,2fr) 65px;gap:6px}.sax-shared-editor .se-item-actions{flex-wrap:wrap}.sax-shared-editor .se-item-actions button{flex:1 1 28px}.sax-shared-editor .se-tags{display:none}.sax-shared-editor .se-row{gap:5px}.sax-shared-editor .se-row button{padding:6px}.sax-shared-editor .se-section .se-muted{display:none}}
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
.sax-shared-editor .se-card[data-single=true] input.se-grow{min-width:40px}
.sax-shared-editor .se-single-mode{font-size:11px;white-space:nowrap}
.sax-shared-editor .se-item-actions{display:flex;gap:4px}
.sax-shared-editor .se-item-actions button{flex:1;min-width:0;padding:4px 0;font-size:11px}.sax-shared-editor .se-item-actions .se-danger{color:var(--error-text,#ed9494)}.sax-shared-editor .se-invalid{border-color:var(--error-text,#ed9494)!important;box-shadow:0 0 0 1px var(--error-text,#ed9494)}.sax-shared-editor .se-field-error{color:var(--error-text,#ed9494);font-size:11px;line-height:15px;white-space:pre-wrap;margin:2px 0 4px}
.sax-shared-editor .se-record{gap:8px;padding:4px 6px;font-size:13px}
.sax-shared-editor .se-cell{line-height:18px;padding:2px 3px}
.sax-shared-editor .se-record button,.sax-shared-editor .se-record input:not([type=checkbox]){font-size:12px;padding:3px 5px;min-height:24px}
.sax-shared-editor .se-record textarea{font-size:13px;line-height:1.5}
.sax-shared-editor .se-item-actions button{padding:3px 0;font-size:11px;line-height:16px;white-space:nowrap}
.sax-shared-editor .se-tools{gap:4px}
.sax-shared-editor .se-section{padding:4px 8px;gap:8px;font-size:12px;min-height:32px}
.sax-shared-editor .se-section button{font-size:11px;padding:3px 6px}
.sax-shared-editor .se-columns{gap:8px}
.sax-shared-editor .se-tag-filter{position:relative;min-width:100px;max-width:180px}
.sax-shared-editor .se-tag-filter>summary{list-style:none;border:1px solid var(--border-color,#45454b);border-radius:6px;background:var(--comfy-input-bg,#242426);padding:4px 8px;font-size:12px;height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sax-shared-editor .se-tag-popup{position:absolute;top:32px;left:0;z-index:20;width:240px;max-width:80vw;padding:8px;background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;box-shadow:0 4px 12px #0006;display:flex;flex-direction:column;gap:6px}
.sax-shared-editor .se-tag-options{max-height:240px;overflow:auto}
.sax-shared-editor .se-tag-options label{flex-wrap:nowrap;gap:6px;height:24px;min-height:24px;margin:0;padding:2px 3px;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden}
.sax-shared-editor .se-tag-options input[type=checkbox]{flex:none;width:14px;height:14px;min-height:0;margin:0;padding:0}
.sax-shared-editor .se-card[data-drop=inside]{outline:2px solid var(--primary-background,#5686d6)}
.sax-shared-editor .se-card[data-drop=before]{border-top:3px solid var(--primary-background,#5686d6)}
.sax-shared-editor .se-card[data-drop=after]{border-bottom:3px solid var(--primary-background,#5686d6)}
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
// 入力欄を赤枠にし、host の直後へ理由を出す。host が null なら赤枠だけにする。エラーを表示したときは true を返す。
let fieldErrorSeq = 0;
function setFieldError(control, message, host = control) {
    control._fieldError?.remove(); control._fieldError = null;
    control.classList?.toggle("se-invalid", Boolean(message));
    if (!message) { control.removeAttribute?.("aria-invalid"); control.removeAttribute?.("aria-describedby"); return false; }
    control.setAttribute("aria-invalid", "true");
    if (host) { const note = el("div", "se-field-error", message); note.id = `se-field-error-${++fieldErrorSeq}`; note.setAttribute("role", "alert"); host.after(note); control._fieldError = note; control.setAttribute("aria-describedby", note.id); }
    return true;
}
const TEXT_INPUT_EXCLUDED = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);
function isTextEntry(target) { return Boolean(target?.isContentEditable) || target?.tagName === "TEXTAREA" || (target?.tagName === "INPUT" && !TEXT_INPUT_EXCLUDED.has(target.type)); }

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
    let pref = preferences.get(session); if (!pref) { pref = { query: "", recipeFilter: "", tags: [], lines: 3, scroll: 0, recipeId: null, sort: "name", results: { query: "", tags: [], scroll: 0 } }; preferences.set(session, pref); }
    let mode = options.mode ?? "items", result = options.result ?? null;
    if (options.recipeId) { if (mode === "items") { pref.recipeFilter = options.recipeId; pref.query = ""; pref.tags = []; pref.scroll = 0; } else pref.recipeId = options.recipeId; }
    let content, status, conflict, errorMessage, close, virtual = null, active = null, unsubscribe, localError = "", saveTimer, refreshing = false;
    let itemMap = new Map(), selected = new Set(), candidateSelection = new Set(), candidateGroup = null, candidateQuery = pref.candidateQuery ?? "", candidateTags = pref.candidateTags ?? [], resultRecipe = "", outputTab = false, selectionAnchor = null;
    let candidatesOnly = false, candidateAnchor = null, targetParent = "";
    let additionMode = "combined";
    let candidateSettings = null;
    const dismissTagFilter = event => { for (const control of content?.querySelectorAll(".se-tag-filter[open]") ?? []) if (!control.contains(event.target)) control.open = false; };
    document.addEventListener("pointerdown", dismissTagFilter, true);
    const collapsedGroups = new Set();
    const setScroll = { candidates: 0, groups: 0 };
    let orderGroup = null, orderScroll = 0;
    const orderLists = [];
    const showCandidates = new Set();
    const doc = () => session.document;
    // アイテム一覧と実行結果は検索語・タグ・スクロール位置を別々に保持する。
    const resultKey = value => value ? `${value.catalog_id}|${value.revision ?? value.catalog_revision}|${value.seed}|${value.text}` : "";
    const view = () => mode === "results" ? pref.results : pref;
    let newItemId = null;
    function sortItems(values, resolve = value => value) {
        const tagKeys = pref.sort === "tags" ? itemTagSortKeys(values.map(resolve)) : null;
        const ranks = pref.sort === "catalog" ? new Map(doc().catalog.items.map((item, index) => [item.id, index])) : null;
        const usage = pref.sort === "usage" ? itemUsage(doc().recipes) : null;
        return values.sort((a, b) => {
            const left = resolve(a), right = resolve(b);
            if (tagKeys) { const difference = compareItemTagKeys(tagKeys.get(left.id), tagKeys.get(right.id)); if (difference) return difference; }
            if (ranks) { const difference = (ranks.get(left.id) ?? Infinity) - (ranks.get(right.id) ?? Infinity); if (difference) return difference; }
            if (pref.sort === "usage") { const difference = (usage.get(right.id)?.groups ?? 0) - (usage.get(left.id)?.groups ?? 0); if (difference) return difference; }
            return left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id);
        });
    }
    const sortControl = onChange => {
        const control = select([["catalog", "登録順"], ["name", "名前順"], ["tags", "タグ順"], ["usage", "利用数順"]], pref.sort, value => { releaseActive(); pref.sort = value; onChange(); });
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
    const groupChildren = (r, parentId) => parentId ? locateGroup(r.groups, parentId)?.group.groups : r.groups;
    function relocate(r, id, parentId, beforeId = null) {
        const source = locateGroup(r.groups, id);
        if (!source || parentId === id || (source.group.kind === "nested" && locateGroup(source.group.groups, parentId))) { localError = "自分自身や配下の構成要素へは移動できません"; updateStatus(); return false; }
        const target = groupChildren(r, parentId);
        if (!target) return false;
        if (source.parentId === parentId && beforeId === id) return true;
        source.siblings.splice(source.index, 1);
        const index = beforeId ? target.findIndex(g => g.id === beforeId) : target.length;
        target.splice(index < 0 ? target.length : index, 0, source.group);
        return true;
    }
    function parentOptions(excludeId = null) {
        const excluded = excludeId ? locateGroup(recipe().groups, excludeId)?.group : null;
        const ids = new Set(excluded ? [excluded.id, ...[...walkGroups(excluded.groups ?? [])].map(g => g.id)] : []);
        return [["", "セット直下"], ...visibleGroups(recipe().groups).filter(({group}) => group.kind === "nested" && !ids.has(group.id)).map(({group, depth}) => [group.id, `${"　".repeat(depth)}${group.name || "ネスト"}`])];
    }
    function editNested(id) {
        const found = locateGroup(recipe().groups, id); if (!found) return;
        let parentId = found.parentId;
        showDialog({ title: `${found.group.name || "ネスト"} — 構成要素`, className: "sax-shared-expanded", width: 520, build(dlg, end) {
            const parent = select(parentOptions(id), parentId, value => { parentId = value; }); parent.setAttribute("aria-label", "ネストの配置先");
            dlg.append(el("p", "", "直下の構成要素をまとめて選択します。選択方式と件数は一覧の2行目で変更できます。"), row(el("span", "", "配置先"), parent), row(btn("配置先を変更", () => { const next = structuredClone(recipe()); if (locateGroup(next.groups,id)?.parentId === parentId || (relocate(next, id, parentId) && putRecipe(next))) { end(); render(); } }), btn("ここにアイテムを追加", () => { targetParent = id; candidateGroup = null; candidateSelection.clear(); candidatesOnly = false; collapsedGroups.delete(id); end(); render(); }), btn("閉じる", end)));
        } });
    }
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
            let ids = null; const r = doc().recipes.find(r => r.id === pref.recipeFilter); if (r) ids = new Set(groupItemIds(r.groups));
            const tokens = searchTokens(pref.query);
            const values = doc().catalog.items.filter(i => (!ids || ids.has(i.id)) && matchesItem(i, tokens, pref.tags));
            return sortItems(values).map(i => ({ key: i.id, itemId: i.id, height: Math.max(33, 13 + pref.lines * 18) }));
        }
        const list = []; const tokens = searchTokens(pref.results.query), resultTags = pref.results.tags;
        for (const [ri, r] of (result?.rows ?? []).entries()) {
            if (resultRecipe && r.recipe_id !== resultRecipe) continue;
            list.push({ key: `r:${ri}`, section: true, title: r.name, subtitle: r.on ? "テキストセット" : "無効・出力なし", height: 32 });
            function appendGroups(groups, prefix, depth = 0, reveal = false) {
                for (const [gi, g] of groups.entries()) {
                    const key = `${prefix}:${g.group_id ?? gi}`;
                    if (g.kind === "nested") {
                        const selected = new Set(g.selected_group_ids ?? []);
                        list.push({ key, section: true, depth, title: g.name || "ネスト", subtitle: !g.on ? "未選択・無効／出力なし" : g.mode === "random" ? `ランダム${Object.hasOwn(g,"count_min") ? formatRandomCount(g) + "件" : ""}・子${g.candidate_group_ids?.length ?? 0}件から${selected.size}件選択` : `子をすべて使用・${selected.size}件`, candidates: g, height: 32 });
                        const expanded = reveal || showCandidates.has(key);
                        appendGroups((g.groups ?? []).filter(child => expanded || selected.has(child.group_id)), key, depth + 1, expanded);
                        continue;
                    }
                    const snapshots = g.items ?? []; const chosen = new Set(g.item_ids ?? snapshots.map(i => i.id));
                    list.push({ key, section: true, depth, title: g.name || "構成要素", subtitle: !r.on || !g.on ? "未選択・無効／出力なし" : g.mode === "random" ? `ランダム${Object.hasOwn(g,"count_min") ? formatRandomCount(g) + "件" : ""}・候補${g.candidate_ids?.length ?? 0}件から${snapshots.length}件選択` : `すべて使用・${snapshots.length}件`, candidates: g, height: 32 });
                    const values = snapshots.map((snapshot, i) => ({ key: `${key}:${i}`, depth, itemId: snapshot.id, snapshot, height: Math.max(33, 13 + pref.lines * 18) + 32 }));
                    if (reveal || showCandidates.has(key)) for (const id of g.candidate_ids ?? []) if (!chosen.has(id)) { const item = itemMap.get(id); if (item) values.push({ key: `${key}:candidate:${id}`, depth, itemId: id, candidate: true, height: Math.max(33, 13 + pref.lines * 18) }); }
                    list.push(...sortItems(values.filter(e => matchesItem(itemMap.get(e.itemId) ?? e.snapshot, tokens, resultTags)), e => itemMap.get(e.itemId) ?? e.snapshot));
                }
            }
            appendGroups(r.groups ?? [], `g:${ri}`);

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
    function revealNewItem(item, resetFilters = true, selectName = false) {
        if (resetFilters) { pref.query = ""; pref.tags = []; pref.recipeFilter = ""; } render();
        newItemId = selectName ? item.id : null;
        const index = virtual.entries.findIndex(e => e.itemId === item.id);
        if (index < 0) return;
        virtual.scroll.scrollTop = virtual.index.offsets[index]; virtual.paint();
        virtual.nodes.get(item.id)?.querySelector('[aria-label="名前を編集"]')?.click();
    }
    function duplicateItem(id) {
        releaseActive();
        const original = doc().catalog.items.find(item => item.id === id); if (!original) return;
        const names = new Set(doc().catalog.items.map(item => item.name));
        let name, number = 1;
        do { const suffix = number === 1 ? " コピー" : ` コピー（${number}）`; name = [...original.name].slice(0, 256 - [...suffix].length).join("") + suffix; number++; } while (names.has(name));
        const item = { ...original, id: newId(), name, tags: [...original.tags] };
        if (mutate([{ type: "item.put", item }])) revealNewItem(item, false);
    }
    function itemRow(entry) {
        if (entry.section) {
            const n = el("div", "se-section"); n.style.paddingLeft = `${8 + (entry.depth ?? 0) * 14}px`; n.append(el("strong", "", entry.title), el("span", "se-muted", entry.subtitle));
            if (entry.candidates) n.append(btn(showCandidates.has(entry.key) ? "候補を隠す" : "候補を表示", () => { releaseActive(); if (showCandidates.has(entry.key)) showCandidates.delete(entry.key); else showCandidates.add(entry.key); virtual.set(entries(), true); }));
            return n;
        }
        const current = itemMap.get(entry.itemId); const shown = current ?? entry.snapshot;
        const n = el("div", "se-record"); n.dataset.itemId = entry.itemId; n.style.setProperty("--se-lines", pref.lines);
        const selection = current ? check(selected.has(entry.itemId), yes => { if (yes) selected.add(entry.itemId); else selected.delete(entry.itemId); updateBulk(); }) : el("span", "se-muted", "削除済み"); selection.setAttribute("aria-label", `${shown?.name || "アイテム"}を一括操作用に選択`); n.append(selection);
        if (current) selection.addEventListener("click", e => { if (e.shiftKey && selectionAnchor) { const ids = selectableIds(), from = ids.indexOf(selectionAnchor), to = ids.indexOf(entry.itemId); if (from >= 0 && to >= 0) { for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) { if (selection.checked) selected.add(id); else selected.delete(id); } updateBulk(); } } selectionAnchor = entry.itemId; });
        function cell(field, value, cls = "") {
            const c = el("div", `se-cell ${cls}`, value); c.dataset.placeholder = field === "text" ? "本文をクリックして入力" : field === "name" ? "名前" : "タグを入力";
            if (current) { c.tabIndex = 0; c.setAttribute("role", "button"); c.setAttribute("aria-label", `${field === "text" ? "本文" : field === "name" ? "名前" : "タグ"}を編集`); c.addEventListener("click", () => begin()); c.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); begin(); } }); }
            function begin() {
                releaseActive(); virtual.pinned = entry.key; n.dataset.editing = "true";
                const latest = itemMap.get(entry.itemId); if (!latest) return;
                const edit = field === "text" ? el("textarea") : el("input"); edit.setAttribute("aria-label", field === "text" ? "アイテム本文" : field === "name" ? "アイテム名" : "アイテムタグ"); edit.value = field === "tags" ? latest.tags.join(", ") : latest[field]; if (field === "name") edit.maxLength = 256;
                const historyKey = newId(); const commit = () => { let next = edit.value; try { if (field === "tags") { next = parseTags(next); if (setFieldError(edit, tagsError(next))) return; } putItem(entry.itemId, { [field]: next }, historyKey); } catch (error) { localError = error.message; updateStatus(); } };
                let composing = false; edit.addEventListener("compositionstart", () => { composing = true; }); edit.addEventListener("compositionend", () => { composing = false; commit(); }); edit.addEventListener("input", () => { if (!composing) commit(); });
                edit.addEventListener("keydown", e => {
                    if (e.defaultPrevented) return;
                    const advance = e.key === "Enter" && field !== "text" && !composing && !e.isComposing && e.keyCode !== 229;
                    if (!advance && !(e.key === "Escape" && !composing)) return;
                    e.preventDefault(); edit.blur();
                    // 名前の確定後は同じアイテムの本文編集へ進む。
                    if (advance && field === "name") virtual?.nodes.get(entry.key)?.querySelector('[aria-label="本文を編集"]')?.click();
                });
                let pickerButton;
                edit.addEventListener("blur", event => { if (active?.edit !== edit || active.picker || event.relatedTarget === pickerButton) return; commit(); active = null; virtual.pinned = null; refresh(); });
                // 欄の下へエラーを出せるよう、タグ欄だけ入力欄を包んで差し替える。
                const holder = field === "tags" ? el("div") : edit; if (holder !== edit) holder.append(edit);
                c.replaceWith(holder); active = { edit, commit, picker: false };
                if (field === "text") {
                    attachAutoComplete(edit);
                    pickerButton = wildcardButton(edit, { commit, inline: true, current: () => doc().catalog.items.some(i => i.id === entry.itemId) });
                    edit.after(pickerButton);
                }
                edit.focus();
                if (field === "name" && newItemId === entry.itemId) edit.select?.(); else edit.setSelectionRange?.(edit.value.length, edit.value.length);
                newItemId = null;
            }
            return c;
        }
        n.append(cell("name", shown?.name ?? ""));
        const textWrap = el("div"); textWrap.append(cell("text", shown?.text ?? ""));
        if (entry.candidate) textWrap.append(el("span", "se-badge", "未選択候補"));
        if (entry.snapshot) { textWrap.append(el("span", "se-badge", !current ? "削除済み・編集できません" : current.text !== entry.snapshot.text || current.name !== entry.snapshot.name ? "編集済み・次回実行に反映" : "実行時の内容")); const details = el("details"); details.append(el("summary", "se-muted", "実行時の本文"), el("div", "se-cell", entry.snapshot.text)); textWrap.append(details); }
        if (entry.snapshot?.output_text !== undefined) { const details = el("details"); details.append(el("summary", "se-muted", "出力中の該当部分（前後付与後）"), el("div", "se-cell", entry.snapshot.output_text)); textWrap.append(details); }
        n.append(textWrap, cell("tags", shown?.tags?.join(", ") ?? "", "se-tags"));
        const tools = el("div", "se-tools"); if (current) {
            const expanded = btn("拡大", () => { releaseActive(); expandedEditor(entry.itemId); });
            const actions = el("div", "se-item-actions"); actions.append(expanded);
            if (mode === "items") { const duplicate = btn("複製", () => duplicateItem(entry.itemId)); duplicate.title = "名前・本文・タグをコピーして新しいアイテムを作成"; duplicate.addEventListener("pointerdown", event => event.preventDefault()); actions.append(duplicate); const remove = btn("削除", () => deleteItems([entry.itemId]), "se-danger"); remove.title = "このアイテムを削除（使用中のセットからも外れます）"; remove.addEventListener("pointerdown", event => event.preventDefault()); actions.append(remove); }
            tools.append(mode === "items" ? actions : expanded);
            const tags = btn("タグ", () => { const value = input(current.tags.join(", "), () => {}); value.setAttribute("aria-label", "アイテムタグ"); showDialog({ title: "タグを編集", build(dlg, end) { dlg.append(value, btn("反映", () => { try { const parsed = parseTags(value.value); if (setFieldError(value, tagsError(parsed))) return; putItem(entry.itemId, { tags: parsed }); end(); } catch (error) { localError = error.message; updateStatus(); } })); } }); }); tags.classList.add("se-mobile-tags"); tools.append(tags);
        } n.append(tools); return n;
    }
    let bulkBar, bulkTagEdit, selectAllControl, selectionCount;
    function selectableIds() { return [...new Set((virtual?.entries ?? []).filter(e => !e.section && itemMap.has(e.itemId)).map(e => e.itemId))]; }
    function selectMatching(yes) {
        releaseActive(); for (const id of selectableIds()) { if (yes) selected.add(id); else selected.delete(id); } updateBulk();
    }
    function updateBulk() {
        for (const id of selected) if (!itemMap.has(id)) selected.delete(id);
        if (selectionCount) selectionCount.textContent = `${selected.size}件選択`;
        for (const node of virtual?.nodes.values() ?? []) { const checkbox = node.querySelector("input[type=checkbox]"); if (checkbox) checkbox.checked = selected.has(node.dataset.itemId); }
        if (bulkBar) { bulkBar.firstChild.textContent = `${selected.size}件選択`; bulkBar.hidden = !selected.size; if (!selected.size && bulkTagEdit) setFieldError(bulkTagEdit, ""); }
        if (selectAllControl && virtual) { const ids = selectableIds(); const count = ids.filter(id => selected.has(id)).length; selectAllControl.checked = Boolean(ids.length) && count === ids.length; selectAllControl.indeterminate = count > 0 && count < ids.length; }
    }
    function matchesItem(item, tokens, tags) {
        return tags.every(tag => item?.tags?.includes(tag)) && matchesSearch(item, tokens);
    }
    function tagFilter(getTags = () => view().tags, setTags = tags => { view().tags = tags; }, onChange = refresh) {
        const control = el("details", "se-tag-filter"), summary = el("summary"), popup = el("div", "se-tag-popup");
        summary.setAttribute("aria-label", "タグで絞り込み");
        const options = el("div", "se-tag-options");
        const tags = [...new Set([...doc().catalog.items.flatMap(i => i.tags), ...getTags()])].sort((a,b) => a.localeCompare(b,"ja"));
        const updateSummary = () => { const chosen = getTags(); summary.textContent = chosen.length ? `タグ：${chosen.join("・")} ▾` : "タグ：すべて ▾"; summary.title = chosen.length ? `すべてに一致（AND）：${chosen.join("、")}` : "複数のタグを選んで絞り込み"; };
        const search = input("", value => { const tokens = searchTokens(value); for (const option of options.children) option.hidden = !tokens.every(token => normalizeSearch(option.dataset.tag).includes(token)); }); search.placeholder = "絞り込みタグを検索";
        for (const tag of tags) {
            const checkbox = check(getTags().includes(tag), yes => { releaseActive(); setTags(yes ? [...new Set([...getTags(), tag])] : getTags().filter(value => value !== tag)); updateSummary(); onChange(); });
            checkbox.setAttribute("aria-label", `${tag}で絞り込み`);
            const option = label(tag, checkbox); option.dataset.tag = tag; option.title = tag; options.append(option);
        }
        if (!tags.length) options.append(el("span", "se-muted", "タグがありません"));
        popup.append(el("span", "se-muted", "選んだタグをすべて含む（AND）"), search, options, btn("タグ絞り込みを解除", () => { releaseActive(); setTags([]); for (const checkbox of options.querySelectorAll("input")) checkbox.checked = false; updateSummary(); onChange(); }));
        control.append(summary, popup); updateSummary();
        control.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); control.open = false; summary.focus(); } });
        control.addEventListener("focusout", event => { if (event.relatedTarget && !control.contains(event.relatedTarget)) control.open = false; });
        return control;
    }
    function filters() {
        const state = view();
        const q = input(state.query, value => { state.query = value; releaseActive(); scheduleRefresh(); }); q.placeholder = "名前・本文・タグを検索（空白区切りで AND）"; q.className = "se-grow";
        const tag = tagFilter(() => state.tags, tags => { state.tags = tags; });
        const sets = [["", "セット：すべて"], ...sortedNamedOptions(doc().recipes).map(r => [r.id, r.name])];
        const set = select(sets, mode === "results" ? resultRecipe : pref.recipeFilter, value => { releaseActive(); if (mode === "results") resultRecipe = value; else pref.recipeFilter = value; refresh(); });
        set.setAttribute("aria-label", "テキストセットで絞り込み");
        const lines = select([["1", "本文1行"], ["3", "本文3行"], ["6", "本文6行"]], String(pref.lines), value => { releaseActive(); pref.lines = Number(value); virtual.heights.clear(); refresh(); });
        const bar = row(q, tag, set, lines, sortControl(refresh)); bar.classList.add("se-filterbar"); return bar;
    }
    function renderList() {
        const filterBar = filters(); content.append(filterBar);
        if (mode === "items") {
            const newItem = btn("＋ アイテム", () => { const item = { id: newId(), name: "新しいアイテム", text: "", tags: [] }; if (mutate([{ type: "item.put", item }])) revealNewItem(item, true, true); });
            filterBar.append(newItem);
        } else {
            const meta = el("div", "se-muted", result ? `カタログ改訂 ${result.revision ?? result.catalog_revision ?? "—"} · Seed ${result.seed ?? "—"} · 本文の修正は次回実行に反映` : "まだ実行結果がありません。ワークフローを実行してください。");
            content.append(row(meta, btn(outputTab ? "アイテム一覧" : "出力テキスト", () => { outputTab = !outputTab; render(); })));
            if (outputTab) { const text = el("textarea", "se-result-text"); text.readOnly = true; text.value = result?.text ?? ""; content.append(text, btn("コピー", async () => { try { await navigator.clipboard.writeText(text.value); } catch { text.focus(); text.select(); localError = "選択したテキストをCtrl+Cでコピーしてください"; updateStatus(); } })); return; }
        }
        selectionCount = el("span", "se-muted");
        const selectionTools = row(btn("一覧を全選択", () => selectMatching(true)), btn("一覧の選択を解除", () => selectMatching(false)), btn("すべて解除", () => { selected.clear(); updateBulk(); }), selectionCount); selectionTools.classList.add("se-filterbar", "se-selection-tools");
        selectionTools.firstChild.title = "検索・タグ・セットに一致する全件を選択（画面外も含む）"; content.append(selectionTools);
        const tagEdit = input("", () => { setFieldError(tagEdit, ""); }); tagEdit.placeholder = "一括操作するタグ"; bulkTagEdit = tagEdit;
        bulkBar = row(el("span", "se-muted", `${selected.size}件選択`), tagEdit, btn("タグ追加", () => bulkTags(tagEdit, true)), btn("タグ削除", () => bulkTags(tagEdit, false)), ...(mode === "items" ? [btn("削除", () => deleteItems([...selected]))] : []));
        bulkBar.classList.add("se-filterbar"); bulkBar.hidden = !selected.size; content.append(bulkBar);
        const columns = el("div", "se-columns"); for (const [name, cls] of [["", ""], ["名前", ""], ["本文（クリックして編集）", ""], ["タグ", "se-tags"], ["", ""]]) columns.append(el("span", cls, name)); content.append(columns);
        selectAllControl = null;
        selectAllControl = check(false, selectMatching); selectAllControl.setAttribute("aria-label", "表示中のアイテムを全選択"); columns.firstChild.replaceWith(selectAllControl);
        const scroll = el("div", "se-scroll"); content.append(scroll); virtual = new VirtualRows(scroll, itemRow, dispose); virtual.set(entries()); const state = view(); scroll.scrollTop = state.scroll; scroll.addEventListener("scroll", () => { state.scroll = scroll.scrollTop; }); virtual.paint();
        if (!virtual.entries.length) virtual.canvas.append(el("div", "se-empty", mode === "items" ? "該当するアイテムがありません。検索・絞り込みを変更するか、アイテムを追加してください。" : "表示する実行結果がありません。"));
        updateBulk();
    }
    function bulkTags(control, add) {
        try {
            const tags = parseTags(control.value), inputProblem = tagsError(tags);
            if (setFieldError(control, inputProblem, bulkBar)) return;
            const items = [...selected].map(id => itemMap.get(id)).filter(Boolean).map(item => ({ ...item, tags: add ? [...new Set([...item.tags, ...tags])] : item.tags.filter(t => !tags.includes(t)) }));
            const failed = items.filter(item => tagsError(item.tags));
            if (failed.length) { setFieldError(control, `「${failed[0].name || "アイテム"}」${failed.length > 1 ? `ほか${failed.length - 1}件` : ""}でタグが最大${LIMITS.tags}件を超えるため、追加できません`, bulkBar); return; }
            setFieldError(control, "");
            mutate(items.map(item => ({ type: "item.put", item })));
        } catch (error) { localError = error.message; updateStatus(); }
    }
    async function deleteItems(ids) {
        releaseActive(); ids = ids.filter(id => itemMap.has(id)); if (!ids.length) return;
        const impact = deletionImpact(itemUsage(doc().recipes), ids);
        const target = ids.length === 1 ? `「${itemMap.get(ids[0]).name || "アイテム"}」` : `${ids.length}件`;
        const detail = impact.groups ? `使用中の構成要素 ${impact.groups}件・セット ${impact.recipes}件から外れます。` : "どのセットでも使用されていません。";
        if (!await showConfirmDialog({ title: "アイテムを削除", message: `${target}を削除します。${detail}\n「元に戻す」で参照も含めて復元できます。`, danger: true, okLabel: "削除", cancelLabel: "キャンセル" })) return;
        ids = ids.filter(id => itemMap.has(id));
        if (mutate(ids.map(id => ({ type: "item.delete", id })))) { for (const id of ids) selected.delete(id); refresh(); updateBulk(); }
    }
    function eligibleCandidateCount(g) { return g.kind === "nested" ? g.groups.filter(child => child.on && (child.weight ?? 1) > 0).length : g.item_ids.filter(id => candidateWeight(g, id) > 0).length; }
    function editGroup(groupId, change, historyKey) {
        const r = recipe(); if (!r) return; const next = structuredClone(r); const g = [...walkGroups(next.groups)].find(g => g.id === groupId); if (!g) return; change(g, next);
        if (mutate([{type:"recipe.put",recipe:next}], historyKey)) for (const label of content.querySelectorAll(".se-group-count")) {
            const current = locateGroup(recipe().groups, label.dataset.countGroupId)?.group;
            if (current) label.textContent = `${eligibleCandidateCount(current)}有効 / ${current.kind === "nested" ? current.groups.length : current.item_ids.length}候補`;
        }
    }
    function editAffixes(groupId) {
        const g = locateGroup(recipe().groups, groupId)?.group; if (!g) return;
        showDialog({title:`Prefix / Suffix — ${g.name || "構成要素"}`,width:580,className:"sax-shared-affix",build(dlg, close) {
            const nested = g.kind === "nested";
            dlg.append(el("span", "", nested ? "直下の各構成要素の出力全体に一度ずつ付与します。その下のアイテムへ個別には付与しません。" : "選ばれた各アイテムの本文へ個別に付与します。元の本文は変更しません。"));
            const preview = el("pre"), fields = {};
            const updatePreview = () => { preview.textContent = (fields.prefix?.value ?? "") + (nested ? "本文A\n本文B" : "本文") + (fields.suffix?.value ?? ""); };
            for (const [key, title, placeholder] of [["prefix","Prefix（前）","例: ("],["suffix","Suffix（後）","例: :1.2)"]]) {
                const field = el("input"), wrap = el("label", "", title), historyKey = newId(); field.value = g[key] ?? ""; field.maxLength = LIMITS.affix; field.placeholder = placeholder; field.setAttribute("aria-label", title); fields[key] = field;
                const commit = () => { const current = locateGroup(recipe().groups, groupId)?.group; if (current && (current[key] ?? "") !== field.value) editGroup(groupId, next => { if (field.value) next[key] = field.value; else delete next[key]; }, historyKey); updatePreview(); };
                let composing = false; field.addEventListener("compositionstart", () => { composing = true; }); field.addEventListener("compositionend", () => { composing = false; commit(); }); field.addEventListener("input", () => { updatePreview(); if (!composing) commit(); }); field.addEventListener("blur", commit);
                wrap.append(field); dlg.append(wrap);
            }
            updatePreview(); dlg.append(el("span", "", "出力例（空白・記号は入力したとおり付与）"), preview, btn("閉じる", close));
        },onClose(){render();}});
    }
    function renderSets() {
        const r = recipe(); if (r) pref.recipeId = r.id;
        const setSelect = select(sortedNamedOptions(doc().recipes).map(s => [s.id, s.name]), r?.id ?? "", value => { pref.recipeId = value; candidateGroup = null; targetParent = ""; candidateSelection.clear(); candidatesOnly = false; candidateAnchor = null; render(); });
        const create = () => { const next = { id: newId(), name: "新しいテキストセット", groups: [] }; if (putRecipe(next)) { pref.recipeId = next.id; render(); } };
        content.append(row(el("strong", "", "テキストセット"), setSelect, btn("＋ 作成", create), btn("コピー", () => { if (!r) return; const next = structuredClone(r); next.id = newId(); next.name += " コピー"; for (const g of walkGroups(next.groups)) g.id = newId(); if (putRecipe(next)) { pref.recipeId = next.id; render(); } }), btn("削除", async () => { if (r && await showConfirmDialog({ title: "テキストセットを削除", message: `${r.name}を共有カタログから削除します。参照しているワークフローではセットの選び直しが必要です。`, danger: true, okLabel: "削除" })) { mutate([{ type: "recipe.delete", id: r.id }]); pref.recipeId = null; render(); } })));
        if (!r) { content.append(el("div", "se-empty", "「＋ 作成」でテキストセットを作成してください。")); return; }
        const name = input(r.name, value => { const next = structuredClone(recipe()); next.name = value; putRecipe(next); }); name.maxLength = 256; name.className = "se-grow"; name.setAttribute("aria-label", "セット名");
        const meta = content.lastChild; meta.classList.add("se-set-meta"); meta.insertBefore(name, meta.children[2]);
        const layout = el("div", "se-layout"), left = el("div", "se-pane"), right = el("div", "se-pane"); layout.append(left, right); content.append(layout);
        if (targetParent && !locateGroup(r.groups,targetParent)) targetParent = "";
        left.append(el("strong", "", candidateGroup ? `「${[...walkGroups(r.groups)].find(g => g.id === candidateGroup)?.name || "構成要素"}」の候補を変更` : "追加するアイテムを選択"));
        const parent = select(parentOptions(candidateGroup), targetParent, value => { targetParent = value; }); parent.setAttribute("aria-label", "構成要素の配置先");
        left.append(row(el("span", "se-muted", "配置先"), parent));
        const q = input(candidateQuery, value => { candidateQuery = value; renderCandidates(); }); q.placeholder = "名前・本文・タグを検索（空白区切りで AND）"; q.className = "se-grow";
        const tag = tagFilter(() => candidateTags, tags => { candidateTags = tags; }, () => renderCandidates());
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
            const tokens = searchTokens(candidateQuery);
            candidateVirtual.set(sortItems(doc().catalog.items.filter(i => (!candidatesOnly || candidateSelection.has(i.id)) && matchesItem(i, tokens, candidateTags))).map(i => ({ key: i.id, itemId: i.id, height: 48 })));
            for (const [id, n] of candidateVirtual.nodes) { n.querySelector("input").checked = candidateSelection.has(id); n.dataset.selected = String(candidateSelection.has(id)); }
            if (number._fieldError) validateCount(); count.textContent = `${candidateSelection.size}件選択`; matched.textContent = `${candidateVirtual.entries.length}件一致`;
        };
        const count = el("strong"), matched = el("span", "se-muted"); count.title = "Shift+クリックで範囲選択。検索・タグを変更しても選択は保持されます";
        const selectionbar = row(count, label("選択済みだけ", check(candidatesOnly, yes => { candidatesOnly = yes; renderCandidates(); })), matched); selectionbar.classList.add("se-selectionbar"); left.insertBefore(selectionbar, scroll);
        const selectAll = btn("一覧を全選択", () => { for (const e of candidateVirtual.entries) candidateSelection.add(e.itemId); renderCandidates(); }); selectAll.title = "検索・タグに一致する全件を選択（画面外の行も含む）";
        left.append(row(selectAll, btn("一覧の選択を解除", () => { for (const e of candidateVirtual.entries) candidateSelection.delete(e.itemId); renderCandidates(); }), btn("すべて解除", () => { candidateSelection.clear(); renderCandidates(); })));
        const edited = [...walkGroups(r.groups)].find(g => g.id === candidateGroup), settingsKey = `${r.id}:${candidateGroup ?? ""}`;
        if (candidateSettings?.key !== settingsKey) candidateSettings = {key:settingsKey,mode:edited?.mode ?? "all",count:edited ? formatRandomCount(edited) : "1"};
        let chosenMode = candidateSettings.mode, chosenCount = candidateSettings.count;
        const unit = el("span", "se-muted", "件");
        const modeSelect = select([["all", "すべて使う"], ["random", "ランダム"]], chosenMode, value => { candidateSettings.mode = chosenMode = value; number.hidden = unit.hidden = value !== "random"; if (value === "random") { if (number._fieldError) validateCount(); } else setFieldError(number, ""); }); const number = input(chosenCount, value => { candidateSettings.count = chosenCount = value; if (chosenMode === "random" && !separate()) validateCount(); else setFieldError(number, ""); }); number.style.width = "85px"; number.placeholder = "0～2"; number.title = "固定件数（2）または範囲（0～2）"; number.setAttribute("aria-label", "追加する構成要素のランダム件数"); number.hidden = unit.hidden = chosenMode !== "random";
        modeSelect.setAttribute("aria-label", "追加する構成要素の選択方式");
        const separate = () => !candidateGroup && additionMode === "separate";
        const parseCount = () => { const bounds = parseRandomCount(chosenCount); if (chosenMode === "random" && !separate() && bounds.count > candidateSelection.size) throw new Error("ランダム件数の上限は候補数以下にしてください"); return bounds; };
        const validateCount = () => { try { parseCount(); setFieldError(number, "", number.parentElement); return true; } catch (error) { setFieldError(number, error.message, number.parentElement); return false; } };
        const updateAdditionMode = () => { modeSelect.hidden = separate(); number.hidden = unit.hidden = separate() || chosenMode !== "random"; if (number.hidden) setFieldError(number, ""); else if (number._fieldError) validateCount(); };
        if (!candidateGroup) {
            const addition = select([["combined", "1つの構成要素にまとめる"], ["separate", "アイテムごとに分ける"]], additionMode, value => { additionMode = value; updateAdditionMode(); });
            addition.setAttribute("aria-label", "構成要素の追加方法"); left.append(row(addition));
        }
        updateAdditionMode();
        left.append(row(modeSelect, number, unit, btn(candidateGroup ? "候補を更新" : "選んだアイテムを追加", () => {
            if (!candidateSelection.size) { localError = "候補アイテムを選択してください"; updateStatus(); return; }
            let bounds;
            try { bounds = separate() ? {count:1} : parseCount(); setFieldError(number, ""); }
            catch (error) { if (chosenMode === "random" && !separate()) setFieldError(number, error.message, number.parentElement); else { localError = error.message; updateStatus(); } return; }
            const next = structuredClone(recipe());
            const previous = [...walkGroups(next.groups)].find(g => g.id === candidateGroup)?.item_ids ?? [];
            const ids = previous.filter(id => candidateSelection.has(id));
            const included = new Set(ids);
            for (const item of doc().catalog.items) if (candidateSelection.has(item.id) && !included.has(item.id)) ids.push(item.id);
            if (candidateGroup) { const g = [...walkGroups(next.groups)].find(g => g.id === candidateGroup); if (g) { Object.assign(g, { item_ids: ids, mode: chosenMode, ...bounds }); if (!Object.hasOwn(bounds,"count_min")) delete g.count_min; if (g.item_weights) { for (const id of Object.keys(g.item_weights)) if (!candidateSelection.has(id)) delete g.item_weights[id]; if (!Object.keys(g.item_weights).length) delete g.item_weights; } if (locateGroup(next.groups,g.id).parentId !== targetParent && !relocate(next, g.id, targetParent)) return; } }
            else for (const itemIds of separate() ? ids.map(id => [id]) : [ids]) groupChildren(next, targetParent).push({ id: newId(), name: itemMap.get(itemIds[0])?.name || "構成要素", on: true, mode: separate() ? "all" : chosenMode, ...bounds, item_ids: itemIds });
            if (putRecipe(next)) { targetParent = ""; candidateSettings = null; candidateSelection.clear(); candidateGroup = null; candidatesOnly = false; candidateAnchor = null; render(); }
        }, "se-primary"), ...(candidateGroup ? [btn("キャンセル", () => { candidateGroup = null; candidateSelection.clear(); candidatesOnly = false; render(); })] : [])));
        right.append(row(el("strong", "se-grow", `構成要素 ${[...walkGroups(r.groups)].length}件（上から出力）`), btn("＋ ネスト", () => { const next = structuredClone(recipe()); const g = {id:newId(),name:"ネスト",kind:"nested",mode:"all",count:1,on:true,groups:[]}; groupChildren(next,targetParent).push(g); if (putRecipe(next)) { targetParent = ""; render(); } }))); const groups = el("div", "se-scroll se-group-scroll"); right.append(groups);
        let dragged = null;
        for (const [index, {group:g, depth}] of visibleGroups(r.groups, collapsedGroups).entries()) {
            const nested = g.kind === "nested";
            const card = el("div", "se-card"); card.dataset.off = !g.on; card.dataset.groupId = g.id; card.dataset.depth = depth;
            card.style.marginLeft = `${depth * 14}px`; card.draggable = true;
            card.addEventListener("dragstart", e => { if (e.target.closest("input,select,button")) { e.preventDefault(); return; } dragged = g.id; e.dataTransfer?.setData("text/plain", g.id); });
            card.addEventListener("dragend", () => { dragged = null; for (const target of groups.querySelectorAll("[data-drop]")) delete target.dataset.drop; });
            card.addEventListener("dragover", e => { if (!dragged) return; e.preventDefault(); const bounds=card.getBoundingClientRect(); card.dataset.drop = nested && e.clientY > bounds.top + bounds.height*.25 && e.clientY < bounds.bottom - bounds.height*.25 ? "inside" : e.clientY >= bounds.top + bounds.height*.5 ? "after" : "before"; });
            card.addEventListener("dragleave", () => { delete card.dataset.drop; });
            card.addEventListener("drop", e => { e.preventDefault(); if (!dragged || dragged === g.id) return; const next=structuredClone(recipe()); const destination=locateGroup(next.groups,g.id), inside=card.dataset.drop === "inside", after=card.dataset.drop === "after"; delete card.dataset.drop; const beforeId=inside ? null : after ? destination.siblings[destination.index+1]?.id ?? null : g.id; if (relocate(next,dragged,inside ? g.id : destination.parentId,beforeId) && putRecipe(next)) { dragged=null; render(); } });

            const groupName = input(g.name, value => editGroup(g.id, next => { next.name = value; })); groupName.className = "se-grow"; groupName.maxLength = 256;
            card.dataset.editing = String(candidateGroup === g.id);
            groupName.setAttribute("aria-label", `構成要素 ${index + 1}の名前`);
            const icon = (text, title, fn) => { const control = btn(text, fn, "se-group-icon"); control.title = title; control.setAttribute("aria-label", title); return control; };
            const enabled = check(g.on, yes => { editGroup(g.id, next => { next.on = yes; }); render(); }); enabled.setAttribute("aria-label", `構成要素 ${index + 1}を使用`);
            const changeCandidates = () => { if (nested) { editNested(g.id); return; } targetParent = locateGroup(recipe().groups,g.id).parentId; candidateSettings = null; candidateGroup = g.id; candidateSelection = new Set(g.item_ids); candidatesOnly = true; candidateAnchor = null; candidateQuery = ""; candidateTags = []; render(); };
            const single = !nested && g.item_ids.length === 1;
            card.dataset.single = String(single);
            const header = row(el("span", "se-muted", "≡"), enabled);
            if (nested) { const toggle = icon(collapsedGroups.has(g.id) ? "▸" : "▾", "子の構成要素を開閉", () => { if (collapsedGroups.has(g.id)) collapsedGroups.delete(g.id); else collapsedGroups.add(g.id); render(); }); toggle.setAttribute("aria-expanded", String(!collapsedGroups.has(g.id))); header.append(toggle); }
            header.append(groupName);
            const parentGroup = locateGroup(recipe().groups, g.id).parentId;
            if (parentGroup && locateGroup(recipe().groups, parentGroup).group.mode === "random") {
                const weight = weightInput(g.weight ?? 1, `${g.name || "構成要素"}の抽選重み`, value => editGroup(g.id, next => { if (value === 1) delete next.weight; else next.weight = value; }));
                header.append(el("span", "se-muted", "重み"), weight);
            }
            if (single) {
                const itemName = el("span", "se-muted se-group-preview", itemMap.get(g.item_ids[0])?.name ?? "削除済み"); itemName.title = itemName.textContent;
                header.append(itemName);
                if (g.mode === "random") header.append(el("span", "se-muted se-single-mode", `ランダム${formatRandomCount(g)}件`));
            }
            header.append(icon("✎", "候補を変更", changeCandidates), icon("↑", "構成要素を上へ", () => moveGroup(g.id, -1)), icon("↓", "構成要素を下へ", () => moveGroup(g.id, 1)), icon("×", "構成要素を削除", () => { const next = structuredClone(recipe()); const found=locateGroup(next.groups,g.id); found.siblings.splice(found.index,1); putRecipe(next); render(); }));
            const affix = icon("前後", "Prefix / Suffixを編集", () => editAffixes(g.id)); if (g.prefix || g.suffix) { affix.classList.add("se-primary"); affix.title = `Prefix: ${g.prefix ?? ""}\nSuffix: ${g.suffix ?? ""}`; } header.append(affix);
            if (!nested && g.mode === "random") header.append(icon("重", "候補アイテムの重みを編集", () => { orderGroup = orderGroup === g.id ? null : g.id; orderScroll = 0; render(); }));
            card.append(header);
            if (!single) {
                const candidates = nested ? g.groups : g.item_ids;
                const groupMode = select([["all", "すべて使う"], ["random", "ランダム"]], g.mode, value => { editGroup(g.id, next => { next.mode = value; }); render(); });
                const amount = input(formatRandomCount(g), value => { try { const bounds = parseRandomCount(value); if (bounds.count > eligibleCandidateCount(locateGroup(recipe().groups, g.id).group)) throw new Error("ランダム件数の上限は有効かつ正の重みの候補数以下にしてください"); editGroup(g.id, next => { Object.assign(next, bounds); if (!Object.hasOwn(bounds,"count_min")) delete next.count_min; }); localError = ""; setFieldError(amount, ""); updateStatus(); } catch (error) { setFieldError(amount, error.message, amount.parentElement); } }); amount.style.width = "85px"; amount.placeholder = "0～2"; amount.title = "固定件数（2）または範囲（0～2）"; amount.hidden = g.mode !== "random"; amount.setAttribute("aria-label", `構成要素 ${index + 1}のランダム件数`);
                const preview = el("span", "se-muted se-group-preview", nested ? g.groups.slice(0,4).map(child => child.name).join("、") : g.item_ids.slice(0, 4).map(id => itemMap.get(id)?.name ?? "削除済み").join("、"));
                preview.title = "編集アイコンで全候補を一覧表示";
                const orderButton = btn("出力順", () => { orderGroup = orderGroup === g.id ? null : g.id; orderScroll = 0; render(); }); orderButton.setAttribute("aria-expanded", String(orderGroup === g.id)); orderButton.title = "候補アイテムの出力順を並び替え";
                const countLabel = el("span", "se-muted", g.mode === "random" ? `${eligibleCandidateCount(g)}有効 / ${candidates.length}候補` : `${candidates.length}${nested ? "構成要素" : "候補"}`);
                if (g.mode === "random") { countLabel.classList.add("se-group-count"); countLabel.dataset.countGroupId = g.id; }
                card.append(row(groupMode, amount, countLabel, preview, ...(nested ? [] : [orderButton])));
            }
            if (!nested && orderGroup === g.id) renderOrder(card, g);
            card.setAttribute("aria-label", `構成要素 ${index + 1}`); groups.append(card);
        }
        if (!r.groups.length) groups.append(el("div", "se-empty", "左側でアイテムを選び、「選んだアイテムを追加」で構成要素を作ります。")); renderCandidates();
        scroll.scrollTop = setScroll.candidates; candidateVirtual.paint(); groups.scrollTop = setScroll.groups;
    }
    function moveCandidate(groupId, itemId, target) {
        const keyboard = document.activeElement?.classList.contains("se-order-handle");
        const next = structuredClone(recipe()), group = [...walkGroups(next.groups)].find(g => g.id === groupId);
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
    // inline が真なら行の高さが固定された一覧内の欄で、メッセージは欄の近くに出せず赤枠とヘッダーの表示にとどめる。
    function weightInput(value, name, commit, inline = false) {
        const control = input(value, raw => { try { const weight = parseSelectionWeight(raw); commit(weight); localError = ""; setFieldError(control, ""); updateStatus(); } catch (error) { if (inline) { setFieldError(control, error.message, null); localError = error.message; updateStatus(); } else setFieldError(control, error.message, control.parentElement); } }, "number");
        control.min = "0"; control.max = "1000000"; control.step = "any"; control.style.width = "60px"; control.style.flex = "none"; control.setAttribute("aria-label", name); control.title = "抽選の重み：1が基準、3は選ばれやすく、0は抽選対象外"; return control;
    }
    function renderOrder(card, group) {
        if (group.mode === "random") card.append(el("span", "se-muted", "重み：1が基準・0は抽選対象外（すべて使用では無視）"));
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
            n.append(handle, position, copy);
            if (group.mode === "random") n.append(weightInput(candidateWeight(group, entry.itemId), `${item?.name || entry.itemId}の抽選重み`, value => editGroup(group.id, next => { if (value === 1) { if (next.item_weights) { delete next.item_weights[entry.itemId]; if (!Object.keys(next.item_weights).length) delete next.item_weights; } } else next.item_weights = {...next.item_weights, [entry.itemId]:value}; }), true));
            n.append(up, down); return n;
        });
        orderLists.push(list); list.set(group.item_ids.map((id, index) => ({ key: id, itemId: id, index, height: 42 })));
        scroll.addEventListener("dragover", event => { if (!dragged) return; event.preventDefault(); const bounds = scroll.getBoundingClientRect(); if (event.clientY < bounds.top + 28) scroll.scrollTop -= 20; else if (event.clientY > bounds.bottom - 28) scroll.scrollTop += 20; list.paint(); });
        scroll.scrollTop = orderScroll; list.paint();
    }
    function moveGroup(id, offset) { const next = structuredClone(recipe()), found=locateGroup(next.groups,id); if (!found) return; const to=found.index+offset; if (to<0 || to>=found.siblings.length) return; [found.siblings[found.index],found.siblings[to]]=[found.siblings[to],found.siblings[found.index]]; if (putRecipe(next)) render(); }

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
    const switchMode = next => { releaseActive(); mode = next; render(); };
    const undo = () => { releaseActive(); session.undo(); render(); };
    const redo = () => { releaseActive(); session.redo(); render(); };
    // 他のダイアログ（確認・拡大編集・ピッカーなど）が前面にあるときは、そちらに任せる。
    const isTopmost = () => {
        const overlay = close?.overlay; if (!overlay?.isConnected || overlay.style.display === "none") return false;
        for (let next = overlay.nextElementSibling; next; next = next.nextElementSibling) if (next.style?.zIndex === "10000" && next.style.display !== "none") return false;
        return true;
    };
    const onKeydown = event => {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !isTopmost()) return;
        if (event.key === "Escape") {
            event.preventDefault();
            const popup = content?.querySelector(".se-tag-filter[open]");
            if (popup) popup.open = false; else close();
        } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !isTextEntry(event.target)) {
            const key = event.key.toLowerCase(), redoing = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.shiftKey);
            if (!redoing && !(key === "z" && !event.shiftKey)) return;
            event.preventDefault(); event.stopPropagation(); if (redoing) redo(); else undo();
        }
    };
    document.addEventListener("keydown", onKeydown);
    close = showDialog({ title: `SAX Text Catalog V2 — ${doc().name}`, width: 1200, maxHeight: "97vh", className: "sax-shared-editor", onClose() {
        pref.candidateQuery = candidateQuery; pref.candidateTags = [...candidateTags];
        document.removeEventListener("pointerdown", dismissTagFilter, true); document.removeEventListener("keydown", onKeydown);
        for (const list of orderLists.splice(0)) list.destroy();
        releaseActive(); clearTimeout(saveTimer); unsubscribe?.(); virtual?.destroy(); for (const t of content?.querySelectorAll("textarea") ?? []) detachAutoComplete(t); openEditors.delete(session); void session.flush().catch(() => {});
    }, build(dlg, end) {
        dlg.children[0].style.display = "none";
        const style = el("style"); style.textContent = STYLE; dlg.append(style);
        status = row(el("span"), btn("保存を再試行", () => safeAsync(() => session.retry()))); status.classList.add("se-status", "se-muted");
        const title = el("strong", "", doc().name); title.title = `SAX Text Catalog V2 — ${doc().name}`;
        const header = row(title, btn("アイテム", () => switchMode("items")), btn("テキストセット", () => switchMode("sets")), ...(result ? [btn("前回の実行結果", () => switchMode("results"))] : []), status, btn("元に戻す", undo), btn("やり直す", redo), btn("閉じる", end)); header.classList.add("se-header");
        errorMessage = el("div", "se-error se-error-message"); errorMessage.setAttribute("role", "alert"); errorMessage.hidden = true;
        conflict = row(el("span", "", "他の編集と競合しています。編集内容を保持しています。"), btn("最新を読み込み", async () => { if (await showConfirmDialog({ title: "最新データを読み込み", message: "この画面の未保存の編集を取り消し、保存済みの最新データを読み込みます。", okLabel: "読み込み" })) await safeAsync(() => session.reload()); render(); }), btn("最新に編集を再適用", () => safeAsync(() => session.reapply()))); conflict.classList.add("se-conflict"); conflict.hidden = true;
        dlg.append(header, errorMessage, conflict); content = el("div", "se-pane"); content.style.flex = "1"; dlg.append(content); render();
    } });
    unsubscribe = session.subscribe(() => { updateStatus(); scheduleRefresh(); });
    openEditors.set(session, { close, open(next) { if (next.result) { if (resultKey(next.result) !== resultKey(result)) pref.results = { query: "", tags: [], scroll: 0 }; result = next.result; } if (next.recipeId) { if (next.mode === "items") { pref.recipeFilter = next.recipeId; pref.query = ""; pref.tags = []; pref.scroll = 0; } else pref.recipeId = next.recipeId; } mode = next.mode ?? mode; render(); close.show(); } });
    return close;
}
