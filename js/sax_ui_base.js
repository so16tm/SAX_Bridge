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
 *   rowLayout(W, flags)
 *   showParamPopup(screenX, screenY, currentVal, cfg, onCommit)
 *   makeItemListWidget(node, spec)
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

export const PAD   = 8;
export const ROW_H = 24;

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
 * rowLayout — 右端から del → move → jump → param を確保し、残りを content 幅とする。
 *
 * @param {number} W - ウィジェット全幅（node.size[0] をそのまま渡す）
 * @param {{ hasToggle?, hasParam?, hasMoveUpDown?, hasDelete?, hasJump? }} flags
 * @returns {{
 *   pill?:    { x: number, w: number },
 *   contentX: number,
 *   contentW: number,
 *   param?:   { x: number, w: number },
 *   jump?:    { x: number, w: number },
 *   move?:    { x: number, w: number },
 *   del?:     { x: number, w: number },
 * }}
 */
export function rowLayout(W, {
    hasToggle     = false,
    hasParam      = false,
    hasMoveUpDown = false,
    hasDelete     = false,
    hasJump       = false,
} = {}) {
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
        rx -= 64;
        layout.param = { x: rx, w: 64 };
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
                        v = dec === 0 ? Math.round(v) : Math.round(v / step) * step;
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
 * @param {object} node - LiteGraph ノードオブジェクト
 * @param {{
 *   widgetName?:    string,
 *   getItems:       () => object[],
 *   saveItems:      (items: object[]) => void,
 *   maxItems?:      number,
 *   hasToggle?:     boolean,
 *   hasMoveUpDown?: boolean,
 *   hasDelete?:     boolean,
 *   hasParam?:      boolean,
 *   param?: {
 *     key:         string,
 *     get:         (item: object) => number,
 *     set:         (item: object, v: number) => void,
 *     min?:        number,
 *     max?:        number,
 *     step?:       number,
 *     format?:     (v: number) => string,
 *     dragScale?:  number,
 *   },
 *   content: {
 *     draw:    (ctx, item, x, y, w, h, on: boolean) => void,
 *     onClick?: (item, index, node) => void,
 *   },
 *   addButton?: {
 *     label:    string,
 *     onCreate: (node) => object | null,
 *   },
 * }} spec
 * @returns {object} LiteGraph custom widget
 */
export function makeItemListWidget(node, spec) {
    const {
        widgetName    = "__sax_item_list",
        getItems,
        saveItems,
        maxItems      = 20,
        hasToggle     = false,
        hasMoveUpDown = false,
        hasDelete     = false,
        hasParam      = false,
        param         = {},
        content,
        addButton     = null,
        enabledWidget = null,   // { name: string } — 指定時はヘッダー行に pill として表示
    } = spec;

    const ADD_H    = addButton ? ROW_H : 0;
    // enabledWidget または param.label があればヘッダー行を表示する
    const HEADER_H = (enabledWidget || (hasParam && param.label)) ? 20 : 0;

    // ドラッグ状態（クロージャで保持）
    let _dragIndex   = -1;   // draw() でのアクティブ表示に使用
    let _dragged     = false;
    let _moveCleanup = null; // 外部から強制終了できるクリーンアップ関数

    return {
        name:  widgetName,
        type:  widgetName,
        value: null,
        _y:    0,   // draw() で更新 → mouse() の相対 Y 計算に使用

        computeSize(W) {
            const items = getItems();
            return [W, HEADER_H + items.length * ROW_H + ADD_H];
        },

        draw(ctx, node, W, y) {
            this._y = y;
            const items  = getItems();
            const layout = rowLayout(W, { hasToggle, hasParam, hasMoveUpDown, hasDelete });
            const t      = getComfyTheme();

            // ヘッダー行（enabledWidget pill + param.label）
            if (HEADER_H > 0) {
                const headerMidY = y + HEADER_H / 2;
                if (enabledWidget) {
                    const ew = node.widgets?.find(w => w.name === enabledWidget.name);
                    drawPill(ctx, PAD, headerMidY, ew ? !!ew.value : true);
                }
                if (hasParam && param.label) {
                    txt(ctx, param.label,
                        layout.param.x + layout.param.w / 2,
                        headerMidY,
                        t.border, "center", 9);
                }
            }

            const itemsY = y + HEADER_H;
            items.forEach((item, i) => {
                const rowY = itemsY + i * ROW_H;
                const midY = rowY + ROW_H / 2;
                const on   = hasToggle ? (item.on ?? true) : true;

                // 行背景：暗い背景 + 明るい枠線でカプセルを表現
                // inputBg (#222) = 暗い本体, contentBg (#4e4e4e) = 枠線（Strength ボックスと同色）
                rrect(ctx, PAD, rowY + 2, W - PAD * 2, ROW_H - 4, (ROW_H - 4) / 2,
                    t.inputBg, t.contentBg);

                // Toggle pill
                if (layout.pill) {
                    drawPill(ctx, layout.pill.x, midY, on);
                }

                // Content（ノード固有の描画 — クリップ済み）
                ctx.save();
                ctx.beginPath();
                ctx.rect(layout.contentX, rowY, layout.contentW, ROW_H);
                ctx.clip();
                content.draw(ctx, item, layout.contentX, rowY, layout.contentW, ROW_H, on);
                ctx.restore();

                // Param ボックス
                if (layout.param) {
                    const v    = param.get(item);
                    const text = param.format ? param.format(v) : v.toFixed(2);
                    drawParamBox(ctx,
                        layout.param.x, rowY, layout.param.w, ROW_H,
                        text, _dragIndex === i);
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
            });

            // Add ボタン（モノクロ）
            if (addButton) {
                const btnY   = itemsY + items.length * ROW_H;
                const canAdd = items.length < maxItems;
                rrect(ctx, PAD, btnY + 2, W - PAD * 2, ADD_H - 4, 4,
                    canAdd ? t.inputBg : t.menuBg,
                    canAdd ? t.contentBg : t.border);
                txt(ctx, addButton.label, W / 2, btnY + ADD_H / 2,
                    canAdd ? t.inputText : t.border, "center", 11);
            }
        },

        mouse(event, pos, node) {
            if (event.type !== "pointerdown") return false;

            const items  = getItems();
            const W      = node.size[0];
            const layout = rowLayout(W, { hasToggle, hasParam, hasMoveUpDown, hasDelete });

            const rawY   = pos[1] - this._y;
            const localY = rawY - HEADER_H;

            // ── ヘッダー行クリック（enabledWidget トグル） ──
            if (rawY < HEADER_H) {
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
                const newItem = addButton.onCreate(node);
                if (newItem) {
                    items.push(newItem);
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                }
                return true;
            }

            if (rowIndex < 0 || rowIndex >= items.length) return false;

            const item = items[rowIndex];

            // ── Delete ──
            if (layout.del && inX(pos, layout.del.x, layout.del.w)) {
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
                    [items[rowIndex - 1], items[rowIndex]] =
                    [items[rowIndex],     items[rowIndex - 1]];
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                } else if (!moveUp && rowIndex < items.length - 1) {
                    [items[rowIndex],     items[rowIndex + 1]] =
                    [items[rowIndex + 1], items[rowIndex]];
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                }
                return true;
            }

            // ── Param（drag or click） ──
            if (layout.param && hasParam && inX(pos, layout.param.x, layout.param.w)) {
                // 既存ドラッグを強制終了してから新しいドラッグを開始
                if (_moveCleanup) { _moveCleanup(); _moveCleanup = null; }

                _dragIndex = rowIndex;
                _dragged   = false;

                const startY    = event.clientY;
                const startVal  = param.get(item);
                const scale     = param.dragScale ?? (param.step ?? 0.01);

                // endCalled フラグで idempotent なクリーンアップを保証
                // — pointerup が canvas + window の両方から届いても二重処理しない
                let endCalled = false;

                const onMove = (e) => {
                    if (endCalled) return;
                    const dy = startY - e.clientY; // 上方向が正
                    if (!_dragged && Math.abs(dy) < 3) return;
                    _dragged = true;
                    const newVal = Math.max(
                        param.min ?? -Infinity,
                        Math.min(param.max ?? Infinity, startVal + dy * scale)
                    );
                    param.set(item, newVal);
                    saveItems(items);
                    app.graph.setDirtyCanvas(true, false);
                };

                const endDrag = (e) => {
                    if (endCalled) return;
                    endCalled    = true;
                    const wasDragged = _dragged;
                    _dragIndex   = -1;
                    _dragged     = false;
                    _moveCleanup = null;
                    // window capture で登録したリスナーをすべて除去
                    window.removeEventListener("pointermove",   onMove);
                    window.removeEventListener("pointerup",     endDrag, { capture: true });
                    window.removeEventListener("pointercancel", endDrag, { capture: true });
                    app.graph.setDirtyCanvas(true, false);

                    // ドラッグなし（クリック）かつ有効な pointerup → ポップアップ表示
                    if (!wasDragged && e?.type === "pointerup") {
                        if (param.onPopup) {
                            // カスタムポップアップ（統合ダイアログ等）
                            param.onPopup(item, rowIndex, node);
                        } else {
                            showParamPopup(
                                e.clientX,
                                e.clientY,
                                param.get(item),
                                { min: param.min, max: param.max, step: param.step, label: param.label },
                                (v) => {
                                    param.set(item, v);
                                    saveItems(items);
                                    app.graph.setDirtyCanvas(true, false);
                                }
                            );
                        }
                    }
                };

                // window + { capture: true } で登録する理由:
                //   LiteGraph がキャンバスに setPointerCapture している場合や
                //   canvas の pointerup ハンドラが stopPropagation しても
                //   window capture リスナーはキャプチャフェーズ先頭で必ず発火する
                window.addEventListener("pointermove",   onMove);
                window.addEventListener("pointerup",     endDrag, { capture: true });
                window.addEventListener("pointercancel", endDrag, { capture: true });

                // 外部クリーンアップ用（次ドラッグ開始時・ウィジェット破棄時に呼ばれる）
                _moveCleanup = () => endDrag(null);
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
