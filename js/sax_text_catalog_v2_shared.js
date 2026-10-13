import { getComfyTheme, txt, autoResize, showDialog, showPromptDialog, showAlertDialog } from "./sax_ui_base.js";
import { listCatalogs, createCatalog, importCatalog, getSession } from "./sax_text_catalog_v2_client.js";
import { openSharedEditor } from "./sax_text_catalog_v2_editor.js";
import { sortedNamedOptions, newId } from "./sax_text_catalog_v2_model.js";
import { makeSharedSetWidget, makeSharedCatalogWidget } from "./sax_text_catalog_v2_widget.js";

const controls = new WeakMap();
const hidden = widget => { widget.serialize = false; widget.options = { ...widget.options, serialize: false }; return widget; };
export function readReference(node) {
    const ref = JSON.parse(node.widgets.find(w => w.name === "config_json").value);
    if (ref.version !== 3 || typeof ref.catalog_id !== "string" || !Array.isArray(ref.rows)) throw new Error("共有カタログの参照形式が不正です");
    const ids = new Set();
    if (ref.rows.length > 10000 || ref.catalog_id.length > 128) throw new Error("カタログ参照の上限を超えています");
    for (const row of ref.rows) {
        if (!row || typeof row.id !== "string" || !row.id || row.id.length > 128 || ids.has(row.id) || typeof row.recipe_id !== "string" || !row.recipe_id || row.recipe_id.length > 128 || typeof row.on !== "boolean") throw new Error("テキストセット行の参照が不正です");
        ids.add(row.id);
    }
    return ref;
}
export async function flushCatalogNodes(nodes) {
    const sessions = new Set();
    for (const node of nodes ?? []) {
        if (node.comfyClass !== "SAX_Bridge_Text_Catalog_V2" && node.type !== "SAX_Bridge_Text_Catalog_V2") continue;
        const raw = JSON.parse(node.widgets.find(w => w.name === "config_json")?.value ?? "{}");
        if (raw.version === 3 && raw.catalog_id) sessions.add(await getSession(raw.catalog_id));
    }
    await Promise.all([...sessions].map(session => session.flush()));
}
export async function flushCatalogPrompt(output) {
    const ids = new Set();
    for (const entry of Object.values(output ?? {})) {
        if (entry.class_type !== "SAX_Bridge_Text_Catalog_V2" || typeof entry.inputs?.config_json !== "string") continue;
        const ref = JSON.parse(entry.inputs.config_json);
        if (ref.version === 3 && ref.catalog_id) ids.add(ref.catalog_id);
    }
    await Promise.all([...ids].map(async id => (await getSession(id)).flush()));
}
export function installSharedControls(node) {
    if (controls.has(node)) { controls.get(node).reload(); return; }
    const controller = { session: null, catalogs: [], unsubscribe: null, result: null, token: 0, disposed: false };
    controls.set(node, controller);
    const report = error => showAlertDialog({ title: "Text Catalog V2", message: error.message });
    const act = fn => (...args) => Promise.resolve().then(() => { if (!controller.disposed) return fn(...args); }).catch(error => { if (!controller.disposed) return report(error); });
    const configWidget = node.widgets.find(w => w.name === "config_json");
    const write = ref => { configWidget.value = JSON.stringify(ref); node.graph?.change?.(); redraw(); };
    const redraw = () => { controller.setWidget?.refresh(); node.setDirtyCanvas?.(true, true); if (node.graph && node.computeSize && node.setSize) autoResize(node); };
    const choose = (title, entries, callback) => showDialog({ title, width: 440, build(dialog, close) {
        const search = document.createElement("input"); search.placeholder = "検索"; dialog.append(search);
        const list = document.createElement("div"); list.style.cssText = "max-height:50vh;overflow:auto;display:grid;gap:6px"; dialog.append(list);
        const render = () => { list.replaceChildren(); for (const entry of sortedNamedOptions(entries).filter(e => e.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))) {
            const button = document.createElement("button"); button.textContent = entry.name || "無題"; button.onclick = act(async () => { await callback(entry.id); close(); }); list.append(button);
        } }; search.oninput = render; render();
    } });
    const open = act(async (mode, recipeId) => {
        const session = mode === "results" && controller.result?.selection?.catalog_id
            ? await getSession(controller.result.selection.catalog_id) : controller.session;
        if (!session) throw new Error("カタログを選択または作成してください");
        // 他ワークフローの保存済み変更を取得。未保存の編集は破棄しない。
        if (session.status === "saved") await session.reload();
        openSharedEditor(session, { mode, recipeId, result: controller.result ? { ...controller.result.selection, text: controller.result.text } : null });
    });
    const catalogWidget = hidden(node.addWidget("combo", "カタログ", "読み込み中", act(async label => {
        const catalog = controller.catalogs.find(c => `${c.name} · ${c.id.slice(0, 8)}` === label);
        if (!catalog) return;
        if (controller.session) await controller.session.flush();
        write({ version: 3, catalog_id: catalog.id, rows: [] }); await controller.reload();
    }), { values: [], serialize: false }));
    const itemsWidget = hidden(node.addWidget("button", "アイテム", null, () => open("items"), { serialize: false }));
    if (typeof node.addDOMWidget === "function") controller.setWidget = makeSharedSetWidget(node, {
        readRows: () => readReference(node).rows,
        readCatalogId: () => readReference(node).catalog_id,
        readRecipes: () => controller.session?.document.recipes ?? (readReference(node).catalog_id ? null : []),
        writeRows: rows => { const ref = readReference(node); ref.rows = rows; write(ref); },
        openSet: id => open("sets", id), openItems: id => open("items", id),
        showHeading: false,
        onResize: () => { if (node.graph && node.computeSize && node.setSize) autoResize(node); node.setDirtyCanvas?.(true, true); },
    });
    const rowsWidget = hidden({ name: "__sax_shared_sets", type: "custom", draw(ctx, currentNode, width, y) {
        this.y = y; const ref = readReference(node), theme = getComfyTheme();
        const recipes = new Map((controller.session?.document.recipes ?? []).map(recipe => [recipe.id, recipe]));
        ref.rows.forEach((row, index) => {
            const top = y + index * 52, recipe = recipes.get(row.recipe_id);
            ctx.fillStyle = theme.inputBg ?? "#252525"; ctx.fillRect(8, top + 2, width - 16, 48);
            txt(ctx, row.on ? "☑" : "☐", 14, top + 15, theme.inputText);
            txt(ctx, "≡", 40, top + 15, theme.inputText);
            ctx.save(); ctx.beginPath(); ctx.rect(62, top + 2, width - 100, 24); ctx.clip();
            txt(ctx, `${recipe?.name ?? "参照先が見つかりません"} ▾`, 62, top + 15, theme.inputText); ctx.restore();
            txt(ctx, "×", width - 25, top + 15, theme.inputText);
            txt(ctx, "セット編集", 62, top + 38, theme.inputText); txt(ctx, "アイテム編集", 158, top + 38, theme.inputText);
        });
        if (controller.drag) { ctx.strokeStyle = theme.inputText; ctx.strokeRect(8, y + controller.drag.target * 52, width - 16, 50); }
        if (!ref.rows.length) txt(ctx, "使用するテキストセットを追加", 12, y + 18, theme.inputText);
    }, computeSize(width) { return [width, Math.max(30, readReference(node).rows.length * 52)]; }, mouse(event, pos) {
        if (event.type !== "pointerdown") return false;
        const ref = readReference(node), index = Math.floor((pos[1] - this.y) / 52), row = ref.rows[index]; if (!row) return false;
        const x = pos[0], localY = pos[1] - this.y - index * 52;
        if (localY > 26) { open(x < 148 ? "sets" : "items", row.recipe_id); return true; }
        if (x < 36) { row.on = !row.on; write(ref); }
        else if (x < 60) {
            const start = event.clientY, original = configWidget.value;
            const scale = node.graph?.list_of_graphcanvas?.[0]?.ds?.scale || 1;
            controller.drag = { target: index };
            const move = e => { controller.drag.target = Math.max(0, Math.min(ref.rows.length - 1, index + Math.round((e.clientY - start) / (52 * scale)))); node.setDirtyCanvas?.(true, true); };
            const up = e => {
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointermove", move); move(e);
                const target = controller.drag.target; controller.drag = null;
                // ドラッグ開始後に別ワークフローへ移動した場合は変更しない。
                if (configWidget.value !== original) return;
                ref.rows.splice(index, 1); ref.rows.splice(target, 0, row); write(ref);
            }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
            controller.stopDrag = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); controller.drag = null; };
        } else if (x > node.size[0] - 40) { ref.rows.splice(index, 1); write(ref); }
        else choose("テキストセットを選択", controller.session?.document.recipes ?? [], id => {
            const current = readReference(node); if (current.catalog_id !== ref.catalog_id) return;
            const target = current.rows.find(r => r.id === row.id); if (target) { target.recipe_id = id; write(current); }
        });
        return true;
    } });
    if (!controller.setWidget) node.addCustomWidget(rowsWidget);
    if (!controller.setWidget) hidden(node.addWidget("button", "＋ テキストセットを追加", null, () => {
        const catalogId = readReference(node).catalog_id;
        const recipes = controller.session?.document.recipes ?? [];
        if (!recipes.length) { open("sets"); return; }
        choose("テキストセットを追加", recipes, id => { const ref = readReference(node); if (ref.catalog_id !== catalogId) return; ref.rows.push({ id: newId(), recipe_id: id, on: true }); write(ref); });
    }, { serialize: false }));
    const resultWidget = hidden(node.addWidget("button", "前回の実行結果", null, () => open("results"), { serialize: false }));
    const managementWidget = hidden(node.addWidget("button", "カタログ作成・入出力", null, () => showDialog({ title: "カタログ作成・入出力", build(dialog, close) {
        for (const [label, callback] of [["新しいカタログ", async () => {
            const name = await showPromptDialog({ title: "カタログ名", defaultValue: "共通カタログ" }); if (name === null) return;
            const doc = await createCatalog({ name }); write({ version: 3, catalog_id: doc.id, rows: [] }); await controller.reload(); close();
        }], ["カタログ名を変更", async () => {
            const session = controller.session; if (!session) throw new Error("カタログを選択してください");
            const name = await showPromptDialog({ title: "カタログ名", defaultValue: session.document.name }); if (name === null) return;
            session.mutate([{ type: "catalog.rename", name }]); await session.flush(); await controller.reload(); close();
        }], ["エクスポート", async () => {
            if (!controller.session) throw new Error("カタログを選択してください"); await controller.session.flush(); await controller.session.reload();
            const url = URL.createObjectURL(new Blob([JSON.stringify(controller.session.document, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = `${controller.session.document.name}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }]]) { const button = document.createElement("button"); button.textContent = label; button.onclick = act(callback); dialog.append(button); }
        const file = document.createElement("input"); file.type = "file"; file.accept = ".json,application/json";
        file.onchange = act(async () => { if (!file.files[0]) return; const doc = await importCatalog(JSON.parse(await file.files[0].text())); write({ version: 3, catalog_id: doc.id, rows: [] }); await controller.reload(); close(); });
        const label = document.createElement("label"); label.textContent = "インポート（新しいカタログとして追加）"; label.append(file); dialog.append(label);
    } }), { serialize: false }));
    controller.reload = act(async () => {
        const token = ++controller.token, ref = readReference(node);
        controller.unsubscribe?.(); controller.unsubscribe = null; controller.session = null;
        const catalogs = await listCatalogs(); if (token !== controller.token) return;
        controller.catalogs = sortedNamedOptions(catalogs.catalogs ?? catalogs);
        catalogWidget.options.values = controller.catalogs.map(c => `${c.name} · ${c.id.slice(0, 8)}`);
        catalogWidget.value = catalogWidget.options.values[controller.catalogs.findIndex(c => c.id === ref.catalog_id)] ?? "カタログを選択／作成";
        controller.catalogToolbar?.refresh(controller.catalogs, ref.catalog_id);
        const session = ref.catalog_id ? await getSession(ref.catalog_id) : null;
        if (token !== controller.token) return;
        controller.unsubscribe?.(); controller.session = session; controller.unsubscribe = session?.subscribe(redraw); redraw();
    });
    controller.dispose = () => {
        controller.disposed = true;
        ++controller.token; controller.stopDrag?.();
        // ComfyUIのDOMウィジェット登録も解除し、configure後の重複表示を防ぐ。
        controller.setWidget?.widget.onRemove?.(); controller.setWidget?.dispose();
        controller.catalogToolbar?.widget.onRemove?.(); controller.catalogToolbar?.dispose();
        controller.unsubscribe?.(); controls.delete(node);
    };
    const seedControls = node.widgets.filter(w => w.name === "seed" || w.name === "control_after_generate");
    if (typeof node.addDOMWidget === "function") controller.catalogToolbar = makeSharedCatalogWidget(node, {
        chooseCatalog: id => {
            const catalog = controller.catalogs.find(c => c.id === id);
            if (catalog) return catalogWidget.callback(`${catalog.name} · ${catalog.id.slice(0, 8)}`);
        },
        openItems: () => open("items"), openManagement: managementWidget.callback,
    });
    const heading = (name, label) => hidden(node.addCustomWidget({ name, type: "custom", computeSize: width => [width, 28],
        draw(ctx, currentNode, width, y) {
            ctx.save(); ctx.font = "600 12px sans-serif"; ctx.fillStyle = getComfyTheme().inputText;
            ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(label, 15, y + 16); ctx.restore();
        },
    }));
    const executionHeading = heading("__sax_execution_heading", "実行設定");
    const catalogHeading = heading("__sax_catalog_heading", "カタログ管理");
    const setHeading = controller.setWidget ? heading("__sax_set_heading", "セット構成") : null;
    const catalogControls = controller.catalogToolbar ? [controller.catalogToolbar.widget] : [catalogWidget, itemsWidget, managementWidget];
    const moved = new Set([...seedControls, resultWidget, catalogWidget, itemsWidget, managementWidget,
        controller.catalogToolbar?.widget, executionHeading, catalogHeading, setHeading]);
    const setControls = node.widgets.filter(w => !moved.has(w) && w !== configWidget);
    node.widgets = [configWidget, executionHeading, ...seedControls, resultWidget, catalogHeading, ...catalogControls, ...(setHeading ? [setHeading] : []), ...setControls];
    controller.reload();
    return controller;
}
export function sharedController(node) { return controls.get(node); }
