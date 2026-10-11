import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { hideWidget, showDialog, showAlertDialog, txt, getComfyTheme, autoResize } from "./sax_ui_base.js";
import { newId } from "./sax_text_catalog_v2_model.js";
import { listCatalogs, getSession } from "./sax_text_catalog_v2_client.js";

const TYPE = "SAX_Bridge_Text_Catalog_Converter";

export function installConverter(node) {
    if (node._saxConverter) return;
    const snapshot = node.widgets.find(w => w.name === "v1_json");
    hideWidget(snapshot);
    node.properties ??= {};
    node.properties.saxConverterDestination ??= { mode: "new", id: "", name: "" };
    const state = { busy: false, disposed: false, status: node.properties.saxConvertedCatalog ? "共有カタログへ登録済み" : "V1ノードを読み込んでから登録してください" };
    node._saxConverter = state;
    const report = message => showAlertDialog({ title: "V1 → V2 カタログ変換", message });
    const refresh = () => { node.setDirtyCanvas?.(true, true); if (node.graph) autoResize(node); };
    const visibility = new Map();
    const showWidget = (widget, visible) => {
        if (!visibility.has(widget)) visibility.set(widget, { computeSize: widget.computeSize, draw: widget.draw, mouse: widget.mouse, display: widget.element?.style.display });
        if (visible) {
            const original = visibility.get(widget); widget.computeSize = original.computeSize; widget.draw = original.draw; widget.mouse = original.mouse; delete widget._saxHidden;
            if (widget.element) widget.element.style.display = original.display ?? "";
        } else hideWidget(widget);
    };
    const destination = node.addWidget("combo", "登録先", "新規カタログ", value => {
        if (state.busy) { destination.value = node.properties.saxConverterDestination.mode === "existing" ? "既存カタログに追加" : "新規カタログ"; return; }
        node.properties.saxConverterDestination.mode = value === "既存カタログに追加" ? "existing" : "new";
        syncDestination(); node.graph?.change?.();
    }, { values: ["新規カタログ", "既存カタログに追加"], serialize: false });
    const existing = node.addWidget("button", "追加先カタログを選択", null, async () => {
        if (state.busy || state.disposed) return;
        try {
            const catalogs = await listCatalogs(); if (state.disposed) return;
            showDialog({ title: "追加先の共有カタログ", build(dialog, close) {
                const search = document.createElement("input"); search.placeholder = "カタログ名を検索";
                const list = document.createElement("div"); list.style.cssText = "display:grid;gap:4px;max-height:50vh;overflow:auto"; dialog.append(search, list);
                const render = () => {
                    list.replaceChildren();
                    for (const catalog of catalogs.filter(c => !c.error && c.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))) {
                        const button = document.createElement("button"); button.type = "button"; button.textContent = `${catalog.name} · ${catalog.id.slice(0, 8)}`;
                        button.onclick = () => {
                            if (state.busy || state.disposed) return;
                            Object.assign(node.properties.saxConverterDestination, { id: catalog.id, name: catalog.name }); syncDestination(); node.graph?.change?.(); close();
                        }; list.append(button);
                    }
                    if (!list.children.length) list.textContent = "選択できるカタログがありません";
                };
                search.oninput = render; render();
                const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "閉じる"; cancel.onclick = close; dialog.append(cancel);
            } });
        } catch (error) { report(error.message); }
    }, { serialize: false });
    function syncDestination() {
        const target = node.properties.saxConverterDestination;
        destination.value = target.mode === "existing" ? "既存カタログに追加" : "新規カタログ";
        existing.name = target.id ? `追加先：${target.name} · ${target.id.slice(0, 8)}` : "追加先カタログを選択";
        showWidget(existing, target.mode === "existing"); showWidget(node.widgets.find(w => w.name === "catalog_name"), target.mode !== "existing"); refresh();
    }
    state.syncDestination = syncDestination;
    const sourceButton = node.addWidget("button", "V1ノードから読み込む", null, () => {
        if (state.busy) return;
        const sources = node.graph?._nodes?.filter(n => n.type === "SAX_Bridge_Text_Catalog" || n.comfyClass === "SAX_Bridge_Text_Catalog") ?? [];
        if (!sources.length) { report("同じグラフにSAX Text Catalog（V1）を追加または読み込んでください。"); return; }
        showDialog({ title: "読み込むV1ノード", build(dialog, close) {
            for (const source of sources) {
                const button = document.createElement("button"); button.type = "button"; button.textContent = `${source.title || "SAX Text Catalog"} · #${source.id}`;
                button.onclick = () => {
                    if (state.busy || state.disposed || source.graph !== node.graph) return;
                    const value = source.widgets.find(w => w.name === "items_json")?.value;
                    if (typeof value !== "string") { report("V1のitems_jsonを読み込めません。"); return; }
                    snapshot.value = value;
                    delete node.properties.saxConvertedCatalog;
                    state.status = `#${source.id}のV1データを読み込み済み`;
                    node.graph?.change?.(); refresh(); close();
                };
                dialog.append(button);
            }
            const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "閉じる"; cancel.onclick = close; dialog.append(cancel);
        } });
    }, { serialize: false });
    const saveButton = node.addWidget("button", "共有カタログへ登録・V2ノードを追加", null, async () => {
        if (state.busy || state.disposed) return;
        const name = node.widgets.find(w => w.name === "catalog_name").value;
        const previous = node.properties.saxConvertedCatalog;
        if (previous) { report(`登録済みです（${previous.id}）。再登録する場合はV1ノードを読み込み直してください。`); return; }
        const graph = node.graph;
        if (!graph) return;
        const targetCatalog = { ...node.properties.saxConverterDestination };
        if (targetCatalog.mode === "existing" && !targetCatalog.id) { report("追加先の共有カタログを選択してください。"); return; }
        state.busy = true; state.status = "変換・保存中…"; refresh();
        try {
            let baseRevision;
            if (targetCatalog.mode === "existing") {
                const session = await getSession(targetCatalog.id);
                await session.flush(); await session.reload(); baseRevision = session.document.revision;
            }
            const response = await api.fetchApi("/sax/text-catalog/v2/catalogs/convert-v1", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v1_json: snapshot.value, catalog_name: name, destination: targetCatalog.mode,
                    ...(targetCatalog.mode === "existing" ? { target_catalog_id: targetCatalog.id, base_revision: baseRevision } : {}),
                }),
            });
            const document = await response.json();
            if (!response.ok) throw new Error(document.error || "変換・保存に失敗しました");
            node.properties.saxConvertedCatalog = { id: document.id, name };
            state.status = `${document.name}へ登録済み（計${document.catalog.items.length}件）`;
            if (targetCatalog.mode === "existing") {
                const session = await getSession(targetCatalog.id);
                // 保存済み変更を取り込む。登録中に別画面で編集した場合は、その内容を上書きしない。
                if (session.status === "saved") {
                    try { await session.reload(); }
                    catch (error) { report(`登録は完了しています。カタログ表示の更新に失敗しました：${error.message}`); }
                }
            }
            if (state.disposed || node.graph !== graph) { report(`カタログの登録は完了しました（${document.id}）。V2ノードを追加してカタログを選択してください。`); return; }
            const target = globalThis.LiteGraph?.createNode("SAX_Bridge_Text_Catalog_V2");
            if (!target) { report(`カタログを登録しました（${document.id}）。V2ノードを追加してカタログを選択してください。`); return; }
            const reference = target.widgets.find(w => w.name === "config_json");
            const imported = new Set(document.imported_recipe_ids ?? document.recipes.map(r => r.id));
            reference.value = JSON.stringify({ version: 3, catalog_id: document.id, rows: document.recipes.filter(r => imported.has(r.id)).map(r => ({ id: newId(), recipe_id: r.id, on: true })) });
            target.pos = [node.pos[0] + node.size[0] + 40, node.pos[1]];
            graph.add(target); target.onConfigure?.({}); graph.change?.();
        } catch (error) { state.status = error.message; if (!state.disposed) report(error.message); }
        finally { state.busy = false; if (!state.disposed) refresh(); }
    }, { serialize: false });
    for (const widget of [destination, existing, sourceButton, saveButton]) { widget.serialize = false; widget.options = { ...widget.options, serialize: false }; }
    syncDestination();
    const statusWidget = node.addCustomWidget({ name: "__sax_converter_status", type: "custom", serialize: false, options: { serialize: false },
        computeSize: width => [width, 24], draw(ctx, currentNode, width, y) {
            ctx.save(); ctx.beginPath(); ctx.rect(12, y, width - 24, 24); ctx.clip();
            txt(ctx, state.status, 12, y + 12, getComfyTheme().inputText); ctx.restore();
        },
    });
    const nameWidget = node.widgets.find(w => w.name === "catalog_name");
    const ordered = [snapshot, sourceButton, destination, nameWidget, existing, saveButton, statusWidget];
    node.widgets = [...ordered, ...node.widgets.filter(w => !ordered.includes(w))];
}

app.registerExtension({ name: "SAX.TextCatalogConverter", beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== TYPE) return;
    const created = nodeType.prototype.onNodeCreated, removed = nodeType.prototype.onRemoved, configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); installConverter(this); return result; };
    nodeType.prototype.onRemoved = function (...args) { if (this._saxConverter) this._saxConverter.disposed = true; return removed?.apply(this, args); };
    nodeType.prototype.onConfigure = function (...args) {
        const result = configured?.apply(this, args);
        this._saxConverter?.syncDestination();
        if (this._saxConverter && this.properties.saxConvertedCatalog) this._saxConverter.status = "共有カタログへ登録済み";
        return result;
    };
} });
