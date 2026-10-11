import { newId } from "./sax_text_catalog_v2_model.js";
import { PAD, GAP, ROW_H, HEADER_H, BTN_RADIUS, getComfyTheme } from "./sax_ui_base.js";

const CSS = `
.sax-shared-sets{width:100%;box-sizing:border-box;color:var(--input-text,var(--ssw-text,#ddd));font:11px/16px sans-serif;padding:0 ${PAD + 7}px 4px;background:transparent;display:flex;flex-direction:column;gap:${GAP}px;overflow:visible}
.sax-shared-sets *{box-sizing:border-box}
.sax-shared-sets .ssw-heading{font:600 12px/${HEADER_H}px sans-serif;margin:0}
.sax-shared-sets .ssw-list{display:flex;flex-direction:column;gap:${GAP}px}
.sax-shared-sets .ssw-entry{padding:2px 0;background:transparent;display:flex;align-items:center;gap:${GAP}px;min-width:0;flex-wrap:nowrap}
.sax-shared-sets .ssw-entry[data-off=true]{opacity:.62}
.sax-shared-sets .ssw-entry[data-drop=true]{outline:2px solid var(--primary-background,#5686d6)}
.sax-shared-sets .ssw-entry[data-drag=true]{opacity:.4}
.sax-shared-sets select,.sax-shared-sets button{font:inherit;color:inherit;border:1px solid var(--border-color,#45454b);border-radius:${BTN_RADIUS}px;background:var(--comfy-input-bg,#222222);padding:1px 6px;min-width:0;height:${ROW_H}px}
.sax-shared-sets button{cursor:pointer;white-space:nowrap}
.sax-shared-sets button:hover{border-color:var(--primary-background,#5686d6)}
.sax-shared-sets button:disabled{opacity:.4;cursor:default}
.sax-shared-sets :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:1px}
.sax-shared-sets select{flex:1;width:0;text-overflow:ellipsis}
.sax-shared-sets input[type=checkbox]{width:15px;height:15px;margin:0;flex:none;accent-color:var(--primary-background,#5686d6)}
.sax-shared-sets .ssw-handle{cursor:grab;touch-action:none;width:20px;padding:0;flex:none;border-color:transparent;background:transparent;font-size:17px}
.sax-shared-sets .ssw-remove{width:${ROW_H}px;padding:0;flex:none;font-size:16px}
.sax-shared-sets .ssw-edit{flex:none;width:${ROW_H}px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.sax-shared-sets .ssw-edit svg{width:16px;height:16px;pointer-events:none}
.sax-shared-sets .ssw-add{width:100%}
.sax-shared-sets .ssw-message{font-size:11px;opacity:.7;line-height:17px}
.sax-shared-sets .ssw-error{color:var(--error-text,#ed9494);opacity:1;white-space:pre-wrap}
.sax-shared-sets .ssw-live{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
`;

function element(tag, cls = "", text = "") { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; }
function button(label, cls) { const n = element("button", cls, label); n.type = "button"; return n; }
function editIcon(title, path) {
    const n = button("", "ssw-edit"); n.title = title;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path"); shape.setAttribute("d", path); svg.append(shape); n.append(svg); return n;
}
const ROW_ESTIMATE = ROW_H + 4 + GAP;

/** Catalog actions share one row; set count does not affect their position. */
export function makeSharedCatalogWidget(node, { chooseCatalog, openItems, openManagement }) {
    const panel = element("div", "sax-shared-catalog");
    const style = element("style"); style.textContent = `
    .sax-shared-catalog{box-sizing:border-box;width:100%;padding:0 ${PAD + 7}px;display:flex;gap:${GAP}px;color:var(--input-text,#ddd);font:11px/16px sans-serif}
    .sax-shared-catalog select,.sax-shared-catalog button{box-sizing:border-box;min-width:0;height:${ROW_H}px;border:1px solid var(--border-color,#45454b);border-radius:${BTN_RADIUS}px;background:var(--comfy-input-bg,#222222);color:inherit;font:inherit;padding:1px 6px}
    .sax-shared-catalog select{flex:1;width:0;text-overflow:ellipsis}.sax-shared-catalog button{flex:none;cursor:pointer}
    .sax-shared-catalog :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:1px}
    `;
    const select = element("select"); select.setAttribute("aria-label", "カタログを選択");
    const items = button("アイテム"), menu = button("⋯");
    menu.style.width = `${ROW_H}px`; menu.style.padding = "0"; menu.style.fontSize = "16px";
    menu.title = "カタログ作成・入出力"; menu.setAttribute("aria-label", "カタログ作成・入出力");
    select.onchange = () => chooseCatalog(select.value); items.onclick = openItems; menu.onclick = openManagement;
    panel.append(style, select, items, menu);
    for (const event of ["pointerdown", "mousedown", "dblclick", "wheel", "keydown", "keyup"]) panel.addEventListener(event, e => e.stopPropagation());
    const height = ROW_H;
    for (const name of ["min-height", "max-height", "height"]) panel.style.setProperty(`--comfy-widget-${name}`, `${height}px`);
    const widget = node.addDOMWidget("__sax_shared_catalog", "sax-shared-catalog", panel, {
        serialize: false, hideOnZoom: false, selectOn: [], margin: 0,
        getMinHeight: () => height, getMaxHeight: () => height, getHeight: () => height, getValue: () => "",
    });
    widget.serialize = false; widget.options = { ...widget.options, serialize: false }; widget.computeSize = width => [width, height];
    function refresh(catalogs, id) {
        select.replaceChildren();
        const placeholder = element("option", "", "カタログを選択／作成"); placeholder.value = ""; placeholder.disabled = true; select.append(placeholder);
        for (const catalog of catalogs) { const option = element("option", "", `${catalog.name} · ${catalog.id.slice(0, 8)}`); option.value = catalog.id; select.append(option); }
        select.value = catalogs.some(c => c.id === id) ? id : "";
    }
    refresh([], "");
    return { widget, refresh, dispose: () => panel.remove() };
}

/** The workflow stores references only. Unselected draft rows stay in this widget. */
export function makeSharedSetWidget(node, { readRows, readRecipes, writeRows, openSet, openItems, onResize, readCatalogId, showHeading = true }) {
    const panel = element("div", "sax-shared-sets"); const style = element("style"); style.textContent = CSS;
    const heading = element("h3", "ssw-heading", "使用するテキストセット");
    heading.hidden = !showHeading;
    const list = element("div", "ssw-list"), message = element("div", "ssw-message"), live = element("div", "ssw-live"); live.setAttribute("aria-live", "polite");
    const add = button("＋ テキストセットを追加", "ssw-add"); panel.append(style, heading, list, message, add, live);
    panel.dataset.saxWidget = "shared-sets";
    const drafts = new Map(), elements = new Map(); let disposed = false, drag = null, frame = null, lastHeight = 0, catalogId = readCatalogId?.();
    const rows = () => readRows() ?? [];
    const displayRows = () => [...rows(), ...drafts.values()];
    const fail = error => { message.textContent = error?.message ?? String(error); message.hidden = false; message.classList.add("ssw-error"); resize(); };
    function commit(next) {
        try { const result = writeRows(next); if (result?.catch) result.catch(fail); message.classList.remove("ssw-error"); refresh(); }
        catch (error) { fail(error); }
    }
    function update(id, change) {
        const draft = drafts.get(id); if (draft) { change(draft); refresh(); return; }
        const next = rows().map(row => ({ ...row })); const target = next.find(row => row.id === id); if (!target) return; change(target); commit(next);
    }
    function remove(id) { if (drafts.delete(id)) refresh(); else commit(rows().filter(row => row.id !== id)); }
    function selectRecipe(id, recipeId) {
        if (!recipeId || !(readRecipes() ?? []).some(recipe => recipe.id === recipeId)) { refresh(); return; }
        const draft = drafts.get(id);
        if (draft) { const next = [...rows(), { id, recipe_id: recipeId, on: draft.on }]; drafts.delete(id); commit(next); }
        else update(id, row => { row.recipe_id = recipeId; });
    }
    function move(id, targetId) {
        if (id === targetId || drafts.has(id) || drafts.has(targetId)) return;
        const next = rows().map(row => ({ ...row })); const from = next.findIndex(row => row.id === id), to = next.findIndex(row => row.id === targetId); if (from < 0 || to < 0) return;
        const [moved] = next.splice(from, 1); next.splice(to, 0, moved); commit(next); live.textContent = `${to + 1}番目へ移動しました`;
    }
    function moveKeyboard(id, direction) {
        const current = rows(), from = current.findIndex(row => row.id === id), target = current[from + direction]; if (!target) return;
        move(id, target.id); elements.get(id)?.handle.focus();
    }
    function clearDrag() { for (const value of elements.values()) { delete value.root.dataset.drag; delete value.root.dataset.drop; } drag = null; }
    function targetAt(x, y) { return document.elementFromPoint(x, y)?.closest(".ssw-entry")?.dataset.rowId; }
    function highlight(id) { for (const [key, value] of elements) value.root.dataset.drop = String(key === id && key !== drag?.id && !drafts.has(key)); }
    function createRow(id) {
        const root = element("div", "ssw-entry"); root.dataset.rowId = id;
        const on = element("input"); on.type = "checkbox";
        const handle = button("≡", "ssw-handle"); handle.draggable = true; handle.setAttribute("aria-label", "ドラッグまたは上下キーで並び替え"); handle.title = "ドラッグで並び替え · 上下キーでも移動できます";
        const select = element("select"), del = button("×", "ssw-remove");
        const edit = editIcon("セット編集", "M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4");
        const items = editIcon("アイテム編集", "M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8M13 3v5h5M13 3l5 5M8 10h3M8 14h2M13 17l6-6 2 2-6 6-3 1 1-3");
        on.addEventListener("change", () => update(id, row => { row.on = on.checked; }));
        select.addEventListener("change", () => selectRecipe(id, select.value)); select.addEventListener("blur", () => refresh());
        del.addEventListener("click", () => remove(id));
        const open = callback => { const current = rows().find(row => row.id === id); if (!current || !(readRecipes() ?? []).some(recipe => recipe.id === current.recipe_id)) return; try { const result = callback(current.recipe_id); result?.catch?.(fail); } catch (error) { fail(error); } };
        edit.addEventListener("click", () => open(openSet)); items.addEventListener("click", () => open(openItems));
        handle.addEventListener("keydown", event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); moveKeyboard(id, event.key === "ArrowUp" ? -1 : 1); } });
        handle.addEventListener("pointerdown", event => { if (event.button !== 0 || drafts.has(id)) return; event.stopPropagation(); drag = { id, target: id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false }; handle.setPointerCapture?.(event.pointerId); });
        handle.addEventListener("pointermove", event => { if (!drag || drag.id !== id || drag.pointerId !== event.pointerId) return; if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4 && !drag.moved) return; event.preventDefault(); event.stopPropagation(); drag.moved = true; root.dataset.drag = "true"; const target = targetAt(event.clientX, event.clientY); if (target && !drafts.has(target)) drag.target = target; highlight(drag.target); });
        handle.addEventListener("pointerup", event => { if (!drag || drag.id !== id) return; event.stopPropagation(); const target = drag.target, moved = drag.moved; clearDrag(); if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId); if (moved) move(id, target); });
        handle.addEventListener("pointercancel", () => { if (!drag?.native) clearDrag(); });
        handle.addEventListener("dragstart", event => { if (drafts.has(id)) { event.preventDefault(); return; } event.stopPropagation(); drag = { id, target: id, native: true }; root.dataset.drag = "true"; event.dataTransfer?.setData("text/plain", id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; });
        root.addEventListener("dragover", event => { if (!drag || drafts.has(id)) return; event.preventDefault(); event.stopPropagation(); drag.target = id; highlight(id); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; });
        root.addEventListener("drop", event => { if (!drag || drafts.has(id)) return; event.preventDefault(); event.stopPropagation(); const source = drag.id; clearDrag(); move(source, id); }); handle.addEventListener("dragend", clearDrag);
        root.append(on, handle, select, edit, items, del); return { root, on, handle, select, del, edit, items, optionSignature: null };
    }
    function resize() {
        if (disposed) return; const count = displayRows().length;
        // Exact row count is used rather than a scroll cap. ResizeObserver refines wrapped messages.
        // Canvasのzoom変換後の画面座標ではなく、未拡縮のレイアウト寸法を使う。
        const height = Math.ceil(heading.offsetHeight + list.offsetHeight + add.offsetHeight + (message.hidden ? 0 : message.offsetHeight) + 4 + GAP * ((showHeading ? 2 : 1) + (message.hidden ? 0 : 1))) || 75 + count * ROW_ESTIMATE;
        panel.style.setProperty("--comfy-widget-min-height", `${height}px`); panel.style.setProperty("--comfy-widget-max-height", `${height}px`); panel.style.setProperty("--comfy-widget-height", `${height}px`);
        if (height !== lastHeight) { lastHeight = height; widget.computedHeight = height; onResize?.(); node.setDirtyCanvas?.(true, true); }
    }
    function scheduleResize() { if (frame !== null || disposed) return; frame = requestAnimationFrame(() => { frame = null; resize(); }); }
    function refresh() {
        if (disposed) return;
        const nextCatalogId = readCatalogId?.();
        if (nextCatalogId !== catalogId) { drafts.clear(); clearDrag(); catalogId = nextCatalogId; }
        const theme = getComfyTheme(); panel.style.setProperty("--ssw-text", theme.inputText); panel.style.setProperty("--ssw-menu", theme.menuBg);
        let current, recipes;
        try { current = displayRows(); recipes = readRecipes(); } catch (error) { fail(error); return; }
        const valid = new Set(current.map(row => row.id));
        for (const [id, value] of elements) if (!valid.has(id)) { value.root.remove(); elements.delete(id); }
        const recipeList = recipes ?? []; const recipesById = new Map(recipeList.map(recipe => [recipe.id, recipe]));
        const signature = JSON.stringify(recipeList.map(recipe => [recipe.id, recipe.name]));
        let missing = 0;
        for (const [index, currentRow] of current.entries()) {
            let value = elements.get(currentRow.id); if (!value) { value = createRow(currentRow.id); elements.set(currentRow.id, value); }
            const draft = drafts.has(currentRow.id); const recipe = recipesById.get(currentRow.recipe_id); if (!draft && !recipe && recipes !== null) missing++;
            const label = recipe?.name || (draft ? "追加するセット" : "参照先が見つからないセット");
            value.on.checked = currentRow.on; value.on.setAttribute("aria-label", `${label}を使用`); value.root.dataset.off = String(!currentRow.on);
            value.select.setAttribute("aria-label", `${label}のテキストセットを選択`); value.del.setAttribute("aria-label", `${label}を行から削除`);
            value.edit.setAttribute("aria-label", `${label}のセット編集`); value.items.setAttribute("aria-label", `${label}のアイテム編集`);
            const optionSignature = `${signature}:${currentRow.recipe_id}:${recipes === null}`;
            if (value.optionSignature !== optionSignature && document.activeElement !== value.select) {
                value.select.replaceChildren(); const placeholder = element("option", "", recipes === null ? "カタログを読み込み中…" : draft ? "テキストセットを選択…" : !recipe ? `参照先なし：${currentRow.recipe_id}` : "テキストセットを選択…"); placeholder.value = !draft && !recipe ? currentRow.recipe_id : ""; placeholder.disabled = !draft; value.select.append(placeholder);
                for (const r of recipeList) { const option = element("option", "", r.name || "名前なしのセット"); option.value = r.id; value.select.append(option); }
                value.select.value = currentRow.recipe_id; value.optionSignature = optionSignature;
            }
            value.select.disabled = recipes === null || !recipeList.length; value.edit.disabled = !recipe; value.items.disabled = !recipe; value.handle.disabled = draft;
            // Moving existing elements retains focus and avoids resetting native select interaction.
            const expected = list.children[index]; if (expected !== value.root) list.insertBefore(value.root, expected ?? null);
        }
        if (!message.classList.contains("ssw-error")) { message.textContent = recipes === null ? "カタログを読み込んでいます" : missing ? `${missing}行の参照先が見つかりません。セットを選び直してください。` : !current.length ? "使うセットを追加し、上から出力順に並べます" : drafts.size ? "セットを選択するとワークフローに追加されます" : ""; message.hidden = !message.textContent; }
        add.disabled = recipes === null; add.title = !recipeList.length ? "テキストセットの作成画面を開きます" : "";
        scheduleResize();
    }
    function addDraft() {
        const recipes = readRecipes(); if (recipes === null) return;
        if (!recipes.length) { try { openSet(null)?.catch?.(fail); } catch (error) { fail(error); } return; }
        const id = newId(); drafts.set(id, { id, recipe_id: "", on: true }); refresh(); queueMicrotask(() => elements.get(id)?.select.focus());
    }
    add.addEventListener("click", addDraft);
    // Node canvas listeners must not interpret a select, checkbox, or edit click as a node drag.
    const stop = event => event.stopPropagation(); for (const event of ["pointerdown", "mousedown", "dblclick", "wheel", "keydown", "keyup"]) panel.addEventListener(event, stop);
    const widget = node.addDOMWidget("__sax_shared_sets", "sax-shared-sets", panel, {
        serialize: false, hideOnZoom: false, selectOn: [], margin: 0,
        getMinHeight: () => lastHeight || 75 + displayRows().length * ROW_ESTIMATE,
        getMaxHeight: () => lastHeight || 75 + displayRows().length * ROW_ESTIMATE,
        getHeight: () => lastHeight || 75 + displayRows().length * ROW_ESTIMATE,
        getValue: () => "",
    });
    widget.serialize = false; widget.options = { ...widget.options, serialize: false }; widget.computeSize = width => [width, lastHeight || 75 + displayRows().length * ROW_ESTIMATE];
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleResize) : null; observer?.observe(panel);
    function dispose() { if (disposed) return; disposed = true; observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame); clearDrag(); drafts.clear(); elements.clear(); panel.remove(); }
    refresh(); return { widget, refresh, dispose, addDraft };
}
