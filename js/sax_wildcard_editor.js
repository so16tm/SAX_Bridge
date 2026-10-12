import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { showConfirmDialog } from "./sax_ui_base.js";
import { buildWildcardTree, visibleWildcardTree } from "./sax_wildcard_editor_model.js";
import { attachAutoComplete, detachAutoComplete } from "./sax_text_autocomplete.js";
import { refreshAutocompleteWildcards } from "./sax_wildcard_refresh.js";
const URL_BASE = "/sax/wildcards";
export const FORMAT_HELP = [
  ["基本", "1行に1候補。空行と # で始まる行は選ばれない。"],
  ["呼び出し", "__clothing/dresses__ → clothing/dresses.txt から1行"],
  ["ランダム", "{red | blue | green} → いずれか1つ"],
  ["重み付き", "{3::red | 1::blue} → red の確率が3倍"],
  ["複数選択", "{2$$red | blue | green} → 重複せず2つ"],
  ["範囲と区切り", "{1-3$$ and $$red | blue | green} → 1〜3個を and で結合"],
  ["エスケープ", "\\{、\\}、\\__ → 展開しない文字として扱う"],
];
const DOC_URL = "https://github.com/michikora/ComfyUI-Autocomplete-Plus-Plus/blob/main/README_jp.md";
export const wildcardRows = text => text.split(/\r\n|\n|\r/);
export const wildcardCount = text => wildcardRows(text).filter(line => line.trim() && !line.trim().startsWith("#")).length;
async function request(url, options) {
  const response = await api.fetchApi(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "通信に失敗しました");
  return data;
}
function node(tag, text = "") { const n = document.createElement(tag); n.textContent = text; return n; }
function button(text, fn) { const n = node("button", text); n.type = "button"; n.onclick = fn; return n; }
const CSS = ".sax-wc-root{position:fixed;inset:0;z-index:10000;background:#000b;display:flex;justify-content:center;align-items:center;color:var(--input-text,#eee);font:13px system-ui,sans-serif}.sax-wc-root *{box-sizing:border-box}.sax-wc-modal{width:min(1160px,97vw);height:min(810px,94vh);min-height:0;display:flex;flex-direction:column;gap:10px;padding:15px;border:1px solid var(--border-color,#555);border-radius:9px;background:var(--comfy-menu-bg,#202024)}.sax-wc-root button,.sax-wc-root input,.sax-wc-root textarea,.sax-wc-root select{min-width:0;padding:6px 8px;color:inherit;background:var(--comfy-input-bg,#2a2a2f);border:1px solid var(--border-color,#555);border-radius:5px;font:inherit}.sax-wc-root button{cursor:pointer}.sax-wc-root button:disabled{opacity:.45}.sax-wc-row{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.sax-wc-grow{flex:1;min-width:120px}.sax-wc-grid{display:grid;grid-template-columns:minmax(175px,270px) minmax(0,1fr);gap:12px;flex:1;min-height:0}.sax-wc-pane{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}.sax-wc-files{flex:1;overflow:auto;min-height:0;border:1px solid var(--border-color,#555);padding:4px}.sax-wc-files button{width:100%;text-align:left;border:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-wc-files button[aria-selected=true]{background:var(--primary-background,#386cb8);color:white}.sax-wc-text{width:100%;flex:1;min-height:120px;resize:none;font:13px/1.6 monospace!important}.sax-wc-alert{color:var(--error-text,#ed9494);min-height:18px;white-space:pre-wrap}.sax-wc-tip{font-size:12px;opacity:.85}.sax-wc-help{max-height:82vh;overflow:auto;width:min(670px,94vw);padding:16px;background:var(--comfy-menu-bg,#202024);border:1px solid var(--border-color,#555);border-radius:8px;display:flex;flex-direction:column;gap:10px}.sax-wc-help-row{display:grid;grid-template-columns:100px 1fr;gap:8px;border-bottom:1px solid var(--border-color,#555);padding:7px 0}.sax-wc-help-row span{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:700px){.sax-wc-grid{grid-template-columns:1fr;grid-template-rows:minmax(115px,.4fr) minmax(220px,1fr)}.sax-wc-modal{padding:8px}.sax-wc-help-row{grid-template-columns:1fr}}";
let active = null;
const TREE_CSS = `.sax-wc-modal{gap:7px;padding:10px}.sax-wc-files{position:relative;padding:0;overflow-anchor:none}.sax-wc-tree-canvas{position:relative}.sax-wc-files .sax-wc-tree-item{position:absolute;left:0;right:0;height:28px;padding:3px 6px;border-radius:0;display:flex;gap:5px;align-items:center;font-size:12px}.sax-wc-tree-item span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sax-wc-tree-item .sax-wc-count{margin-left:auto;opacity:.65;flex:none}.sax-wc-tree-item:focus-visible{outline:2px solid var(--primary-background,#5686d6);outline-offset:-2px}.sax-wc-left-tools{flex-wrap:nowrap;gap:4px}.sax-wc-left-tools button{flex:1;padding:4px;font-size:11px}.sax-wc-path{overflow-wrap:anywhere;font-size:12px;min-height:18px}.sax-wc-alert:empty{display:none}.sax-wc-root .sax-wc-files button:hover{background:color-mix(in srgb,var(--primary-background,#5686d6) 18%,transparent)}.sax-wc-root .sax-wc-files button[aria-selected=true]{background:var(--primary-background,#386cb8)}`;
function shell() {
  const root = node("div"); root.className = "sax-wc-root";
  const style = node("style", CSS + TREE_CSS); root.append(style); document.body.append(root); return root;
}
export function showWildcardHelp() {
  const root = shell(), modal = node("div"); modal.className = "sax-wc-help";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-label", "Autocomplete++ 書式ヘルプ");
  modal.append(node("strong", "Autocomplete++ 書式ヘルプ"));
  for (const [title, detail] of FORMAT_HELP) {
    const row = node("div"); row.className = "sax-wc-help-row";
    row.append(node("strong", title), node("span", detail)); modal.append(row);
  }
  const link = node("a", "詳しくは公式ドキュメント"); link.href = DOC_URL;
  link.target = "_blank"; link.rel = "noopener noreferrer";
  const close = button("閉じる", () => root.remove()); modal.append(link, close);
  root.append(modal); root.addEventListener("click", event => { if (event.target === root) root.remove(); }); close.focus();
}
export function openWildcardEditor(owner = null) {
  if (active) return;
  const previousFocus = document.activeElement;
  const root = shell(); active = root;
  const modal = node("div"); modal.className = "sax-wc-modal";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-label", "Autocomplete++ ワイルドカード編集");
  const graph = app.graph ?? app.rootGraph;
  if (owner?.id == null) owner = graph?._nodes?.find(n => n.comfyClass === "SAX_Bridge_Wildcard_Editor" || n.type === "SAX_Bridge_Wildcard_Editor");
  // ノードとの関連付けで補完対象にする。keep-underscores属性で整形設定を上書きしない。
  if (owner?.id != null) modal.setAttribute("node-id", String(owner.id));
  const header = node("div"); header.className = "sax-wc-row";
  const title = node("strong", "Autocomplete++ ワイルドカードエディター"); title.className = "sax-wc-grow";
  header.append(title, button("？ 書式ヘルプ", showWildcardHelp), button("閉じる", () => { void close(); }));
  const grid = node("div"); grid.className = "sax-wc-grid";
  const left = node("div"); left.className = "sax-wc-pane";
  const filter = node("input"); filter.placeholder = "ファイル・フォルダーを検索"; filter.setAttribute("aria-label", "ファイル・フォルダーを検索");
  const listing = node("div"); listing.className = "sax-wc-files";
  listing.setAttribute("role", "tree"); listing.setAttribute("aria-label", "ワイルドカードファイル");
  const listTitle = node("strong", "ファイル一覧"), listTools = node("div"); listTools.className = "sax-wc-row sax-wc-left-tools";
  listTools.append(button("すべて開く", () => { visitFolders(tree, item => expanded.add(item.key)); render(); }), button("折りたたむ", () => { expanded.clear(); render(); }));
  const refreshButton = button("一覧更新", async () => { await refresh(); await syncExpansion(); });
  const createButton = button("＋ 新規作成", () => { void blank(); });
  const bottomTools = node("div"); bottomTools.className = "sax-wc-row sax-wc-left-tools"; bottomTools.append(createButton, refreshButton);
  left.append(listTitle, filter, listTools, listing, bottomTools);
  const right = node("div"); right.className = "sax-wc-pane";
  const selection = node("div"); selection.className = "sax-wc-row";
  const folder = node("select"); folder.setAttribute("aria-label", "保存先");
  const filename = node("input"); filename.placeholder = "clothing/dresses.txt"; filename.className = "sax-wc-grow";
  filename.setAttribute("aria-label", "ファイル名");
  selection.append(node("span", "保存先"), folder, filename);
  const tools = node("div"); tools.className = "sax-wc-row";
  const content = node("textarea"); content.className = "sax-wc-text"; content.spellcheck = false;
  content.setAttribute("aria-label", "ワイルドカード本文");
  content.placeholder = "1行1候補で入力。コメント行は # から始める。";
  const notice = node("div"); notice.className = "sax-wc-alert"; notice.setAttribute("role", "alert");
  const footer = node("div"); footer.className = "sax-wc-row";
  const state = node("span", "一覧取得中…"); state.className = "sax-wc-grow sax-wc-tip";
  const save = button("保存", () => { void persist(); });
  const remove = button("ファイルを削除", () => { void deleteSelected(); }); footer.append(state, remove, save);
  const pathLabel = node("div"); pathLabel.className = "sax-wc-path";
  right.append(selection, pathLabel, tools, content, notice, footer); grid.append(left, right); modal.append(header, grid); root.append(modal);
  void attachAutoComplete(content);
  let roots = [], files = [], source = null, baseline = "", newline = "\n", busy = false, listingBusy = false, closed = false, searchTimer;
  let expansionState = "", expansionWarning = "";
  let tree = [], visible = [], focusedKey = null;
  const expanded = new Set(), initializedRoots = new Set();
  const canvas = node("div"); canvas.className = "sax-wc-tree-canvas"; listing.append(canvas);
  const rowHeight = 28;
  const normalizeName = value => value.trim().replace(/\\/g, "/").replace(/\.txt$/, "");
  const identity = entry => entry.root_id + ":" + entry.name;
  function modified() {
    return content.value !== baseline || (source ? folder.value !== source.root_id || normalizeName(filename.value) !== source.name : Boolean(filename.value.trim() || content.value));
  }
  function update() {
    state.textContent = wildcardCount(content.value) + "候補" + (modified() ? " · 未保存" : " · 保存済み") + (expansionState ? ` · ${expansionState}` : "");
    save.disabled = busy || !modified() || !folder.value || !filename.value.trim();
    content.disabled = folder.disabled = filename.disabled = createButton.disabled = busy;
    refreshButton.disabled = busy || listingBusy;
    remove.disabled = busy || !source;
    pathLabel.textContent = filename.value.trim() ? `__${normalizeName(filename.value)}__` : "ファイルを選択するか、新規作成してください";
  }
  async function leave() { return !modified() || await showConfirmDialog({title:"未保存の変更", message:"未保存の変更を破棄しますか？",danger:true,okLabel:"破棄する"}); }
  async function close() { if (busy || !await leave()) return; closed = true; clearTimeout(searchTimer); viewportObserver.disconnect(); detachAutoComplete(content); root.remove(); active = null; previousFocus?.focus?.(); }
  async function blank() {
    if (busy || !await leave()) return;
    source = null; baseline = ""; newline = "\n"; content.value = ""; filename.value = ""; notice.textContent = ""; update(); render(); filename.focus();
  }
  function visitFolders(nodes, fn) { for (const item of nodes) if (item.kind === "folder") { fn(item); visitFolders(item.children, fn); } }
  function reveal(entry) {
    function find(nodes, ancestors = []) {
      for (const item of nodes) {
        if (item.kind === "file" && identity(item.entry) === identity(entry)) { for (const key of ancestors) expanded.add(key); return item.key; }
        if (item.kind === "folder") { const key = find(item.children, [...ancestors, item.key]); if (key) return key; }
      }
    }
    const key = find(tree); render(); const index = visible.findIndex(item => item.key === key);
    if (index >= 0 && (index * rowHeight < listing.scrollTop || (index + 1) * rowHeight > listing.scrollTop + listing.clientHeight)) listing.scrollTop = index * rowHeight;
    paint();
  }
  function render() {
    visible = visibleWildcardTree(tree, expanded, filter.value.trim());
    if (!visible.some(item => item.key === focusedKey)) focusedKey = null;
    listTitle.textContent = `ファイル一覧 · ${files.length}件`;
    canvas.style.height = `${visible.length * rowHeight}px`;
    listing.scrollTop = Math.min(listing.scrollTop, Math.max(0, visible.length * rowHeight - listing.clientHeight));
    paint();
  }
  function focusRow(index) {
    index = Math.max(0, Math.min(visible.length - 1, index)); if (!visible[index]) return;
    focusedKey = visible[index].key;
    if (index * rowHeight < listing.scrollTop) listing.scrollTop = index * rowHeight;
    else if ((index + 1) * rowHeight > listing.scrollTop + listing.clientHeight) listing.scrollTop = (index + 1) * rowHeight - listing.clientHeight;
    paint(); [...canvas.children].find(n => n.dataset.key === focusedKey)?.focus();
  }
  function paint() {
    if (closed) return;
    const start = Math.max(0, Math.floor(listing.scrollTop / rowHeight) - 5), end = Math.min(visible.length, Math.ceil((listing.scrollTop + listing.clientHeight) / rowHeight) + 5);
    const focusWasInside = canvas.contains(document.activeElement), frag = document.createDocumentFragment();
    const indexes = Array.from({length:end-start}, (_,i) => start+i);
    const focusedIndex = visible.findIndex(item => item.key === focusedKey);
    if (focusWasInside && focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) indexes.push(focusedIndex);
    if (!visible.length) { const empty = node("div", files.length ? "一致するファイルがありません" : "ファイルがありません。新規作成できます。"); empty.style.padding = "8px"; frag.append(empty); }
    for (const index of indexes) {
      const item = visible[index], branch = item.kind === "folder", opened = expanded.has(item.key) || Boolean(filter.value.trim());
      const control = button("", () => { focusedKey = item.key; if (branch) { if (expanded.has(item.key)) expanded.delete(item.key); else expanded.add(item.key); render(); } else void open(item.entry); });
      control.className = "sax-wc-tree-item"; control.dataset.key = item.key;
      control.style.top = `${index * rowHeight}px`; control.style.paddingLeft = `${6 + item.depth * 14}px`;
      control.setAttribute("role", "treeitem"); control.setAttribute("aria-level", String(item.depth + 1));
      control.tabIndex = item.key === focusedKey || (index === start && (!focusedKey || (!focusWasInside && (focusedIndex < start || focusedIndex >= end)))) ? 0 : -1;
      if (branch) { control.setAttribute("aria-expanded", String(opened)); control.append(node("span", opened ? "▾" : "▸"), node("span", item.label), node("span", String(item.count))); control.lastChild.className = "sax-wc-count"; }
      else { control.append(node("span", item.label + (item.entry.shadowed ? " ⚠" : ""))); control.setAttribute("aria-selected", String(Boolean(source && identity(source) === identity(item.entry)))); }
      control.title = branch ? item.label : `${roots.find(r => r.id === item.entry.root_id)?.label ?? ""}/${item.entry.name}.txt${item.entry.shadowed ? " — 優先順位の高い同名ファイルあり" : ""}`;
      control.addEventListener("focus", () => { focusedKey = item.key; });
      control.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") { event.preventDefault(); focusRow(event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1)); }
        else if (event.key === "ArrowRight" && branch) { event.preventDefault(); if (!opened) { expanded.add(item.key); render(); } else focusRow(index + 1); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); if (branch && opened && !filter.value.trim()) { expanded.delete(item.key); render(); } else { let parent = index - 1; while (parent >= 0 && visible[parent].depth >= item.depth) parent--; if (parent >= 0) focusRow(parent); } }
      });
      frag.append(control);
    }
    canvas.replaceChildren(frag);
    if (focusWasInside) [...canvas.children].find(n => n.dataset.key === focusedKey)?.focus({preventScroll:true});
  }
  listing.addEventListener("scroll", paint);
  const viewportObserver = new ResizeObserver(paint); viewportObserver.observe(listing);
  async function refresh() {
    if (listingBusy || closed) return;
    listingBusy = true; update();
    try {
      const data = await request(URL_BASE); if (closed) return; roots = data.roots; files = data.files;
      tree = buildWildcardTree(roots, files);
      for (const r of tree) if (!initializedRoots.has(r.key)) { initializedRoots.add(r.key); expanded.add(r.key); }
      const previous = folder.value; folder.replaceChildren();
      for (const r of roots) { const option = node("option", r.label); option.value = r.id; folder.append(option); }
      if (roots.some(r => r.id === previous)) folder.value = previous;
      if (data.truncated) notice.textContent = "一覧の表示上限に達しました";
      render();
    } catch (error) { notice.textContent = error.message; }
    finally { listingBusy = false; if (!closed) update(); }
  }
  async function open(entry) {
    if (busy || !await leave() || busy || closed) return;
    busy = true; update();
    try {
      const data = await request(URL_BASE + "/file?root_id=" + encodeURIComponent(entry.root_id) + "&name=" + encodeURIComponent(entry.name));
      source = { root_id: data.root_id, name: data.name, sha: data.sha };
      folder.value = data.root_id; filename.value = data.name; content.value = data.content; baseline = content.value;
      newline = data.content.includes("\r\n") ? "\r\n" : "\n";
      notice.textContent = entry.shadowed ? "注意: このファイルは同名の別ファイルより優先順位が低く、展開に使われません。" : "";
      reveal(entry);
    } catch (error) { notice.textContent = error.message; }
    finally { busy = false; update(); }
  }
  async function syncExpansion() {
    if (!closed && expansionWarning) notice.textContent = notice.textContent.replace(expansionWarning, "").trim(); expansionWarning = "";
    expansionState = "展開データ更新中…"; if (!closed) update();
    try { await refreshAutocompleteWildcards(); expansionState = "展開更新済み"; }
    catch (error) { expansionState = "展開未更新"; expansionWarning = `展開データを更新できませんでした：${error.message}。「一覧更新」で再試行するか、ブラウザーを再読み込みしてください。`; if (!closed) notice.textContent += `${notice.textContent ? "\n" : ""}${expansionWarning}`; }
    finally { if (!closed) update(); }
  }
  async function deleteSelected() {
    if (busy || !source) return;
    const target = {...source};
    const label = roots.find(r => r.id === target.root_id)?.label ?? target.root_id;
    const confirmed = await showConfirmDialog({title:"ファイルを削除", message:`${label}/${target.name}.txt を削除します。元に戻せません。${modified() ? "\n未保存の変更も破棄されます。" : ""}`, danger:true, okLabel:"削除する", cancelLabel:"キャンセル"});
    if (!confirmed || busy || closed || source?.sha !== target.sha || identity(source) !== identity(target)) return;
    busy = true; update(); notice.textContent = "";
    try {
      await request(`${URL_BASE}/file?root_id=${encodeURIComponent(target.root_id)}&name=${encodeURIComponent(target.name)}&base_sha=${encodeURIComponent(target.sha)}`, {method:"DELETE"});
      source = null; baseline = ""; newline = "\n"; content.value = ""; filename.value = "";
      files = files.filter(entry => identity(entry) !== identity(target)); tree = buildWildcardTree(roots, files); render();
      await refresh();
      await syncExpansion();
    } catch (error) { notice.textContent = error.message; }
    finally { busy = false; update(); }
  }
  async function persist() {
    if (busy || !modified()) return;
    busy = true; update(); notice.textContent = "";
    const name = normalizeName(filename.value);
    const same = Boolean(source && source.root_id === folder.value && source.name === name);
    try {
      const data = await request(URL_BASE + "/file", {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({root_id:folder.value,name,content:wildcardRows(content.value).join(newline),base_sha:same?source.sha:null})});
      source = {root_id:data.root_id,name:data.name,sha:data.sha}; baseline = content.value; filename.value = data.name;
      if (data.shadowed) notice.textContent = "注意: 同名の別ファイルが優先されるため、この内容は展開に使われません。";
      await refresh();
      reveal(source);
      await syncExpansion();
    } catch (error) { notice.textContent = error.message; }
    finally { busy = false; update(); }
  }
  function selectedLines() {
    const start = wildcardRows(content.value.slice(0, content.selectionStart)).length - 1;
    // A selection ending at the next line's start does not include that line.
    const endOffset = content.selectionEnd > content.selectionStart && /[\r\n]/.test(content.value[content.selectionEnd - 1]) ? content.selectionEnd - 1 : content.selectionEnd;
    return [start, wildcardRows(content.value.slice(0, endOffset)).length - 1];
  }
  function mutateLines(fn) {
    if (busy) return;
    const lines = wildcardRows(content.value); const [start, end] = selectedLines();
    const result = fn(lines, start, end);
    if (result === false) return;
    content.value = lines.join("\n");
    const first = Math.max(0, Math.min(lines.length - 1, result?.start ?? start)), last = Math.min(lines.length - 1, result?.end ?? first);
    const offset = lines.slice(0, first).reduce((sum, line) => sum + line.length + 1, 0);
    const length = lines.slice(first, last + 1).join("\n").length;
    content.focus(); content.setSelectionRange(offset, offset + length); update();
  }
  tools.append(
    button("＋ 候補", () => mutateLines((lines,start,end) => { const at = content.value ? end + 1 : 0; lines.splice(at, content.value ? 0 : 1, "new item"); return {start:at,end:at}; })),
    button("選択行を削除", () => mutateLines((lines,start,end) => { lines.splice(start,end-start+1); if (!lines.length) lines.push(""); })),
    button("↑", () => mutateLines((lines,start,end) => { if (!start) return false; const previous=lines.splice(start-1,1)[0]; lines.splice(end,0,previous); return {start:start-1,end:end-1}; })),
    button("↓", () => mutateLines((lines,start,end) => { if (end >= lines.length-1) return false; const next=lines.splice(end+1,1)[0]; lines.splice(start,0,next); return {start:start+1,end:end+1}; })),
  );
  tools.children[2].setAttribute("aria-label", "選択行を上へ"); tools.children[3].setAttribute("aria-label", "選択行を下へ");
  content.addEventListener("input", update, true); folder.addEventListener("change", update); filename.addEventListener("input", update);
  filter.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { focusedKey = null; listing.scrollTop = 0; render(); }, 120); });
  root.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || document.querySelector(".__sax_confirm_dlg")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void persist(); }
    else if (event.key === "Escape") { event.preventDefault(); void close(); }
  });
  filter.focus();
  void refresh();
}
app.registerExtension({name:"SAX.WildcardEditor", nodeCreated(node) {
  if (node.comfyClass !== "SAX_Bridge_Wildcard_Editor") return;
  const edit = node.addWidget("button","ワイルドカードを編集",null,()=>openWildcardEditor(node),{serialize:false});
  const help = node.addWidget("button","書式ヘルプ",null,showWildcardHelp,{serialize:false});
  edit.serialize = help.serialize = false;
}});
