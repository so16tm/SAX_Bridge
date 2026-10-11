import { showDialog, showConfirmDialog } from "./sax_ui_base.js";
import { newId, parseTags } from "./sax_text_catalog_v2_model.js";
import { attachAutoComplete, detachAutoComplete } from "./sax_text_autocomplete.js";

const preferences = new WeakMap();
const openEditors = new WeakMap();
const STYLE = `
.sax-shared-editor *{box-sizing:border-box}.sax-shared-editor [hidden]{display:none!important}.sax-shared-editor .se-mobile-tags{display:none}.sax-shared-editor>div{width:97vw!important;height:94vh;max-height:97vh!important;padding:16px!important;border-radius:12px!important;font-family:system-ui,sans-serif}
.sax-shared-editor button,.sax-shared-editor input,.sax-shared-editor select,.sax-shared-editor textarea{font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:7px 9px;min-width:0}.sax-shared-editor button{cursor:pointer}.sax-shared-editor button:disabled{opacity:.45;cursor:default}.sax-shared-editor :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:2px}.sax-shared-editor textarea{width:100%;resize:vertical;line-height:1.7;min-height:160px}.sax-shared-editor input[type=checkbox]{width:16px;height:16px;accent-color:var(--primary-background,#5686d6)}
.sax-shared-editor .se-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sax-shared-editor .se-grow{flex:1;min-width:110px}.sax-shared-editor .se-muted{opacity:.68;font-size:12px}.sax-shared-editor .se-error{color:var(--error-text,#ed9494);white-space:pre-wrap}.sax-shared-editor .se-status{min-height:18px}.sax-shared-editor .se-scroll{flex:1;min-height:0;overflow:auto;position:relative;scrollbar-gutter:stable;overflow-anchor:none}.sax-shared-editor .se-canvas{position:relative}.sax-shared-editor .se-record{position:absolute;left:0;right:0;display:grid;grid-template-columns:24px minmax(130px,.8fr) minmax(260px,3fr) minmax(120px,.7fr) 72px;gap:12px;padding:10px 6px;border-bottom:1px solid var(--border-color,#45454b);align-items:start}.sax-shared-editor .se-cell{border:0;background:transparent;text-align:left;cursor:text;line-height:1.7;padding:3px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--se-lines,3)}.sax-shared-editor .se-cell:hover{background:color-mix(in srgb,var(--primary-background,#5686d6) 12%,transparent);border-radius:5px}.sax-shared-editor .se-cell:empty:before{content:attr(data-placeholder);opacity:.45}.sax-shared-editor .se-record input:not([type=checkbox]){width:100%}.sax-shared-editor .se-record textarea{resize:none;min-height:200px}.sax-shared-editor .se-record[data-editing=true]{background:color-mix(in srgb,var(--primary-background,#5686d6) 8%,transparent)}.sax-shared-editor .se-tools{display:flex;flex-direction:column;gap:6px}.sax-shared-editor .se-section{position:absolute;left:0;right:0;padding:12px 8px;background:var(--comfy-input-bg,#242426);border-radius:6px;display:flex;align-items:center;gap:12px;overflow:hidden}.sax-shared-editor .se-section strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-shared-editor .se-empty{padding:24px;opacity:.7}.sax-shared-editor .se-columns{display:grid;grid-template-columns:24px minmax(130px,.8fr) minmax(260px,3fr) minmax(120px,.7fr) 72px;gap:12px;padding:0 6px;font-size:12px;opacity:.65}.sax-shared-editor .se-layout{display:grid;grid-template-columns:minmax(240px,1fr) minmax(320px,1.4fr);gap:16px;flex:1;min-height:0}.sax-shared-editor .se-pane{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}.sax-shared-editor .se-card{padding:12px;border:1px solid var(--border-color,#45454b);border-radius:8px;margin-bottom:10px}.sax-shared-editor .se-card[data-off=true]{opacity:.55}.sax-shared-editor .se-card>.se-row{margin-bottom:8px}.sax-shared-editor .se-candidate{position:absolute;left:0;right:0;height:40px;display:flex;align-items:center;gap:10px;padding:6px;border-bottom:1px solid var(--border-color,#45454b)}.sax-shared-editor .se-candidate span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-shared-editor .se-primary{background:var(--primary-background,#386cb8);color:#fff}.sax-shared-editor .se-result-text{flex:1;min-height:0;resize:none!important}.sax-shared-editor .se-badge{font-size:11px;color:var(--primary-background,#80adf2);display:block}.sax-shared-editor .se-conflict{padding:8px;border:1px solid var(--error-text,#ed9494);border-radius:6px}.sax-shared-editor details>summary{cursor:pointer}
@media(max-width:760px){.sax-shared-editor>div{padding:10px!important}.sax-shared-editor .se-layout{grid-template-columns:1fr;grid-template-rows:minmax(180px,.7fr) minmax(220px,1fr)}.sax-shared-editor .se-record,.sax-shared-editor .se-columns{grid-template-columns:20px minmax(75px,.7fr) minmax(140px,2fr) 65px;gap:6px}.sax-shared-editor .se-tags{display:none}.sax-shared-editor .se-row{gap:5px}.sax-shared-editor .se-row button{padding:6px}.sax-shared-editor .se-section .se-muted{display:none}}
@media(max-width:760px){.sax-shared-editor .se-mobile-tags{display:block}}
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
    let pref = preferences.get(session); if (!pref) { pref = { query: "", tag: "", recipeFilter: "", lines: 3, scroll: 0, recipeId: null, sort: "catalog" }; preferences.set(session, pref); }
    let mode = options.mode ?? "items", result = options.result ?? null;
    if (options.recipeId) { if (mode === "items") { pref.recipeFilter = options.recipeId; pref.query = ""; pref.tag = ""; pref.scroll = 0; } else pref.recipeId = options.recipeId; }
    let content, status, conflict, close, virtual = null, active = null, unsubscribe, localError = "", saveTimer, refreshing = false;
    let itemMap = new Map(), selected = new Set(), candidateSelection = new Set(), candidateGroup = null, candidateQuery = "", candidateTag = "", resultRecipe = "", outputTab = false, selectionAnchor = null;
    const showCandidates = new Set();
    const doc = () => session.document;
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
    function updateStatus() { if (!status) return; const messages = { saved: "共有カタログへ保存済み", pending: "変更を保存中…", saving: "変更を保存中…", error: "保存に失敗しました", conflict: "他の編集と競合しています" }; status.firstChild.textContent = localError || session.error?.message || messages[session.status] || session.status || "保存済み"; status.classList.toggle("se-error", Boolean(localError || session.error) || session.conflict); conflict.hidden = !session.conflict; status.lastChild.hidden = !session.error || session.conflict; }
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
    function entries() {
        if (mode === "items") {
            let ids = null; const r = doc().recipes.find(r => r.id === pref.recipeFilter); if (r) ids = new Set(r.groups.flatMap(g => g.item_ids));
            const q = pref.query.trim().toLocaleLowerCase();
            const values = doc().catalog.items.filter(i => (!ids || ids.has(i.id)) && (!pref.tag || i.tags.includes(pref.tag)) && (!q || `${i.name}\n${i.text}\n${i.tags.join(" ")}`.toLocaleLowerCase().includes(q)));
            if (pref.sort === "name") values.sort((a, b) => a.name.localeCompare(b.name, "ja"));
            if (pref.sort === "usage") { const counts = new Map(); for (const r of doc().recipes) for (const g of r.groups) for (const id of g.item_ids) counts.set(id, (counts.get(id) ?? 0) + 1); values.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)); }
            return values.map(i => ({ key: i.id, itemId: i.id, height: Math.max(76, 28 + pref.lines * 23) }));
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
                list.push(...values.filter(e => { const i = itemMap.get(e.itemId) ?? e.snapshot; return (!pref.tag || i?.tags?.includes(pref.tag)) && (!q || `${i?.name ?? ""}\n${i?.text ?? ""}`.toLocaleLowerCase().includes(q)); }));
            }
        }
        return list;
    }
    function syncBadges() { if (!virtual) return; for (const [key, n] of virtual.nodes) { const entry = virtual.entries.find(e => e.key === key); if (!entry?.snapshot) continue; const current = itemMap.get(entry.itemId); const badge = n.querySelector(".se-badge"); if (badge) badge.textContent = !current ? "削除済み・編集できません" : current.text !== entry.snapshot.text || current.name !== entry.snapshot.name ? "編集済み・次回実行に反映" : "実行時の内容"; } }
    function expandedEditor(id) {
        const item = itemMap.get(id); if (!item) return;
        let area;
        showDialog({ title: `${item.name || "アイテム"} — 本文編集`, width: 1000, maxHeight: "90vh", build(dlg, end) {
            area = el("textarea"); area.style.height = "65vh"; area.value = item.text; area.setAttribute("aria-label", "アイテム本文（拡大）"); const historyKey = newId(); let composing = false; area.addEventListener("compositionstart", () => { composing = true; }); area.addEventListener("input", () => { if (!composing) putItem(id, { text: area.value }, historyKey); }); area.addEventListener("compositionend", () => { composing = false; putItem(id, { text: area.value }, historyKey); }); attachAutoComplete(area);
            dlg.append(el("p", "se-muted", "共有カタログの元アイテムへ自動保存されます"), area, btn("閉じる", end)); queueMicrotask(() => area.focus());
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
                edit.addEventListener("keydown", e => { if ((e.key === "Enter" && field !== "text") || (e.key === "Escape" && !composing)) { e.preventDefault(); edit.blur(); } });
                edit.addEventListener("blur", () => { if (active?.edit !== edit) return; commit(); active = null; virtual.pinned = null; refresh(); });
                c.replaceWith(edit); active = { edit, commit }; if (field === "text") attachAutoComplete(edit); edit.focus(); edit.setSelectionRange?.(edit.value.length, edit.value.length);
            }
            return c;
        }
        n.append(cell("name", shown?.name ?? ""));
        const textWrap = el("div"); textWrap.append(cell("text", shown?.text ?? ""));
        if (entry.snapshot) { textWrap.append(el("span", "se-badge", !current ? "削除済み・編集できません" : current.text !== entry.snapshot.text || current.name !== entry.snapshot.name ? "編集済み・次回実行に反映" : "実行時の内容")); const details = el("details"); details.append(el("summary", "se-muted", "実行時の本文"), el("div", "se-cell", entry.snapshot.text)); textWrap.append(details); }
        n.append(textWrap, cell("tags", shown?.tags?.join(", ") ?? "", "se-tags"));
        const tools = el("div", "se-tools"); if (current) { tools.append(btn("拡大", () => { releaseActive(); expandedEditor(entry.itemId); })); const tags = btn("タグ", () => { const value = input(current.tags.join(", "), () => {}); value.setAttribute("aria-label", "アイテムタグ"); showDialog({ title: "タグを編集", build(dlg, end) { dlg.append(value, btn("反映", () => { try { putItem(entry.itemId, { tags: parseTags(value.value) }); end(); } catch (error) { localError = error.message; updateStatus(); } })); } }); }); tags.classList.add("se-mobile-tags"); tools.append(tags); } n.append(tools); return n;
    }
    let bulkBar;
    function updateBulk() { if (bulkBar) bulkBar.firstChild.textContent = `${selected.size}件選択`; }
    function filters() {
        const q = input(pref.query, value => { pref.query = value; releaseActive(); scheduleRefresh(); }); q.placeholder = "名前・本文を検索"; q.className = "se-grow";
        const tags = [...new Set(doc().catalog.items.flatMap(i => i.tags))].sort(); const tag = select([["", "タグ：すべて"], ...tags.map(t => [t, t])], pref.tag, value => { pref.tag = value; releaseActive(); refresh(); });
        const sets = [["", "セット：すべて"], ...doc().recipes.map(r => [r.id, r.name])];
        const set = select(sets, mode === "results" ? resultRecipe : pref.recipeFilter, value => { releaseActive(); if (mode === "results") resultRecipe = value; else pref.recipeFilter = value; refresh(); });
        const lines = select([["1", "本文1行"], ["3", "本文3行"], ["6", "本文6行"]], String(pref.lines), value => { releaseActive(); pref.lines = Number(value); virtual.heights.clear(); refresh(); });
        const sort = select([["catalog", "登録順"], ["name", "名前順"], ["usage", "利用数順"]], pref.sort, value => { releaseActive(); pref.sort = value; refresh(); });
        return row(q, tag, set, lines, ...(mode === "items" ? [sort] : []));
    }
    function renderList() {
        content.append(filters());
        if (mode === "items") {
            const newItem = btn("＋ アイテム", () => { const item = { id: newId(), name: "新しいアイテム", text: "", tags: [] }; if (mutate([{ type: "item.put", item }])) { pref.query = ""; pref.tag = ""; pref.recipeFilter = ""; render(); const index = virtual.entries.findIndex(e => e.itemId === item.id); virtual.scroll.scrollTop = virtual.index.offsets[index]; virtual.paint(); virtual.nodes.get(item.id)?.querySelector('[aria-label="名前を編集"]')?.click(); } });
            const tagEdit = input("", () => {}); tagEdit.placeholder = "一括操作するタグ";
            bulkBar = row(el("span", "se-muted", `${selected.size}件選択`), btn("表示中を選択", () => { selected = new Set(entries().map(e => e.itemId)); virtual.set(entries(), true); updateBulk(); }), btn("選択解除", () => { selected.clear(); virtual.set(entries(), true); updateBulk(); }), tagEdit,
                btn("タグ追加", () => bulkTags(tagEdit.value, true)), btn("タグ削除", () => bulkTags(tagEdit.value, false)), btn("削除", async () => { if (!selected.size) return; if (await showConfirmDialog({ title: "アイテムを削除", message: `${selected.size}件を削除します。すべてのセットの候補からも除かれます。`, danger: true, okLabel: "削除" })) { mutate([...selected].map(id => ({ type: "item.delete", id }))); selected.clear(); refresh(); updateBulk(); } }), newItem);
            content.append(bulkBar);
        } else {
            const meta = el("div", "se-muted", result ? `カタログ改訂 ${result.revision ?? result.catalog_revision ?? "—"} · Seed ${result.seed ?? "—"} · 本文の修正は次回実行に反映` : "まだ実行結果がありません。ワークフローを実行してください。");
            content.append(row(meta, btn(outputTab ? "アイテム一覧" : "出力テキスト", () => { outputTab = !outputTab; render(); })));
            if (outputTab) { const text = el("textarea", "se-result-text"); text.readOnly = true; text.value = result?.text ?? ""; content.append(text, btn("コピー", async () => { try { await navigator.clipboard.writeText(text.value); } catch { text.focus(); text.select(); localError = "選択したテキストをCtrl+Cでコピーしてください"; updateStatus(); } })); return; }
        }
        const columns = el("div", "se-columns"); for (const [name, cls] of [["", ""], ["名前", ""], ["本文（クリックして編集）", ""], ["タグ", "se-tags"], ["", ""]]) columns.append(el("span", cls, name)); content.append(columns);
        const scroll = el("div", "se-scroll"); content.append(scroll); virtual = new VirtualRows(scroll, itemRow, dispose); virtual.set(entries()); scroll.scrollTop = pref.scroll; scroll.addEventListener("scroll", () => { pref.scroll = scroll.scrollTop; }); virtual.paint();
        if (!virtual.entries.length) virtual.canvas.append(el("div", "se-empty", mode === "items" ? "該当するアイテムがありません。検索・絞り込みを変更するか、アイテムを追加してください。" : "表示する実行結果がありません。"));
    }
    function bulkTags(value, add) { try { const tags = parseTags(value); mutate([...selected].map(id => itemMap.get(id)).filter(Boolean).map(item => ({ type: "item.put", item: { ...item, tags: add ? [...new Set([...item.tags, ...tags])] : item.tags.filter(t => !tags.includes(t)) } }))); } catch (error) { localError = error.message; updateStatus(); } }
    function editGroup(groupId, change) { const r = recipe(); if (!r) return; const next = structuredClone(r); const g = next.groups.find(g => g.id === groupId); if (!g) return; change(g, next); putRecipe(next); }
    function renderSets() {
        const r = recipe(); if (r) pref.recipeId = r.id;
        const setSelect = select(doc().recipes.map(s => [s.id, s.name]), r?.id ?? "", value => { pref.recipeId = value; candidateGroup = null; candidateSelection.clear(); render(); });
        const create = () => { const next = { id: newId(), name: "新しいテキストセット", groups: [] }; if (putRecipe(next)) { pref.recipeId = next.id; render(); } };
        content.append(row(el("strong", "", "テキストセット"), setSelect, btn("＋ 作成", create), btn("コピー", () => { if (!r) return; const next = structuredClone(r); next.id = newId(); next.name += " コピー"; for (const g of next.groups) g.id = newId(); if (putRecipe(next)) { pref.recipeId = next.id; render(); } }), btn("削除", async () => { if (r && await showConfirmDialog({ title: "テキストセットを削除", message: `${r.name}を共有カタログから削除します。参照しているワークフローではセットの選び直しが必要です。`, danger: true, okLabel: "削除" })) { mutate([{ type: "recipe.delete", id: r.id }]); pref.recipeId = null; render(); } })));
        if (!r) { content.append(el("div", "se-empty", "「＋ 作成」でテキストセットを作成してください。")); return; }
        const name = input(r.name, value => { const next = structuredClone(recipe()); next.name = value; putRecipe(next); }); name.maxLength = 256; name.className = "se-grow"; content.append(row(el("span", "", "セット名"), name));
        const layout = el("div", "se-layout"), left = el("div", "se-pane"), right = el("div", "se-pane"); layout.append(left, right); content.append(layout);
        left.append(el("strong", "", candidateGroup ? "候補アイテムを変更" : "追加するアイテムを選択"));
        const q = input(candidateQuery, value => { candidateQuery = value; renderCandidates(); }); q.placeholder = "名前・タグを検索"; q.className = "se-grow";
        const tag = select([["", "タグ：すべて"], ...[...new Set(doc().catalog.items.flatMap(i => i.tags))].sort().map(t => [t, t])], candidateTag, value => { candidateTag = value; renderCandidates(); });
        left.append(row(q, tag)); const scroll = el("div", "se-scroll"); left.append(scroll);
        let candidateVirtual = new VirtualRows(scroll, entry => { const i = itemMap.get(entry.itemId); const n = el("div", "se-candidate"); n.append(check(candidateSelection.has(i.id), yes => { if (yes) candidateSelection.add(i.id); else candidateSelection.delete(i.id); count.textContent = `${candidateSelection.size}件選択`; }), el("span", "se-grow", i.name), el("span", "se-muted", i.tags.join(", "))); return n; });
        virtual = candidateVirtual;
        const renderCandidates = () => { const query = candidateQuery.trim().toLocaleLowerCase(); candidateVirtual.set(doc().catalog.items.filter(i => (!candidateTag || i.tags.includes(candidateTag)) && (!query || `${i.name} ${i.tags.join(" ")}`.toLocaleLowerCase().includes(query))).map(i => ({ key: i.id, itemId: i.id, height: 40 })), true); };
        const count = el("span", "se-muted", `${candidateSelection.size}件選択`); left.append(row(count, btn("表示中を選択", () => { for (const e of candidateVirtual.entries) candidateSelection.add(e.itemId); count.textContent = `${candidateSelection.size}件選択`; renderCandidates(); }), btn("解除", () => { candidateSelection.clear(); count.textContent = "0件選択"; renderCandidates(); })));
        let chosenMode = "all", chosenCount = 1; const edited = r.groups.find(g => g.id === candidateGroup); if (edited) { chosenMode = edited.mode; chosenCount = edited.count; }
        const modeSelect = select([["all", "すべて使う"], ["random", "この中からランダム"]], chosenMode, value => { chosenMode = value; number.disabled = value !== "random"; }); const number = input(chosenCount, value => { chosenCount = Number(value); }, "number"); number.min = "0"; number.max = "10000"; number.step = "1"; number.style.width = "80px"; number.disabled = chosenMode !== "random";
        left.append(row(modeSelect, number, el("span", "se-muted", "件")));
        left.append(row(btn(candidateGroup ? "候補を更新" : "選んだアイテムを追加", () => {
            if (!candidateSelection.size) { localError = "候補アイテムを選択してください"; updateStatus(); return; }
            if (chosenMode === "random" && (!Number.isSafeInteger(chosenCount) || chosenCount < 0 || chosenCount > candidateSelection.size)) { localError = "ランダム件数は候補数以下の整数にしてください"; updateStatus(); return; }
            const ids = doc().catalog.items.filter(i => candidateSelection.has(i.id)).map(i => i.id); const next = structuredClone(recipe());
            if (candidateGroup) { const g = next.groups.find(g => g.id === candidateGroup); if (g) Object.assign(g, { item_ids: ids, mode: chosenMode, count: chosenCount }); }
            else next.groups.push({ id: newId(), name: "構成要素", on: true, mode: chosenMode, count: chosenCount, item_ids: ids });
            if (putRecipe(next)) { candidateSelection.clear(); candidateGroup = null; render(); }
        }, "se-primary"), ...(candidateGroup ? [btn("キャンセル", () => { candidateGroup = null; candidateSelection.clear(); render(); })] : [])));
        right.append(el("strong", "", "出力する構成要素（上から順に使用）")); const groups = el("div", "se-scroll"); right.append(groups);
        let dragged = null;
        for (const [index, g] of r.groups.entries()) {
            const card = el("div", "se-card"); card.dataset.off = !g.on; card.draggable = true; card.addEventListener("dragstart", e => { if (e.target.closest("input,select,button")) { e.preventDefault(); return; } dragged = g.id; }); card.addEventListener("dragover", e => e.preventDefault()); card.addEventListener("drop", e => { e.preventDefault(); if (!dragged || dragged === g.id) return; const next = structuredClone(recipe()); const from = next.groups.findIndex(v => v.id === dragged), to = next.groups.findIndex(v => v.id === g.id); const [moved] = next.groups.splice(from, 1); next.groups.splice(to, 0, moved); putRecipe(next); render(); });
            const groupName = input(g.name, value => editGroup(g.id, next => { next.name = value; })); groupName.className = "se-grow"; groupName.maxLength = 256;
            card.append(row(el("span", "se-muted", "≡"), check(g.on, yes => { editGroup(g.id, next => { next.on = yes; }); card.dataset.off = !yes; }), groupName, btn("↑", () => moveGroup(g.id, -1)), btn("↓", () => moveGroup(g.id, 1)), btn("削除", () => { const next = structuredClone(recipe()); next.groups = next.groups.filter(v => v.id !== g.id); putRecipe(next); render(); })));
            const groupMode = select([["all", "すべて使う"], ["random", "ランダム"]], g.mode, value => { editGroup(g.id, next => { next.mode = value; }); render(); });
            const amount = input(g.count, value => { const count = Number(value); if (Number.isSafeInteger(count) && count >= 0 && count <= g.item_ids.length) editGroup(g.id, next => { next.count = count; }); else { localError = "ランダム件数は候補数以下の整数にしてください"; updateStatus(); } }, "number"); amount.style.width = "80px"; amount.min = "0"; amount.max = String(g.item_ids.length); amount.step = "1"; amount.disabled = g.mode !== "random";
            card.append(row(groupMode, amount, el("span", "se-muted", `件 / 候補 ${g.item_ids.length}件`), btn("候補を変更", () => { candidateGroup = g.id; candidateSelection = new Set(g.item_ids); render(); })));
            card.append(el("div", "se-muted", g.item_ids.slice(0, 12).map(id => itemMap.get(id)?.name ?? "削除済み").join("、") + (g.item_ids.length > 12 ? ` …ほか${g.item_ids.length - 12}件` : ""))); card.setAttribute("aria-label", `構成要素 ${index + 1}`); groups.append(card);
        }
        if (!r.groups.length) groups.append(el("div", "se-empty", "左側でアイテムを選び、「選んだアイテムを追加」で構成要素を作ります。")); renderCandidates();
    }
    function moveGroup(id, offset) { const next = structuredClone(recipe()); const from = next.groups.findIndex(g => g.id === id), to = from + offset; if (to < 0 || to >= next.groups.length) return; [next.groups[from], next.groups[to]] = [next.groups[to], next.groups[from]]; putRecipe(next); render(); }
    function render() {
        refreshing = true; releaseActive(); virtual?.destroy(); virtual = null; content.replaceChildren(); itemMap = new Map(doc().catalog.items.map(i => [i.id, i]));
        if (mode === "sets") renderSets(); else renderList(); updateStatus(); refreshing = false;
    }
    const switchMode = next => { releaseActive(); pref.scroll = 0; pref.query = ""; pref.tag = ""; mode = next; render(); };
    close = showDialog({ title: `SAX Text Catalog V2 — ${doc().name}`, width: 1200, maxHeight: "97vh", className: "sax-shared-editor", onClose() {
        releaseActive(); clearTimeout(saveTimer); unsubscribe?.(); virtual?.destroy(); for (const t of content?.querySelectorAll("textarea") ?? []) detachAutoComplete(t); openEditors.delete(session); void session.flush().catch(() => {});
    }, build(dlg, end) {
        const style = el("style"); style.textContent = STYLE; dlg.append(style);
        dlg.append(row(btn("アイテム", () => switchMode("items")), btn("テキストセット", () => switchMode("sets")), ...(result ? [btn("前回の実行結果", () => switchMode("results"))] : []), el("span", "se-grow"), btn("元に戻す", () => { releaseActive(); session.undo(); render(); }), btn("やり直す", () => { releaseActive(); session.redo(); render(); }), btn("閉じる", end)));
        status = row(el("span", "se-grow"), btn("保存を再試行", () => safeAsync(() => session.retry()))); status.classList.add("se-status", "se-muted"); conflict = row(el("span", "", "他の編集と競合しています。編集内容を保持しています。"), btn("最新を読み込み", async () => { if (await showConfirmDialog({ title: "最新データを読み込み", message: "この画面の未保存の編集を取り消し、保存済みの最新データを読み込みます。", okLabel: "読み込み" })) await safeAsync(() => session.reload()); render(); }), btn("最新に編集を再適用", () => safeAsync(() => session.reapply()))); conflict.classList.add("se-conflict"); conflict.hidden = true;
        dlg.append(status, conflict); content = el("div", "se-pane"); content.style.flex = "1"; dlg.append(content); render();
    } });
    unsubscribe = session.subscribe(() => { updateStatus(); scheduleRefresh(); });
    openEditors.set(session, { close, open(next) { if (next.result) result = next.result; if (next.recipeId) { if (next.mode === "items") { pref.recipeFilter = next.recipeId; pref.query = ""; pref.tag = ""; pref.scroll = 0; } else pref.recipeId = next.recipeId; } if (next.mode && next.mode !== mode) { pref.query = ""; pref.tag = ""; pref.scroll = 0; } mode = next.mode ?? mode; render(); close.show(); } });
    return close;
}
