import { app } from "../../scripts/app.js";
import { showDialog, showConfirmDialog, hideWidget } from "./sax_ui_base.js";
import { LIMITS, newId, parseConfig, validateConfig, parseTags, filteredItems, recipeWarnings, removeItems, EditHistory, BufferedJson, visibleWindow } from "./sax_text_catalog_v2_model.js";

const NODE_TYPE = "SAX_Bridge_Text_Catalog_V2";
const states = new WeakMap();
const STYLE = `
.sax-catalog-v2 *{box-sizing:border-box}.sax-catalog-v2>div{width:min(1180px,96vw)!important;height:88vh;max-height:94vh!important;padding:20px!important;border-radius:14px!important}
.sax-catalog-v2 button,.sax-catalog-v2 input,.sax-catalog-v2 select,.sax-catalog-v2 textarea{font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#45454b);border-radius:7px;padding:7px 9px;min-width:0}
.sax-catalog-v2 button{cursor:pointer;white-space:nowrap}.sax-catalog-v2 button:hover{border-color:var(--primary-background,#5686d6)}.sax-catalog-v2 button:disabled{opacity:.4;cursor:default}.sax-catalog-v2 :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:2px}
.sax-catalog-v2 input[type=checkbox]{accent-color:var(--primary-background,#5686d6);width:16px;height:16px;flex-shrink:0}.sax-catalog-v2 textarea{resize:vertical;min-height:92px;line-height:1.65;width:100%}.sax-catalog-v2 input[type=number]{width:76px}
.sax-catalog-v2 .cv2-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sax-catalog-v2 .cv2-grow{min-width:100px}.sax-catalog-v2 .cv2-row>.cv2-grow{flex:1}.sax-catalog-v2 .cv2-pane>input,.sax-catalog-v2 .cv2-editor>input{flex:none;height:36px}.sax-catalog-v2 .cv2-pane>.cv2-row,.sax-catalog-v2 .cv2-pane>.cv2-muted{flex-shrink:0}.sax-catalog-v2 .cv2-row>input[type=number]{flex:none;min-width:76px;width:76px}.sax-catalog-v2 .cv2-muted{opacity:.68;font-size:12px}.sax-catalog-v2 .cv2-primary{background:var(--primary-background,#386cb8);color:white;border-color:transparent}
.sax-catalog-v2 .cv2-layout{display:grid;grid-template-columns:minmax(260px,.8fr) minmax(360px,1.4fr);gap:20px;min-height:0;flex:1}.sax-catalog-v2 .cv2-pane{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}.sax-catalog-v2 .cv2-pane+div{border-left:1px solid var(--border-color,#45454b);padding-left:20px}
.sax-catalog-v2 .cv2-scroll{overflow:auto;min-height:0;flex:1;scrollbar-gutter:stable}.sax-catalog-v2 .cv2-list{max-height:38%;min-height:100px}.sax-catalog-v2 .cv2-item{display:flex;align-items:center;gap:8px;padding:7px 5px;border-bottom:1px solid var(--border-color,#45454b)}.sax-catalog-v2 .cv2-item[data-active=true]{background:color-mix(in srgb,var(--primary-background,#5686d6) 16%,transparent);border-radius:7px}.sax-catalog-v2 .cv2-item button{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;border:0;background:transparent}
.sax-catalog-v2 .cv2-card{border:1px solid var(--border-color,#45454b);border-radius:10px;padding:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:10px}.sax-catalog-v2 .cv2-card[data-off=true]{opacity:.55}.sax-catalog-v2 .cv2-editor{display:flex;flex-direction:column;gap:8px;padding:2px 4px 10px}.sax-catalog-v2 .cv2-candidate{padding-top:10px;border-top:1px solid var(--border-color,#45454b);margin-top:10px}.sax-catalog-v2 .cv2-error{color:var(--error-text,#ed9494);white-space:pre-wrap}.sax-catalog-v2 .cv2-status{min-height:20px}.sax-catalog-v2 summary{cursor:pointer}.sax-catalog-v2 pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;max-height:180px;overflow:auto;margin:6px 0}.sax-catalog-v2 label{display:flex;align-items:center;gap:6px}.sax-catalog-v2 .cv2-empty{padding:24px 8px;opacity:.65;line-height:1.8}.sax-catalog-v2 .cv2-warning{font-size:12px;color:var(--error-text,#ed9494)}
@media(max-width:760px){.sax-catalog-v2>div{padding:12px!important}.sax-catalog-v2 .cv2-layout{display:flex;flex-direction:column;overflow:auto}.sax-catalog-v2 .cv2-pane{min-height:380px;flex-shrink:0}.sax-catalog-v2 .cv2-pane+div{padding:14px 0 0;border-left:0;border-top:1px solid var(--border-color,#45454b)}.sax-catalog-v2 .cv2-list{max-height:170px}}
`;

function el(tag, className = "", text = "") {
    const node = document.createElement(tag); node.className = className;
    if (text) node.textContent = text;
    return node;
}
function button(text, callback, options = {}) {
    const b = el("button", options.primary ? "cv2-primary" : "", text);
    b.type = "button"; b.disabled = Boolean(options.disabled);
    b.addEventListener("click", callback); return b;
}
function row(...children) { const r = el("div", "cv2-row"); r.append(...children); return r; }
function hint(text) { return el("span", "cv2-muted", text); }
function widget(node) { return node.widgets?.find(w => w.name === "config_json"); }
function seed(node) { return node.widgets?.find(w => w.name === "seed")?.value; }
function stateFor(node) {
    let state = states.get(node);
    if (!state) {
        state = { selected: new Set(), activeItem: null, query: "", tag: "", tagQuery: "", openGroups: new Set(), pages: new Map(), scroll: new Map(), history: null, result: null, close: null, refresh: null, status: null, flush: null };
        states.set(node, state);
    }
    return state;
}

function openCatalog(node) {
    const state = stateFor(node);
    if (state.close) { state.close.show(); return; }
    let config;
    try { config = parseConfig(widget(node)?.value); }
    catch (error) {
        state.close = showDialog({ title: "SAX Text Catalog V2", className: "sax-catalog-v2", width: 700, onClose: () => { state.close = null; }, build(dlg, close) {
            dlg.append(el("p", "cv2-error", `${error.message}\nデータを保護するため編集を停止しました。config_json またはワークフローの元データを修正して再度開いてください。`), button("閉じる", close));
        } });
        return;
    }
    if (!state.history || state.history.current !== widget(node).value) state.history = new EditHistory(widget(node).value);
    const recipe = () => config.recipes.find(r => r.id === config.active_recipe_id);
    let content, status, preview, undoButton, redoButton;
    let referenceCounts = new Map();
    let itemMap = new Map(config.catalog.items.map(item => [item.id, item]));
    let listObserver = null;
    let pendingKey = null;
    const report = (message, error = false) => { status.textContent = message; status.classList.toggle("cv2-error", error); };
    const buffer = new BufferedJson(widget(node), () => {
        try { validateConfig(config); }
        catch (error) {
            config = parseConfig(widget(node).value); report(`未反映: ${error.message}`, true);
            queueMicrotask(() => { if (state.close) render(); });
            return config;
        }
        return config;
    }, raw => { state.history.record(raw, pendingKey); updateHistory(); renderPreview(); });
    state.flush = () => buffer.flush();
    const serializeValue = widget(node).serializeValue;
    widget(node).serializeValue = () => buffer.flush();
    const commit = (change, key = null, redraw = true) => {
        if (!redraw) {
            if (pendingKey !== key) buffer.flush();
            pendingKey = key;
            change(config); buffer.changed(); syncFields();
            report("ノードに自動反映 · ワークフローの保存は別途必要です");
            node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
            return true;
        }
        buffer.flush(); pendingKey = null;
        const next = structuredClone(config);
        try { change(next); validateConfig(next); }
        catch (error) { report(`未反映: ${error.message}`, true); return false; }
        const raw = JSON.stringify(next);
        state.history.record(raw, key);
        config = next;
        widget(node).value = raw;
        node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
        report("ノードに反映済み · ワークフローの保存は別途必要です");
        if (redraw) render(); else { syncFields(); renderPreview(); updateHistory(); }
        return true;
    };
    const updateHistory = () => { undoButton.disabled = !state.history.undoStack.length; redoButton.disabled = !state.history.redoStack.length; };
    const restore = direction => {
        buffer.flush(); pendingKey = null;
        const raw = state.history[direction](); if (raw === null) return;
        config = parseConfig(raw); widget(node).value = raw;
        node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
        report(direction === "undo" ? "元に戻しました" : "やり直しました"); render();
    };
    const field = (value, label, focusKey, onInput, { area = false, type = "text", max = LIMITS.name, bind, search = false } = {}) => {
        const input = el(area ? "textarea" : "input", "cv2-grow");
        if (!area) input.type = type;
        input.value = value; input.setAttribute("aria-label", label); input.placeholder = label;
        input.dataset.focus = focusKey;
        if (type === "number") { input.min = "0"; input.max = String(LIMITS.items); input.step = "1"; }
        else input.maxLength = max;
        if (bind) input.dataset.bind = bind;
        input.addEventListener("input", event => { if (!search || !event.isComposing) onInput(input.value); });
        if (search) input.addEventListener("compositionend", () => onInput(input.value));
        input.addEventListener("blur", () => { buffer.flush(); state.history.boundary(); pendingKey = null; });
        return input;
    };
    const itemField = (item, prop, where, area = false) => field(item[prop], prop === "text" ? "本文" : "素材名", `${where}:${item.id}:${prop}`,
        value => commit(next => { next.catalog.items.find(i => i.id === item.id)[prop] = value; }, `${where}:${item.id}:${prop}`, false),
        { area, max: area ? LIMITS.text : LIMITS.name, bind: `${item.id}:${prop}` });
    const syncFields = () => {
        for (const input of content.querySelectorAll("[data-bind]")) {
            if (input === document.activeElement) continue;
            const at = input.dataset.bind.lastIndexOf(":");
            const id = input.dataset.bind.slice(0, at), prop = input.dataset.bind.slice(at + 1);
            const item = itemMap.get(id);
            if (item) input.value = item[prop];
        }
        for (const label of content.querySelectorAll("[data-itemname]")) label.textContent = itemMap.get(label.dataset.itemname)?.name || "無題の素材";
        for (const label of content.querySelectorAll("[data-recipename]")) label.textContent = config.recipes.find(r => r.id === label.dataset.recipename)?.name || "無題の組み合わせ";
    };
    const selectedIds = () => config.catalog.items.filter(i => state.selected.has(i.id)).map(i => i.id);
    const addGroup = mode => {
        const ids = selectedIds(); const id = newId();
        if (commit(next => next.recipes.find(r => r.id === next.active_recipe_id).groups.push({ id, name: mode === "random" ? "ランダム選択" : "固定テキスト", mode, item_ids: ids, count: 1, on: true }))) {
            state.openGroups.add(id); render();
        }
    };
    const editGroup = (id, change, key = null, redraw = true) => commit(next => change(next.recipes.find(r => r.id === next.active_recipe_id).groups.find(g => g.id === id)), key, redraw);
    const moveGroup = (id, delta) => commit(next => {
        const groups = next.recipes.find(r => r.id === next.active_recipe_id).groups;
        const at = groups.findIndex(g => g.id === id); const to = at + delta;
        if (to >= 0 && to < groups.length) [groups[at], groups[to]] = [groups[to], groups[at]];
    });
    const renderPreview = () => {
        if (!preview) return;
        preview.replaceChildren();
        for (const warning of recipeWarnings(config)) preview.append(el("div", "cv2-warning", warning));
        const enabled = recipe().groups.filter(g => g.on);
        const items = new Map(config.catalog.items.map(i => [i.id, i]));
        const random = enabled.some(g => g.mode === "random");
        if (!random) {
            const parts = []; let length = 0;
            outer: for (const group of enabled) for (const id of group.item_ids) {
                const text = items.get(id).text.trim();
                if (text) { parts.push(text.slice(0, Math.max(0, 6000 - length))); length += text.length; }
                if (length >= 6000) { parts.push("…（プレビューを省略・出力は全文）"); break outer; }
            }
            preview.append(hint("出力プレビュー"), el("pre", "", parts.join("\n") || "（空の出力）"));
        }
        else preview.append(hint("ランダムの確定結果はワークフロー実行後に表示 · 同じseedで再現 · グループ内は重複なし"));
        if (state.result) {
            const fresh = !buffer.dirty && state.result.config === widget(node).value && String(state.result.seed) === String(seed(node));
            preview.append(hint(fresh ? "最新の実行結果" : "前回の実行結果（設定またはseed変更後・未更新）"), el("pre", "", (state.result.text || "（空の出力）").slice(0, 6000)));
            const details = el("details"); details.append(el("summary", "cv2-muted", "抽選結果の詳細（先頭6000文字）"), el("pre", "", state.result.selection.slice(0, 6000))); preview.append(details);
        }
    };

    function renderLibrary(pane) {
        pane.append(row(el("strong", "", "ライブラリ"), hint(`${config.catalog.items.length} / ${LIMITS.items}件`), button("＋ 新規", () => {
            const id = newId();
            if (commit(next => next.catalog.items.push({ id, name: "新しい素材", text: "", tags: [] }))) {
                state.activeItem = id; state.query = ""; state.tag = ""; render();
                content.querySelector(`[data-focus="library:${id}:name"]`)?.focus();
            }
        }, { disabled: config.catalog.items.length >= LIMITS.items })));
        const search = field(state.query, "名前・本文・タグを検索", "search", value => { state.query = value; render(); }, { search: true });
        const tags = el("select"); tags.setAttribute("aria-label", "タグで絞り込み"); tags.dataset.focus = "tag-filter";
        tags.append(new Option("すべてのタグ", ""));
        const allTags = [...new Set(config.catalog.items.flatMap(i => i.tags))].sort();
        const visibleTags = allTags.filter(tag => tag.toLocaleLowerCase().includes(state.tagQuery.toLocaleLowerCase())).slice(0, 12);
        if (state.tag && !visibleTags.includes(state.tag)) visibleTags.unshift(state.tag);
        for (const tag of visibleTags) tags.append(new Option(tag, tag));
        tags.value = state.tag; tags.addEventListener("change", () => { state.tag = tags.value; render(); });
        pane.append(search, row(field(state.tagQuery, "タグを検索", "tag-search", value => { state.tagQuery = value; render(); }, { search: true }), tags));
        if (allTags.length > 12) pane.append(hint(`タグ${allTags.length}種類 · 検索結果の先頭12件を表示`));
        const visible = filteredItems(config, state.query, state.tag);
        pane.append(row(button("表示中を選択", () => { for (const item of visible) state.selected.add(item.id); render(); }, { disabled: !visible.length }), button("選択解除", () => { state.selected.clear(); render(); }, { disabled: !state.selected.size }), hint(`${selectedIds().length}件選択`)));
        const list = el("div", "cv2-scroll cv2-list"); list.dataset.scroll = "items";
        if (!visible.length) list.append(el("div", "cv2-empty", config.catalog.items.length ? "一致する素材がありません" : "「＋ 新規」で素材を作成します。\n素材を選択して組み合わせに追加できます。"));
        const paintRows = () => {
            if (!visible.length) return;
            const { start, end, top, bottom } = visibleWindow(visible.length, list.scrollTop, list.clientHeight || 220);
            list.replaceChildren();
            const before = el("div"); before.style.height = `${top}px`; list.append(before);
            for (const item of visible.slice(start, end)) {
                const line = el("div", "cv2-item"); line.style.height = "40px"; line.dataset.active = String(item.id === state.activeItem);
                const check = el("input"); check.type = "checkbox"; check.checked = state.selected.has(item.id); check.setAttribute("aria-label", `${item.name}を選択`);
                check.addEventListener("change", () => { if (check.checked) state.selected.add(item.id); else state.selected.delete(item.id); render(); });
                const choose = button(item.name || "無題の素材", () => { state.activeItem = item.id; render(); });
                choose.dataset.itemname = item.id;
                choose.title = item.text.slice(0, 500); line.append(check, choose, hint(`${referenceCounts.get(item.id) || 0}件で使用`)); list.append(line);
            }
            const after = el("div"); after.style.height = `${bottom}px`; list.append(after);
        };
        list.addEventListener("scroll", paintRows); paintRows();
        if (typeof ResizeObserver !== "undefined") { listObserver = new ResizeObserver(paintRows); listObserver.observe(list); }
        pane.append(list);
        const selected = selectedIds();
        if (selected.length) {
            pane.append(row(button("固定で追加", () => addGroup("all"), { disabled: recipe().groups.length >= LIMITS.groups }), button("ランダムで追加", () => addGroup("random"), { primary: true, disabled: recipe().groups.length >= LIMITS.groups })));
            const bulkTag = field("", "一括追加するタグ（カンマ区切り）", "bulk-tags", () => {});
            pane.append(row(bulkTag, button("タグ追加", () => {
                const added = parseTags(bulkTag.value);
                commit(next => { for (const item of next.catalog.items) if (state.selected.has(item.id)) item.tags = [...new Set([...item.tags, ...added])]; });
            }), button("削除", async () => {
                const count = selected.reduce((n, id) => n + (referenceCounts.get(id) || 0), 0);
                if (await showConfirmDialog({ title: "素材を削除", message: `${selected.length}件の素材を削除します。${count}件のグループ参照からも外れます。Undoで戻せます。`, danger: true, okLabel: "削除", cancelLabel: "キャンセル" })) {
                    if (!state.close) return;
                    commit(next => removeItems(next, selected)); state.selected.clear(); render();
                }
            })));
        }
        const active = config.catalog.items.find(i => i.id === state.activeItem);
        const editor = el("div", "cv2-scroll cv2-editor"); editor.dataset.scroll = "editor";
        if (active) {
            editor.append(row(hint("素材を直接編集"), hint(`使用${referenceCounts.get(active.id) || 0}件に反映`), button("複製", () => {
                const copy = { ...structuredClone(active), id: newId(), name: `${active.name.slice(0, 250)} コピー` };
                if (commit(next => next.catalog.items.push(copy))) { state.activeItem = copy.id; render(); }
            }, { disabled: config.catalog.items.length >= LIMITS.items })), itemField(active, "name", "library"), itemField(active, "text", "library", true));
            editor.append(field(active.tags.join(", "), "タグ（カンマ区切り・最大8件）", `tags:${active.id}`, value => {
                const parsed = parseTags(value);
                if (parsed.length > LIMITS.tags || parsed.some(tag => [...tag].length > LIMITS.name)) { report("未反映: タグは8件・各256文字までです", true); return; }
                commit(next => { next.catalog.items.find(i => i.id === active.id).tags = parsed; }, `tags:${active.id}`, false);
            }, { max: 8 * (LIMITS.name + 2) }));
        } else editor.append(el("div", "cv2-empty", "素材名をクリックすると、ここで本文を編集できます。"));
        pane.append(editor);
    }

    function renderRecipe(pane) {
        const current = recipe();
        const select = el("select", "cv2-grow"); select.setAttribute("aria-label", "組み合わせ");
        for (const item of config.recipes) { const option = new Option(item.name || "無題の組み合わせ", item.id); option.dataset.recipename = item.id; select.append(option); }
        select.value = current.id; select.addEventListener("change", () => commit(next => { next.active_recipe_id = select.value; }));
        pane.append(row(el("strong", "", "組み合わせ"), select, button("＋", () => commit(next => {
            const id = newId(); next.recipes.push({ id, name: `組み合わせ ${next.recipes.length + 1}`, groups: [] }); next.active_recipe_id = id;
        }), { disabled: config.recipes.length >= LIMITS.recipes })));
        pane.append(row(field(current.name, "組み合わせ名", `recipe:${current.id}`, value => commit(next => { next.recipes.find(r => r.id === current.id).name = value; }, `recipe:${current.id}`, false)), button("複製", () => commit(next => {
            const copy = structuredClone(current); copy.id = newId(); copy.name = `${copy.name.slice(0, 250)} コピー`; copy.groups.forEach(g => { g.id = newId(); }); next.recipes.push(copy); next.active_recipe_id = copy.id;
        }), { disabled: config.recipes.length >= LIMITS.recipes }), button("削除", async () => {
            if (await showConfirmDialog({ title: "組み合わせを削除", message: "この組み合わせを削除します。素材はライブラリに残ります。Undoで戻せます。", danger: true, okLabel: "削除", cancelLabel: "キャンセル" })) {
                if (!state.close) return;
                commit(next => { next.recipes = next.recipes.filter(r => r.id !== current.id); next.active_recipe_id = next.recipes[0].id; });
            }
        }, { disabled: config.recipes.length === 1 })));
        const groups = el("div", "cv2-scroll"); groups.dataset.scroll = "groups";
        if (!current.groups.length) groups.append(el("div", "cv2-empty", "左で素材を選び、「固定で追加」または「ランダムで追加」。\n複数グループを上から順に結合します。"));
        for (const [index, group] of current.groups.entries()) {
            const card = el("div", "cv2-card"); card.dataset.off = String(!group.on);
            const enabled = el("input"); enabled.type = "checkbox"; enabled.checked = group.on; enabled.setAttribute("aria-label", "グループを有効化");
            enabled.addEventListener("change", () => editGroup(group.id, g => { g.on = enabled.checked; }));
            card.append(row(enabled, field(group.name, "グループ名", `group:${group.id}`, value => editGroup(group.id, g => { g.name = value; }, `group:${group.id}`, false)), button("↑", () => moveGroup(group.id, -1), { disabled: !index }), button("↓", () => moveGroup(group.id, 1), { disabled: index === current.groups.length - 1 }), button("外す", () => commit(next => { const r = next.recipes.find(r => r.id === next.active_recipe_id); r.groups = r.groups.filter(g => g.id !== group.id); }))));
            const mode = el("select"); mode.setAttribute("aria-label", "選択方式"); mode.append(new Option("すべて使用", "all"), new Option("ランダム選択", "random")); mode.value = group.mode;
            mode.addEventListener("change", () => editGroup(group.id, g => { g.mode = mode.value; }));
            const modeRow = row(mode, hint(`候補 ${group.item_ids.length}件`));
            if (group.mode === "random") modeRow.append(field(group.count, "抽選する件数", `count:${group.id}`, value => {
                if (value === "" || !/^\d+$/.test(value) || Number(value) > LIMITS.items) { report("未反映: 抽選数は0〜10000の整数で指定してください", true); return; }
                editGroup(group.id, g => { g.count = Number(value); }, `count:${group.id}`, false);
            }, { type: "number" }), hint("件を選ぶ"));
            card.append(modeRow);
            card.append(row(button("左の選択を候補に設定", () => editGroup(group.id, g => { g.item_ids = selectedIds(); }), { disabled: !selectedIds().length }), button("左で候補を選択", () => { state.selected = new Set(group.item_ids); state.query = ""; state.tag = ""; render(); })));
            const candidates = el("details"); candidates.open = state.openGroups.has(group.id) || group.item_ids.length === 1;
            candidates.addEventListener("toggle", () => {
                if (!candidates.isConnected) return;
                const wasOpen = state.openGroups.has(group.id);
                if (candidates.open) state.openGroups.add(group.id); else state.openGroups.delete(group.id);
                if (candidates.open && !wasOpen && group.item_ids.length !== 1) render();
            });
            const names = group.item_ids.slice(0, 4).map(id => itemMap.get(id)?.name || "無題");
            candidates.append(el("summary", "cv2-muted", names.length ? `${names.join(" · ")}${group.item_ids.length > 4 ? ` … 全${group.item_ids.length}件` : ""}` : "候補がありません"));
            const page = Math.min(state.pages.get(group.id) || 0, Math.max(0, Math.ceil(group.item_ids.length / 20) - 1));
            if (group.item_ids.length > 20) candidates.append(row(button("前の20件", () => { state.pages.set(group.id, page - 1); render(); }, { disabled: page === 0 }), hint(`${page * 20 + 1}–${Math.min((page + 1) * 20, group.item_ids.length)} / ${group.item_ids.length}件`), button("次の20件", () => { state.pages.set(group.id, page + 1); render(); }, { disabled: (page + 1) * 20 >= group.item_ids.length })));
            for (const [offset, id] of (candidates.open ? group.item_ids.slice(page * 20, (page + 1) * 20) : []).entries()) {
                const at = page * 20 + offset;
                const item = itemMap.get(id);
                const candidate = el("div", "cv2-candidate cv2-editor");
                candidate.append(row(itemField(item, "name", group.id), hint(`使用${referenceCounts.get(id) || 0}件に反映`)), itemField(item, "text", group.id, true));
                candidate.append(row(button("複製して差し替え", () => commit(next => {
                    const original = next.catalog.items.find(i => i.id === id); const copy = { ...structuredClone(original), id: newId(), name: `${original.name.slice(0, 250)} コピー` };
                    next.catalog.items.push(copy); next.recipes.find(r => r.id === next.active_recipe_id).groups.find(g => g.id === group.id).item_ids[at] = copy.id;
                }), { disabled: config.catalog.items.length >= LIMITS.items }), button("↑", () => editGroup(group.id, g => { [g.item_ids[at - 1], g.item_ids[at]] = [g.item_ids[at], g.item_ids[at - 1]]; }), { disabled: !at }), button("↓", () => editGroup(group.id, g => { [g.item_ids[at + 1], g.item_ids[at]] = [g.item_ids[at], g.item_ids[at + 1]]; }), { disabled: at === group.item_ids.length - 1 }), button("候補から外す", () => editGroup(group.id, g => { g.item_ids = g.item_ids.filter(value => value !== id); }))));
                candidates.append(candidate);
            }
            card.append(candidates); groups.append(card);
        }
        pane.append(groups);
        preview = el("div"); pane.append(preview); renderPreview();
    }

    function render() {
        const active = document.activeElement;
        const focus = active?.dataset?.focus;
        const selection = focus && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
        const scroll = content.children.length ? new Map([...content.querySelectorAll("[data-scroll]")].map(e => [e.dataset.scroll, e.scrollTop])) : state.scroll;
        listObserver?.disconnect(); listObserver = null;
        content.replaceChildren();
        itemMap = new Map(config.catalog.items.map(item => [item.id, item]));
        const itemIds = new Set(config.catalog.items.map(i => i.id));
        referenceCounts = new Map();
        for (const r of config.recipes) for (const g of r.groups) for (const id of g.item_ids) referenceCounts.set(id, (referenceCounts.get(id) || 0) + 1);
        for (const id of state.selected) if (!itemIds.has(id)) state.selected.delete(id);
        if (!config.catalog.items.some(i => i.id === state.activeItem)) state.activeItem = config.catalog.items[0]?.id ?? null;
        const left = el("div", "cv2-pane"), right = el("div", "cv2-pane"); content.append(left, right);
        renderLibrary(left); renderRecipe(right); updateHistory();
        for (const target of content.querySelectorAll("[data-scroll]")) if (scroll.has(target.dataset.scroll)) { target.scrollTop = scroll.get(target.dataset.scroll); target.dispatchEvent(new Event("scroll")); }
        if (focus) {
            const input = [...content.querySelectorAll("[data-focus]")].find(e => e.dataset.focus === focus);
            input?.focus({ preventScroll: true }); if (selection && input?.setSelectionRange) input.setSelectionRange(...selection);
        }
    }

    state.close = showDialog({ title: "SAX Text Catalog V2", className: "sax-catalog-v2", width: 1180, maxHeight: "94vh", gap: 12,
        onClose: () => {
            if (state.discard) buffer.cancel(); else buffer.flush();
            state.scroll = new Map([...content.querySelectorAll("[data-scroll]")].map(e => [e.dataset.scroll, e.scrollTop]));
            listObserver?.disconnect(); widget(node).serializeValue = serializeValue;
            state.close = null; state.refresh = null; state.status = null; state.flush = null;
        },
        build(dlg, close) {
            const style = el("style"); style.textContent = STYLE; dlg.append(style);
            undoButton = button("元に戻す", () => restore("undo")); redoButton = button("やり直す", () => restore("redo"));
            dlg.append(row(hint("直接編集・自動反映"), undoButton, redoButton, button("閉じる", close)));
            content = el("div", "cv2-layout"); status = el("div", "cv2-status cv2-muted"); dlg.append(content, status);
            report("ノードに自動反映 · ワークフローの保存は別途必要です");
            // テキスト入力中のCtrl+Zはブラウザの編集履歴を維持する。
            dlg.addEventListener("keydown", event => {
                if (event.isComposing) return;
                if (event.key === "Escape") { event.preventDefault(); close(); }
                else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !["INPUT", "TEXTAREA"].includes(event.target.tagName)) {
                    event.preventDefault(); restore(event.shiftKey ? "redo" : "undo");
                }
            });
            render();
        },
    });
    state.refresh = renderPreview;
    state.status = report;
}

function initialize(node) {
    const value = widget(node);
    if (value) hideWidget(value, { mode: "minimal" });
    if (!node.widgets?.some(w => w.name === "カタログを開く")) node.addWidget("button", "カタログを開く", null, () => openCatalog(node), { serialize: false });
    node.size[0] = Math.max(node.size[0] ?? 0, 310);
    const seedWidget = node.widgets?.find(w => w.name === "seed");
    if (seedWidget && !seedWidget._saxV2Chained) {
        const callback = seedWidget.callback;
        seedWidget.callback = function (...args) { const result = callback?.apply(this, args); states.get(node)?.refresh?.(); return result; };
        seedWidget._saxV2Chained = true;
    }
}

app.registerExtension({
    name: "SAX.TextCatalogV2",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () { const result = created?.apply(this, arguments); initialize(this); return result; };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const state = states.get(this); if (state) state.discard = true;
            state?.close?.(); states.delete(this);
            const result = configure?.apply(this, arguments); initialize(this); return result;
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () { states.get(this)?.close?.(); states.delete(this); return removed?.apply(this, arguments); };
        const serialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            states.get(this)?.flush?.();
            // LiteGraphはonSerialize前にwidgets_valuesを採取する版がある。
            const result = serialize?.apply(this, arguments);
            const index = this.widgets?.findIndex(w => w.name === "config_json");
            if (index >= 0 && data.widgets_values) data.widgets_values[index] = widget(this).value;
            return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = executed?.apply(this, arguments);
            const state = stateFor(this);
            state.result = { text: message.text?.[0] ?? "", selection: message.selection_json?.[0] ?? "", config: message.config_json?.[0], seed: message.seed?.[0] };
            state.refresh?.(); return result;
        };
    },
});
