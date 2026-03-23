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
 *
 * 出力スロット接続維持ユーティリティ:
 *   captureOutputLinks(node, items, slotOffset?)
 *   restoreOutputLinks(node, items, syncFn, slotOffset?)
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

    // プライマリアクション（Apply ボタン等）— DOM インラインスタイル用 CSS 変数文字列
    primaryBg:      "var(--primary-background,      #0b8ce9)",
    primaryHoverBg: "var(--primary-background-hover,#31b9f4)",
    primaryText:    "var(--button-surface-contrast, #ffffff)",
};

// ---------------------------------------------------------------------------
// ComfyUI テーマ（CSS変数から読み込み・キャッシュ）
// ---------------------------------------------------------------------------

let _themeCache = null;

// ComfyUI がパレットを変更した際にキャッシュを自動無効化する。
// パレット変更は documentElement の style 属性、または head への style 要素追加で行われる。
{
    const _inv = () => { _themeCache = null; };
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
    // ON: コンテンツグレー背景 + 明るいボーダー / OFF: 最暗背景 + 通常ボーダー
    rrect(ctx, x, pY, pW, pH, 7,
        on ? t.contentBg : t.menuBg,
        on ? t.inputText : t.border);
    const kX = on ? x + pW - 12 : x + 2;
    // ON: 白ノブ / OFF: ボーダー色ノブ（暗く = 明確にオフ）
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
    // 背景色 = 行枠線と同色 (contentBg) → 枠線から自然につながる埋め込み表現
    // y+4 / h-8 で行枠線の内側に 1px のマージンを確保
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

        // 右側: right 配列を順に右から積む
        let rx = W - PAD;
        for (const el of right) {
            rx -= el.w;
            layout[el.key] = { x: rx, w: el.w };
            rx -= GAP;
        }
        layout.contentW = Math.max(0, rx - layout.contentX);
        return layout;
    }

    // 旧 API（後方互換）: フラグ方式
    const {
        hasToggle     = false,
        hasParam      = false,
        hasMoveUpDown = false,
        hasDelete     = false,
        hasJump       = false,
    } = opts;

    const layout = {};

    // 左側: pill があれば確保し、content の開始 X を決める
    let lx = PAD;
    if (hasToggle) {
        lx += 4;   // 行枠線の内側マージン（枠線との重なりを回避）
        layout.pill = { x: lx, w: 26 };
        lx += 26 + 4;   // pill 幅 + ギャップ
    }
    layout.contentX = lx;

    // 右側: 内側に向かって del → move → jump → param を積む
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

    // ラベル — showDialog のタイトル行と同じスタイル
    if (cfg.label) {
        box.appendChild(h("div",
            "font:bold 14px sans-serif;color:var(--input-text,#ddd);flex-shrink:0;",
            cfg.label));
    }

    // ±ボタン + 入力欄 行
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

    // ヒント
    box.appendChild(h("div",
        "font-size:10px;color:var(--border-color,#4e4e4e);text-align:center;",
        `${cfg.min ?? "−∞"} – ${cfg.max ?? "+∞"}  ·  Enter to confirm`));

    // append 前に概算位置を設定（二重クリック時の即閉じ防止）
    const approxW = 220, approxH = 110;
    box.style.left = `${Math.max(4, Math.min(screenX - approxW / 2, window.innerWidth  - approxW - 4))}px`;
    box.style.top  = `${Math.max(4, Math.min(screenY - approxH - 6, window.innerHeight - approxH - 4))}px`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();

    // レイアウト確定後に正確な位置へ調整
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

    // 値変更
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

    // 長押し auto-repeat
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

    // confirm / cancel
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

    // ホイールで値増減
    overlay.addEventListener("wheel", e => {
        e.preventDefault();
        applyDelta((e.deltaY < 0 ? 1 : -1) * step);
    }, { passive: false });

    // 開いた直後の pointerdown では閉じない（二重クリック対策）
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
 * }} opts
 * @returns {() => void} close 関数
 */
export function showDialog({ title, width = 480, maxHeight = "76vh", gap = 8, className, build }) {
    const overlay = h("div",
        "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:10000;" +
        "display:flex;align-items:center;justify-content:center;");
    if (className) overlay.classList.add(className);

    const dlg = h("div",
        `background:var(--comfy-menu-bg,#171718);border:1px solid var(--border-color,#4e4e4e);` +
        `border-radius:8px;padding:16px;width:${width}px;max-height:${maxHeight};` +
        `display:flex;flex-direction:column;color:var(--input-text,#ddd);font:13px/1.5 sans-serif;gap:${gap}px;`);

    dlg.appendChild(h("div", "font:bold 14px sans-serif;color:var(--input-text,#ddd);flex-shrink:0;", title));

    const close = () => overlay.remove();
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
    let okBtn      = null;  // keydown ハンドラから参照（代入後に発火）

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
                            const color  = opt.color || "var(--primary-background,#0b8ce9)";
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
                        // toFixed で桁丸めしてから parseFloat に通すことで浮動小数点誤差を除去
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

                    // 長押し auto-repeat
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

    // 後方互換: hasParam + param → _params[0] に正規化
    const _params    = params  ?? (hasParam ? [{ w: 42, ...param }] : []);
    const _leftElems = leftElements ?? [];

    const addBtnH = addButton ? ADD_H : 0;

    // ヘッダー高さ: enabledWidget あり → HEADER_H、param ラベルのみ → COLUMN_HEADER_H、なし → 0
    const hasAnyParamLabel = _params.some(p => p.label);
    const hdrH = enabledWidget   ? HEADER_H
               : hasAnyParamLabel ? COLUMN_HEADER_H
               : 0;

    // ドラッグ状態（クロージャで保持）
    let _activeDrag  = null;  // { paramKey: string, rowIndex: number } | null
    let _dragged     = false;
    let _moveCleanup = null;  // 外部から強制終了できるクリーンアップ関数

    // レイアウト計算（W に依存するため都度呼ぶ）
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
        _y:    0,   // draw() で更新 → mouse() の相対 Y 計算に使用

        computeSize(W) {
            const items = getItems();
            return [W, hdrH + items.length * ROW_H + addBtnH + BOTTOM_PAD];
        },

        draw(ctx, node, W, y) {
            this._y = y;
            const items  = getItems();
            const layout = buildLayout(W);
            const t      = getComfyTheme();

            // ヘッダー行
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

                // 行背景
                drawRowBg(ctx, W, rowY);

                // Toggle pill
                if (layout.pill) {
                    drawPill(ctx, layout.pill.x, midY, on);
                }

                // leftElements（モードバッジ等）
                for (const le of _leftElems) {
                    const area = layout[le.key];
                    if (area) le.draw?.(ctx, item, area.x, midY, area.w, ROW_H, on);
                }

                // Content（ノード固有の描画 — クリップ済み）
                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                content.draw(ctx, item, layout.contentX, rowY, layout.contentW, ROW_H, on);
                ctx.restore();

                // Param ボックス群
                for (const p of _params) {
                    const area = layout[p.key];
                    if (!area) continue;
                    const v    = p.get(item);
                    const text = p.format ? p.format(v) : v.toFixed(2);
                    const active = _activeDrag?.rowIndex === i && _activeDrag?.paramKey === p.key;
                    drawParamBox(ctx, area.x, rowY, area.w, ROW_H, text, active);
                }

                // Move arrows
                if (layout.move) {
                    drawMoveArrows(ctx, layout.move.x, rowY, ROW_H,
                        i > 0, i < items.length - 1);
                }

                // Delete ボタン
                if (layout.del) {
                    drawDeleteBtn(ctx, layout.del.x, midY);
                }

                // Jump ボタン
                if (layout.jump) {
                    drawJumpBtn(ctx, layout.jump.x, midY);
                }
            });

            // Add ボタン
            if (addButton) {
                const btnY   = itemsY + items.length * ROW_H;
                const canAdd = items.length < maxItems;
                drawAddBtn(ctx, W, btnY, addButton.label, canAdd);
            }
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;

            const items  = getItems();
            const W      = node.size[0];
            const layout = buildLayout(W);

            const rawY   = pos[1] - this._y;
            const localY = rawY - hdrH;

            // ── ヘッダー行クリック（enabledWidget トグル） ──
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

            // ── Add ボタン ──
            if (addButton && rowIndex === items.length) {
                if (items.length >= maxItems) return true;
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

            // ── Delete ──
            if (layout.del && inX(pos, layout.del.x, layout.del.w)) {
                beforeModify?.(items);
                items.splice(rowIndex, 1);
                saveItems(items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Move arrows ──
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

            // ── Jump ──
            if (layout.jump && inX(pos, layout.jump.x, layout.jump.w)) {
                content.onJump?.(item, rowIndex, node);
                return true;
            }

            // ── Param ボックス（ドラッグ or クリック） ──
            for (const p of _params) {
                const area = layout[p.key];
                if (!area || !inX(pos, area.x, area.w)) continue;

                if (_moveCleanup) { _moveCleanup(); _moveCleanup = null; }

                _activeDrag = { paramKey: p.key, rowIndex };
                _dragged    = false;

                const startY   = event.clientY;
                const startVal = p.get(item);
                const scale    = (typeof p.dragScale === "function" ? p.dragScale(item) : p.dragScale) ?? (p.step ?? 0.01);

                // endCalled フラグで idempotent なクリーンアップを保証
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

                // window + { capture: true } で登録する理由:
                //   LiteGraph がキャンバスに setPointerCapture している場合でも
                //   キャプチャフェーズ先頭で必ず発火する
                window.addEventListener("pointermove",   onMove);
                window.addEventListener("pointerup",     endDrag, { capture: true });
                window.addEventListener("pointercancel", endDrag, { capture: true });

                _moveCleanup = () => endDrag(null);
                return true;
            }

            // ── leftElements クリック ──
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

            // ── Toggle pill ──
            if (layout.pill && hasToggle && inX(pos, layout.pill.x, layout.pill.w + 6)) {
                item.on = !(item.on ?? true);
                saveItems(items);
                app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // ── Content クリック ──
            if (content.onClick && inX(pos, layout.contentX, layout.contentW)) {
                content.onClick(item, rowIndex, node);
                return true;
            }

            return false;
        },
    };
}

// ---------------------------------------------------------------------------
// renderLink パッチ — ステルスリンク（非表示リンク）制御
//
// 複数ノードで共有する必要があるため sax_ui_base に定義する。
// node._remoteLinksVisible: true = リンク表示, false = 非表示（デフォルト）
// ---------------------------------------------------------------------------

export const _hiddenLinkIds = new Set();
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

/** ノードの全入力リンクを非表示セットに追加する。 */
export function hideSourceLinks(node) {
    for (let i = 0; i < (node.inputs?.length ?? 0); i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.add(linkId);
    }
    app.canvas?.setDirty(true, false);
}

/** ノードの全入力リンクを非表示セットから除去する。 */
export function unhideSourceLinks(node) {
    for (let i = 0; i < (node.inputs?.length ?? 0); i++) {
        const linkId = node.inputs[i]?.link;
        if (linkId != null) _hiddenLinkIds.delete(linkId);
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
        for (let i = 0; i < items.length; i++) {
            for (const conn of (items[i]._links ?? [])) {
                const targetNode = app.graph.getNodeById(conn.targetId);
                if (targetNode) node.connect(slotOffset + i, targetNode, conn.targetSlot);
            }
        }
        // 再接続後の状態を _links に反映
        captureOutputLinks(node, items, slotOffset);
        app.canvas?.setDirty(true, true);
    }, 0);
}
