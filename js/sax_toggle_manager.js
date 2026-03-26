import { app } from "../../scripts/app.js";
import {
    panCanvasTo,
    clearPickerHighlight,
    showReturnButton,
    hideReturnButton,
    itemKey,
    showPicker,
} from "./sax_picker.js";
import {
    PAD, ROW_H,
    rrect, txt, inX,
    h,
    showDialog,
    getComfyTheme,
    SAX_COLORS,
    drawPill,
    drawMoveArrows,
    drawDeleteBtn,
    drawRowBg,
    rowLayout,
} from "./sax_ui_base.js";

const EXT_NAME   = "SAX.ToggleManager";
const NODE_TYPE  = "SAX_Bridge_Toggle_Manager";
const WIDGET_CFG = "config_json";

const MODE_ACTIVE = 0;
const MODE_BYPASS = 4;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function defaultConfig() {
    return { managed: [], scenes: { "Default": {} }, currentScene: "Default", backKey: "m" };
}

function getConfig(node) {
    const w = node.widgets?.find(w => w.name === WIDGET_CFG);
    try { return Object.assign(defaultConfig(), JSON.parse(w?.value ?? "{}")); }
    catch { return defaultConfig(); }
}

function saveConfig(node, config) {
    const w = node.widgets?.find(w => w.name === WIDGET_CFG);
    if (w) w.value = JSON.stringify(config);
}

// ---------------------------------------------------------------------------
// Item helpers
// ---------------------------------------------------------------------------

// pos OR title どちらかが一致すれば存在すると判断（Rescan の missing 判定に使用）
function matchGroup(g, item) {
    if (item.pos == null) return g.title === item.title;
    const posMatch = Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8;
    return posMatch || g.title === item.title;
}

function findGroup(item) {
    const groups = app.graph._groups ?? [];
    if (item.pos == null) return groups.find(g => g.title === item.title) ?? null;
    const exact = groups.find(g =>
        g.title === item.title &&
        Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8
    );
    if (exact) return exact;
    const byPos = groups.find(g =>
        Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8
    );
    if (byPos) return byPos;
    return groups.find(g => g.title === item.title) ?? null;
}

function isSubgraphNode(n) { return n.subgraph != null; }

function itemLabel(item) {
    if (item.type === "group")               return `▦  ${item.title}`;
    if (item.type === "node" && item.isSub)  return `▣  ${item.title}`;
    if (item.type === "node")                return `◈  ${item.title}`;
    if (item.type === "widget")              return `  ⊞  ${item.nodeTitle} / ${item.widgetName}`;
    return "";
}

function itemColor(item, on) {
    if (!on) return getComfyTheme().contentBg;
    if (item.type === "group")              return SAX_COLORS.group;
    if (item.type === "node" && item.isSub) return SAX_COLORS.subgraph;
    if (item.type === "node")               return SAX_COLORS.node;
    if (item.type === "widget")             return SAX_COLORS.widget;
    return getComfyTheme().inputText;
}

// ---------------------------------------------------------------------------
// Graph operations
// ---------------------------------------------------------------------------

function applyScene(config) {
    const scene = config.scenes[config.currentScene] ?? {};
    for (const item of config.managed)
        applyItem(item, scene[itemKey(item)] ?? true);
    app.graph.setDirtyCanvas(true, false);
}

// グループ内のノードを取得する（_children が空の場合はバウンディングボックスで判定）
function getNodesInGroup(group) {
    if (group._children?.size > 0) {
        return Array.from(group._children).filter(c => c?.id != null && typeof c.mode === "number");
    }
    const x1 = group.pos[0];
    const y1 = group.pos[1];
    const x2 = x1 + group.size[0];
    const y2 = y1 + group.size[1];
    return (app.graph._nodes ?? []).filter(n =>
        n.pos[0] >= x1 && n.pos[0] < x2 &&
        n.pos[1] >= y1 && n.pos[1] < y2
    );
}

function applyItem(item, value) {
    const mode = value ? MODE_ACTIVE : MODE_BYPASS;
    if (item.type === "group") {
        const g = findGroup(item);
        if (g) for (const n of getNodesInGroup(g)) n.mode = mode;
    } else if (item.type === "node") {
        const n = app.graph.getNodeById(item.id);
        if (n) n.mode = mode;
    } else if (item.type === "widget") {
        const n = app.graph.getNodeById(item.nodeId);
        const w = n?.widgets?.find(w => w.name === item.widgetName);
        if (w) { w.value = value; w.callback?.(value); }
    }
}

function getItemCurrentValue(item) {
    if (item.type === "group") {
        const g = findGroup(item);
        if (g) {
            const nodes = getNodesInGroup(g);
            if (nodes.length > 0) return nodes[0].mode !== MODE_BYPASS;
        }
        return true;
    }
    if (item.type === "node") {
        const n = app.graph.getNodeById(item.id);
        return n ? n.mode !== MODE_BYPASS : true;
    }
    if (item.type === "widget") {
        const n = app.graph.getNodeById(item.nodeId);
        const w = n?.widgets?.find(w => w.name === item.widgetName);
        return w != null ? !!w.value : true;
    }
    return true;
}

function snapshotCurrentState(config) {
    const snap = {};
    for (const item of config.managed)
        snap[itemKey(item)] = getItemCurrentValue(item);
    return snap;
}

// ---------------------------------------------------------------------------
// グループ自動同期（移動・名称変更をインメモリ→config に遅延反映）
// ---------------------------------------------------------------------------

let _groupSyncTimer = null;
let _groupSyncNode  = null;

function syncGroupsToConfig(node) {
    const cfg      = getConfig(node);
    const toggleWs = (node.widgets ?? []).filter(w => w.type === "__sax_toggle");
    let changed    = false;

    for (let i = 0; i < Math.min(toggleWs.length, cfg.managed.length); i++) {
        const liveItem = toggleWs[i].item;
        const fi       = cfg.managed[i];
        if (!liveItem || !fi || fi.type !== "group" || liveItem.type !== "group") continue;

        const titleChanged = liveItem.title !== fi.title;
        const posChanged   = fi.pos != null && liveItem.pos != null && (
            Math.abs(liveItem.pos[0] - fi.pos[0]) > 8 ||
            Math.abs(liveItem.pos[1] - fi.pos[1]) > 8
        );
        if (!titleChanged && !posChanged) continue;

        const oldKey = itemKey(fi);
        fi.title = liveItem.title;
        if (fi.pos != null && liveItem.pos != null) fi.pos = [...liveItem.pos];
        const newKey = itemKey(fi);
        if (oldKey !== newKey) {
            for (const s of Object.values(cfg.scenes)) {
                if (oldKey in s) { s[newKey] = s[oldKey]; delete s[oldKey]; }
            }
        }
        changed = true;
    }
    if (changed) saveConfig(node, cfg);
}

function scheduleGroupSync(node) {
    if (_groupSyncTimer !== null) clearTimeout(_groupSyncTimer);
    _groupSyncNode  = node;
    _groupSyncTimer = setTimeout(() => {
        _groupSyncTimer = null;
        const n = _groupSyncNode;
        _groupSyncNode = null;
        if (n) syncGroupsToConfig(n);
    }, 500);
}

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

const LS_BACK_POS = "sax_tm_back_pos";

const BACK_POS_STYLES = {
    "top-left":      "top:60px;left:72px;",
    "top-middle":    "top:60px;left:50%;transform:translateX(-50%);",
    "top-right":     "top:60px;right:20px;",
    "bottom-left":   "bottom:60px;left:72px;",
    "bottom-middle": "bottom:60px;left:50%;transform:translateX(-50%);",
    "bottom-right":  "bottom:60px;right:20px;",
};

let _backBtn          = null;
let _managerNode      = null;
let _sceneFlashUntil  = 0;
let _capturingBackKey = false;

function exitToRootGraph() {
    try {
        let guard = 0;
        while (app.canvas.graph && app.canvas.graph !== app.graph && guard++ < 10) {
            if (typeof app.canvas.exitCurrentGroup === "function") {
                app.canvas.exitCurrentGroup();
            } else {
                break;
            }
        }
        app.canvas.graph = app.graph;

        app.canvas._subgraph             = null;
        app.canvas.selected_group        = null;
        app.canvas.connecting_node       = null;
        app.canvas.node_over             = null;
        app.canvas.node_capturing_input  = null;
        if (typeof app.canvas.deselectAllNodes === "function") {
            app.canvas.deselectAllNodes();
        } else if (app.canvas.selected_nodes) {
            app.canvas.selected_nodes = {};
        }
        app.canvas.setDirty(true, true);
    } catch (e) { console.warn("[SAX Toggle] exitToRootGraph:", e); }
}

function goBack() {
    exitToRootGraph();
    requestAnimationFrame(() => {
        app.canvas.setDirty(true, true);
        requestAnimationFrame(() => {
            const mgr = _managerNode ?? (app.graph._nodes ?? []).find(n => n.comfyClass === NODE_TYPE);
            if (mgr) panCanvasTo(
                mgr.pos[0] + (mgr.size?.[0] ?? 0) / 2,
                mgr.pos[1] + (mgr.size?.[1] ?? 0) / 2
            );
        });
    });
}

function hideBackButton() {
    _backBtn?.remove();
    _backBtn = null;
}

function showBackButton() {
    hideBackButton();
    const pos = localStorage.getItem(LS_BACK_POS) ?? "bottom-left";
    if (pos === "hidden") return;
    const posStyle = BACK_POS_STYLES[pos] ?? BACK_POS_STYLES["bottom-left"];

    const btn = document.createElement("button");
    btn.textContent = "↩ Back";
    btn.style.cssText =
        `position:fixed;${posStyle}z-index:9999;padding:9px 22px;` +
        `background:var(--comfy-menu-bg,#171718);border:1px solid var(--border-color,#4e4e4e);border-radius:6px;` +
        `color:var(--input-text,#ddd);cursor:pointer;font-size:13px;font-family:sans-serif;font-weight:bold;` +
        `box-shadow:0 2px 16px rgba(0,0,0,.5);`;
    btn.addEventListener("mouseenter", () => { btn.style.background = "var(--comfy-menu-secondary-bg,#303030)"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "var(--comfy-menu-bg,#171718)"; });
    btn.addEventListener("click", goBack);
    document.body.appendChild(btn);
    _backBtn = btn;
}

function navigateToItem(item) {
    try {
        if (item.type === "node" || item.type === "widget") {
            const nId = item.type === "widget" ? item.nodeId : item.id;
            const n = app.graph.getNodeById(nId);
            if (n) panCanvasTo(
                n.pos[0] + (n.size?.[0] ?? 0) / 2,
                n.pos[1] + (n.size?.[1] ?? 0) / 2
            );
        } else if (item.type === "group") {
            const g = findGroup(item);
            if (g) panCanvasTo(g.pos[0] + g.size[0] / 2, g.pos[1] + g.size[1] / 2);
        }
    } catch (e) {
        console.warn("[SAX Toggle] navigateToItem error:", e);
    }
}

// setup() の呼び出しタイミングに依存しないようモジュールレベルで登録
document.addEventListener("keydown", (e) => {
    if (_capturingBackKey) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    const mgr = _managerNode ?? (app.graph._nodes ?? []).find(n => n.comfyClass === NODE_TYPE);
    const key = mgr ? (getConfig(mgr).backKey ?? "m") : "m";
    if (e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault();
        goBack();
    }
});

// ---------------------------------------------------------------------------
// アイテム追加・Rescan
// ---------------------------------------------------------------------------

function runAdd(node) {
    const config    = getConfig(node);
    const selection = new Map();
    for (const item of config.managed) selection.set(itemKey(item), item);

    showPicker({
        title:         "Add / Remove Items",
        sections:      ["groups", "subgraphs", "nodes"],
        mode:          "multi",
        selection,
        excludeNodeId: node.id,
        onConfirm:     (newManaged) => {
            const oldKeys = new Set(config.managed.map(itemKey));
            const newKeys = new Set(newManaged.map(itemKey));
            for (const item of config.managed)
                if (!newKeys.has(itemKey(item))) {
                    const key = itemKey(item);
                    for (const s of Object.values(config.scenes)) delete s[key];
                }
            for (const item of newManaged)
                if (!oldKeys.has(itemKey(item))) {
                    const val = getItemCurrentValue(item);
                    for (const s of Object.values(config.scenes)) s[itemKey(item)] = val;
                }
            config.managed = [
                ...config.managed.filter(i => newKeys.has(itemKey(i))),
                ...newManaged.filter(i => !oldKeys.has(itemKey(i))),
            ];
            saveConfig(node, config); rebuildUI(node);
        },
    });
}

function runRescan(node) {
    const config = getConfig(node);

    const missing = config.managed.filter(item => {
        if (item.type === "group")
            return !(app.graph._groups ?? []).some(g => matchGroup(g, item));
        if (item.type === "node")
            return !app.graph.getNodeById(item.id);
        if (item.type === "widget") {
            const n = app.graph.getNodeById(item.nodeId);
            return !(n?.widgets?.some(w => w.name === item.widgetName) ?? false);
        }
        return true;
    });

    if (missing.length > 0) {
        const names = missing.map(i => itemLabel(i).trim()).join("\n");
        if (!confirm(`Rescan will remove ${missing.length} item(s) that no longer exist:\n\n${names}\n\nContinue?`)) return;
    }

    config.managed = config.managed.filter(item => {
        if (item.type === "group")
            return (app.graph._groups ?? []).some(g => matchGroup(g, item));
        if (item.type === "node")
            return !!app.graph.getNodeById(item.id);
        if (item.type === "widget") {
            const n = app.graph.getNodeById(item.nodeId);
            return n?.widgets?.some(w => w.name === item.widgetName) ?? false;
        }
        return false;
    });
    for (const item of config.managed) {
        if (item.type === "group") {
            const g = findGroup(item);
            if (g) {
                const oldKey = itemKey(item);
                item.title = g.title;
                if (item.pos != null) item.pos = [g.pos[0], g.pos[1]];
                const newKey = itemKey(item);
                if (oldKey !== newKey) {
                    for (const s of Object.values(config.scenes)) {
                        if (oldKey in s) { s[newKey] = s[oldKey]; delete s[oldKey]; }
                    }
                }
            }
        }
        if (item.type === "node") {
            const n = app.graph.getNodeById(item.id);
            if (n) item.title = n.title || n.type || `Node#${n.id}`;
        }
        if (item.type === "widget") {
            const n = app.graph.getNodeById(item.nodeId);
            if (n) item.nodeTitle = n.title || n.type || `Node#${n.id}`;
        }
    }
    saveConfig(node, config); rebuildUI(node);
}

// ---------------------------------------------------------------------------
// Widget: scene selector
//  [ [◀] [シーン名] [▶] [⚙] ]   [ [+ Node] [⟳ Rescan] ]
//   ←── scene box ──→             ←── node box ──→
// ---------------------------------------------------------------------------

function makeSceneWidget(node) {
    const H = ROW_H + 6;

    const NODE_BW = 5 + 52 + 4 + 58 + 5; // = 124
    const BOX_GAP = 6;

    const bp = (W) => {
        const nodeBX  = W - PAD - NODE_BW;
        const sceneBX = PAD;
        const sceneBW = nodeBX - BOX_GAP - sceneBX;
        const prevX   = sceneBX + 4;
        const gearX   = sceneBX + sceneBW - 4 - 24;
        const nextX   = gearX - 4 - 18;
        const nameX   = prevX + 18 + 4;
        const nameW   = nextX - 4 - nameX;
        const addX    = nodeBX + 5;
        const rescanX = addX + 52 + 4;
        return { sceneBX, sceneBW, nodeBX, prevX, nextX, gearX, nameX, nameW, addX, rescanX };
    };

    return {
        name: "__sax_scene",
        type: "__sax_scene",
        value: null,
        computeSize: (W) => [W, H - 4],

        draw(ctx, node, W, y) {
            const t      = getComfyTheme();
            const config = getConfig(node);
            const scenes = Object.keys(config.scenes);
            const idx    = scenes.indexOf(config.currentScene);
            const midY   = y + H / 2;
            const p      = bp(W);

            rrect(ctx, p.sceneBX, y + 2, p.sceneBW, H - 4, 4, t.inputBg, t.contentBg);

            const canPrev = idx > 0;
            rrect(ctx, p.prevX, y + 5, 18, H - 10, 3,
                canPrev ? t.menuSecBg : t.menuBg,
                canPrev ? t.border    : t.menuSecBg);
            txt(ctx, "◀", p.prevX + 9, midY, canPrev ? t.inputText : t.contentBg, "center", 9);

            const flashing   = Date.now() < _sceneFlashUntil;
            const sceneColor = flashing ? "#ffe066" : t.fg;
            ctx.save();
            ctx.beginPath();
            ctx.rect(p.nameX, y + 2, p.nameW, H - 4);
            ctx.clip();
            txt(ctx, config.currentScene, p.nameX + p.nameW / 2, midY, sceneColor, "center", 12);
            ctx.restore();
            if (flashing) app.canvas.setDirty(true, false);

            const canNext = idx < scenes.length - 1;
            rrect(ctx, p.nextX, y + 5, 18, H - 10, 3,
                canNext ? t.menuSecBg : t.menuBg,
                canNext ? t.border    : t.menuSecBg);
            txt(ctx, "▶", p.nextX + 9, midY, canNext ? t.inputText : t.contentBg, "center", 9);

            rrect(ctx, p.gearX, y + 5, 24, H - 10, 3, t.menuSecBg, t.border);
            txt(ctx, "⚙", p.gearX + 12, midY, t.inputText, "center", 12);

            rrect(ctx, p.nodeBX, y + 2, NODE_BW, H - 4, 4, t.inputBg, t.contentBg);
            rrect(ctx, p.addX, y + 5, 52, H - 10, 3, t.menuSecBg, t.border);
            txt(ctx, "+ Node", p.addX + 26, midY, t.inputText, "center", 10);

            rrect(ctx, p.rescanX, y + 5, 58, H - 10, 3, t.menuSecBg, t.border);
            txt(ctx, "⟳ Rescan", p.rescanX + 29, midY, t.inputText, "center", 10);
        },

        mouse(event, pos_, node) {
            if (event.type !== "pointerdown") return false;
            const W      = node.size[0];
            const p      = bp(W);
            const config = getConfig(node);
            const scenes = Object.keys(config.scenes);
            const idx    = scenes.indexOf(config.currentScene);

            if (inX(pos_, p.prevX, 18) && idx > 0) {
                config.currentScene = scenes[idx - 1];
                _sceneFlashUntil = Date.now() + 500;
                saveConfig(node, config); applyScene(config); return true;
            }
            if (inX(pos_, p.nextX, 18) && idx < scenes.length - 1) {
                config.currentScene = scenes[idx + 1];
                _sceneFlashUntil = Date.now() + 500;
                saveConfig(node, config); applyScene(config); return true;
            }
            if (inX(pos_, p.gearX, 24)) { showSceneManager(node); return true; }
            if (inX(pos_, p.addX,  52)) { runAdd(node);    return true; }
            if (inX(pos_, p.rescanX, 58)) { runRescan(node); return true; }
            return false;
        },
    };
}

// ---------------------------------------------------------------------------
// Scene management popup
// ---------------------------------------------------------------------------

function showSceneManager(node) {
    const makeBtn = (label, bg, border, color, fn) => {
        const b = h("button",
            `padding:2px 8px;background:${bg};border:1px solid ${border};border-radius:3px;color:${color};cursor:pointer;font-size:11px;flex-shrink:0;`);
        b.textContent = label;
        b.addEventListener("click", fn);
        return b;
    };

    showDialog({
        title:     "Scene Manager",
        width:     400,
        maxHeight: "64vh",
        gap:       10,
        build(dlg, close) {

    const list = h("div", "overflow-y:auto;flex:1;");
    dlg.appendChild(list);

    const renderList = () => {
        list.innerHTML = "";
        const config = getConfig(node);
        const scenes = Object.keys(config.scenes);

        for (let i = 0; i < scenes.length; i++) {
            const name = scenes[i];
            const isCurrent = name === config.currentScene;
            const row = h("div",
                "display:flex;align-items:center;gap:6px;padding:5px 2px;" +
                "border-bottom:1px solid var(--border-color,#4e4e4e);");

            const lbl = h("span",
                `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
                `color:${isCurrent ? "#fff" : "var(--input-text,#ddd)"};` +
                `${isCurrent ? "font-weight:bold;" : ""}`);
            lbl.textContent = name;
            row.appendChild(lbl);

            row.appendChild(makeBtn("✎",
                "var(--comfy-input-bg,#222)", "var(--content-bg,#4e4e4e)", "var(--input-text,#ddd)", () => {
                    const cfg     = getConfig(node);
                    const newName = prompt("Rename scene:", name);
                    if (!newName?.trim() || newName.trim() === name) return;
                    if (cfg.scenes[newName.trim()]) { alert("A scene with that name already exists."); return; }
                    const newScenes = {};
                    for (const k of Object.keys(cfg.scenes))
                        newScenes[k === name ? newName.trim() : k] = cfg.scenes[k];
                    cfg.scenes = newScenes;
                    if (cfg.currentScene === name) cfg.currentScene = newName.trim();
                    saveConfig(node, cfg); rebuildUI(node); renderList();
                }));

            row.appendChild(makeBtn("▲",
                i > 0 ? "var(--comfy-input-bg,#222)"    : "var(--comfy-menu-bg,#171718)",
                i > 0 ? "var(--content-bg,#4e4e4e)"     : "var(--border-color,#4e4e4e)",
                i > 0 ? "var(--input-text,#ddd)"         : "var(--content-bg,#4e4e4e)",
                () => {
                    if (i === 0) return;
                    const cfg  = getConfig(node);
                    const keys = Object.keys(cfg.scenes);
                    [keys[i - 1], keys[i]] = [keys[i], keys[i - 1]];
                    const ns = {}; for (const k of keys) ns[k] = cfg.scenes[k];
                    cfg.scenes = ns;
                    saveConfig(node, cfg); rebuildUI(node); renderList();
                }));

            row.appendChild(makeBtn("▼",
                i < scenes.length - 1 ? "var(--comfy-input-bg,#222)"    : "var(--comfy-menu-bg,#171718)",
                i < scenes.length - 1 ? "var(--content-bg,#4e4e4e)"     : "var(--border-color,#4e4e4e)",
                i < scenes.length - 1 ? "var(--input-text,#ddd)"         : "var(--content-bg,#4e4e4e)",
                () => {
                    if (i >= scenes.length - 1) return;
                    const cfg  = getConfig(node);
                    const keys = Object.keys(cfg.scenes);
                    [keys[i], keys[i + 1]] = [keys[i + 1], keys[i]];
                    const ns = {}; for (const k of keys) ns[k] = cfg.scenes[k];
                    cfg.scenes = ns;
                    saveConfig(node, cfg); rebuildUI(node); renderList();
                }));

            const canDel = scenes.length > 1;  // 最後の 1 件は削除不可
            row.appendChild(makeBtn("✕",
                canDel ? "#3a1a1a"                      : "var(--comfy-menu-bg,#171718)",
                canDel ? "#6a2a2a"                      : "var(--border-color,#4e4e4e)",
                canDel ? "#d77"                         : "var(--content-bg,#4e4e4e)",
                () => {
                    if (!canDel) return;
                    if (!confirm(`Delete scene "${name}"?`)) return;
                    const cfg = getConfig(node);
                    delete cfg.scenes[name];
                    if (cfg.currentScene === name) {
                        cfg.currentScene = Object.keys(cfg.scenes)[0];
                        applyScene(cfg);
                    }
                    saveConfig(node, cfg); rebuildUI(node); renderList();
                }));

            list.appendChild(row);
        }
    };

    renderList();

    const btnRow = h("div", "display:flex;gap:8px;justify-content:space-between;flex-shrink:0;");

    const newBtn = h("button",
        "padding:6px 12px;background:var(--comfy-input-bg,#222);border:1px solid var(--content-bg,#4e4e4e);" +
        "border-radius:4px;color:var(--input-text,#ddd);cursor:pointer;font-size:12px;");
    newBtn.textContent = "+ New Scene";
    newBtn.addEventListener("click", () => {
        const cfg  = getConfig(node);
        const name = prompt("New scene name:", `Scene ${Object.keys(cfg.scenes).length + 1}`);
        if (!name?.trim() || cfg.scenes[name.trim()]) return;
        cfg.scenes[name.trim()] = snapshotCurrentState(cfg);
        cfg.currentScene = name.trim();
        saveConfig(node, cfg); applyScene(cfg); rebuildUI(node); renderList();
    });

    const closeBtn = h("button",
        "padding:6px 14px;background:var(--comfy-input-bg,#222);border:1px solid var(--content-bg,#4e4e4e);" +
        "border-radius:4px;color:var(--input-text,#ddd);cursor:pointer;font-size:12px;");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);

    btnRow.appendChild(newBtn);
    btnRow.appendChild(closeBtn);
    dlg.appendChild(btnRow);

    const sep = h("div",
        "border-top:1px solid var(--border-color,#4e4e4e);padding-top:10px;flex-shrink:0;" +
        "display:flex;flex-direction:column;gap:6px;");
    sep.appendChild(h("div",
        "font:bold 11px sans-serif;color:var(--content-bg,#4e4e4e);letter-spacing:.5px;", "SETTINGS"));

    const posRow = h("div", "display:flex;align-items:center;gap:8px;");
    posRow.appendChild(h("span", "font-size:12px;color:var(--input-text,#ddd);flex:1;", "Back button"));
    const posSelect = document.createElement("select");
    posSelect.style.cssText =
        "background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:3px;color:var(--input-text,#ddd);font-size:12px;padding:2px 6px;cursor:pointer;";
    const POS_OPTIONS = [
        ["top-left",      "Top Left"],
        ["top-middle",    "Top Middle"],
        ["top-right",     "Top Right"],
        ["bottom-left",   "Bottom Left"],
        ["bottom-middle", "Bottom Middle"],
        ["bottom-right",  "Bottom Right"],
        ["hidden",        "Hidden"],
    ];
    const curPos = localStorage.getItem(LS_BACK_POS) ?? "bottom-left";
    for (const [val, label] of POS_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        if (val === curPos) opt.selected = true;
        posSelect.appendChild(opt);
    }
    posSelect.addEventListener("change", () => { localStorage.setItem(LS_BACK_POS, posSelect.value); showBackButton(); });
    posRow.appendChild(posSelect);
    sep.appendChild(posRow);

    const keyRow = h("div", "display:flex;align-items:center;gap:8px;");
    keyRow.appendChild(h("span", "font-size:12px;color:var(--input-text,#ddd);flex:1;", "Back key"));
    const curKey     = getConfig(node).backKey ?? "m";
    const keyDisplay = h("span",
        "padding:2px 10px;background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:3px;color:var(--input-text,#ddd);font-size:12px;min-width:28px;" +
        "text-align:center;font-family:monospace;",
        curKey.toUpperCase());
    const keyEditBtn = h("button",
        "padding:2px 8px;background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:3px;color:var(--input-text,#ddd);cursor:pointer;font-size:11px;",
        "✎");
    keyEditBtn.addEventListener("click", () => {
        keyDisplay.textContent = "…";
        keyDisplay.style.color = "#7d7";
        _capturingBackKey = true;
        const capture = (e) => {
            e.preventDefault(); e.stopPropagation();
            const cfg = getConfig(node);
            if (e.key !== "Escape") {
                cfg.backKey = e.key;
                saveConfig(node, cfg);
                keyDisplay.textContent = e.key.toUpperCase();
            } else {
                keyDisplay.textContent = (getConfig(node).backKey ?? "m").toUpperCase();
            }
            keyDisplay.style.color = "var(--input-text,#ddd)";
            _capturingBackKey = false;
            document.removeEventListener("keydown", capture, true);
        };
        document.addEventListener("keydown", capture, true);
    });
    keyRow.appendChild(keyDisplay);
    keyRow.appendChild(keyEditBtn);
    sep.appendChild(keyRow);

    dlg.appendChild(sep);

        }, // build
    }); // showDialog
}

// ---------------------------------------------------------------------------
// Widget: toggle row — [pill] label … [▲▼] [✕]
// ---------------------------------------------------------------------------

function makeToggleWidget(node, item, index) {
    const H = ROW_H;
    return {
        name:  `__sax_toggle_${index}`,
        type:  "__sax_toggle",
        value: null,
        item,
        _y: 0,
        computeSize: (W) => [W, H - 4],

        draw(ctx, node, W, y) {
            this._y = y;
            const t      = getComfyTheme();
            const config = getConfig(node);
            const scene  = config.scenes[config.currentScene] ?? {};
            const on     = scene[itemKey(item)] ?? true;
            const midY   = y + H / 2;
            const total  = config.managed.length;
            const layout = rowLayout(W, { hasToggle: true, hasMoveUpDown: true, hasDelete: true });

            drawRowBg(ctx, W, y);

            drawPill(ctx, layout.pill.x, midY, on);

            ctx.save();
            ctx.beginPath();
            ctx.rect(layout.contentX, y, layout.contentW, H);
            ctx.clip();
            // 毎フレームグラフから直接参照して名称変更に即追従
            let displayItem = item;
            if (item.type === "node") {
                const liveNode = app.graph.getNodeById(item.id);
                if (liveNode) displayItem = { ...item, title: liveNode.title || liveNode.type || `Node#${liveNode.id}` };
            } else if (item.type === "widget") {
                const liveNode = app.graph.getNodeById(item.nodeId);
                if (liveNode) displayItem = { ...item, nodeTitle: liveNode.title || liveNode.type || `Node#${liveNode.id}` };
            } else if (item.type === "group") {
                const liveGroup = findGroup(item);
                if (liveGroup) {
                    displayItem = { ...item, title: liveGroup.title };
                    const posChanged = item.pos != null && (
                        Math.abs(liveGroup.pos[0] - item.pos[0]) > 8 ||
                        Math.abs(liveGroup.pos[1] - item.pos[1]) > 8
                    );
                    if (liveGroup.title !== item.title || posChanged) {
                        item.title = liveGroup.title;
                        if (item.pos != null) item.pos = [liveGroup.pos[0], liveGroup.pos[1]];
                        scheduleGroupSync(node);
                    }
                }
            }
            // 同名アイテムが複数ある場合のみ位置ヒントを付加
            let label = itemLabel(displayItem);
            if (item.pos != null && (item.type === "group" || item.type === "node")) {
                const isDupe = config.managed.filter(
                    i => i.type === item.type && i.title === item.title
                ).length > 1;
                if (isDupe) label += `  (${Math.round(item.pos[0])}, ${Math.round(item.pos[1])})`;
            }
            txt(ctx, label, layout.contentX + 4, midY, itemColor(item, on), "left", 11);
            txt(ctx, "⌖", layout.contentX + layout.contentW - 2, midY, t.contentBg, "right", 10);
            ctx.restore();

            drawMoveArrows(ctx, layout.move.x, y, H, index > 0, index < total - 1);
            drawDeleteBtn(ctx, layout.del.x, midY);
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;
            const W      = node.size[0];
            const config = getConfig(node);
            const total  = config.managed.length;
            const layout = rowLayout(W, { hasToggle: true, hasMoveUpDown: true, hasDelete: true });

            if (inX(pos, layout.del.x, layout.del.w)) {
                const key = itemKey(item);
                config.managed.splice(index, 1);
                for (const s of Object.values(config.scenes)) delete s[key];
                saveConfig(node, config); rebuildUI(node);
                return true;
            }

            if (inX(pos, layout.move.x, layout.move.w)) {
                const relY   = pos[1] - this._y;
                const moveUp = relY < H / 2;
                if (moveUp && index > 0) {
                    [config.managed[index - 1], config.managed[index]] =
                    [config.managed[index],     config.managed[index - 1]];
                    saveConfig(node, config); rebuildUI(node);
                } else if (!moveUp && index < total - 1) {
                    [config.managed[index],     config.managed[index + 1]] =
                    [config.managed[index + 1], config.managed[index]];
                    saveConfig(node, config); rebuildUI(node);
                }
                return true;
            }

            // pill はコンテンツより先にチェック（境界付近の重なりを回避）
            if (inX(pos, layout.pill.x, layout.pill.w + 6)) {
                const scene = config.scenes[config.currentScene];
                if (!scene) return false;
                const key    = itemKey(item);
                const newVal = !(scene[key] ?? true);
                scene[key]   = newVal;
                saveConfig(node, config);
                applyItem(item, newVal);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            if (inX(pos, layout.contentX, layout.contentW)) {
                navigateToItem(item);
                return true;
            }

            return false;
        },
    };
}

// ---------------------------------------------------------------------------
// UI 再構築
// ---------------------------------------------------------------------------

function rebuildUI(node) {
    const cfgW = node.widgets?.find(w => w.name === WIDGET_CFG);
    if (cfgW && !cfgW._saxHidden) {
        cfgW._saxHidden  = true;
        cfgW.computeSize = () => [0, -4];
        cfgW.draw        = () => {};
        cfgW.mouse       = () => false;
        if (cfgW.element) cfgW.element.style.display = "none";
    }

    node.widgets = node.widgets?.filter(w => w.name === WIDGET_CFG) ?? [];
    const config = getConfig(node);

    node.addCustomWidget(makeSceneWidget(node));
    config.managed.forEach((item, i) => node.addCustomWidget(makeToggleWidget(node, item, i)));

    // H-4 トリック: LiteGraph が per-widget +4 を加算するが、
    // ノードレベルでさらに +6 される。それを相殺するため -6 する。
    if (!node._saxComputeSizeFixed) {
        node._saxComputeSizeFixed = true;
        const _origCS = node.computeSize.bind(node);
        node.computeSize = function(out) {
            const s = _origCS(out);
            s[1] -= 6;
            return s;
        };
    }
    const [, newH] = node.computeSize();
    node.size[0] = Math.max(node.size[0], 320);
    node.size[1] = newH;
    app.graph.setDirtyCanvas(true, false);
}

// ---------------------------------------------------------------------------
// 拡張登録
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        await new Promise(r => requestAnimationFrame(r));
        rebuildUI(node);
        const config = getConfig(node);
        if (config.managed.length > 0) applyScene(config);

        _managerNode = node;
        showBackButton();

        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            if (_managerNode === node) {
                const other = (app.graph._nodes ?? []).find(
                    n => n.comfyClass === NODE_TYPE && n.id !== node.id
                );
                if (other) {
                    _managerNode = other;
                } else {
                    _managerNode = null;
                    hideBackButton();
                }
            }
            origOnRemoved?.call(this);
        };
    },
});
