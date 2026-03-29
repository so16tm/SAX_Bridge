/**
 * sax_picker.js — SAX シリーズ共通ピッカーモジュール
 *
 * Exports:
 *   panCanvasTo(cx, cy)
 *   clearPickerHighlight()
 *   showReturnButton(restoreFn)
 *   hideReturnButton()
 *   itemKey(item)
 *   showPicker(options)
 *
 * showPicker options:
 *   title          {string}            ダイアログタイトル
 *   sections       {string[]}          表示するセクション: ["groups","subgraphs","nodes"] の部分集合
 *   mode           {"multi"|"single"}  複数選択 or 単数選択
 *
 *   --- multi mode ---
 *   selection      {Map}               初期選択状態 Map<itemKey, item>（内部で更新される）
 *   showWidgets    {boolean}           boolean ウィジェット行を表示するか（default: true）
 *   onConfirm      {function}          Apply 時に fn([...selection.values()]) を呼ぶ
 *
 *   --- single mode ---
 *   currentNodeId  {number|null}       現在選択中のノード ID（ハイライト用）
 *   onSelect       {function}          Select 時に fn(litegraphNode) を呼ぶ
 *
 *   --- both ---
 *   excludeNodeId  {number|null}       リストから除外するノード ID
 *   filterNode     {function|null}     追加フィルタ fn(node)=>bool
 */

import { app } from "../../scripts/app.js";
import {
    h,
    SAX_COLORS,
    buildPickerContent,
    makePickerSection,
    AUTO_EXPAND_THRESHOLD,
} from "./sax_ui_base.js";

// ---------------------------------------------------------------------------
// キャンバスナビゲーション
// ---------------------------------------------------------------------------

export function panCanvasTo(cx, cy) {
    const scale = app.canvas.ds.scale;
    const cw    = app.canvas.canvas.width;
    const ch    = app.canvas.canvas.height;
    app.canvas.ds.offset[0] = -cx + cw * 0.5 / scale;
    app.canvas.ds.offset[1] = -cy + ch * 0.5 / scale;
    app.canvas.setDirty(true, true);
}

export function clearPickerHighlight() {
    if (typeof app.canvas.deselectAllNodes === "function") {
        app.canvas.deselectAllNodes();
    } else if (app.canvas.selected_nodes) {
        app.canvas.selected_nodes = {};
    }
    app.canvas.selected_group = null;
    app.canvas.setDirty(true, true);
}

// ---------------------------------------------------------------------------
// Return to picker ボタン
// ---------------------------------------------------------------------------

let _returnBtn = null;

export function showReturnButton(restoreOverlay, label = "↩ Return") {
    if (_returnBtn) _returnBtn.remove();
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText =
        "position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:10001;" +
        "padding:9px 22px;background:var(--comfy-menu-bg,#171718);" +
        "border:1px solid rgba(74,153,153,.6);border-radius:6px;" +
        "color:var(--input-text,#ddd);cursor:pointer;font-size:13px;" +
        "font-family:sans-serif;font-weight:bold;" +
        "box-shadow:0 0 12px rgba(74,153,153,.4),0 2px 16px rgba(0,0,0,.5);";
    btn.addEventListener("mouseenter", () => { btn.style.background = "var(--comfy-menu-secondary-bg,#303030)"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "var(--comfy-menu-bg,#171718)"; });
    btn.addEventListener("click", () => {
        btn.remove();
        _returnBtn = null;
        restoreOverlay();
    });
    document.body.appendChild(btn);
    _returnBtn = btn;
}

export function hideReturnButton() {
    _returnBtn?.remove();
    _returnBtn = null;
}

// ---------------------------------------------------------------------------
// アイテムキー生成（Toggle Manager と共有）
// ---------------------------------------------------------------------------

export function itemKey(item) {
    if (item.type === "group") {
        if (item.pos != null)
            return `g:${item.title}:${Math.round(item.pos[0])},${Math.round(item.pos[1])}`;
        return `g:${item.title}`;
    }
    if (item.type === "node")   return `n:${item.id}`;
    if (item.type === "widget") return `w:${item.nodeId}:${item.widgetName}`;
    return "";
}

// ---------------------------------------------------------------------------
// メインピッカー
// ---------------------------------------------------------------------------

export function showPicker({
    title         = "Select",
    sections      = ["groups", "subgraphs", "nodes"],
    mode          = "multi",
    selection     = new Map(),
    showWidgets   = true,
    onConfirm     = null,
    currentNodeId = null,
    onSelect      = null,
    excludeNodeId = null,
    filterNode    = null,
} = {}) {

    const collapsed = new Map();

    function typeGroupKey(n) {
        return n.category || n.constructor?.category || "Other";
    }

    function makePeekBtn(onPeek) {
        const btn = h("button",
            "padding:1px 6px;background:var(--comfy-input-bg,#222);" +
            "border:1px solid var(--border-color,#4e4e4e);border-radius:3px;" +
            "color:var(--input-text,#ddd);cursor:pointer;font-size:10px;flex-shrink:0;line-height:1.4;",
            "📍");
        btn.title = "Peek location (hides this picker)";
        btn.addEventListener("mouseenter", () => { btn.style.background = "var(--comfy-menu-secondary-bg,#303030)"; });
        btn.addEventListener("mouseleave", () => { btn.style.background = "var(--comfy-input-bg,#222)"; });
        btn.addEventListener("click", (e) => { e.stopPropagation(); onPeek(); });
        return btn;
    }

    function makeCheckRow(label, checked, indent, onChange, { onPeek, tooltip } = {}) {
        const row = h("div",
            `display:flex;align-items:center;gap:8px;padding:3px 0 3px ${indent ? "16px" : "2px"};`);
        if (!indent) row.classList.add("sax-picker-item");
        if (tooltip) row.title = tooltip;
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = checked;
        cb.style.cssText = "cursor:pointer;flex-shrink:0;accent-color:#4a9;";
        cb.addEventListener("change", () => onChange(cb.checked));
        const lbl = h("label",
            "cursor:pointer;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
        lbl.textContent = label;
        lbl.addEventListener("click", () => { cb.checked = !cb.checked; onChange(cb.checked); });
        row.appendChild(cb);
        row.appendChild(lbl);
        if (onPeek) row.appendChild(makePeekBtn(onPeek));
        return row;
    }

    function makeSelectRow(label, labelColor, isCurrent, tooltip, onPeek, onSelectClick) {
        const row = h("div",
            `display:flex;align-items:center;gap:6px;padding:3px 2px;border-radius:3px;` +
            `${isCurrent ? "background:var(--comfy-menu-secondary-bg,#303030);" : ""}`);
        if (tooltip) row.title = tooltip;
        if (onPeek) row.appendChild(makePeekBtn(onPeek));
        const lbl = h("label",
            `cursor:default;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;` +
            `white-space:nowrap;font-size:11px;color:${isCurrent ? "#7d7" : labelColor};`);
        lbl.textContent = label;
        row.appendChild(lbl);
        const selBtn = h("button",
            `padding:2px 10px;border-radius:3px;font-size:11px;cursor:pointer;flex-shrink:0;` +
            `background:${isCurrent ? "var(--comfy-menu-secondary-bg,#303030)" : "var(--comfy-input-bg,#222)"};` +
            `border:1px solid var(--content-bg,#4e4e4e);` +
            `color:${isCurrent ? "#9f9" : "#7d7"};`,
            isCurrent ? "✓" : "Select");
        selBtn.addEventListener("mouseenter", () => { selBtn.style.background = "var(--comfy-menu-secondary-bg,#303030)"; });
        selBtn.addEventListener("mouseleave", () => {
            selBtn.style.background = isCurrent
                ? "var(--comfy-menu-secondary-bg,#303030)"
                : "var(--comfy-input-bg,#222)";
        });
        selBtn.addEventListener("click", (e) => { e.stopPropagation(); onSelectClick(); });
        row.appendChild(selBtn);
        return row;
    }

    function makeNodePeek(n) {
        return () => {
            const savedOffset = [...app.canvas.ds.offset];
            overlay.style.display = "none";
            panCanvasTo(
                n.pos[0] + (n.size?.[0] ?? 0) / 2,
                n.pos[1] + (n.size?.[1] ?? 0) / 2
            );
            if (typeof app.canvas.selectNode === "function") {
                app.canvas.selectNode(n, false);
            } else {
                app.canvas.selected_nodes = { [n.id]: n };
            }
            app.canvas.setDirty(true, true);
            showReturnButton(() => {
                overlay.style.display = "flex";
                clearPickerHighlight();
                app.canvas.ds.offset[0] = savedOffset[0];
                app.canvas.ds.offset[1] = savedOffset[1];
                app.canvas.setDirty(true, true);
            });
        };
    }

    function buildNodeRows(n, titleCountMap, isSub) {
        const nodeTitle = n.title || n.type || `Node#${n.id}`;
        const nKey      = `n:${n.id}`;
        const isDupe    = (titleCountMap.get(nodeTitle) ?? 1) > 1;
        const posHint   = isDupe ? `  (${Math.round(n.pos[0])}, ${Math.round(n.pos[1])})` : "";
        const icon      = isSub ? "▣" : "◈";
        const label     = `${icon}  ${nodeTitle}${posHint}`;
        const tooltip   = `pos: (${Math.round(n.pos[0])}, ${Math.round(n.pos[1])})  id: ${n.id}`;
        const nPeek     = makeNodePeek(n);

        if (mode === "multi") {
            const row = makeCheckRow(label, selection.has(nKey), false, (now) => {
                if (now) selection.set(nKey, {
                    type: "node", id: n.id, title: nodeTitle,
                    pos: [n.pos[0], n.pos[1]], isSub,
                });
                else selection.delete(nKey);
            }, { onPeek: nPeek, tooltip });

            const widgetRows = !showWidgets ? [] :
                (n.widgets ?? [])
                    .filter(w => typeof w.value === "boolean")
                    .map(w => {
                        const wKey = `w:${n.id}:${w.name}`;
                        return makeCheckRow(`⊞  ${w.name}`, selection.has(wKey), true, (now) => {
                            if (now) selection.set(wKey,
                                { type: "widget", nodeId: n.id, nodeTitle, widgetName: w.name });
                            else selection.delete(wKey);
                        });
                    });
            return [row, ...widgetRows];
        } else {
            const isCurrent = n.id === currentNodeId;
            const color     = isSub ? SAX_COLORS.subgraph : SAX_COLORS.node;
            const row = makeSelectRow(label, color, isCurrent, tooltip, nPeek, () => {
                closeAll();
                onSelect?.(n);
            });
            // 出力スロット名を小さく表示
            const outs = n.outputs ?? [];
            if (outs.length > 0) {
                const outStr = outs.slice(0, 8).map(o => o.name || o.type || "?").join("  ·  ")
                    + (outs.length > 8 ? `  …(+${outs.length - 8})` : "");
                const sub = h("div",
                    "font-size:10px;color:var(--content-bg,#4e4e4e);padding-left:22px;overflow:hidden;" +
                    "text-overflow:ellipsis;white-space:nowrap;padding-bottom:2px;",
                    outStr);
                const wrap = h("div", "");
                wrap.appendChild(row);
                wrap.appendChild(sub);
                return [wrap];
            }
            return [row];
        }
    }

    const overlay = h("div",
        "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:10000;" +
        "display:flex;align-items:center;justify-content:center;");
    const dlg = h("div",
        "background:var(--comfy-menu-bg,#171718);border:1px solid var(--border-color,#4e4e4e);" +
        "border-radius:8px;padding:16px;width:440px;max-height:76vh;display:flex;flex-direction:column;" +
        "color:var(--input-text,#ddd);font:13px/1.5 sans-serif;gap:8px;");
    dlg.appendChild(h("div", "font:bold 14px sans-serif;color:var(--fg-color,#fff);flex-shrink:0;", title));

    // 全アイテム中で x+y が最小の座標を基準点（左上アンカー）として返す
    function computeAnchor(posArr) {
        let ax = Infinity, ay = Infinity;
        for (const [x, y] of posArr) {
            if (x + y < ax + ay) { ax = x; ay = y; }
        }
        return ax === Infinity ? [0, 0] : [ax, ay];
    }

    function sortByNameThenDist(arr, nameOf, posOf, anchor) {
        const [ax, ay] = anchor;
        return arr.slice().sort((a, b) => {
            const nc = nameOf(a).localeCompare(nameOf(b));
            if (nc !== 0) return nc;
            const [x1, y1] = posOf(a);
            const [x2, y2] = posOf(b);
            return Math.hypot(x1 - ax, y1 - ay) - Math.hypot(x2 - ax, y2 - ay);
        });
    }

    const renderContentFn = (query, scroll) => {
        const q = query.toLowerCase().trim();
        scroll.innerHTML = "";

        const allPosItems = [];
        for (const g of app.graph._groups ?? [])
            allPosItems.push([g.pos[0], g.pos[1]]);
        for (const n of app.graph._nodes ?? []) {
            if (n.id !== excludeNodeId && !(filterNode && !filterNode(n)))
                allPosItems.push([n.pos[0], n.pos[1]]);
        }
        const anchor = computeAnchor(allPosItems);

        const allCandidates = (app.graph._nodes ?? []).filter(n => {
            if (n.id === excludeNodeId) return false;
            if (filterNode && !filterNode(n)) return false;
            if (!q) return true;
            return (n.title || n.type || "").toLowerCase().includes(q)
                || (n.type || "").toLowerCase().includes(q);
        });

        const allSubgraphs = sections.includes("subgraphs")
            ? allCandidates.filter(n => n.subgraph != null) : [];
        const allNodes     = sections.includes("nodes")
            ? allCandidates.filter(n => n.subgraph == null) : [];

        // セクション数が閾値以下なら全セクションを強制展開
        const filteredGroupCount = sections.includes("groups")
            ? (app.graph._groups ?? []).filter(g => !q || g.title.toLowerCase().includes(q)).length
            : 0;
        const typeMap = new Map();
        for (const n of allNodes) {
            const k = typeGroupKey(n);
            if (!typeMap.has(k)) typeMap.set(k, []);
            typeMap.get(k).push(n);
        }
        const sectionCount = (filteredGroupCount > 0 ? 1 : 0)
            + (allSubgraphs.length > 0 ? 1 : 0)
            + typeMap.size;
        const forceOpen = sectionCount <= AUTO_EXPAND_THRESHOLD;

        if (sections.includes("groups")) {
            const allGroups = app.graph._groups ?? [];
            const groups    = sortByNameThenDist(
                allGroups.filter(g => !q || g.title.toLowerCase().includes(q)),
                g => g.title,
                g => [g.pos[0], g.pos[1]],
                anchor
            );
            const titleCount = new Map();
            for (const g of allGroups)
                titleCount.set(g.title, (titleCount.get(g.title) ?? 0) + 1);

            if (groups.length > 0 || (!q && allGroups.length > 0)) {
                const rows = groups.map(g => {
                    const gPos    = [g.pos[0], g.pos[1]];
                    const key     = `g:${g.title}:${Math.round(gPos[0])},${Math.round(gPos[1])}`;
                    const isDupe  = (titleCount.get(g.title) ?? 1) > 1;
                    const posHint = isDupe ? `  (${Math.round(gPos[0])}, ${Math.round(gPos[1])})` : "";
                    const label   = `▦  ${g.title}${posHint}`;
                    const tooltip = `pos: (${Math.round(gPos[0])}, ${Math.round(gPos[1])})  size: ${Math.round(g.size[0])}×${Math.round(g.size[1])}`;
                    const onPeek  = () => {
                        const savedOffset = [...app.canvas.ds.offset];
                        overlay.style.display = "none";
                        panCanvasTo(g.pos[0] + g.size[0] / 2, g.pos[1] + g.size[1] / 2);
                        g.selected = true;
                        app.canvas.selected_group = g;
                        app.canvas.setDirty(true, true);
                        showReturnButton(() => {
                            overlay.style.display = "flex";
                            g.selected = false;
                            app.canvas.selected_group = null;
                            app.canvas.ds.offset[0] = savedOffset[0];
                            app.canvas.ds.offset[1] = savedOffset[1];
                            app.canvas.setDirty(true, true);
                        });
                    };
                    if (mode === "multi") {
                        return makeCheckRow(label, selection.has(key), false, (now) => {
                            if (now) selection.set(key,
                                { type: "group", title: g.title, pos: gPos });
                            else selection.delete(key);
                        }, { onPeek, tooltip });
                    } else {
                        return makeSelectRow(label, SAX_COLORS.group, false, tooltip, onPeek, () => {
                            closeAll();
                            onSelect?.({ type: "group", title: g.title, pos: gPos, _group: g });
                        });
                    }
                });
                const lbl = `Groups (${groups.length}${groups.length < allGroups.length ? `/${allGroups.length}` : ""})`;
                if (rows.length > 0)
                    scroll.appendChild(makePickerSection(collapsed, "__groups", lbl, SAX_COLORS.group, rows, false, forceOpen, mode));
            }
        }

        if (allSubgraphs.length > 0) {
            const sortedSubs = sortByNameThenDist(
                allSubgraphs,
                n => n.title || n.type || `Node#${n.id}`,
                n => [n.pos[0], n.pos[1]],
                anchor
            );
            const subTitleCount = new Map();
            for (const n of allSubgraphs) {
                const t = n.title || n.type || `Node#${n.id}`;
                subTitleCount.set(t, (subTitleCount.get(t) ?? 0) + 1);
            }
            const rows = sortedSubs.flatMap(n => buildNodeRows(n, subTitleCount, true));
            scroll.appendChild(makePickerSection(collapsed, "__subgraphs", `Subgraphs (${allSubgraphs.length})`, SAX_COLORS.subgraph, rows, true, forceOpen, mode));
        }

        if (allNodes.length > 0) {
            const nodeTitleCount = new Map();
            for (const n of allNodes) {
                const t = n.title || n.type || `Node#${n.id}`;
                nodeTitleCount.set(t, (nodeTitleCount.get(t) ?? 0) + 1);
            }
            for (const [typeKey, typeNodes] of [...typeMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
                const sortedTypeNodes = sortByNameThenDist(
                    typeNodes,
                    n => n.title || n.type || `Node#${n.id}`,
                    n => [n.pos[0], n.pos[1]],
                    anchor
                );
                const rows = sortedTypeNodes.flatMap(n => buildNodeRows(n, nodeTitleCount, false));
                scroll.appendChild(makePickerSection(
                    collapsed,
                    `__node_${typeKey}`,
                    `${typeKey}  (${typeNodes.length})`,
                    SAX_COLORS.node, rows, true, forceOpen, mode
                ));
            }
        }

        if (q && allCandidates.length === 0
            && (!(app.graph._groups ?? []).length || !sections.includes("groups"))) {
            scroll.appendChild(h("div",
                "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;",
                "No results"));
        }
    };

    function closeAll() {
        clearPickerHighlight();
        hideReturnButton();
        pickerCleanup();
        overlay.remove();
    }

    const { element, focusSearch, cleanup: pickerCleanup } = buildPickerContent({
        mode,
        placeholder: mode === "single" ? "Search node name…" : "Search by group or node name…",
        renderContent: renderContentFn,
        onApply: mode === "multi" ? () => { closeAll(); onConfirm?.([...selection.values()]); } : null,
        onCancel: closeAll,
    });

    dlg.appendChild(element);
    overlay.appendChild(dlg);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeAll(); });
    document.body.appendChild(overlay);
    focusSearch();
}
