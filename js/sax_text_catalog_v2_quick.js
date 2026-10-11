import { makeItemListWidget, getComfyTheme, txt, ROW_H, autoResize, showPromptDialog, showAlertDialog } from "./sax_ui_base.js";
import { sortedNamedOptions, parseConfig, validateConfig, EditHistory, parseRandomCount, formatRandomCount } from "./sax_text_catalog_v2_model.js";

// 大量の素材と本文は管理画面、生成時の切替・有効化・抽選数はノード上で扱う。
const controllers = new WeakMap();
const PAGE_SIZE = 8;

export function installQuickControls(node, callbacks) {
    const installed = controllers.get(node);
    if (installed) { installed.callbacks = callbacks; installed.refresh(); return installed; }
    const json = () => node.widgets?.find(w => w.name === "config_json");
    const controller = { callbacks, raw: null, config: null, error: "", labels: new Map(), signature: null, page: 0, recipeId: null };
    controllers.set(node, controller);
    let formattingGroup = null;
    let recipeWidget, groupsWidget;
    const read = () => {
        const live = controller.callbacks.read?.();
        if (live) { controller.error = ""; return live; }
        const raw = json()?.value;
        if (raw !== controller.raw) {
            controller.raw = raw;
            try { controller.config = parseConfig(raw); controller.error = ""; }
            catch (error) { controller.config = null; controller.error = error.message; }
        }
        return controller.config;
    };
    const active = () => { const config = read(); return config?.recipes.find(r => r.id === config.active_recipe_id); };
    const write = change => {
        const handled = controller.callbacks.commit?.(change);
        if (handled !== undefined) { controller.refresh(); return handled; }
        const current = read(); if (!current) return false;
        const next = structuredClone(current);
        change(next); validateConfig(next);
        const old = json().value, raw = JSON.stringify(next);
        const state = controller.callbacks.state?.();
        if (state) {
            if (!state.history || state.history.current !== old) state.history = new EditHistory(old);
            state.history.record(raw);
        }
        json().value = raw;
        controller.raw = raw; controller.config = next;
        node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
        controller.refresh(); return true;
    };
    controller.refresh = () => {
        const config = read();
        controller.labels.clear();
        for (const recipe of sortedNamedOptions(config?.recipes ?? [])) {
            const base = recipe.name || "無題の組み合わせ";
            let label = base, suffix = 2;
            while (controller.labels.has(label)) label = `${base} (${suffix++})`;
            controller.labels.set(label, recipe.id);
        }
        if (recipeWidget) {
            recipeWidget.options ??= {};
            recipeWidget.options.values = [...controller.labels.keys()];
            recipeWidget.value = [...controller.labels].find(([, id]) => id === config?.active_recipe_id)?.[0] ?? "設定エラー";
        }
        const recipe = config?.recipes.find(r => r.id === config.active_recipe_id);
        if (controller.recipeId !== recipe?.id) { controller.page = 0; controller.recipeId = recipe?.id; }
        controller.page = Math.min(controller.page, Math.max(0, Math.ceil((recipe?.groups.length ?? 0) / PAGE_SIZE) - 1));
        const signature = `${recipe?.id ?? ""}:${recipe?.groups.length ?? 0}:${controller.page}`;
        if (signature !== controller.signature) {
            controller.signature = signature;
            // computeSize は refresh を参照するため、サイズ変更を次の microtask に分離する。
            queueMicrotask(() => { if (node.graph && node.computeSize && node.setSize) autoResize(node); });
        }
    };
    recipeWidget = node.addWidget("combo", "組み合わせ", "", value => {
        const id = controller.labels.get(value);
        if (id) write(config => { if (config.recipes.some(r => r.id === id)) config.active_recipe_id = id; });
    }, { values: [], serialize: false });
    recipeWidget.serialize = false;
    recipeWidget.options = { ...(recipeWidget.options ?? {}), serialize: false };
    groupsWidget = makeItemListWidget({
        widgetName: "__sax_text_catalog_v2_quick",
        hasToggle: true,
        getItems: () => {
            controller.refresh();
            const recipe = active();
            return (recipe?.groups ?? []).slice(controller.page * PAGE_SIZE, (controller.page + 1) * PAGE_SIZE).map(group => ({ ...group, _recipeId: recipe.id }));
        },
        saveItems: groups => {
            const recipeId = groups[0]?._recipeId;
            if (!recipeId || active()?.id !== recipeId) return;
            write(config => {
                if (config.active_recipe_id !== recipeId) return;
                const recipe = config.recipes.find(r => r.id === recipeId);
                if (!recipe) return;
                const updates = new Map(groups.map(g => [g.id, g]));
                for (const group of recipe.groups) {
                    const update = updates.get(group.id);
                    if (update) { group.on = update.on; if (group.mode === "random") { group.count = update.count; if (Object.hasOwn(update, "count_min")) group.count_min = update.count_min; else delete group.count_min; } }
                }
            });
        },
        params: [{
            key: "count", label: "選択数", w: 60,
            get: group => { formattingGroup = group.mode === "random" ? group : null; return formattingGroup ? formattingGroup.count : -1; },
            format: value => value < 0 ? "全件" : formattingGroup ? formatRandomCount(formattingGroup) : String(value),
            step: 1, min: 0, max: 10000,
            set: (group, value) => { if (group.mode === "random") { group.count = Math.round(value); delete group.count_min; } },
            onPopup: async group => {
                if (group.mode !== "random") return;
                const recipeId = active()?.id, groupId = group.id;
                const entered = await showPromptDialog({title:"ランダム選択数（例: 2、0～2）",defaultValue:formatRandomCount(group)});
                if (entered == null) return;
                let value;
                try { value = parseRandomCount(entered); }
                catch (error) { await showAlertDialog({title:"ランダム選択数",message:error.message}); return; }
                write(config => {
                    // 数値入力中に組み合わせを切り替えた場合、別グループへ値を適用しない。
                    if (config.active_recipe_id !== recipeId) return;
                    const current = config.recipes.find(r => r.id === recipeId)?.groups.find(g => g.id === groupId);
                    if (current?.mode === "random") { current.count = value.count; if (Object.hasOwn(value, "count_min")) current.count_min = value.count_min; else delete current.count_min; }
                });
            },
        }],
        content: {
            draw(ctx, group, x, y, width, rowHeight, on) {
                const theme = getComfyTheme();
                const name = group.name || "無題のグループ";
                txt(ctx, `${name} · ${group.kind === "nested" ? `子${group.groups.length}` : `候補${group.item_ids.length}`}`, x + 4, y + rowHeight / 2, on ? theme.inputText : theme.border);
            },
        },
    });
    groupsWidget.serialize = false;
    groupsWidget.options = { ...(groupsWidget.options ?? {}), serialize: false };
    const draw = groupsWidget.draw, compute = groupsWidget.computeSize, mouse = groupsWidget.mouse;
    groupsWidget.draw = function (ctx, ...args) {
        if (!active()?.groups.length) {
            this._y = args[2];
            txt(ctx, controller.error ? "設定エラー · 管理画面で確認" : "管理画面で組み合わせを作成", 12, this._y + ROW_H / 2, getComfyTheme().border);
        } else {
            draw.call(this, ctx, ...args);
            const total = active().groups.length;
            if (total > PAGE_SIZE) {
                const width = args[1], mid = args[2] + compute.call(this, width)[1] + ROW_H / 2;
                txt(ctx, `${controller.page * PAGE_SIZE + 1}–${Math.min((controller.page + 1) * PAGE_SIZE, total)} / ${total}`, 12, mid, getComfyTheme().inputText);
                txt(ctx, "前", width - 66, mid, getComfyTheme().inputText);
                txt(ctx, "次", width - 30, mid, getComfyTheme().inputText);
            }
        }
    };
    groupsWidget.computeSize = function (width) { const size = compute.call(this, width); return [size[0], Math.max(ROW_H, size[1]) + ((active()?.groups.length ?? 0) > PAGE_SIZE ? ROW_H : 0)]; };
    groupsWidget.mouse = function (event, pos, currentNode) {
        const total = active()?.groups.length ?? 0;
        const footer = compute.call(this, currentNode.size[0])[1];
        if (event.type === "pointerdown" && total > PAGE_SIZE && pos[1] - this._y >= footer && pos[1] - this._y < footer + ROW_H) {
            if (pos[0] >= currentNode.size[0] - 84) {
                controller.page = Math.max(0, Math.min(Math.ceil(total / PAGE_SIZE) - 1, controller.page + (pos[0] < currentNode.size[0] - 44 ? -1 : 1)));
                controller.refresh(); currentNode.setDirtyCanvas?.(true, true);
            }
            return true;
        }
        return mouse.call(this, event, pos, currentNode);
    };
    node.addCustomWidget(groupsWidget);
    const manager = node.widgets.find(w => w.name === "カタログを開く" || w.name === "管理・編集");
    if (manager) {
        manager.name = "管理・編集"; manager.serialize = false;
        manager.options = { ...(manager.options ?? {}), serialize: false };
        node.widgets.splice(node.widgets.indexOf(manager), 1); node.widgets.push(manager);
    }
    controller.refresh();
    return controller;
}
