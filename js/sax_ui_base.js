/**
 * sax_ui_base.js — SAX シリーズ共通 Canvas UI テンプレート
 *
 * Exports:
 *   PAD, ROW_H
 *   rrect(ctx, x, y, w, h, r, fill, stroke)
 *   txt(ctx, s, x, y, color, align, size)
 *   inX(pos, x, w)
 *   drawPill(ctx, x, midY, on)
 *   drawMoveArrows(ctx, x, y, h, canUp, canDown)
 *   drawDeleteBtn(ctx, x, midY)
 *   drawJumpBtn(ctx, x, midY)
 *   drawParamBox(ctx, x, y, w, h, text, active)
 *   drawRowBg(ctx, W, y, h?)
 *   drawAddBtn(ctx, W, y, label, canAdd)
 *   rowLayout(W, opts)
 *   showParamPopup(screenX, screenY, currentVal, cfg, onCommit)
 *   makeItemListWidget(node, spec)
 *   makeSourceListWidget(spec) — Collector ノード共通ソースリストウィジェット
 *
 * 出力スロット接続維持ユーティリティ:
 *   captureOutputLinks(node, items, slotOffset?)
 *   restoreOutputLinks(node, items, syncFn, slotOffset?)
 *
 * ピッカー共通ユーティリティ:
 *   AUTO_EXPAND_THRESHOLD       — セクション強制展開の閾値定数
 *   makePickerSection(collapsed, key, label, color, childEls, defaultCollapsed?, forceOpen?)
 *   buildPickerContent({ mode, placeholder, renderContent, onApply, onCancel })
 *     → { element, focusSearch, cleanup }
 *   showFilePicker(opts)         — 汎用ファイルピッカーダイアログ
 *
 * DOM UI ヘルパー:
 *   h(tag, css, text)
 *   showDialog({ title, width, maxHeight, gap, className, build })
 *
 * SAX 共通配色:
 *   SAX_COLORS.group / subgraph / node / widget  — アイテム種別テキスト色
 *   SAX_COLORS.primaryBg / primaryHoverBg / primaryText  — プライマリアクション
 */

import { app } from "../../scripts/app.js";

export const PAD             = 8;    // 水平余白（左右パディング）
export const ROW_H           = 24;   // 標準行高（LoRA / SAM3 / Toggle Manager）
export const HEADER_H        = 20;   // ヘッダー行高（Show Links トグル等）
export const COLUMN_HEADER_H = 16;   // 列ラベル行高（SAM3 Multi 等）
export const ADD_H           = 28;   // Add ボタン行高（全ノード統一）
export const ADD_BTN_LABEL   = "+ Add Item";  // Add ボタンの標準ラベル
export const GAP             = 4;    // 行内部の要素間ギャップ
export const BTN_RADIUS      = 4;    // アクションボタンの角丸半径
export const ITEM_MARGIN     = 2;    // 行／ボタン内の上下マージン（上: +ITEM_MARGIN, 高さ: -2*ITEM_MARGIN）
export const BOTTOM_PAD      = 6;    // LiteGraph 標準 computeSize の +6 に合わせたボトムパディング

// ---------------------------------------------------------------------------
// SAX シリーズ共通配色定数
// ---------------------------------------------------------------------------

/**
 * SAX ノード群で統一使用する配色。
 *
 * アイテム種別色はテーマ非依存の固定色（Canvas 描画・DOM 共用）。
 * プライマリアクション色は ComfyUI の --primary-background 変数に従い
 * テーマ変更時にも追従する（DOM インラインスタイル文字列として使用）。
 */
export const SAX_COLORS = {
    // アイテム種別テキスト色
    group:          "#8bc",   // グループ
    subgraph:       "#c8b",   // サブグラフ / サブグラフ内ノード
    node:           "#bc8",   // ノード
    widget:         "#cb8",   // Boolean ウィジェット（トグル）

    // フィードバック
    flash:          "#ffe066",  // シーン切替フラッシュ
    capture:        "#7d7",     // キーキャプチャ中

    // プライマリアクション（Apply ボタン等）— DOM インラインスタイル用 CSS 変数文字列
    primaryBg:      "var(--primary-background,      #0b8ce9)",
    primaryHoverBg: "var(--primary-background-hover,#31b9f4)",
    primaryText:    "var(--button-surface-contrast, #ffffff)",
};

/** プリミティブ型バッジの定義（badge: 表示ラベル, color: 背景色） */
export const PRIMITIVE_TYPE_META = {
    INT:     { badge: "INT", color: "#3a7bd5", tooltip: "INTEGER" },
    FLOAT:   { badge: "FLT", color: "#2d9e6b", tooltip: "FLOAT" },
    STRING:  { badge: "STR", color: "#c47c22", tooltip: "STRING" },
    BOOLEAN: { badge: "BOL", color: "#8c52c7", tooltip: "BOOLEAN" },
    SEED:    { badge: "SED", color: "#d4a017", tooltip: "SEED" },
};

/** バッジ描画用の補助定数 */
export const PRIMITIVE_BADGE_FALLBACK = { badge: "???", color: "#555" };
export const PRIMITIVE_BADGE_TEXT_COLOR = "#fff";

// ---------------------------------------------------------------------------
// ComfyUI テーマ（CSS変数から読み込み・キャッシュ）
// ---------------------------------------------------------------------------

let _themeCache = null;

// パレット変更（documentElement の style 変更 or head への style 追加）を検知してキャッシュを無効化する
// MutationObserver は短時間に大量発火しうるため 100ms trailing-edge デバウンスで invalidate 回数を抑える
// （leading-edge だと連続発火の途中変更が捨てられ、最後の状態を見逃すリスクがある）
{
    let _invTimer = null;
    const _inv = () => {
        if (_invTimer != null) clearTimeout(_invTimer);
        _invTimer = setTimeout(() => { _themeCache = null; _invTimer = null; }, 100);
    };
    const _obs = new MutationObserver(_inv);
    _obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    _obs.observe(document.head, { childList: true });
}

/**
 * ComfyUI の CSS カスタムプロパティを読み込んでキャッシュする。
 * Canvas 描画は CSS変数を直接使えないため、一度だけ解決して定数化する。
 * フォールバック値は ComfyUI デフォルト dark テーマの実値。
 */
export function getComfyTheme() {
    if (_themeCache) return _themeCache;
    const s = getComputedStyle(document.documentElement);
    const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
    _themeCache = {
        // ComfyUI パレット変数（ユーザーカスタマイズ対応）
        menuBg:          v("--comfy-menu-bg",            "#171718"),
        menuSecBg:       v("--comfy-menu-secondary-bg",  "#303030"),
        inputBg:         v("--comfy-input-bg",           "#222222"),
        bgColor:         v("--bg-color",                 "#202020"),
        fg:              v("--fg-color",                 "#ffffff"),
        inputText:       v("--input-text",               "#dddddd"),
        contentBg:       v("--content-bg",               "#4e4e4e"),
        contentFg:       v("--content-fg",               "#ffffff"),
        contentHoverBg:  v("--content-hover-bg",         "#222222"),
        border:          v("--border-color",             "#4e4e4e"),
        trEvenBg:        v("--tr-even-bg-color",         "#222222"),
        trOddBg:         v("--tr-odd-bg-color",          "#353535"),
    };
    return _themeCache;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

export function rrect(ctx, x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
    } else {
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
    if (fill)   { ctx.fillStyle = fill;     ctx.fill();   }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

export function txt(ctx, s, x, y, color, align = "left", size = 11) {
    ctx.font        = `${size}px sans-serif`;
    ctx.fillStyle   = color;
    ctx.textAlign   = align;
    ctx.textBaseline = "middle";
    ctx.fillText(s, x, y);
}

/** pos = [x, y] がエリア [x0, x0+w] 内かどうか */
export function inX(pos, x0, w) {
    return pos[0] >= x0 && pos[0] <= x0 + w;
}

// ---------------------------------------------------------------------------
// 共通 UI パーツ描画
// ---------------------------------------------------------------------------

/** トグル pill を描画。x: pill 左端、midY: 行中央Y */
export function drawPill(ctx, x, midY, on) {
    const t  = getComfyTheme();
    const pW = 26, pH = 14;
    const pY = midY - pH / 2;
    rrect(ctx, x, pY, pW, pH, 7,
        on ? t.contentBg : t.menuBg,
        on ? t.inputText : t.border);
    const kX = on ? x + pW - 12 : x + 2;
    rrect(ctx, kX, pY + 3, 8, 8, 4, on ? t.fg : t.border, null);
}

/** ▲▼ 移動矢印を描画。x: エリア左端、y: 行上端、h: 行高 */
export function drawMoveArrows(ctx, x, y, h, canUp, canDown) {
    const t = getComfyTheme();
    txt(ctx, "▲", x + 10, y + h / 4 + 2,     canUp   ? t.contentBg : t.menuSecBg, "center", 9);
    txt(ctx, "▼", x + 10, y + h * 3 / 4 - 2, canDown ? t.contentBg : t.menuSecBg, "center", 9);
}

/** ✕ 削除ボタンを描画。x: エリア左端、midY: 行中央Y */
export function drawDeleteBtn(ctx, x, midY) {
    const t = getComfyTheme();
    txt(ctx, "✕", x + 10, midY, t.contentBg, "center", 10);
}

/** ↗ ジャンプボタンを描画。x: エリア左端、midY: 行中央Y */
export function drawJumpBtn(ctx, x, midY) {
    const t = getComfyTheme();
    txt(ctx, "↗", x + 9, midY, t.contentBg, "center", 10);
}

/** 行背景カプセルを描画。W: ウィジェット全幅、y: 行上端、h: 行高（デフォルト ROW_H） */
export function drawRowBg(ctx, W, y, h = ROW_H) {
    const t = getComfyTheme();
    rrect(ctx, PAD, y + ITEM_MARGIN, W - PAD * 2, h - 2 * ITEM_MARGIN,
        (h - 2 * ITEM_MARGIN) / 2, t.inputBg, t.contentBg);
}

/** Add ボタンを描画。W: ウィジェット全幅、y: ボタン行上端 */
export function drawAddBtn(ctx, W, y, label, canAdd) {
    const t = getComfyTheme();
    rrect(ctx, PAD, y + ITEM_MARGIN, W - PAD * 2, ADD_H - 2 * ITEM_MARGIN, BTN_RADIUS,
        canAdd ? t.inputBg : t.menuBg,
        canAdd ? t.contentBg : t.border);
    txt(ctx, label, W / 2, y + ADD_H / 2,
        canAdd ? t.inputText : t.border, "center", 11);
}

/**
 * パラメータ値ボックスを描画。
 * x: ボックス左端、y: 行上端、w: 幅、h: 行高、active: ドラッグ中かどうか
 */
export function drawParamBox(ctx, x, y, w, h, text, active) {
    const t = getComfyTheme();
    // contentBg と同色にすることで行枠線から自然につながる埋め込み表現になる
    rrect(ctx, x + 1, y + 4, w - 2, h - 8, 4,
        t.contentBg, null);
    txt(ctx, text, x + w / 2, y + h / 2,
        active ? t.fg : t.inputText, "center", 11);
}

// ---------------------------------------------------------------------------
// Layout calculator
// ---------------------------------------------------------------------------

/**
 * rowLayout — 行内の要素配置を計算する。
 *
 * **新 API（配列方式）**: opts に `left` または `right` 配列を含む場合に使用。
 *   left:  左端に並べる要素配列 `[{ key, w }, ...]`（pill の後ろに配置）
 *   right: 右端から内側へ積む要素配列 `[{ key, w }, ...]`
 *
 * **旧 API（フラグ方式）**: 後方互換。`left`/`right` を含まない場合。
 *   hasToggle, hasParam, hasMoveUpDown, hasDelete, hasJump フラグで構成を指定。
 *
 * @param {number} W - ウィジェット全幅（node.size[0] をそのまま渡す）
 * @param {object} opts
 * @returns {{ pill?, contentX, contentW, [key]: { x, w } }}
 */
export function rowLayout(W, opts = {}) {
    // 新 API: left / right 配列が指定された場合
    if (opts.left !== undefined || opts.right !== undefined) {
        const { left = [], right = [], hasToggle = false } = opts;
        const layout = {};

        // 左側: toggle pill → left 要素群
        let lx = (hasToggle || left.length > 0) ? PAD + GAP : PAD;
        if (hasToggle) {
            layout.pill = { x: lx, w: 26 };
            lx += 26 + GAP;
        }
        for (const el of left) {
            layout[el.key] = { x: lx, w: el.w };
            lx += el.w + GAP;
        }
        layout.contentX = lx;

        let rx = W - PAD;
        for (const el of right) {
            rx -= el.w;
            layout[el.key] = { x: rx, w: el.w };
            rx -= GAP;
        }
        layout.contentW = Math.max(0, rx - layout.contentX);
        return layout;
    }

    const {
        hasToggle     = false,
        hasParam      = false,
        hasMoveUpDown = false,
        hasDelete     = false,
        hasJump       = false,
    } = opts;

    const layout = {};

    let lx = PAD;
    if (hasToggle) {
        lx += 4;
        layout.pill = { x: lx, w: 26 };
        lx += 26 + 4;
    }
    layout.contentX = lx;

    let rx = W - PAD;

    if (hasDelete) {
        rx -= 20;
        layout.del = { x: rx, w: 20 };
        rx -= 4;
    }
    if (hasMoveUpDown) {
        rx -= 20;
        layout.move = { x: rx, w: 20 };
        rx -= 4;
    }
    if (hasJump) {
        rx -= 18;
        layout.jump = { x: rx, w: 18 };
        rx -= 4;
    }
    if (hasParam) {
        rx -= 42;
        layout.param = { x: rx, w: 42 };
        rx -= 4;
    }

    layout.contentW = Math.max(0, rx - layout.contentX);

    return layout;
}

// ---------------------------------------------------------------------------
// パラメータ入力ポップアップ
// ---------------------------------------------------------------------------

/**
 * パラメータ直接入力用オーバーレイポップアップを表示する。
 *
 * @param {number} screenX - ポップアップを中央揃えする画面X座標
 * @param {number} screenY - ポップアップの下端に合わせる画面Y座標
 * @param {number} currentVal - 現在値
 * @param {{ min?, max?, step? }} cfg - 値の制約
 * @param {function(number)} onCommit - 確定時コールバック
 */
export function showParamPopup(screenX, screenY, currentVal, cfg, onCommit) {
    // 既存ポップアップを除去
    document.querySelectorAll(".__sax_param_popup").forEach(e => e.remove());

    const step     = cfg.step ?? 0.01;
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;

    const overlay = h("div", "position:fixed;inset:0;z-index:10010;");
    overlay.className = "__sax_param_popup";

    const box = h("div",
        "position:absolute;background:var(--comfy-menu-bg,#171718);" +
        "border:1px solid var(--border-color,#4e4e4e);border-radius:8px;" +
        "padding:16px;display:flex;flex-direction:column;gap:8px;" +
        "font:13px/1.5 sans-serif;color:var(--input-text,#ddd);" +
        "box-shadow:0 4px 20px rgba(0,0,0,.7);min-width:200px;");

    if (cfg.label) {
        box.appendChild(h("div",
            "font:bold 14px sans-serif;color:var(--input-text,#ddd);flex-shrink:0;",
            cfg.label));
    }

    const btnRow = h("div", "display:flex;align-items:stretch;gap:4px;");

    const btnStyle =
        "width:44px;background:var(--comfy-input-bg,#222);" +
        "border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;" +
        "color:var(--input-text,#ddd);font-size:24px;cursor:pointer;" +
        "display:flex;align-items:center;justify-content:center;" +
        "user-select:none;flex-shrink:0;padding:0;line-height:1;";

    const minusBtn = h("button", btnStyle, "−");
    const plusBtn  = h("button", btnStyle, "+");

    const input = h("input",
        "flex:1;background:var(--comfy-input-bg,#222);border:1px solid var(--content-bg,#4e4e4e);" +
        "border-radius:4px;color:var(--input-text,#ddd);padding:8px;" +
        "font-size:20px;font-weight:bold;outline:none;text-align:center;min-width:0;");
    input.type      = "text";
    input.inputMode = "decimal";
    input.value     = currentVal.toFixed(decimals);

    btnRow.appendChild(minusBtn);
    btnRow.appendChild(input);
    btnRow.appendChild(plusBtn);
    box.appendChild(btnRow);

    box.appendChild(h("div",
        "font-size:10px;color:var(--border-color,#4e4e4e);text-align:center;",
        `${cfg.min ?? "−∞"} – ${cfg.max ?? "+∞"}  ·  Enter to confirm`));

    // 二重クリック時の即閉じを防ぐため append 前に概算位置を設定
    const approxW = 220, approxH = 110;
    box.style.left = `${Math.max(4, Math.min(screenX - approxW / 2, window.innerWidth  - approxW - 4))}px`;
    box.style.top  = `${Math.max(4, Math.min(screenY - approxH - 6, window.innerHeight - approxH - 4))}px`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();

    requestAnimationFrame(() => {
        const bw = box.offsetWidth;
        const bh = box.offsetHeight;
        let left = screenX - bw / 2;
        let top  = screenY - bh - 6;
        left = Math.max(4, Math.min(left, window.innerWidth  - bw - 4));
        top  = Math.max(4, Math.min(top,  window.innerHeight - bh - 4));
        box.style.left = `${left}px`;
        box.style.top  = `${top}px`;
    });

    const applyDelta = (d) => {
        let val = parseFloat(input.value);
        if (isNaN(val)) val = currentVal;
        val += d;
        if (cfg.min != null) val = Math.max(cfg.min, val);
        if (cfg.max != null) val = Math.min(cfg.max, val);
        val = Math.round(val / step) * step;
        input.value = parseFloat(val.toFixed(decimals)).toFixed(decimals);
        input.select();
    };

    let _holdTimer = null, _holdInterval = null;
    const stopHold = () => {
        clearTimeout(_holdTimer);
        clearInterval(_holdInterval);
        _holdTimer = _holdInterval = null;
        window.removeEventListener("pointerup",     stopHold, { capture: true });
        window.removeEventListener("pointercancel", stopHold, { capture: true });
    };
    const startHold = (d) => {
        stopHold();
        applyDelta(d);
        _holdTimer = setTimeout(() => {
            _holdInterval = setInterval(() => applyDelta(d), 100);
        }, 400);
        window.addEventListener("pointerup",     stopHold, { capture: true });
        window.addEventListener("pointercancel", stopHold, { capture: true });
    };

    minusBtn.addEventListener("pointerdown", e => { e.preventDefault(); startHold(-step); });
    plusBtn.addEventListener( "pointerdown", e => { e.preventDefault(); startHold(+step); });

    const close = () => { stopHold(); overlay.remove(); };
    const commit = () => {
        stopHold();
        const raw = parseFloat(input.value);
        if (!isNaN(raw)) {
            let val = raw;
            if (cfg.min != null) val = Math.max(cfg.min, val);
            if (cfg.max != null) val = Math.min(cfg.max, val);
            onCommit(parseFloat(val.toFixed(decimals)));
        }
        overlay.remove();
    };

    input.addEventListener("keydown", e => {
        if (e.key === "Enter")                              { e.preventDefault(); commit(); }
        if (e.key === "Escape")                             { close(); }
        if (e.key === "ArrowLeft"  || e.key === "ArrowDown")  { e.preventDefault(); applyDelta(-step); }
        if (e.key === "ArrowRight" || e.key === "ArrowUp")    { e.preventDefault(); applyDelta(+step); }
    });

    overlay.addEventListener("wheel", e => {
        e.preventDefault();
        applyDelta((e.deltaY < 0 ? 1 : -1) * step);
    }, { passive: false });

    // 二重クリック対策: 開いた直後の pointerdown では閉じない
    let closeEnabled = false;
    requestAnimationFrame(() => { closeEnabled = true; });
    overlay.addEventListener("pointerdown", e => {
        if (!closeEnabled) return;
        if (e.target === overlay) close();
    });
}

// ---------------------------------------------------------------------------
// DOM UI ヘルパー
// ---------------------------------------------------------------------------

/** DOM 要素ファクトリ。tag・style・text を一括指定して要素を生成する。 */
export function h(tag, css = "", text = "") {
    const e = document.createElement(tag);
    if (css)  e.style.cssText = css;
    if (text) e.textContent   = text;
    return e;
}

/**
 * ComfyUI スタイルのモーダルダイアログを表示する。
 * build(dlg, close) コールバックでタイトル行以降のコンテンツを構築する。
 *
 * @param {{
 *   title:      string,
 *   width?:     number,   // デフォルト 480
 *   maxHeight?: string,   // デフォルト "76vh"
 *   gap?:       number,   // dlg の gap (px)。デフォルト 8
 *   className?: string,   // overlay に付与するクラス名（重複除去用）
 *   build:      (dlg: HTMLElement, close: () => void) => void,
 *   onClose?:   () => void,  // close 時に追加で呼ばれるコールバック（cleanup 用）
 * }} opts
 * @returns {() => void} close 関数
 */
export function showDialog({ title, width = 480, maxHeight = "76vh", gap = 8, className, build, onClose }) {
    const overlay = h("div",
        "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:10000;" +
        "display:flex;align-items:center;justify-content:center;");
    if (className) overlay.classList.add(className);

    const dlg = h("div",
        `background:var(--comfy-menu-bg,#171718);border:1px solid var(--border-color,#4e4e4e);` +
        `border-radius:8px;padding:16px;width:${width}px;max-height:${maxHeight};` +
        `display:flex;flex-direction:column;color:var(--input-text,#ddd);font:13px/1.5 sans-serif;gap:${gap}px;`);

    dlg.appendChild(h("div", "font:bold 14px sans-serif;color:var(--input-text,#ddd);flex-shrink:0;", title));

    const close = () => { onClose?.(); overlay.remove(); };
    build(dlg, close);

    overlay.appendChild(dlg);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);

    return close;
}

// ---------------------------------------------------------------------------
// showItemEditDialog — 汎用アイテム編集ダイアログ
// ---------------------------------------------------------------------------

/**
 * 複数フィールドを一括編集するモーダルダイアログを表示する。
 *
 * @param {{
 *   title:      string,
 *   width?:     number,
 *   className?: string,   // 重複除去用クラス名
 *   fields:     Array<{
 *     type:       "text" | "number" | "select" | "custom",
 *     key?:       string,      // text / number / select で使用
 *     label?:     string,
 *     // number
 *     min?:       number,
 *     max?:       number,
 *     step?:      number,
 *     decimals?:  number,
 *     // select
 *     options?:   Array<{ value: string, label: string, color?: string }>,
 *     // custom — build(container, editData, close) で HTML を構築
 *     build?:     (container: HTMLElement, data: object, close: () => void) => void,
 *   }>,
 *   data:       object,           // 編集対象の初期値（コピーして使用）
 *   onCommit:   (data: object) => void,
 * }} opts
 */
export function showItemEditDialog({ title, width = 380, className, fields, data, onCommit }) {
    const cls = className || "__sax_item_edit_dlg";
    document.querySelectorAll(`.${cls}`).forEach(e => e.remove());

    const ed = { ...data };

    const LABEL = (
        "font-size:10px;color:var(--border-color,#4e4e4e);" +
        "text-transform:uppercase;letter-spacing:0.05em;" +
        "min-width:110px;flex-shrink:0;align-self:center;"
    );
    const INPUT = (
        "flex:1;background:var(--comfy-input-bg,#222);" +
        "border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;" +
        "color:var(--input-text,#ddd);padding:6px;font-size:13px;" +
        "outline:none;text-align:center;min-width:0;"
    );
    const BTN_SM = (
        "width:34px;height:30px;flex-shrink:0;" +
        "background:var(--comfy-input-bg,#222);" +
        "border:1px solid var(--content-bg,#4e4e4e);border-radius:4px;" +
        "color:var(--input-text,#ddd);font-size:18px;cursor:pointer;" +
        "display:flex;align-items:center;justify-content:center;padding:0;"
    );

    let firstInput = null;
    let okBtn      = null;

    showDialog({
        title, width, gap: 10, className: cls,
        build(dlg, close) {
            for (const f of fields) {
                const row = h("div", "display:flex;align-items:center;gap:6px;");
                if (f.label) row.appendChild(h("div", LABEL, f.label));

                if (f.type === "text") {
                    const inp = h("input", INPUT.replace("text-align:center;", "text-align:left;") + "padding:6px 8px;");
                    inp.type  = "text";
                    inp.value = ed[f.key] ?? "";
                    inp.addEventListener("input",   () => { ed[f.key] = inp.value; });
                    inp.addEventListener("keydown", (e) => {
                        if (e.key === "Enter")  okBtn?.click();
                        if (e.key === "Escape") close();
                    });
                    row.appendChild(inp);
                    if (!firstInput) firstInput = inp;

                } else if (f.type === "select") {
                    const group = h("div", "display:flex;gap:6px;flex:1;");
                    const btns  = [];
                    const refresh = () => {
                        btns.forEach(({ btn, opt }) => {
                            const active = ed[f.key] === opt.value;
                            const color  = opt.color || SAX_COLORS.primaryBg;
                            btn.style.background  = active ? color : "var(--comfy-input-bg,#222)";
                            btn.style.borderColor = active ? color : "var(--content-bg,#4e4e4e)";
                            btn.style.color       = active ? "#fff" : "var(--input-text,#ddd)";
                            btn.style.fontWeight  = active ? "bold" : "normal";
                        });
                    };
                    for (const opt of (f.options ?? [])) {
                        const btn = h("button",
                            "flex:1;padding:6px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid;",
                            opt.label);
                        if (opt.tooltip) btn.title = opt.tooltip;
                        btn.addEventListener("click", () => { ed[f.key] = opt.value; refresh(); });
                        group.appendChild(btn);
                        btns.push({ btn, opt });
                    }
                    row.appendChild(group);
                    refresh();

                } else if (f.type === "number") {
                    const dec  = f.decimals ?? 2;
                    const step = f.step ?? 0.01;
                    const minus = h("button", BTN_SM, "−");
                    const plus  = h("button", BTN_SM, "+");
                    const inp   = h("input", INPUT);
                    inp.type      = "text";
                    inp.inputMode = dec > 0 ? "decimal" : "numeric";
                    inp.value     = Number(ed[f.key] ?? 0).toFixed(dec);

                    const set = (v) => {
                        if (f.min != null) v = Math.max(f.min, v);
                        if (f.max != null) v = Math.min(f.max, v);
                        // toFixed → parseFloat で浮動小数点誤差を除去
                        v = dec === 0
                            ? Math.round(v)
                            : parseFloat((Math.round(v / step) * step).toFixed(dec));
                        ed[f.key]  = v;
                        inp.value  = v.toFixed(dec);
                    };
                    inp.addEventListener("change", () => {
                        const v = parseFloat(inp.value);
                        set(isNaN(v) ? (ed[f.key] ?? 0) : v);
                    });

                    let _ht = null, _hi = null;
                    const stopHold = () => {
                        clearTimeout(_ht); clearInterval(_hi); _ht = _hi = null;
                        window.removeEventListener("pointerup",     stopHold, { capture: true });
                        window.removeEventListener("pointercancel", stopHold, { capture: true });
                    };
                    const startHold = (d) => {
                        stopHold();
                        set((ed[f.key] ?? 0) + d);
                        _ht = setTimeout(() => { _hi = setInterval(() => set((ed[f.key] ?? 0) + d), 100); }, 400);
                        window.addEventListener("pointerup",     stopHold, { capture: true });
                        window.addEventListener("pointercancel", stopHold, { capture: true });
                    };
                    minus.addEventListener("pointerdown", e => { e.preventDefault(); startHold(-step); });
                    plus.addEventListener( "pointerdown", e => { e.preventDefault(); startHold(+step); });

                    row.appendChild(minus);
                    row.appendChild(inp);
                    row.appendChild(plus);

                } else if (f.type === "custom") {
                    f.build?.(row, ed, close);
                }

                dlg.appendChild(row);
            }

            // OK / Cancel
            const foot = h("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:2px;");
            const cancelBtn = h("button",
                "padding:7px 20px;border-radius:4px;border:1px solid var(--border-color,#4e4e4e);" +
                "background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);cursor:pointer;",
                "Cancel");
            okBtn = h("button",
                "padding:7px 20px;border-radius:4px;border:none;" +
                "background:var(--primary-background,#0b8ce9);color:#fff;cursor:pointer;font-weight:bold;",
                "OK");
            cancelBtn.addEventListener("click", close);
            okBtn.addEventListener("click", () => { onCommit(ed); close(); });
            foot.appendChild(cancelBtn);
            foot.appendChild(okBtn);
            dlg.appendChild(foot);

            requestAnimationFrame(() => { firstInput?.focus(); firstInput?.select?.(); });
        },
    });
}

// ---------------------------------------------------------------------------
// makeItemListWidget — アイテムリスト共通ウィジェットファクトリ
// ---------------------------------------------------------------------------

/**
 * アイテムリスト形式のカスタムウィジェットを生成して返す。
 *
 * @param {{
 *   widgetName?:    string,
 *   getItems:       () => object[],
 *   saveItems:      (items: object[]) => void,
 *   beforeModify?:  (items: object[]) => void,  // 削除・並び替え直前に呼ばれる（出力スロット接続維持に使用）
 *   maxItems?:      number,
 *   hasToggle?:     boolean,
 *   hasMoveUpDown?: boolean,
 *   hasDelete?:     boolean,
 *   hasJump?:       boolean,
 *
 *   // 複数パラメータ（新 API）— 指定すると params 配列の各要素がパラメータボックスになる。
 *   // 配列の最初の要素が content 寄り（最左）、最後が del/move 寄り（最右）に配置される。
 *   params?: Array<{
 *     key:         string,
 *     w?:          number,   // デフォルト 42
 *     label?:      string,   // ヘッダー列ラベル（COLUMN_HEADER_H モード）
 *     get:         (item: object) => number,
 *     set:         (item: object, v: number) => void,
 *     min?:        number,
 *     max?:        number,
 *     step?:       number,
 *     format?:     (v: number) => string,
 *     dragScale?:  number | ((item: any) => number),
 *     onPopup?:    (item, index, node) => void,
 *   }>,
 *
 *   // 左側バッジ等（新 API）— toggle pill の右に並べる要素。
 *   leftElements?: Array<{
 *     key:      string,
 *     w:        number,
 *     draw:     (ctx, item, x, midY, w, h, on) => void,
 *     onClick?: (item, index, node) => boolean,  // true を返すと saveItems を呼ぶ
 *   }>,
 *
 *   // 旧 API（後方互換）— params/leftElements を使わない場合に使用
 *   hasParam?:      boolean,
 *   param?: {
 *     key:         string,
 *     get:         (item: object) => number,
 *     set:         (item: object, v: number) => void,
 *     min?:        number,
 *     max?:        number,
 *     step?:       number,
 *     format?:     (v: number) => string,
 *     dragScale?:  number | ((item: any) => number),
 *     label?:      string,
 *     onPopup?:    (item, index, node) => void,
 *   },
 *
 *   content: {
 *     draw:    (ctx, item, x, y, w, h, on: boolean) => void,
 *     onClick?: (item, index, node) => void,
 *     onJump?:  (item, index, node) => void,
 *   },
 *   addButton?: {
 *     label:    string,
 *     onCreate?: (node) => object | null,
 *     onAdd?:   (node, items, saveItems) => void,  // onCreate の代替。複数追加などに使用
 *   },
 *   enabledWidget?: { name: string },  // 指定時はヘッダー行に pill として表示
 * }} spec
 * @returns {object} LiteGraph custom widget
 */
export function makeItemListWidget(spec) {
    const {
        widgetName    = "__sax_item_list",
        getItems,
        saveItems,
        beforeModify  = null,   // 配列を変更する直前に呼ばれるコールバック (items: object[]) => void
        maxItems      = 20,
        hasToggle     = false,
        hasMoveUpDown = false,
        hasDelete     = false,
        hasJump       = false,
        params        = null,
        leftElements  = null,
        // 旧 API（後方互換）
        hasParam      = false,
        param         = {},
        content,
        addButton     = null,
        enabledWidget = null,
    } = spec;

    // hasParam + param → _params[0] に正規化（後方互換）
    const _params    = params  ?? (hasParam ? [{ w: 42, ...param }] : []);
    const _leftElems = leftElements ?? [];

    const addBtnH = addButton ? ADD_H : 0;

    const hasAnyParamLabel = _params.some(p => p.label);
    const hdrH = enabledWidget   ? HEADER_H
               : hasAnyParamLabel ? COLUMN_HEADER_H
               : 0;

    let _activeDrag  = null;
    let _dragged     = false;
    let _moveCleanup = null;

    function buildLayout(W) {
        const right = [];
        if (hasDelete)     right.push({ key: "del",  w: 20 });
        if (hasMoveUpDown) right.push({ key: "move", w: 20 });
        if (hasJump)       right.push({ key: "jump", w: 18 });
        // params を逆順で右側に積む（index 0 が content 寄り = 最左）
        for (let i = _params.length - 1; i >= 0; i--) {
            right.push({ key: _params[i].key, w: _params[i].w ?? 42 });
        }
        return rowLayout(W, {
            hasToggle,
            left:  _leftElems.map(le => ({ key: le.key, w: le.w })),
            right,
        });
    }

    return {
        name:  widgetName,
        type:  widgetName,
        value: null,
        _y:    0,

        computeSize(W) {
            const items = getItems();
            return [W, hdrH + items.length * ROW_H + addBtnH + BOTTOM_PAD];
        },

        draw(ctx, node, W, y) {
            this._y = y;
            const items  = getItems();
            const layout = buildLayout(W);
            const t      = getComfyTheme();

            if (hdrH > 0) {
                const headerMidY = y + hdrH / 2;
                if (enabledWidget) {
                    const ew = node.widgets?.find(w => w.name === enabledWidget.name);
                    drawPill(ctx, PAD, headerMidY, ew ? !!ew.value : true);
                }
                for (const p of _params) {
                    if (!p.label) continue;
                    const area = layout[p.key];
                    if (area) {
                        txt(ctx, p.label, area.x + area.w / 2, headerMidY,
                            t.border, "center", 9);
                    }
                }
            }

            const itemsY = y + hdrH;
            items.forEach((item, i) => {
                const rowY = itemsY + i * ROW_H;
                const midY = rowY + ROW_H / 2;
                const on   = hasToggle ? (item.on ?? true) : true;

                drawRowBg(ctx, W, rowY);

                if (layout.pill) {
                    drawPill(ctx, layout.pill.x, midY, on);
                }

                for (const le of _leftElems) {
                    const area = layout[le.key];
                    if (area) le.draw?.(ctx, item, area.x, midY, area.w, ROW_H, on);
                }

                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                content.draw(ctx, item, layout.contentX, rowY, layout.contentW, ROW_H, on);
                ctx.restore();

                for (const p of _params) {
                    const area = layout[p.key];
                    if (!area) continue;
                    const v    = p.get(item);
                    const text = p.format ? p.format(v) : v.toFixed(2);
                    const active = _activeDrag?.rowIndex === i && _activeDrag?.paramKey === p.key;
                    drawParamBox(ctx, area.x, rowY, area.w, ROW_H, text, active);
                }

                if (layout.move) {
                    drawMoveArrows(ctx, layout.move.x, rowY, ROW_H,
                        i > 0, i < items.length - 1);
                }

                if (layout.del) {
                    drawDeleteBtn(ctx, layout.del.x, midY);
                }

                if (layout.jump) {
                    drawJumpBtn(ctx, layout.jump.x, midY);
                }
            });

            if (addButton) {
                const btnY   = itemsY + items.length * ROW_H;
                const canAdd = items.length < maxItems;
                drawAddBtn(ctx, W, btnY, addButton.label ?? ADD_BTN_LABEL, canAdd);
            }
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;

            const items  = getItems();
            const W      = node.size[0];
            const layout = buildLayout(W);

            const rawY   = pos[1] - this._y;
            const localY = rawY - hdrH;

            if (rawY < hdrH) {
                if (enabledWidget && inX(pos, PAD, 30)) {
                    const ew = node.widgets?.find(w => w.name === enabledWidget.name);
                    if (ew) {
                        ew.value = !ew.value;
                        ew.callback?.(ew.value);
                    }
                    app.graph.setDirtyCanvas(true, false);
                    return true;
                }
                return false;
            }

            if (localY < 0) return false;
            const rowIndex = Math.floor(localY / ROW_H);

            if (addButton && rowIndex === items.length) {
                if (items.length >= maxItems) return true;
                beforeModify?.(items);
                if (addButton.onAdd) {
                    addButton.onAdd(node, items, saveItems);
                } else {
                    const newItem = addButton.onCreate(node);
                    if (newItem) {
                        items.push(newItem);
                        saveItems(items);
                        app.graph.setDirtyCanvas(true, false);
                    }
                }
                return true;
            }

            if (rowIndex < 0 || rowIndex >= items.length) return false;

            const item = items[rowIndex];

            if (layout.del && inX(pos, layout.del.x, layout.del.w)) {
                beforeModify?.(items);
                items.splice(rowIndex, 1);
                saveItems(items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            if (layout.move && inX(pos, layout.move.x, layout.move.w)) {
                const relY   = localY - rowIndex * ROW_H;
                const moveUp = relY < ROW_H / 2;
                if (moveUp && rowIndex > 0) {
                    beforeModify?.(items);
                    [items[rowIndex - 1], items[rowIndex]] =
                    [items[rowIndex],     items[rowIndex - 1]];
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                } else if (!moveUp && rowIndex < items.length - 1) {
                    beforeModify?.(items);
                    [items[rowIndex],     items[rowIndex + 1]] =
                    [items[rowIndex + 1], items[rowIndex]];
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                }
                return true;
            }

            if (layout.jump && inX(pos, layout.jump.x, layout.jump.w)) {
                content.onJump?.(item, rowIndex, node);
                return true;
            }

            for (const p of _params) {
                const area = layout[p.key];
                if (!area || !inX(pos, area.x, area.w)) continue;

                if (_moveCleanup) { _moveCleanup(); _moveCleanup = null; }

                _activeDrag = { paramKey: p.key, rowIndex };
                _dragged    = false;

                const startY   = event.clientY;
                const startVal = p.get(item);
                const scale    = (typeof p.dragScale === "function" ? p.dragScale(item) : p.dragScale) ?? (p.step ?? 0.01);

                let endCalled = false;

                const onMove = (e) => {
                    if (endCalled) return;
                    const dy = startY - e.clientY; // 上方向が正
                    if (!_dragged && Math.abs(dy) < 3) return;
                    _dragged = true;
                    const newVal = Math.max(
                        p.min ?? -Infinity,
                        Math.min(p.max ?? Infinity, startVal + dy * scale)
                    );
                    p.set(item, newVal);
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                };

                const endDrag = (e) => {
                    if (endCalled) return;
                    endCalled    = true;
                    const wasDragged = _dragged;
                    _activeDrag  = null;
                    _dragged     = false;
                    _moveCleanup = null;
                    window.removeEventListener("pointermove",   onMove);
                    window.removeEventListener("pointerup",     endDrag, { capture: true });
                    window.removeEventListener("pointercancel", endDrag, { capture: true });
                    app.graph.setDirtyCanvas(true, false);

                    if (!wasDragged && e?.type === "pointerup") {
                        if (p.onPopup) {
                            p.onPopup(item, rowIndex, node);
                        } else {
                            showParamPopup(
                                e.clientX, e.clientY,
                                p.get(item),
                                { min: p.min, max: p.max, step: p.step, label: p.label },
                                (v) => {
                                    p.set(item, v);
                                    saveItems(items);
                                    app.graph.setDirtyCanvas(true, false);
                                }
                            );
                        }
                    }
                };

                // { capture: true } で登録することで LiteGraph の setPointerCapture より先に発火する
                window.addEventListener("pointermove",   onMove);
                window.addEventListener("pointerup",     endDrag, { capture: true });
                window.addEventListener("pointercancel", endDrag, { capture: true });

                _moveCleanup = () => endDrag(null);
                return true;
            }

            for (const le of _leftElems) {
                const area = layout[le.key];
                if (!area || !inX(pos, area.x, area.w)) continue;
                const changed = le.onClick?.(item, rowIndex, node);
                if (changed) {
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                }
                return true;
            }

            if (layout.pill && hasToggle && inX(pos, layout.pill.x, layout.pill.w + 6)) {
                item.on = !(item.on ?? true);
                saveItems(items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            if (content.onClick && inX(pos, layout.contentX, layout.contentW)) {
                content.onClick(item, rowIndex, node);
                return true;
            }

            return false;
        },
    };
}

// ---------------------------------------------------------------------------
// makeSourceListWidget — Collector ノード共通ソースリストウィジェット
//
// Image Collector / Pipe Collector / Node Collector が持つ「ソースノード管理」
// ウィジェットの共通実装。各 Collector はコールバック経由で差異を注入する。
// ---------------------------------------------------------------------------

/**
 * Collector ノード用の汎用ソースリストウィジェットを生成する。
 *
 * @param {{
 *   widgetName:        string,
 *   serializeKey:      string,           // onSerialize/onConfigure のデータキー
 *   maxSlots?:         number,           // デフォルト 64
 *
 *   filterSourceNode:  (srcNode) => boolean,
 *   buildSource:       (srcNode, collectorNode, offset, remaining) => object|null,
 *   connectSource:     (srcNode, src, collectorNode, offset) => void,
 *   showAddPicker:     (collectorNode, selection, onConfirm) => void,  — selection: 既存ソースをプリセット済みの Map
 *
 *   formatInfo?:       (src) => string,
 *   onContentClick?:   (src, srcIdx, node) => void,
 *
 *   getSlotCount?:     (src) => number,
 *   getOffset?:        (sources, srcIdx) => number,
 *
 *   hasOutputSlots?:   boolean,  — true の場合、buildSource が返す src に enabledSlots を必ず初期化すること
 *   buildOutputSlots?: (src, absIdx, localIdx, collectorNode) => void,
 *
 *   migrateData?:      (savedData) => object[]|null,
 *   syncSlotLabels?:   (node, sources) => void,
 * }} spec
 *
 * @returns {{
 *   createWidget:  (ownerNode: object) => object,
 *   onNodeCreated: function,  — this にノードがバインドされた状態で呼ぶ
 *   onSerialize:   function,  — this にノードがバインドされた状態で呼ぶ
 *   onConfigure:   function,  — this にノードがバインドされた状態で呼ぶ
 *   addSource:     function,
 *   getSources:    function,
 *   modifySource:  function,  — (node, srcIdx, updater) source 変更+rebuild+下流リンク復元
 * }}
 */
export function makeSourceListWidget(spec) {
    const {
        widgetName,
        serializeKey,
        maxSlots       = 64,

        filterSourceNode,
        buildSource,
        connectSource,
        showAddPicker,

        formatInfo     = null,
        onContentClick = null,

        getSlotCount   = (src) => src.slotCount ?? 0,
        getOffset      = null,   // null の場合は累積和
        hasOutputSlots = false,
        buildOutputSlots = null,

        migrateData    = null,
        syncSlotLabels = null,
    } = spec;

    // 必須コールバックの検証
    if (typeof filterSourceNode !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: filterSourceNode は必須です`);
    }
    if (typeof buildSource !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: buildSource は必須です`);
    }
    if (typeof connectSource !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: connectSource は必須です`);
    }
    if (typeof showAddPicker !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: showAddPicker は必須です`);
    }
    if (hasOutputSlots && typeof buildOutputSlots !== "function") {
        throw new Error(`makeSourceListWidget [${widgetName}]: hasOutputSlots=true の場合 buildOutputSlots は必須です`);
    }

    // ----------------------------------------------------------------
    // 内部ヘルパー
    // ----------------------------------------------------------------

    function _getSources(node) {
        return node._remoteSources ?? [];
    }

    function _getOffset(node, srcIdx) {
        if (getOffset) return getOffset(_getSources(node), srcIdx);
        const sources = _getSources(node);
        let offset = 0;
        for (let i = 0; i < srcIdx; i++) offset += getSlotCount(sources[i]);
        return offset;
    }

    function _getTotalSlotCount(node) {
        return _getSources(node).reduce((sum, s) => sum + getSlotCount(s), 0);
    }

    function _sourceSignature(srcNode) {
        return (srcNode.outputs ?? [])
            .map(o => `${o.label ?? o.name ?? ""}:${o.type ?? ""}`).join(",");
    }

    function _autoResize(node) {
        const sz = node.computeSize?.();
        if (sz && node.size[1] !== sz[1]) {
            node.size[1] = sz[1];
            app.canvas?.setDirty(true, true);
        }
    }

    function _defaultSyncSlotLabels(node) {
        const sources = _getSources(node);
        let absIdx = 0;
        for (const src of sources) {
            const count = getSlotCount(src);
            for (let li = 0; li < count; li++) {
                if (node.inputs[absIdx]) {
                    node.inputs[absIdx].name = `slot_${absIdx}`;
                    node.inputs[absIdx].type = "*";
                }
                absIdx++;
            }
        }
        app.canvas?.setDirty(true, true);
    }

    function _syncSlotLabels(node) {
        if (syncSlotLabels) {
            try { syncSlotLabels(node, _getSources(node)); } catch (e) { console.warn(`[${widgetName}] syncSlotLabels error:`, e); }
        } else {
            _defaultSyncSlotLabels(node);
        }
    }

    // ----------------------------------------------------------------
    // 下流リンク保存（hasOutputSlots 時）
    // ----------------------------------------------------------------

    function _captureDownstream(node) {
        if (!hasOutputSlots) return [];
        const sources     = _getSources(node);
        const downstream  = [];
        for (let si = 0; si < sources.length; si++) {
            const src    = sources[si];
            const offset = _getOffset(node, si);
            const count  = getSlotCount(src);
            for (let li = 0; li < count; li++) {
                const absIdx = offset + li;
                const out    = node.outputs?.[absIdx];
                if (!out?.links?.length) continue;
                for (const lid of out.links) {
                    const lnk = app.graph.links?.[lid];
                    if (lnk) downstream.push({
                        sourceId:      src.sourceId,
                        globalSlotIdx: src.enabledSlots?.[li] ?? li,
                        outName:       out.label ?? out.name ?? null,
                        localSlot:     li,
                        targetId:      lnk.target_id,
                        targetSlot:    lnk.target_slot,
                    });
                }
            }
        }
        return downstream;
    }

    function _restoreDownstream(node, downstream) {
        if (!hasOutputSlots || !downstream.length) return;
        for (const ds of downstream) {
            const si = _getSources(node).findIndex(s => s.sourceId === ds.sourceId);
            if (si < 0) continue;
            const src = _getSources(node)[si];

            let resolvedLocalSlot = -1;
            if (ds.outName != null && src.slotNames) {
                const nameIdx = src.slotNames.indexOf(ds.outName);
                if (nameIdx >= 0) {
                    const localIdx = (src.enabledSlots ?? []).indexOf(nameIdx);
                    if (localIdx >= 0) resolvedLocalSlot = localIdx;
                }
            }
            if (resolvedLocalSlot < 0 && ds.globalSlotIdx != null && src.enabledSlots) {
                const localIdx = src.enabledSlots.indexOf(ds.globalSlotIdx);
                if (localIdx >= 0) resolvedLocalSlot = localIdx;
            }
            if (resolvedLocalSlot < 0) continue;

            const newAbsIdx = _getOffset(node, si) + resolvedLocalSlot;
            const tgtNode   = app.graph.getNodeById(ds.targetId);
            if (tgtNode && node.outputs?.[newAbsIdx]) {
                node.connect(newAbsIdx, tgtNode, ds.targetSlot);
            }
        }
    }

    // ----------------------------------------------------------------
    // ソース操作
    // ----------------------------------------------------------------

    function addSource(collectorNode, srcNode) {
        const sources   = collectorNode._remoteSources ?? [];
        const offset    = _getTotalSlotCount(collectorNode);
        const remaining = maxSlots - offset;
        if (remaining <= 0) return;

        let src;
        try {
            src = buildSource(srcNode, collectorNode, offset, remaining);
        } catch (e) {
            console.warn(`[${widgetName}] buildSource error:`, e);
            return;
        }
        if (!src) return;

        src.sig = _sourceSignature(srcNode);

        const physCount = getSlotCount(src);
        for (let li = 0; li < physCount; li++) {
            collectorNode.addInput(`slot_${offset + li}`, "*");
            if (hasOutputSlots && buildOutputSlots) {
                try { buildOutputSlots(src, offset + li, li, collectorNode); } catch (e) { console.warn(`[${widgetName}] buildOutputSlots error:`, e); }
            }
        }

        try {
            connectSource(srcNode, src, collectorNode, offset);
        } catch (e) {
            console.warn(`[${widgetName}] connectSource error:`, e);
        }

        sources.push(src);
        collectorNode._remoteSources = sources;

        _syncSlotLabels(collectorNode);
        applyLinkVisibility(collectorNode);
        _autoResize(collectorNode);
    }

    function removeSourceAt(node, idx) {
        const sources = _getSources(node);
        if (idx < 0 || idx >= sources.length) return;

        const offset    = _getOffset(node, idx);
        const physCount = getSlotCount(sources[idx]);

        unhideSourceLinks(node);
        for (let i = offset + physCount - 1; i >= offset; i--) {
            const linkId = node.inputs[i]?.link;
            if (linkId != null) app.graph.removeLink(linkId);
            if (hasOutputSlots) node.removeOutput(i);
            node.removeInput(i);
        }
        sources.splice(idx, 1);
        node._remoteSources = sources;

        for (const [id] of _hiddenLinkIds) {
            if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
        }

        _syncSlotLabels(node);
        applyLinkVisibility(node);
        _autoResize(node);
        app.canvas?.setDirty(true, false);
    }

    function rebuildAllSources(node, preDownstream = null) {
        const savedSources = [..._getSources(node)];
        const autoHints = hasOutputSlots && !node._rebuildHints;
        if (autoHints) {
            node._rebuildHints = new Map(
                savedSources.map(s => [s.sourceId, { enabledSlots: s.enabledSlots, slotCount: s.slotCount }])
            );
        }
        const downstream = preDownstream ?? _captureDownstream(node);

        unhideSourceLinks(node);
        for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
            const linkId = node.inputs[i]?.link;
            if (linkId != null) app.graph.removeLink(linkId);
            node.removeInput(i);
        }
        if (hasOutputSlots) {
            for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) node.removeOutput(i);
        }
        node._remoteSources = [];

        for (const src of savedSources) {
            const srcNode = app.graph.getNodeById(src.sourceId);
            if (srcNode) addSource(node, srcNode);
        }

        _restoreDownstream(node, downstream);
        if (autoHints) node._rebuildHints = null;
    }

    function swapSources(node, si, sj) {
        const sources    = _getSources(node);
        const downstream = _captureDownstream(node);
        [sources[si], sources[sj]] = [sources[sj], sources[si]];
        rebuildAllSources(node, downstream);
        applyLinkVisibility(node);
        _autoResize(node);
        app.canvas?.setDirty(true, false);
    }

    function resetAllSources(node) {
        for (const [id] of _hiddenLinkIds) {
            if (!app.graph.links[id]) _hiddenLinkIds.delete(id);
        }
        unhideSourceLinks(node);
        for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
            const linkId = node.inputs[i]?.link;
            if (linkId != null) app.graph.removeLink(linkId);
            node.removeInput(i);
        }
        if (hasOutputSlots) {
            for (let i = (node.outputs?.length ?? 0) - 1; i >= 0; i--) node.removeOutput(i);
        }
        node._remoteSources = [];
        _autoResize(node);
        app.canvas?.setDirty(true, false);
    }

    // ----------------------------------------------------------------
    // ウィジェット本体（ノードごとにインスタンス化）
    // ----------------------------------------------------------------

    // ownerNode: computeSize でノード参照が必要（LiteGraph が引数に渡さないため）
    // draw/mouse は LiteGraph が正しいノードを引数に渡すため、引数の drawNode/mouseNode を使用する
    function _createWidget(ownerNode) {
        let _widgetY = 0;

        return {
            name:  widgetName,
            type:  widgetName,
            value: null,

            computeSize(W) {
                const n = _getSources(ownerNode).length;
                return [W, HEADER_H + n * ROW_H + ADD_H + BOTTOM_PAD];
            },

            draw(ctx, drawNode, W, y) {
                _widgetY = y;
            const t = getComfyTheme();

            // 毎フレーム: ソース生存確認・タイトル変更・sig 変化の検知
            const sources = _getSources(drawNode);
            let sigChangedDetected = false;
            for (let si = sources.length - 1; si >= 0; si--) {
                const src     = sources[si];
                const srcNode = app.graph.getNodeById(src.sourceId);
                if (!srcNode) {
                    removeSourceAt(drawNode, si);
                    continue;
                }
                const currentTitle = srcNode.title || srcNode.type || `Node#${srcNode.id}`;
                if (currentTitle !== src.sourceTitle) {
                    src.sourceTitle = currentTitle;
                    app.canvas?.setDirty(true, false);
                }
                const sig = _sourceSignature(srcNode);
                if (sig !== src.sig) {
                    src.sig = sig;
                    sigChangedDetected = true;
                }
            }
            if (sigChangedDetected) {
                const ds = _captureDownstream(drawNode);
                setTimeout(() => rebuildAllSources(drawNode, ds), 0);
                return;
            }

            // ヘッダー: Show links pill
            const linksVisible = drawNode._remoteLinksVisible ?? false;
            const headerMidY   = y + HEADER_H / 2;
            drawPill(ctx, PAD + 4, headerMidY, linksVisible);
            txt(ctx, "Show links", PAD + 38, headerMidY, t.contentBg, "left", 10);

            // ソース行
            const layout = rowLayout(W, { hasJump: true, hasMoveUpDown: true, hasDelete: true });
            for (let si = 0; si < sources.length; si++) {
                const src  = sources[si];
                const rowY = y + HEADER_H + si * ROW_H;
                const midY = rowY + ROW_H / 2;

                drawRowBg(ctx, W, rowY);

                const icon  = src.isSub ? "▣" : "◈";
                const color = src.isSub ? SAX_COLORS.subgraph : SAX_COLORS.node;
                let info    = "";
                if (formatInfo) {
                    try { info = formatInfo(src); } catch (e) { console.warn(`[${widgetName}] formatInfo error:`, e); }
                }

                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                txt(ctx, `${icon}  ${src.sourceTitle}`, layout.contentX + 4, midY, color, "left", 11);
                if (info) txt(ctx, info, layout.contentX + layout.contentW, midY, t.contentBg, "right", 10);
                ctx.restore();

                drawJumpBtn(ctx, layout.jump.x, midY);
                drawMoveArrows(ctx, layout.move.x, rowY, ROW_H, si > 0, si < sources.length - 1);
                drawDeleteBtn(ctx, layout.del.x, midY);
            }

            // Add ボタン
            const btnY   = y + HEADER_H + sources.length * ROW_H;
            const canAdd = _getTotalSlotCount(drawNode) < maxSlots;
            drawAddBtn(ctx, W, btnY,
                sources.length === 0 ? "Select source…" : "+ Add Source",
                canAdd);
        },

        mouse(event, pos, mouseNode) {
            if (event.type !== "pointerdown") return false;
            const W       = mouseNode.size[0];
            const relY    = pos[1] - _widgetY;
            const sources = _getSources(mouseNode);
            const layout  = rowLayout(W, { hasJump: true, hasMoveUpDown: true, hasDelete: true });

            // ヘッダー領域
            if (relY < HEADER_H) {
                if (pos[0] >= PAD && pos[0] < PAD + 34) {
                    toggleLinkVisibility(mouseNode);
                    return true;
                }
                return false;
            }

            const localY = relY - HEADER_H;

            // ソース行
            for (let si = 0; si < sources.length; si++) {
                if (localY < si * ROW_H || localY >= (si + 1) * ROW_H) continue;

                if (inX(pos, layout.del.x, layout.del.w)) {
                    removeSourceAt(mouseNode, si);
                    return true;
                }

                if (inX(pos, layout.move.x, layout.move.w)) {
                    const moveUp = (localY - si * ROW_H) < ROW_H / 2;
                    if (moveUp && si > 0) swapSources(mouseNode, si - 1, si);
                    else if (!moveUp && si < sources.length - 1) swapSources(mouseNode, si, si + 1);
                    return true;
                }

                if (inX(pos, layout.jump.x, layout.jump.w)) {
                    const srcNode = app.graph.getNodeById(sources[si].sourceId);
                    if (srcNode) {
                        const savedOffset = [...app.canvas.ds.offset];
                        import("./sax_picker.js").then(({ panCanvasTo, showReturnButton, clearPickerHighlight }) => {
                            panCanvasTo(
                                srcNode.pos[0] + (srcNode.size?.[0] ?? 0) / 2,
                                srcNode.pos[1] + (srcNode.size?.[1] ?? 0) / 2
                            );
                            const jumpTimer = setTimeout(() => {
                                for (const n of app.graph._nodes) n.is_selected = false;
                                if (typeof app.canvas.selectNode === "function") {
                                    app.canvas.selectNode(srcNode, false);
                                } else {
                                    app.canvas.selected_nodes = { [srcNode.id]: srcNode };
                                    srcNode.is_selected = true;
                                }
                                app.canvas.setDirty(true, true);
                            }, 100);
                            showReturnButton(() => {
                                clearTimeout(jumpTimer);
                                srcNode.is_selected = false;
                                clearPickerHighlight();
                                app.canvas.ds.offset[0] = savedOffset[0];
                                app.canvas.ds.offset[1] = savedOffset[1];
                                setTimeout(() => {
                                    if (!app.graph.getNodeById(mouseNode.id)) return;
                                    for (const n of app.graph._nodes) n.is_selected = false;
                                    if (typeof app.canvas.selectNode === "function") {
                                        app.canvas.selectNode(mouseNode, false);
                                    } else {
                                        app.canvas.selected_nodes = { [mouseNode.id]: mouseNode };
                                        mouseNode.is_selected = true;
                                    }
                                    app.canvas.setDirty(true, true);
                                }, 100);
                            });
                        }).catch(e => console.warn(`[${widgetName}] panCanvasTo error:`, e));
                    }
                    return true;
                }

                if (onContentClick && inX(pos, layout.contentX, layout.contentW)) {
                    try { onContentClick(sources[si], si, mouseNode); } catch (e) { console.warn(`[${widgetName}] onContentClick error:`, e); }
                    return true;
                }

                return false;
            }

            // Add ボタン領域
            const btnRowTop = HEADER_H + sources.length * ROW_H;
            if (relY < btnRowTop || relY >= btnRowTop + ADD_H) return false;

            {
                const sources = _getSources(mouseNode);
                const selection = new Map();
                for (const src of sources) {
                    selection.set(`n:${src.sourceId}`, { type: "node", id: src.sourceId });
                }
                try {
                    showAddPicker(mouseNode, selection, (items) => {
                        const currentSources = _getSources(mouseNode);
                        const newIds = new Set(items.filter(i => i.type === "node").map(i => i.id));
                        const oldIds = currentSources.map(s => s.sourceId);

                        // 除去（逆順でインデックスずれを防止）
                        for (let i = oldIds.length - 1; i >= 0; i--) {
                            if (!newIds.has(oldIds[i])) removeSourceAt(mouseNode, i);
                        }

                        // 追加（既存にないもののみ）
                        const survivingIds = new Set(oldIds.filter(id => newIds.has(id)));
                        for (const item of items) {
                            if (item.type !== "node") continue;
                            if (survivingIds.has(item.id)) continue;
                            if (_getTotalSlotCount(mouseNode) >= maxSlots) break;
                            const n = app.graph.getNodeById(item.id);
                            if (n) addSource(mouseNode, n);
                        }
                    });
                } catch (e) { console.warn(`[${widgetName}] showAddPicker error:`, e); }
            }
            return true;
        },
    };
    }

    // ----------------------------------------------------------------
    // ノードフック
    // ----------------------------------------------------------------

    function onNodeCreated() {
        this._remoteSources      = [];
        this._remoteLinksVisible = false;
        this.addCustomWidget(_createWidget(this));
    }

    function onSerialize(data) {
        data[serializeKey] = {
            sources:      _getSources(this).map(({ _connectRetries, ...rest }) => rest),
            linksVisible: this._remoteLinksVisible ?? false,
        };
    }

    function onConfigure(data) {
        const saved = data[serializeKey];
        if (saved) {
            let sources = null;
            if (migrateData) {
                try {
                    sources = migrateData(saved);
                } catch (e) {
                    console.warn(`[${widgetName}] migrateData error:`, e);
                    sources = [];
                }
            }
            if (sources == null) sources = saved.sources ?? [];

            this._remoteSources      = sources;
            this._remoteLinksVisible = saved.linksVisible ?? false;

            // LiteGraph はリンク復元前に onConfigure を呼ぶため、スロット数のみ同期する
            const total  = _getTotalSlotCount(this);
            const curIn  = this.inputs?.length ?? 0;
            for (let i = curIn - 1; i >= total; i--) this.removeInput(i);
            for (let i = curIn; i < total; i++) this.addInput(`slot_${i}`, "*");
            if (hasOutputSlots) {
                const curOut = this.outputs?.length ?? 0;
                for (let i = curOut - 1; i >= total; i--) this.removeOutput(i);
                for (let i = curOut; i < total; i++) this.addOutput(`out_${i}`, "*");
            }
            _syncSlotLabels(this);
        }

        if (!this.widgets?.some(w => w.name === widgetName)) {
            this.addCustomWidget(_createWidget(this));
        }

        const node = this;
        setTimeout(() => {
            const sources = _getSources(node);
            for (let si = 0; si < sources.length; si++) {
                const src     = sources[si];
                const srcNode = app.graph.getNodeById(src.sourceId);
                if (!srcNode) {
                    src.sig = "";
                    src._connectRetries = (src._connectRetries ?? 0) + 1;
                    continue;
                }
                const offset = _getOffset(node, si);
                try {
                    connectSource(srcNode, src, node, offset);
                    src.sig = _sourceSignature(srcNode);
                    delete src._connectRetries;
                } catch (e) {
                    console.warn(`[${widgetName}] connectSource (configure) error:`, e);
                    if ((src._connectRetries ?? 0) < 3) {
                        src.sig = "";
                        src._connectRetries = (src._connectRetries ?? 0) + 1;
                    }
                }
            }
            applyLinkVisibility(node);
            _autoResize(node);
        }, 0);
    }

    function modifySource(node, srcIdx, updater) {
        const sources = _getSources(node);
        if (srcIdx < 0 || srcIdx >= sources.length) return;
        const downstream = _captureDownstream(node);
        try { updater(sources[srcIdx]); } catch (e) { console.warn(`[${widgetName}] modifySource updater error:`, e); return; }
        rebuildAllSources(node, downstream);
    }

    return {
        createWidget: _createWidget,
        onNodeCreated,
        onSerialize,
        onConfigure,
        addSource,
        getSources: _getSources,
        modifySource,
    };
}

// ---------------------------------------------------------------------------
// renderLink パッチ — ステルスリンク（非表示リンク）制御
//
// linkId → nodeId の Map で所有権を追跡し、ノード間の干渉を防ぐ。
// node._remoteLinksVisible: true = リンク表示, false = 非表示（デフォルト）
// ---------------------------------------------------------------------------

const _hiddenLinkIds = new Map();
let _renderLinkPatched = false;

/** renderLink を1度だけパッチし、_hiddenLinkIds に含まれるリンクをスキップする。 */
export function ensureRenderLinkPatch() {
    if (_renderLinkPatched) return;
    _renderLinkPatched = true;
    const proto    = Object.getPrototypeOf(app.canvas);
    const original = proto.renderLink;
    if (!original) return;
    proto.renderLink = function (ctx, a, b, link, ...rest) {
        if (link && _hiddenLinkIds.has(link.id)) return;
        return original.call(this, ctx, a, b, link, ...rest);
    };
}

/** ノードの全入力リンクを非表示 Map に登録する（所有者 = node.id）。 */
export function hideSourceLinks(node) {
    for (let i = 0; i < (node.inputs?.length ?? 0); i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.set(linkId, node.id);
    }
    app.canvas?.setDirty(true, false);
}

/** ノードが所有する全エントリを非表示 Map から除去する。 */
export function unhideSourceLinks(node) {
    for (const [lid, nid] of _hiddenLinkIds) {
        if (nid === node.id) _hiddenLinkIds.delete(lid);
    }
}

/** node._remoteLinksVisible の値に従ってリンク表示を適用する。 */
export function applyLinkVisibility(node) {
    if (node._remoteLinksVisible) {
        unhideSourceLinks(node);
    } else {
        hideSourceLinks(node);
    }
    app.canvas?.setDirty(true, false);
}

/** node._remoteLinksVisible を反転してリンク表示を切り替える。 */
export function toggleLinkVisibility(node) {
    node._remoteLinksVisible = !node._remoteLinksVisible;
    applyLinkVisibility(node);
}

// ---------------------------------------------------------------------------
// 出力スロット接続維持ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 各アイテムに現在の出力スロット接続状態を `_links` プロパティとして記録する。
 *
 * **呼び出しタイミング:**
 * - `makeItemListWidget` の `beforeModify` コールバック内（配列変更の直前）
 * - `onConfigure` の setTimeout 内（LiteGraph によるリンク復元後）
 *
 * @param {object}   node        LiteGraph ノード
 * @param {object[]} items       現在のアイテム配列（node.outputs と同順）
 * @param {number}  [slotOffset] 出力スロットの開始インデックス（デフォルト: 0）
 */
export function captureOutputLinks(node, items, slotOffset = 0) {
    for (let i = 0; i < items.length; i++) {
        const slotLinks = node.outputs?.[slotOffset + i]?.links ?? [];
        items[i]._links = slotLinks.map(linkId => {
            const link = app.graph.links[linkId];
            return link ? { targetId: link.target_id, targetSlot: link.target_slot } : null;
        }).filter(Boolean);
    }
}

/**
 * 全出力スロットのリンクを削除し、`syncFn` でスロット構造を更新してから
 * 各アイテムの `_links` に記録された接続先へ非同期で再接続する。
 *
 * **使い方（パターン）:**
 * ```js
 * const saveItems = (newItems) => {
 *     node._myItems = newItems;
 *     restoreOutputLinks(node, newItems, () => syncMyOutputSlots(node, newItems));
 * };
 * return makeItemListWidget({
 *     ...
 *     beforeModify: (items) => captureOutputLinks(node, items),
 *     saveItems,
 * });
 * ```
 *
 * @param {object}   node        LiteGraph ノード
 * @param {object[]} items       新しいアイテム配列（syncFn 適用後の順序）
 * @param {Function} syncFn      スロット構造を更新する同期関数（removeOutput/addOutput を含む）
 * @param {number}  [slotOffset] 出力スロットの開始インデックス（デフォルト: 0）
 */
export function restoreOutputLinks(node, items, syncFn, slotOffset = 0) {
    // 全スロットのリンクを削除（removeOutput は内部でリンクも消すが、
    // スロット数が変わらない場合は removeOutput が呼ばれないため明示削除する）
    for (let i = 0; i < (node.outputs?.length ?? 0); i++) {
        for (const linkId of [...(node.outputs[i]?.links ?? [])]) {
            app.graph.removeLink(linkId);
        }
    }

    // スロット構造を更新
    syncFn();

    // LiteGraph の DOM/グラフ更新を待ってから再接続
    setTimeout(() => {
        const affectedNodes = new Set();
        for (let i = 0; i < items.length; i++) {
            for (const conn of (items[i]._links ?? [])) {
                const targetNode = app.graph.getNodeById(conn.targetId);
                if (targetNode) {
                    node.connect(slotOffset + i, targetNode, conn.targetSlot);
                    affectedNodes.add(targetNode);
                }
            }
        }
        // 再接続後の状態を _links に反映
        captureOutputLinks(node, items, slotOffset);
        // 接続先ノードのリンク非表示状態を再適用（link ID が変わるため）
        for (const targetNode of affectedNodes) {
            if (targetNode._remoteLinksVisible === false) {
                applyLinkVisibility(targetNode);
            }
        }
        app.canvas?.setDirty(true, true);
    }, 0);
}

// ---------------------------------------------------------------------------
// ピッカー共通ユーティリティ
// ---------------------------------------------------------------------------

/**
 * セクション数がこの閾値以下のとき、全セクションを強制展開する。
 * sax_picker.js / sax_lora_loader.js が共有する。
 */
export const AUTO_EXPAND_THRESHOLD = 3;

/**
 * 折りたたみ可能なセクション要素を生成する。
 *
 * @param {Map}     collapsed        - 呼び出し側が管理する折りたたみ状態 Map<key, boolean>
 * @param {string}  key              - セクションを一意に識別するキー
 * @param {string}  label            - ヘッダーに表示するテキスト
 * @param {string}  color            - ヘッダーテキスト色（デフォルト: SAX_COLORS.node）
 * @param {Element[]} childEls       - 子要素の配列
 * @param {boolean} [defaultCollapsed=false] - 初期折りたたみ状態
 * @param {boolean} [forceOpen=false]        - true のとき collapsed Map を無視して強制展開
 * @param {string}  [mode="multi"]           - "multi" のとき一括選択チェックボックスを表示
 * @returns {HTMLElement}
 */
export function makePickerSection(collapsed, key, label, color, childEls, defaultCollapsed = false, forceOpen = false, mode = "multi") {
    if (color == null) color = SAX_COLORS.node;
    const isCollapsed = forceOpen ? false : (collapsed.has(key) ? collapsed.get(key) : defaultCollapsed);
    const sec    = h("div", "margin-bottom:4px;");
    const header = h("div",
        `display:flex;align-items:center;gap:6px;cursor:pointer;padding:5px 4px;` +
        `background:var(--comfy-input-bg,#222);border-radius:4px;` +
        `color:${color};font-weight:bold;font-size:12px;`);
    const arrow  = h("span", "font-size:10px;flex-shrink:0;", isCollapsed ? "▶" : "▼");
    if (mode === "multi") {
        const hasDirectItems = childEls.some(el => el.classList?.contains("sax-picker-item"));
        const selectAllCb = document.createElement("input");
        selectAllCb.type = "checkbox";
        selectAllCb.disabled = !hasDirectItems;
        selectAllCb.style.cssText = `cursor:${hasDirectItems ? "pointer" : "default"};flex-shrink:0;accent-color:#4a9;${hasDirectItems ? "" : "opacity:0.3;"}`;
        selectAllCb.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!hasDirectItems) return;
            const checked = selectAllCb.checked;
            body.querySelectorAll(":scope > .sax-picker-item input[type='checkbox']").forEach(cb => {
                if (cb.checked !== checked) {
                    cb.checked = checked;
                    cb.dispatchEvent(new Event("change", { bubbles: true }));
                }
            });
        });
        header.appendChild(selectAllCb);
    }
    header.appendChild(arrow);
    header.appendChild(h("span", "flex:1;", label));
    const body = h("div", `padding-left:8px;${isCollapsed ? "display:none;" : ""}`);
    for (const c of childEls) body.appendChild(c);
    header.addEventListener("click", (e) => {
        if (e.target.type === "checkbox") return;
        const currentState = collapsed.has(key) ? collapsed.get(key) : (forceOpen ? false : defaultCollapsed);
        const now = !currentState;
        collapsed.set(key, now);
        arrow.textContent  = now ? "▶" : "▼";
        body.style.display = now ? "none" : "";
    });
    sec.appendChild(header);
    sec.appendChild(body);
    return sec;
}

/**
 * ピッカーダイアログ内の共通コンテンツ（検索バー・スクロールコンテナ・ボタン行・ESC ハンドラ）を生成する。
 *
 * @param {object}   opts
 * @param {"single"|"multi"} [opts.mode="multi"]   - "single" では Apply ボタンを表示しない
 * @param {string}   [opts.placeholder="Search…"]  - 検索バーのプレースホルダー
 * @param {Function} opts.renderContent             - (query: string, scroll: Element) => void
 * @param {Function|null} [opts.onApply=null]       - Apply 時のコールバック（multi のみ）
 * @param {Function} opts.onCancel                  - Cancel / ESC 時のコールバック
 * @returns {{ element: HTMLElement, focusSearch: () => void, cleanup: () => void }}
 */
export function buildPickerContent({
    mode          = "multi",
    placeholder   = "Search…",
    renderContent,
    onApply       = null,
    onCancel,
}) {
    // 検索バー
    const searchWrap = h("div",
        "display:flex;align-items:center;gap:6px;background:var(--comfy-input-bg,#222);" +
        "border:1px solid var(--border-color,#4e4e4e);border-radius:4px;padding:5px 10px;flex-shrink:0;");
    searchWrap.appendChild(h("span", "color:var(--content-bg,#4e4e4e);", "🔍"));
    const searchInput = document.createElement("input");
    searchInput.placeholder = placeholder;
    searchInput.style.cssText =
        "flex:1;background:none;border:none;outline:none;" +
        "color:var(--input-text,#ddd);font-size:12px;";
    searchWrap.appendChild(searchInput);

    // スクロールコンテナ
    const scroll = h("div", "overflow-y:auto;flex:1;");

    // Expand All / Collapse All — scroll 内のセクションを DOM 操作で一括制御
    function toggleAllSections(expand) {
        scroll.querySelectorAll(":scope div > div").forEach(header => {
            const arrow = header.querySelector(":scope > span:first-of-type");
            const body = header.nextElementSibling;
            if (!arrow || !body || body.tagName !== "DIV") return;
            const isArrow = arrow.textContent === "▶" || arrow.textContent === "▼";
            if (!isArrow) return;
            arrow.textContent = expand ? "▼" : "▶";
            body.style.display = expand ? "" : "none";
        });
        // collapsed Map の同期は header の click イベントに任せず、
        // 次回 renderContent 時に collapsed Map の状態で再構築される
    }

    const makeFoldBtn = (label, title, fn) => {
        const b = h("button",
            "padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer;" +
            "background:none;border:1px solid var(--content-bg,#4e4e4e);" +
            "color:var(--input-text,#ddd);white-space:nowrap;flex-shrink:0;");
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", fn);
        return b;
    };
    searchWrap.appendChild(makeFoldBtn("▼", "Expand all", () => toggleAllSections(true)));
    searchWrap.appendChild(makeFoldBtn("▶", "Collapse all", () => toggleAllSections(false)));

    // 描画関数
    // 検索入力の連続発火による DOM 全再構築を防ぐため 150ms デバウンス
    // （100+ ノードのグラフで体感的な遅延が発生していたため）
    const doRender = () => renderContent(searchInput.value, scroll);
    let _searchTimer = null;
    const doRenderDebounced = () => {
        if (_searchTimer != null) clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => { _searchTimer = null; doRender(); }, 150);
    };
    doRender();
    searchInput.addEventListener("input", doRenderDebounced);

    // ボタン行
    const btnRow = h("div", "display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;");
    const makeBtn = (text, bg, fn, color = "var(--input-text,#ddd)", hoverBg = null) => {
        const b = h("button",
            `padding:6px 14px;background:${bg};border:1px solid var(--content-bg,#4e4e4e);` +
            `border-radius:4px;color:${color};cursor:pointer;font-size:12px;`);
        b.textContent = text;
        b.addEventListener("click", fn);
        if (hoverBg) {
            b.addEventListener("mouseenter", () => { b.style.background = hoverBg; });
            b.addEventListener("mouseleave", () => { b.style.background = bg; });
        }
        return b;
    };
    btnRow.appendChild(makeBtn("Cancel", "var(--comfy-input-bg,#222)", onCancel));
    if (mode === "multi" && onApply) {
        btnRow.appendChild(makeBtn(
            "Apply",
            SAX_COLORS.primaryBg,
            onApply,
            SAX_COLORS.primaryText,
            SAX_COLORS.primaryHoverBg,
        ));
    }

    // ESC キーハンドラ
    const onKeyDown = (e) => {
        if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);

    const cleanup = () => {
        document.removeEventListener("keydown", onKeyDown);
        // ダイアログ閉鎖後に残留タイマーが切り離し済み DOM へ doRender を呼ぶのを防ぐ
        if (_searchTimer != null) { clearTimeout(_searchTimer); _searchTimer = null; }
    };

    // コンテナ要素
    const element = h("div", "display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;");
    element.appendChild(searchWrap);
    element.appendChild(scroll);
    element.appendChild(btnRow);

    return {
        element,
        focusSearch: () => requestAnimationFrame(() => searchInput.focus()),
        cleanup,
    };
}

// ---------------------------------------------------------------------------
// 汎用ファイルピッカー
// ---------------------------------------------------------------------------

/**
 * 汎用ファイルピッカーダイアログ。
 * フォルダツリー + 検索フィルタ + single/multi 選択をサポート。
 *
 * @param {object}  opts
 * @param {string[]} opts.items           - 選択肢の文字列配列（パス区切りでフォルダ構造を自動構築）
 * @param {string}  [opts.currentValue]   - 現在選択中の値（ハイライト用）
 * @param {string}  [opts.title]          - ダイアログタイトル
 * @param {string}  [opts.placeholder]    - 検索バーのプレースホルダー
 * @param {"single"|"multi"} [opts.mode="single"] - 選択モード
 * @param {string}  [opts.className]      - ダイアログの CSS クラス
 * @param {Function} [opts.onSelect]      - single モード: (name) => void
 * @param {Set}     [opts.selection]      - multi モード: 初期選択セット
 * @param {Function} [opts.onConfirm]     - multi モード: (names: string[]) => void
 * @param {Function} [opts.displayName]   - 表示名変換関数（デフォルト: 拡張子除去 + パス除去）
 * @param {Function} [opts.filterFn]      - カスタムフィルタ (name, query) => boolean
 */
export function showFilePicker(opts) {
    const mode = opts.mode ?? "single";
    const {
        items,
        currentValue   = "",
        title          = mode === "multi" ? "Add / Remove Items" : "Select Item",
        placeholder    = "Search…",
        className      = "__sax_file_picker",
        onSelect       = null,
        selection: initSelection = new Set(),
        onConfirm      = null,
        displayName: displayFn = (name) => name.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""),
        filterFn: customFilter = null,
    } = opts;

    document.querySelectorAll(`.${className}`).forEach(e => e.remove());

    const collapsed = new Map();
    const selection = new Set(initSelection);

    // -- ツリー構造 --

    function buildTree(names) {
        const root = { children: new Map(), items: [] };
        for (const name of names) {
            const parts = name.split(/[\\/]/);
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                const p = parts[i];
                if (!node.children.has(p))
                    node.children.set(p, { children: new Map(), items: [] });
                node = node.children.get(p);
            }
            node.items.push(name);
        }
        return root;
    }

    function countAll(node) {
        return node.items.length +
            [...node.children.values()].reduce((s, c) => s + countAll(c), 0);
    }

    function countFiltered(node, fn) {
        const own = node.items.filter(fn).length;
        return own + [...node.children.values()].reduce((s, c) => s + countFiltered(c, fn), 0);
    }

    function countSections(node, fn) {
        let count = 0;
        for (const child of node.children.values()) {
            const directItems = fn ? child.items.filter(fn).length : child.items.length;
            if (directItems > 0) count += 1;
            count += countSections(child, fn);
        }
        return count;
    }

    function containsCurrent(node, pathPrefix) {
        if (!currentValue) return false;
        const norm = currentValue.replace(/\\/g, "/");
        if (pathPrefix && !norm.startsWith(pathPrefix + "/")) return false;
        return node.items.includes(currentValue) ||
            [...node.children.entries()].some(([name, child]) =>
                containsCurrent(child, (pathPrefix ? pathPrefix + "/" : "") + name));
    }

    // -- 行生成 --

    function makeRow(fullName, isCurrent, close) {
        const label = displayFn(fullName);

        if (mode === "multi") {
            const row = h("div",
                "display:flex;align-items:center;gap:8px;padding:3px 0 3px 2px;");
            row.classList.add("sax-picker-item");
            row.title = fullName;
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selection.has(fullName);
            cb.style.cssText = "cursor:pointer;flex-shrink:0;accent-color:#4a9;";
            cb.addEventListener("change", () => {
                if (cb.checked) selection.add(fullName); else selection.delete(fullName);
            });
            const lbl = h("span",
                "cursor:pointer;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;" +
                "white-space:nowrap;font-size:11px;color:var(--input-text,#ddd);");
            lbl.textContent = label;
            lbl.addEventListener("click", () => { cb.click(); });
            row.appendChild(cb);
            row.appendChild(lbl);
            return row;
        }

        const row = h("div",
            `display:flex;align-items:center;gap:6px;padding:3px 2px;border-radius:3px;` +
            `${isCurrent ? "background:var(--comfy-menu-secondary-bg,#303030);" : ""}`);
        row.title = fullName;

        const lbl = h("label",
            `cursor:default;user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;` +
            `white-space:nowrap;font-size:11px;` +
            `color:${isCurrent ? "#7d7" : "var(--input-text,#ddd)"};`);
        lbl.textContent = label;
        row.appendChild(lbl);

        const selBtn = h("button",
            `padding:2px 10px;border-radius:3px;font-size:11px;cursor:pointer;flex-shrink:0;` +
            `background:${isCurrent ? "var(--comfy-menu-secondary-bg,#303030)" : "var(--comfy-input-bg,#222)"};` +
            `border:1px solid var(--content-bg,#4e4e4e);` +
            `color:${isCurrent ? "#9f9" : "var(--input-text,#ddd)"};`,
            isCurrent ? "✓" : "Select");
        selBtn.addEventListener("mouseenter", () => {
            selBtn.style.background = "var(--comfy-menu-secondary-bg,#303030)";
        });
        selBtn.addEventListener("mouseleave", () => {
            selBtn.style.background = isCurrent
                ? "var(--comfy-menu-secondary-bg,#303030)"
                : "var(--comfy-input-bg,#222)";
        });
        selBtn.addEventListener("click", () => { close(); onSelect?.(fullName); });

        row.appendChild(selBtn);
        if (isCurrent) row.dataset.current = "true";
        return row;
    }

    // -- ツリーレンダリング --

    function renderTree(node, pathPrefix, close, filterFn = null, alwaysOpen = false) {
        const els = [];
        for (const name of [...node.items].sort()) {
            if (filterFn && !filterFn(name)) continue;
            els.push(makeRow(name, name === currentValue, close));
        }
        for (const [folderName, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const key      = (pathPrefix ? pathPrefix + "/" : "") + folderName;
            const childEls = renderTree(child, key, close, filterFn, alwaysOpen);
            if (childEls.length === 0) continue;
            const total    = countAll(child);
            const matched  = filterFn ? countFiltered(child, filterFn) : total;
            const countStr = filterFn && matched < total ? `${matched}/${total}` : String(total);
            const hasCur   = containsCurrent(child, key);
            els.push(makePickerSection(collapsed, key, `${folderName}  (${countStr})`, SAX_COLORS.node, childEls, !hasCur, alwaysOpen, mode));
        }
        return els;
    }

    // -- ダイアログ表示 --

    let pickerCleanup = null;
    showDialog({
        title,
        width:     480,
        className,
        onClose:   () => { pickerCleanup?.(); },
        build(dlg, close) {
            const closeFn = () => { pickerCleanup?.(); close(); };

            const renderContentFn = (q, scroll) => {
                scroll.innerHTML = "";
                const lower = q.toLowerCase().trim();
                const filterFn = lower
                    ? customFilter
                        ? (name) => customFilter(name, lower)
                        : (name) => name.replace(/\.[^.]+$/, "").toLowerCase().includes(lower)
                    : null;

                if (items.length === 0) {
                    scroll.appendChild(h("div",
                        "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;",
                        "No items found"));
                    return;
                }

                const tree         = buildTree(items);
                const sectionCount = countSections(tree, filterFn);
                const forceOpen    = sectionCount <= AUTO_EXPAND_THRESHOLD;
                const els          = renderTree(tree, "", closeFn, filterFn, forceOpen);
                if (els.length === 0) {
                    scroll.appendChild(h("div",
                        "color:var(--content-bg,#4e4e4e);padding:20px;text-align:center;font-size:12px;",
                        "No results"));
                    return;
                }
                for (const el of els) scroll.appendChild(el);
                if (!filterFn) {
                    requestAnimationFrame(() => {
                        const cur = scroll.querySelector("[data-current='true']");
                        if (cur) cur.scrollIntoView({ block: "center" });
                    });
                }
            };

            const { element, focusSearch, cleanup } = buildPickerContent({
                mode,
                placeholder,
                renderContent: renderContentFn,
                onApply: mode === "multi" ? () => { closeFn(); onConfirm?.([...selection]); } : null,
                onCancel: closeFn,
            });
            pickerCleanup = cleanup;

            dlg.appendChild(element);
            focusSearch();
        },
    });
}
