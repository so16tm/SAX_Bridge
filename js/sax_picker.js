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

export function showReturnButton(restoreOverlay) {
    if (_returnBtn) _returnBtn.remove();
    const btn = document.createElement("button");
    btn.textContent = "↩ Return to picker";
    btn.style.cssText =
        "position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:10001;" +
        "padding:9px 22px;background:#1a2a3e;border:2px solid #4a8acc;border-radius:6px;" +
        "color:#7ac8ff;cursor:pointer;font-size:13px;font-family:sans-serif;font-weight:bold;" +
        "box-shadow:0 2px 16px rgba(74,138,204,.4);";
    btn.addEventListener("mouseenter", () => { btn.style.background = "#1e3350"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#1a2a3e"; });
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

    // ---- DOM ヘルパー ----
    function hEl(tag, css = "", text = "") {
        const e = document.createElement(tag);
        if (css)  e.style.cssText = css;
        if (text) e.textContent   = text;
        return e;
    }

    function typeGroupKey(n) {
        return n.category || n.constructor?.category || "Other";
    }

    // ---- 折りたたみセクション ----
    function makeSection(key, label, color, childEls, defaultCollapsed = false) {
        const isCollapsed = collapsed.has(key) ? collapsed.get(key) : defaultCollapsed;
        const sec    = hEl("div", "margin-bottom:4px;");
        const header = hEl("div",
            `display:flex;align-items:center;gap:6px;cursor:pointer;padding:5px 4px;` +
            `background:#12122a;border-radius:4px;color:${color};font-weight:bold;font-size:12px;`);
        const arrow  = hEl("span", "font-size:10px;flex-shrink:0;", isCollapsed ? "▶" : "▼");
        header.appendChild(arrow);
        header.appendChild(hEl("span", "flex:1;", label));
        const body = hEl("div", `padding-left:6px;${isCollapsed ? "display:none;" : ""}`);
        for (const c of childEls) body.appendChild(c);
        header.addEventListener("click", () => {
            const now = !(collapsed.has(key) ? collapsed.get(key) : defaultCollapsed);
            collapsed.set(key, now);
            arrow.textContent = now ? "▶" : "▼";
            body.style.display = now ? "none" : "";
        });
        sec.appendChild(header);
        sec.appendChild(body);
        return sec;
    }

    // ---- 📍 peek ボタン ----
    function makePeekBtn(onPeek) {
        const btn = hEl("button",
            "padding:1px 6px;background:#1e1e32;border:1px solid #3a3a5a;border-radius:3px;" +
            "color:#aaa;cursor:pointer;font-size:10px;flex-shrink:0;line-height:1.4;",
            "📍");
        btn.title = "Peek location (hides this picker)";
        btn.addEventListener("mouseenter", () => { btn.style.background = "#2a2a42"; });
        btn.addEventListener("mouseleave", () => { btn.style.background = "#1e1e32"; });
        btn.addEventListener("click", (e) => { e.stopPropagation(); onPeek(); });
        return btn;
    }

    // ---- multi mode: チェックボックス行 ----
    function makeCheckRow(label, checked, indent, onChange, { onPeek, tooltip } = {}) {
        const row = hEl("div",
            `display:flex;align-items:center;gap:8px;padding:3px 0 3px ${indent ? "16px" : "2px"};`);
        if (tooltip) row.title = tooltip;
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = checked;
        cb.style.cssText = "cursor:pointer;flex-shrink:0;accent-color:#4a9;";
        cb.addEventListener("change", () => onChange(cb.checked));
        const lbl = hEl("label",
            "cursor:pointer;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
        lbl.textContent = label;
        lbl.addEventListener("click", () => { cb.checked = !cb.checked; onChange(cb.checked); });
        row.appendChild(cb);
        row.appendChild(lbl);
        if (onPeek) row.appendChild(makePeekBtn(onPeek));
        return row;
    }

    // ---- single mode: Select ボタン行 ----
    function makeSelectRow(label, labelColor, isCurrent, tooltip, onPeek, onSelectClick) {
        const row = hEl("div",
            `display:flex;align-items:center;gap:6px;padding:3px 2px;border-radius:3px;` +
            `${isCurrent ? "background:#1a2a1a;" : ""}`);
        if (tooltip) row.title = tooltip;
        if (onPeek) row.appendChild(makePeekBtn(onPeek));
        const lbl = hEl("label",
            `cursor:default;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;` +
            `white-space:nowrap;font-size:11px;color:${isCurrent ? "#7d7" : labelColor};`);
        lbl.textContent = label;
        row.appendChild(lbl);
        const selBtn = hEl("button",
            `padding:2px 10px;border-radius:3px;font-size:11px;cursor:pointer;flex-shrink:0;` +
            `background:${isCurrent ? "#1a4a1a" : "#1a3a1a"};` +
            `border:1px solid ${isCurrent ? "#3a8a3a" : "#2a6a2a"};` +
            `color:${isCurrent ? "#9f9" : "#7d7"};`,
            isCurrent ? "✓" : "Select");
        selBtn.addEventListener("mouseenter", () => { selBtn.style.background = "#1e4a1e"; });
        selBtn.addEventListener("mouseleave", () => { selBtn.style.background = isCurrent ? "#1a4a1a" : "#1a3a1a"; });
        selBtn.addEventListener("click", (e) => { e.stopPropagation(); onSelectClick(); });
        row.appendChild(selBtn);
        return row;
    }

    // ---- ノードの peek ハンドラ ----
    function makeNodePeek(n) {
        return () => {
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
            });
        };
    }

    // ---- ノード行を生成（multi / single 共通） ----
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
            // single mode
            const isCurrent = n.id === currentNodeId;
            const color     = isSub ? "#c8b" : "#bc8";
            const row = makeSelectRow(label, color, isCurrent, tooltip, nPeek, () => {
                closeAll();
                onSelect?.(n);
            });
            // 出力スロット名を小さく表示
            const outs = n.outputs ?? [];
            if (outs.length > 0) {
                const outStr = outs.slice(0, 8).map(o => o.name || o.type || "?").join("  ·  ")
                    + (outs.length > 8 ? `  …(+${outs.length - 8})` : "");
                const sub = hEl("div",
                    "font-size:10px;color:#555;padding-left:22px;overflow:hidden;" +
                    "text-overflow:ellipsis;white-space:nowrap;padding-bottom:2px;",
                    outStr);
                const wrap = hEl("div", "");
                wrap.appendChild(row);
                wrap.appendChild(sub);
                return [wrap];
            }
            return [row];
        }
    }

    // ---- オーバーレイ構造 ----
    const overlay = hEl("div",
        "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:10000;" +
        "display:flex;align-items:center;justify-content:center;");
    const dlg = hEl("div",
        "background:#1a1a2e;border:1px solid #4a4a6a;border-radius:8px;padding:16px;" +
        "width:440px;max-height:76vh;display:flex;flex-direction:column;" +
        "color:#ccc;font:13px/1.5 sans-serif;gap:8px;");
    dlg.appendChild(hEl("div", "font:bold 14px sans-serif;color:#fff;", title));

    // 検索バー
    const searchWrap = hEl("div",
        "display:flex;align-items:center;gap:6px;background:#0e0e20;" +
        "border:1px solid #3a3a5a;border-radius:4px;padding:5px 10px;flex-shrink:0;");
    searchWrap.appendChild(hEl("span", "color:#555;", "🔍"));
    const searchInput = document.createElement("input");
    searchInput.placeholder = mode === "single"
        ? "Search node name…"
        : "Search by group or node name…";
    searchInput.style.cssText =
        "flex:1;background:none;border:none;outline:none;color:#ccc;font-size:12px;";
    searchWrap.appendChild(searchInput);
    dlg.appendChild(searchWrap);

    const scroll = hEl("div", "overflow-y:auto;flex:1;");
    dlg.appendChild(scroll);

    // ---- コンテンツ描画 ----
    const renderContent = (query = "") => {
        const q = query.toLowerCase().trim();
        scroll.innerHTML = "";

        // ── Groups ──
        if (sections.includes("groups")) {
            const allGroups = app.graph._groups ?? [];
            const groups    = allGroups
                .filter(g => !q || g.title.toLowerCase().includes(q))
                .sort((a, b) => a.title.localeCompare(b.title));
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
                        overlay.style.display = "none";
                        panCanvasTo(g.pos[0] + g.size[0] / 2, g.pos[1] + g.size[1] / 2);
                        g.selected = true;
                        app.canvas.selected_group = g;
                        app.canvas.setDirty(true, true);
                        showReturnButton(() => {
                            overlay.style.display = "flex";
                            g.selected = false;
                            app.canvas.selected_group = null;
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
                        return makeSelectRow(label, "#8bc", false, tooltip, onPeek, () => {
                            // single mode でのグループ選択（呼び出し側で用途を決める）
                            closeAll();
                            onSelect?.({ type: "group", title: g.title, pos: gPos, _group: g });
                        });
                    }
                });
                const lbl = `Groups (${groups.length}${groups.length < allGroups.length ? `/${allGroups.length}` : ""})`;
                if (rows.length > 0)
                    scroll.appendChild(makeSection("__groups", lbl, "#8bc", rows, false));
            }
        }

        // ── ノード候補を収集 ──
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

        // ── Subgraphs ──
        if (allSubgraphs.length > 0) {
            allSubgraphs.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
            const subTitleCount = new Map();
            for (const n of allSubgraphs) {
                const t = n.title || n.type || `Node#${n.id}`;
                subTitleCount.set(t, (subTitleCount.get(t) ?? 0) + 1);
            }
            const rows = allSubgraphs.flatMap(n => buildNodeRows(n, subTitleCount, true));
            scroll.appendChild(makeSection("__subgraphs", `Subgraphs (${allSubgraphs.length})`, "#c8b", rows, false));
        }

        // ── Nodes（カテゴリごと）──
        if (allNodes.length > 0) {
            const nodeTitleCount = new Map();
            for (const n of allNodes) {
                const t = n.title || n.type || `Node#${n.id}`;
                nodeTitleCount.set(t, (nodeTitleCount.get(t) ?? 0) + 1);
            }
            const typeMap = new Map();
            for (const n of allNodes) {
                const k = typeGroupKey(n);
                if (!typeMap.has(k)) typeMap.set(k, []);
                typeMap.get(k).push(n);
            }
            for (const [typeKey, typeNodes] of [...typeMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
                typeNodes.sort((a, b) =>
                    (a.title || a.type || "").localeCompare(b.title || b.type || ""));
                const rows = typeNodes.flatMap(n => buildNodeRows(n, nodeTitleCount, false));
                // single mode: 選択中ノードのカテゴリはデフォルト展開
                const hasCurrent = mode === "single"
                    && typeNodes.some(n => n.id === currentNodeId);
                scroll.appendChild(makeSection(
                    `__node_${typeKey}`,
                    `${typeKey}  (${typeNodes.length})`,
                    "#bc8", rows, !hasCurrent
                ));
            }
        }

        if (q && allCandidates.length === 0
            && (!(app.graph._groups ?? []).length || !sections.includes("groups"))) {
            scroll.appendChild(hEl("div",
                "color:#555;padding:20px;text-align:center;font-size:12px;", "No results"));
        }
    };

    renderContent();
    searchInput.addEventListener("input", () => renderContent(searchInput.value));

    // ---- フッターボタン ----
    const btnRow = hEl("div", "display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;");
    const makeBtn = (text, bg, fn) => {
        const b = hEl("button",
            `padding:6px 14px;background:${bg};border:1px solid #555;` +
            `border-radius:4px;color:#fff;cursor:pointer;font-size:12px;`);
        b.textContent = text;
        b.addEventListener("click", fn);
        return b;
    };

    function closeAll() {
        clearPickerHighlight();
        hideReturnButton();
        overlay.remove();
    }

    btnRow.appendChild(makeBtn("Cancel", "#2a2a3a", closeAll));
    if (mode === "multi") {
        btnRow.appendChild(makeBtn("Apply", "#1e5a32", () => {
            closeAll();
            onConfirm?.([...selection.values()]);
        }));
    }
    dlg.appendChild(btnRow);

    overlay.appendChild(dlg);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeAll(); });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => searchInput.focus());
}
