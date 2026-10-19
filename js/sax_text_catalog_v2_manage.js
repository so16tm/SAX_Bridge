import { showDialog, showConfirmDialog } from "./sax_ui_base.js";
import { catalogSummary, duplicateNames, nameKey, sortedNamedOptions } from "./sax_text_catalog_v2_model.js";
import { listCatalogs, duplicateCatalog, archiveCatalog, restoreCatalog, listArchivedCatalogs, flushCatalog, releaseSession } from "./sax_text_catalog_v2_client.js";

const STYLE = `
.sax-catalog-manager [hidden]{display:none!important}
.sax-catalog-manager button{font:inherit;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#242426);border:1px solid var(--border-color,#45454b);border-radius:6px;padding:4px 9px;cursor:pointer}
.sax-catalog-manager button:disabled{opacity:.45;cursor:default}.sax-catalog-manager :focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:2px}
.sax-catalog-manager .scm-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.sax-catalog-manager .scm-muted{opacity:.68;font-size:12px}
.sax-catalog-manager .scm-list{display:flex;flex-direction:column;gap:6px;overflow:auto;max-height:46vh;min-height:0}
.sax-catalog-manager .scm-entry{display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--border-color,#45454b);border-radius:6px}
.sax-catalog-manager .scm-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.sax-catalog-manager .scm-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sax-catalog-manager .scm-warn{color:var(--warning-text,#e0b050);font-size:11px}.sax-catalog-manager .scm-error{color:var(--error-text,#ed9494);font-size:12px;white-space:pre-wrap}
.sax-catalog-manager .scm-danger{color:var(--error-text,#ed9494)}
.sax-catalog-manager .scm-status{display:flex;gap:8px;align-items:center;min-height:24px;font-size:12px}
.sax-catalog-manager details>summary{cursor:pointer}
`;

function el(tag, cls = "", text = "") { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; }
function btn(text, fn, cls = "") { const n = el("button", cls, text); n.type = "button"; n.addEventListener("click", fn); return n; }

/**
 * アーカイブの確認文。削除ではないこと、戻し方、検出できない参照元の影響を示す。
 * workflowUsers はこのワークフロー内でそのカタログを使う Text Catalog V2 ノードの数。
 */
export function archiveMessage(catalog, workflowUsers = 0) {
    const detail = catalogSummary(catalog);
    return [`「${catalog.name || "無題"}」${detail ? `（${detail}）` : ""}をアーカイブします。`,
        "削除はされず、archive フォルダーへ移動します。「アーカイブ済み」からいつでも復元できます。",
        ...(workflowUsers ? [`このワークフローの ${workflowUsers} 個の Text Catalog V2 ノードがこのカタログを参照しています。アーカイブ後は、参照先が見つからずエラーになります。`] : []),
        "このカタログを使う他のワークフローは検出できません。アーカイブ後にそれらを実行すると、参照先が見つからずエラーになります。"].join("\n");
}

/**
 * カタログの一覧（アイテム数・セット数・更新日時）と、複製・アーカイブ・復元の画面。
 * 削除はせず、アーカイブ直後は「元に戻す」で復元できる。workflowUsage(id) はこのワークフロー内の参照ノード数。
 * onCatalogChange(id) は、アーカイブ・復元でそのカタログの有無が変わったとき（V2 ノードに最新の状態を読み直させる）。
 */
export function openCatalogManager({ workflowUsage = () => 0, onCatalogChange = () => {} } = {}) {
    let statusEl, listEl, archivedEl, archivedList, heading, dialogRoot, busy = false, archivedLoaded = false, catalogs = [];
    const report = error => { statusEl.replaceChildren(el("span", "scm-error", error?.message ?? String(error))); };
    const notify = (message, undo = null) => {
        statusEl.replaceChildren(el("span", "", message));
        if (undo) statusEl.append(btn("元に戻す", guard(async () => { await undo(); notify("元に戻しました"); })));
    };
    // 操作中は二重に押せないようにする。失敗は画面の通知に出す。
    function guard(fn) {
        return async () => {
            if (busy) return; busy = true; dialogRoot?.setAttribute("aria-busy", "true");
            const disabled = [...dialogRoot?.querySelectorAll("button:not(:disabled)") ?? []];
            for (const control of disabled) control.disabled = true;
            try { await fn(); } catch (error) { report(error); }
            finally {
                busy = false; dialogRoot?.setAttribute("aria-busy", "false");
                for (const control of disabled) control.disabled = false;
                await paintList().catch(() => {});
            }
        };
    }
    async function paintList() {
        catalogs = sortedNamedOptions(await listCatalogs());
        const duplicated = duplicateNames(catalogs.filter(catalog => !catalog.error));
        heading.textContent = `カタログ一覧（${catalogs.length}件）`; listEl.replaceChildren();
        if (!catalogs.length) listEl.append(el("div", "scm-muted", "カタログがありません"));
        for (const catalog of catalogs) {
            const entry = el("div", "scm-entry"); entry.dataset.catalogId = catalog.id;
            const title = el("strong", "", catalog.name || "無題"); title.title = catalog.name;
            const meta = el("span", "scm-muted", `${catalogSummary(catalog)} · ID ${catalog.id.slice(0, 8)}`); meta.title = catalog.error ? `${catalog.error}\nID ${catalog.id}` : `ID ${catalog.id}`;
            const copy = el("div", "scm-copy"); copy.append(title, meta);
            if (!catalog.error && duplicated.has(nameKey(catalog.name))) copy.append(el("span", "scm-warn", "同じ名前のカタログがあります（件数・更新日時・IDで見分けてください）"));
            const actions = el("div", "scm-row");
            if (!catalog.error) {
                const copyButton = btn("複製", guard(async () => { await flushCatalog(catalog.id); const created = await duplicateCatalog(catalog.id); notify(`「${created.name}」を作成しました`); }));
                copyButton.title = "アイテムとセットをコピーして、別のカタログとして追加します";
                actions.append(copyButton);
            }
            const archive = btn("アーカイブ", guard(async () => {
                if (!await showConfirmDialog({ title: "カタログをアーカイブ", message: archiveMessage(catalog, workflowUsage(catalog.id)), danger: true, okLabel: "アーカイブ", cancelLabel: "キャンセル" })) return;
                await releaseSession(catalog.id); // 未保存の編集を保存してから移す
                try { await archiveCatalog(catalog.id); } finally { onCatalogChange(catalog.id); } // 失敗しても、外したセッションを参照ノードが持ち続けないよう通知する
                archivedLoaded = false; if (archivedEl.open) await paintArchived();
                notify(`「${catalog.name || catalog.id}」をアーカイブしました`, async () => { await restoreCatalog(catalog.id); onCatalogChange(catalog.id); archivedLoaded = false; if (archivedEl.open) await paintArchived(); });
            }), "scm-danger");
            archive.title = "削除せず、別フォルダー（archive）へ移します。あとから復元できます";
            actions.append(archive); entry.append(copy, actions); listEl.append(entry);
        }
    }
    async function paintArchived() {
        archivedList.replaceChildren(el("div", "scm-muted", "読み込み中…"));
        let archived;
        try { archived = await listArchivedCatalogs(); } catch (error) { archivedList.replaceChildren(el("div", "scm-error", error.message)); return; }
        archivedLoaded = true; archivedEl.firstChild.textContent = `アーカイブ済み（${archived.length}件）`; archivedList.replaceChildren();
        if (!archived.length) archivedList.append(el("div", "scm-muted", "アーカイブ済みのカタログはありません"));
        for (const catalog of sortedNamedOptions(archived)) {
            const entry = el("div", "scm-entry"); entry.dataset.archivedId = catalog.id;
            const copy = el("div", "scm-copy"); copy.append(el("strong", "", catalog.name || "無題"), el("span", "scm-muted", `${catalogSummary(catalog)} · ID ${catalog.id.slice(0, 8)}`));
            entry.append(copy, btn("復元", guard(async () => { const restored = await restoreCatalog(catalog.id); onCatalogChange(catalog.id); archivedLoaded = false; await paintArchived(); notify(`「${restored.name || catalog.id}」を復元しました`); })));
            archivedList.append(entry);
        }
    }
    return showDialog({ title: "カタログ管理", width: 760, className: "sax-catalog-manager", build(dlg, end) {
        dialogRoot = dlg;
        const style = el("style"); style.textContent = STYLE;
        heading = el("strong", "", "カタログ一覧");
        listEl = el("div", "scm-list"); listEl.setAttribute("aria-label", "カタログ一覧");
        archivedEl = el("details"); archivedEl.append(el("summary", "", "アーカイブ済み"));
        archivedList = el("div", "scm-list"); archivedEl.append(archivedList);
        archivedEl.addEventListener("toggle", () => { if (archivedEl.open && !archivedLoaded) paintArchived(); });
        statusEl = el("div", "scm-status"); statusEl.setAttribute("role", "status");
        const note = el("div", "scm-muted", "アーカイブは削除ではありません。完全に削除する場合は、ComfyUI の user/__sax_text_catalog フォルダーの archive 内のファイルを手動で削除してください。");
        dlg.append(style, heading, listEl, archivedEl, note, statusEl, btn("閉じる", end));
        paintList().catch(report);
    } });
}
