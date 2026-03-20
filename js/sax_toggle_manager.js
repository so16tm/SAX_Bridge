import { app } from "../../scripts/app.js";
import {
    panCanvasTo,
    clearPickerHighlight,
    showReturnButton,
    hideReturnButton,
    itemKey,
    showPicker,
} from "./sax_picker.js";

const EXT_NAME   = "SAX.ToggleManager";
const NODE_TYPE  = "SAX_Bridge_Toggle_Manager";
const WIDGET_CFG = "config_json";

const MODE_ACTIVE = 0;
const MODE_BYPASS = 4;
const PAD   = 8;
const ROW_H = 24;

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

// グループを title + pos でマッチする（pos なしの旧データは title のみ）
function matchGroup(g, item) {
    if (g.title !== item.title) return false;
    if (item.pos == null) return true;
    return Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8;
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
    if (!on) return "#555";
    if (item.type === "group")              return "#8bc";
    if (item.type === "node" && item.isSub) return "#c8b";
    if (item.type === "node")               return "#bc8";
    if (item.type === "widget")             return "#cb8";
    return "#ccc";
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
    // _children (Set) が使えるなら優先する
    if (group._children?.size > 0) {
        return Array.from(group._children).filter(c => c?.id != null && typeof c.mode === "number");
    }
    // フォールバック: グループの矩形内に pos があるノードを返す
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
        for (const g of (app.graph._groups ?? []))
            if (matchGroup(g, item))
                for (const n of getNodesInGroup(g))
                    n.mode = mode;
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
        for (const g of (app.graph._groups ?? [])) {
            if (!matchGroup(g, item)) continue;
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
// Canvas drawing helpers
// ---------------------------------------------------------------------------

function rrect(ctx, x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
    } else {
        // roundRect 非対応ブラウザ向けフォールバック
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y,     x + w, y + r,     r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x,     y + h, x,     y + h - r, r);
        ctx.lineTo(x,     y + r);
        ctx.arcTo(x,     y,     x + r, y,         r);
        ctx.closePath();
    }
    if (fill)  { ctx.fillStyle = fill;     ctx.fill();   }
    if (stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function txt(ctx, s, x, y, color, align = "left", size = 11) {
    ctx.font = `${size}px sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(s, x, y);
}

function inX(pos, x, w) { return pos[0] >= x && pos[0] <= x + w; }

// ---------------------------------------------------------------------------
// Back navigation — state & localStorage
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
let _managerNode      = null;  // 最後に作成／使用された Manager ノードへの参照
let _sceneFlashUntil  = 0;     // シーン切り替えフラッシュの終了時刻 (ms)
let _capturingBackKey = false; // Back キーキャプチャ中フラグ

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

        // _subgraph が残るとサブグラフの ( ) 接続ポイントが描画され続ける
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
    // 2フレーム待機してサブグラフ描画を完全にクリアしてからパン
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
        `background:#1a2a3e;border:2px solid #4a8acc;border-radius:6px;` +
        `color:#7ac8ff;cursor:pointer;font-size:13px;font-family:sans-serif;font-weight:bold;` +
        `box-shadow:0 2px 16px rgba(74,138,204,.4);`;
    btn.addEventListener("mouseenter", () => { btn.style.background = "#1e3350"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#1a2a3e"; });
    btn.addEventListener("click", goBack);
    document.body.appendChild(btn);
    _backBtn = btn;
}

// ---------------------------------------------------------------------------
// キャンバスナビゲーション（panCanvasTo は sax_picker.js から import）
// ---------------------------------------------------------------------------

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
            const g = (app.graph._groups ?? []).find(g => g.title === item.title);
            if (g) panCanvasTo(g.pos[0] + g.size[0] / 2, g.pos[1] + g.size[1] / 2);
        }
    } catch (e) {
        console.warn("[SAX Toggle] navigateToItem error:", e);
    }
}

// キーバインドをモジュールレベルで登録（setup() の呼び出しタイミングに依存しない）
document.addEventListener("keydown", (e) => {
    if (_capturingBackKey) return;  // キャプチャ中は Back キー処理をスキップ
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
// Picker / Rescan logic (shared between scene widget mouse handler)
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
// Widget: scene selector — 2つの独立した枠で左右に分割
//
//  [ [◀] [シーン名（中央揃え）] [▶] [⚙] ]   [ [+ Node] [⟳ Rescan] ]
//   ←────────── scene box ──────────────→   ←── node box ──→
//
// node box: 5 + [+Node 52] + 4 + [Rescan 58] + 5 = 124px (固定)
// scene box: 残り幅
//   ◀: sceneBX+4, w=18
//   ▶: gearX-4-18, w=18
//   ⚙: sceneBX+sceneBW-4-24, w=24
//   シーン名: ◀右 ~ ▶左 の中央揃え
// ---------------------------------------------------------------------------

function makeSceneWidget(node) {
    const H = ROW_H + 6;

    const NODE_BW = 5 + 52 + 4 + 58 + 5; // = 124
    const BOX_GAP = 6;

    const bp = (W) => {
        const nodeBX  = W - PAD - NODE_BW;
        const sceneBX = PAD;
        const sceneBW = nodeBX - BOX_GAP - sceneBX;
        const prevX   = sceneBX + 4;                    // [◀] w=18
        const gearX   = sceneBX + sceneBW - 4 - 24;    // [⚙] w=24
        const nextX   = gearX - 4 - 18;                // [▶] w=18
        const nameX   = prevX + 18 + 4;                // シーン名 開始
        const nameW   = nextX - 4 - nameX;             // シーン名 幅
        const addX    = nodeBX + 5;                     // [+ Node] w=52
        const rescanX = addX + 52 + 4;                  // [⟳ Rescan] w=58
        return { sceneBX, sceneBW, nodeBX, prevX, nextX, gearX, nameX, nameW, addX, rescanX };
    };

    return {
        name: "__sax_scene",
        type: "__sax_scene",
        value: null,
        computeSize: (W) => [W, H],

        draw(ctx, node, W, y) {
            const config = getConfig(node);
            const scenes = Object.keys(config.scenes);
            const idx    = scenes.indexOf(config.currentScene);
            const midY   = y + H / 2;
            const p      = bp(W);

            // ── scene box ──
            rrect(ctx, p.sceneBX, y + 2, p.sceneBW, H - 4, 4, "#1e1e32", "#4a4a7a");

            // [◀]
            const canPrev = idx > 0;
            rrect(ctx, p.prevX, y + 5, 18, H - 10, 3,
                canPrev ? "#3a3a5a" : "#28283a",
                canPrev ? "#5a5a8a" : "#383848");
            txt(ctx, "◀", p.prevX + 9, midY, canPrev ? "#aaa" : "#444", "center", 9);

            // シーン名（◀▶の間に中央揃え・クリップ）
            const flashing   = Date.now() < _sceneFlashUntil;
            const sceneColor = flashing ? "#ffe066" : "#fff";
            ctx.save();
            ctx.beginPath();
            ctx.rect(p.nameX, y + 2, p.nameW, H - 4);
            ctx.clip();
            txt(ctx, config.currentScene, p.nameX + p.nameW / 2, midY, sceneColor, "center", 12);
            ctx.restore();
            if (flashing) app.canvas.setDirty(true, false);

            // [▶]
            const canNext = idx < scenes.length - 1;
            rrect(ctx, p.nextX, y + 5, 18, H - 10, 3,
                canNext ? "#3a3a5a" : "#28283a",
                canNext ? "#5a5a8a" : "#383848");
            txt(ctx, "▶", p.nextX + 9, midY, canNext ? "#aaa" : "#444", "center", 9);

            // [⚙]
            rrect(ctx, p.gearX, y + 5, 24, H - 10, 3, "#2a2a2a", "#4a4a4a");
            txt(ctx, "⚙", p.gearX + 12, midY, "#999", "center", 12);

            // ── node box ──
            rrect(ctx, p.nodeBX, y + 2, NODE_BW, H - 4, 4, "#1e2a1e", "#4a7a4a");

            // [+ Node]
            rrect(ctx, p.addX, y + 5, 52, H - 10, 3, "#1a3a1a", "#2a5a2a");
            txt(ctx, "+ Node", p.addX + 26, midY, "#7d7", "center", 10);

            // [⟳ Rescan]
            rrect(ctx, p.rescanX, y + 5, 58, H - 10, 3, "#1a1a3a", "#2a2a5a");
            txt(ctx, "⟳ Rescan", p.rescanX + 29, midY, "#77d", "center", 10);
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
// Scene management popup  (名称変更・削除・並び替え・Save State)
// ---------------------------------------------------------------------------

function showSceneManager(node) {
    const h = (tag, css = "", text = "") => {
        const e = document.createElement(tag);
        if (css)  e.style.cssText = css;
        if (text) e.textContent   = text;
        return e;
    };

    const makeBtn = (label, bg, border, color, fn) => {
        const b = h("button",
            `padding:2px 8px;background:${bg};border:1px solid ${border};border-radius:3px;color:${color};cursor:pointer;font-size:11px;flex-shrink:0;`);
        b.textContent = label;
        b.addEventListener("click", fn);
        return b;
    };

    const overlay = h("div",
        "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:10000;display:flex;align-items:center;justify-content:center;");
    const dlg = h("div",
        "background:#1a1a2e;border:1px solid #4a4a6a;border-radius:8px;padding:16px;width:400px;max-height:64vh;display:flex;flex-direction:column;color:#ccc;font:13px/1.5 sans-serif;gap:10px;");

    dlg.appendChild(h("div", "font:bold 14px sans-serif;color:#fff;", "Scene Manager"));

    const list = h("div", "overflow-y:auto;flex:1;");
    dlg.appendChild(list);

    const renderList = () => {
        list.innerHTML = "";
        const config = getConfig(node);
        const scenes = Object.keys(config.scenes);

        for (let i = 0; i < scenes.length; i++) {
            const name = scenes[i];
            const isCurrent = name === config.currentScene;
            const row  = h("div",
                "display:flex;align-items:center;gap:6px;padding:5px 2px;border-bottom:1px solid #2a2a3a;");

            const lbl = h("span", `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isCurrent ? "#fff" : "#aaa"};${isCurrent ? "font-weight:bold;" : ""}`);
            lbl.textContent = name;
            row.appendChild(lbl);

            // ✎ Rename
            row.appendChild(makeBtn("✎", "#2a2a3a", "#4a4a6a", "#aaa", () => {
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

            // ▲ Move up
            row.appendChild(makeBtn("▲", i > 0 ? "#2a2a3a" : "#1e1e2e", i > 0 ? "#4a4a6a" : "#2a2a2a", i > 0 ? "#aaa" : "#444", () => {
                if (i === 0) return;
                const cfg  = getConfig(node);
                const keys = Object.keys(cfg.scenes);
                [keys[i - 1], keys[i]] = [keys[i], keys[i - 1]];
                const ns = {}; for (const k of keys) ns[k] = cfg.scenes[k];
                cfg.scenes = ns;
                saveConfig(node, cfg); rebuildUI(node); renderList();
            }));

            // ▼ Move down
            row.appendChild(makeBtn("▼",
                i < scenes.length - 1 ? "#2a2a3a" : "#1e1e2e",
                i < scenes.length - 1 ? "#4a4a6a" : "#2a2a2a",
                i < scenes.length - 1 ? "#aaa"    : "#444",
                () => {
                    if (i >= scenes.length - 1) return;
                    const cfg  = getConfig(node);
                    const keys = Object.keys(cfg.scenes);
                    [keys[i], keys[i + 1]] = [keys[i + 1], keys[i]];
                    const ns = {}; for (const k of keys) ns[k] = cfg.scenes[k];
                    cfg.scenes = ns;
                    saveConfig(node, cfg); rebuildUI(node); renderList();
                }));

            // ✕ Delete (disabled if only 1)
            const canDel = scenes.length > 1;
            row.appendChild(makeBtn("✕",
                canDel ? "#3a1a1a" : "#1e1e2e",
                canDel ? "#6a2a2a" : "#2a2a2a",
                canDel ? "#d77"    : "#444",
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
        "padding:6px 12px;background:#1a3a1a;border:1px solid #2a5a2a;border-radius:4px;color:#7d7;cursor:pointer;font-size:12px;");
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
        "padding:6px 14px;background:#2a2a3a;border:1px solid #555;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());

    btnRow.appendChild(newBtn);
    btnRow.appendChild(closeBtn);
    dlg.appendChild(btnRow);

    // ── Settings section ──
    const sep = h("div", "border-top:1px solid #2a2a3a;padding-top:10px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;");
    sep.appendChild(h("div", "font:bold 11px sans-serif;color:#666;letter-spacing:.5px;", "SETTINGS"));

    // Back button position
    const posRow = h("div", "display:flex;align-items:center;gap:8px;");
    posRow.appendChild(h("span", "font-size:12px;color:#aaa;flex:1;", "Back button"));
    const posSelect = document.createElement("select");
    posSelect.style.cssText = "background:#2a2a3a;border:1px solid #4a4a6a;border-radius:3px;color:#ccc;font-size:12px;padding:2px 6px;cursor:pointer;";
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

    // Back key
    const keyRow = h("div", "display:flex;align-items:center;gap:8px;");
    keyRow.appendChild(h("span", "font-size:12px;color:#aaa;flex:1;", "Back key"));
    const curKey     = getConfig(node).backKey ?? "m";
    const keyDisplay = h("span",
        "padding:2px 10px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:3px;" +
        "color:#ccc;font-size:12px;min-width:28px;text-align:center;font-family:monospace;",
        curKey.toUpperCase());
    const keyEditBtn = h("button",
        "padding:2px 8px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:3px;color:#aaa;cursor:pointer;font-size:11px;",
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
            keyDisplay.style.color = "#ccc";
            _capturingBackKey = false;
            document.removeEventListener("keydown", capture, true);
        };
        document.addEventListener("keydown", capture, true);
    });
    keyRow.appendChild(keyDisplay);
    keyRow.appendChild(keyEditBtn);
    sep.appendChild(keyRow);

    dlg.appendChild(sep);

    overlay.appendChild(dlg);
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Widget: toggle row   [pill] label … [▲▼] [✕]
// ---------------------------------------------------------------------------

function makeToggleWidget(node, item, index) {
    const H = ROW_H + 2;
    return {
        name:  `__sax_toggle_${index}`,
        type:  "__sax_toggle",
        value: null,
        item,
        _y: 0,
        computeSize: (W) => [W, H],

        draw(ctx, node, W, y) {
            this._y = y;
            const config = getConfig(node);
            const scene  = config.scenes[config.currentScene] ?? {};
            const on     = scene[itemKey(item)] ?? true;
            const midY   = y + H / 2;
            const total  = config.managed.length;

            rrect(ctx, PAD, y + 1, W - PAD * 2, H - 2, 3,
                index % 2 === 0 ? "#1c1c2c" : "#20202e", null);

            // Toggle pill
            const pX = PAD + 5, pY = y + 7, pW = 26, pH = 12;
            rrect(ctx, pX, pY, pW, pH, 6,
                on ? "#1e5a32" : "#5a1e1e",
                on ? "#2a8a4a" : "#8a2a2a");
            const kX = on ? pX + pW - 11 : pX + 2;
            rrect(ctx, kX, pY + 2, 8, 8, 4, "#fff", null);

            // Label（クリックでナビゲート可能。右端に ⌖ を表示）
            const labelEndX = W - PAD - 48;
            ctx.save();
            ctx.beginPath();
            ctx.rect(PAD + 38, y, labelEndX - (PAD + 38), H);
            ctx.clip();
            // 同名アイテムが複数ある場合は位置ヒントを付加
            let label = itemLabel(item);
            if (item.pos != null && (item.type === "group" || item.type === "node")) {
                const isDupe = config.managed.filter(
                    i => i.type === item.type && i.title === item.title
                ).length > 1;
                if (isDupe) label += `  (${Math.round(item.pos[0])}, ${Math.round(item.pos[1])})`;
            }
            txt(ctx, label, PAD + 38, midY, itemColor(item, on), "left", 11);
            ctx.restore();
            txt(ctx, "⌖", labelEndX + 4, midY, "#444", "left", 10);

            // ▲ / ▼ (stacked in right area)
            const upOk   = index > 0;
            const downOk = index < total - 1;
            txt(ctx, "▲", W - PAD - 32, y + H / 4,     upOk   ? "#888" : "#383838", "center", 9);
            txt(ctx, "▼", W - PAD - 32, y + H * 3 / 4, downOk ? "#888" : "#383838", "center", 9);

            // ✕
            txt(ctx, "✕", W - PAD - 10, midY, "#666", "center", 10);
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;
            const W      = node.size[0];
            const config = getConfig(node);
            const total  = config.managed.length;

            // ✕ remove
            if (inX(pos, W - PAD - 20, 20)) {
                const key = itemKey(item);
                config.managed.splice(index, 1);
                for (const s of Object.values(config.scenes)) delete s[key];
                saveConfig(node, config); rebuildUI(node);
                return true;
            }

            // ▲▼ move (X: W-PAD-44 to W-PAD-22)
            if (inX(pos, W - PAD - 44, 22)) {
                const relY = pos[1] - this._y;
                const moveUp = relY < (ROW_H + 2) / 2;
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

            // ラベルエリアクリック → ナビゲート
            if (inX(pos, PAD + 38, W - PAD - 48 - (PAD + 38))) {
                navigateToItem(item);
                return true;
            }

            // Toggle pill
            if (inX(pos, PAD + 3, 32)) {
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
            return false;
        },
    };
}

// ---------------------------------------------------------------------------
// UI rebuild
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

    const [, newH] = node.computeSize();
    node.size[0] = Math.max(node.size[0], 320);
    node.size[1] = Math.max(newH, 80);
    app.graph.setDirtyCanvas(true, false);
}

// showPicker は sax_picker.js から import — ここには定義不要

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

app.registerExtension({
    name: EXT_NAME,

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        await new Promise(r => requestAnimationFrame(r));
        rebuildUI(node);
        const config = getConfig(node);
        if (config.managed.length > 0) applyScene(config);

        // Manager ノードの参照を保持
        _managerNode = node;
        showBackButton();

        // ノード削除時のクリーンアップ
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            if (_managerNode === node) {
                // 他に Manager ノードが残っていれば参照を切り替え、なければボタンを消す
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
