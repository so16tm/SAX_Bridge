import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { showConfirmDialog } from "./sax_ui_base.js";
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
function shell() {
  const root = node("div"); root.className = "sax-wc-root";
  const style = node("style", CSS); root.append(style); document.body.append(root); return root;
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
export function openWildcardEditor() {
  if (active) return;
  const root = shell(); active = root;
  const modal = node("div"); modal.className = "sax-wc-modal";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-label", "Autocomplete++ ワイルドカード編集");
  const header = node("div"); header.className = "sax-wc-row";
  const title = node("strong", "Autocomplete++ ワイルドカードエディター"); title.className = "sax-wc-grow";
  header.append(title, button("？ 書式ヘルプ", showWildcardHelp), button("閉じる", () => { void close(); }));
  const grid = node("div"); grid.className = "sax-wc-grid";
  const left = node("div"); left.className = "sax-wc-pane";
  const filter = node("input"); filter.placeholder = "ファイル名を検索";
  const listing = node("div"); listing.className = "sax-wc-files";
  left.append(node("strong", "ファイル一覧"), filter, listing, button("＋ 新規作成", () => { void blank(); }), button("一覧更新", () => { void refresh(); }));
  const right = node("div"); right.className = "sax-wc-pane";
  const selection = node("div"); selection.className = "sax-wc-row";
  const folder = node("select"); folder.setAttribute("aria-label", "保存先");
  const filename = node("input"); filename.placeholder = "clothing/dresses.txt"; filename.className = "sax-wc-grow";
  filename.setAttribute("aria-label", "ファイル名");
  selection.append(node("span", "保存先"), folder, filename);
  const tools = node("div"); tools.className = "sax-wc-row";
  const content = node("textarea"); content.className = "sax-wc-text"; content.spellcheck = false;
  content.placeholder = "1行1候補で入力。コメント行は # から始める。";
  const notice = node("div"); notice.className = "sax-wc-alert"; notice.setAttribute("role", "alert");
  const footer = node("div"); footer.className = "sax-wc-row";
  const state = node("span", "一覧取得中…"); state.className = "sax-wc-grow sax-wc-tip";
  const save = button("保存", () => { void persist(); }); footer.append(state, save);
  right.append(selection, tools, content, notice, footer); grid.append(left, right); modal.append(header, grid); root.append(modal);
  let roots = [], files = [], source = null, baseline = "", newline = "\n", busy = false;
  const normalizeName = value => value.trim().replace(/\\/g, "/").replace(/\.txt$/, "");
  const identity = entry => entry.root_id + ":" + entry.name;
  function modified() {
    return content.value !== baseline || (source ? folder.value !== source.root_id || normalizeName(filename.value) !== source.name : Boolean(filename.value.trim() || content.value));
  }
  function update() {
    state.textContent = wildcardCount(content.value) + "候補" + (modified() ? " · 未保存" : " · 保存済み");
    save.disabled = busy || !modified() || !folder.value || !filename.value.trim();
  }
  async function leave() { return !modified() || await showConfirmDialog({title:"未保存の変更", message:"未保存の変更を破棄しますか？",danger:true,okLabel:"破棄する"}); }
  async function close() { if (!await leave()) return; root.remove(); active = null; }
  async function blank() {
    if (!await leave()) return;
    source = null; baseline = ""; content.value = ""; filename.value = ""; notice.textContent = ""; update(); render(); filename.focus();
  }
  function render() {
    const query = filter.value.trim().toLocaleLowerCase();
    const shown = files.filter(f => f.name.toLocaleLowerCase().includes(query) || (roots.find(r => r.id === f.root_id)?.label || "").toLocaleLowerCase().includes(query));
    const frag = document.createDocumentFragment();
    for (const entry of shown.slice(0, 300)) {
      const item = button(entry.name + (entry.shadowed ? " ⚠" : ""), () => { void open(entry); });
      item.title = (roots.find(r => r.id === entry.root_id)?.label || "") + (entry.shadowed ? " — 優先順位の高い同名ファイルあり" : "");
      item.setAttribute("aria-selected", String(Boolean(source && identity(source) === identity(entry))));
      frag.append(item);
    }
    listing.replaceChildren(frag);
    if (shown.length > 300) listing.append(node("div", "300件のみ表示。検索で絞り込んでください。"));
  }
  async function refresh() {
    try {
      const data = await request(URL_BASE); roots = data.roots; files = data.files;
      const previous = folder.value; folder.replaceChildren();
      for (const r of roots) { const option = node("option", r.label); option.value = r.id; folder.append(option); }
      if (roots.some(r => r.id === previous)) folder.value = previous;
      if (data.truncated) notice.textContent = "一覧の表示上限に達しました";
      render(); update();
    } catch (error) { notice.textContent = error.message; }
  }
  async function open(entry) {
    if (busy || !await leave()) return;
    busy = true; update();
    try {
      const data = await request(URL_BASE + "/file?root_id=" + encodeURIComponent(entry.root_id) + "&name=" + encodeURIComponent(entry.name));
      source = { root_id: data.root_id, name: data.name, sha: data.sha };
      folder.value = data.root_id; filename.value = data.name; content.value = baseline = data.content;
      newline = content.value.includes("\r\n") ? "\r\n" : "\n";
      notice.textContent = entry.shadowed ? "注意: このファイルは同名の別ファイルより優先順位が低く、展開に使われません。" : "";
      render();
    } catch (error) { notice.textContent = error.message; }
    finally { busy = false; update(); }
  }
  async function persist() {
    if (busy || !modified()) return;
    busy = true; update(); notice.textContent = "";
    const name = normalizeName(filename.value);
    const same = Boolean(source && source.root_id === folder.value && source.name === name);
    try {
      const data = await request(URL_BASE + "/file", {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({root_id:folder.value,name,content:content.value,base_sha:same?source.sha:null})});
      source = {root_id:data.root_id,name:data.name,sha:data.sha}; baseline = content.value; filename.value = data.name;
      if (data.shadowed) notice.textContent = "注意: 同名の別ファイルが優先されるため、この内容は展開に使われません。";
      await refresh();
    } catch (error) { notice.textContent = error.message; }
    finally { busy = false; update(); }
  }
  function selectedLine() { return wildcardRows(content.value.slice(0,content.selectionStart)).length - 1; }
  function mutateLines(fn) {
    const lines = wildcardRows(content.value); const index = selectedLine();
    const result = fn(lines, index);
    if (result === false) return;
    content.value = lines.join(newline); update(); content.focus();
  }
  tools.append(
    button("＋ 候補", () => {
      const pos = content.selectionStart; const prefix = content.value && !/[\r\n]$/.test(content.value) ? newline : "";
      content.setRangeText(prefix + "new item" + newline,pos,pos,"select"); update(); content.focus();
    }),
    button("選択行を削除", () => mutateLines((lines,i) => { lines.splice(i,1); })),
    button("↑", () => mutateLines((lines,i) => { if (!i) return false; [lines[i-1],lines[i]] = [lines[i],lines[i-1]]; })),
    button("↓", () => mutateLines((lines,i) => { if (i >= lines.length-1) return false; [lines[i+1],lines[i]] = [lines[i],lines[i+1]]; })),
  );
  content.addEventListener("input", update); folder.addEventListener("change", update); filename.addEventListener("input", update); filter.addEventListener("input", render);
  void refresh();
}
app.registerExtension({name:"SAX.WildcardEditor", nodeCreated(node) {
  if (node.comfyClass !== "SAX_Bridge_Wildcard_Editor") return;
  const edit = node.addWidget("button","ワイルドカードを編集",null,openWildcardEditor,{serialize:false});
  const help = node.addWidget("button","書式ヘルプ",null,showWildcardHelp,{serialize:false});
  edit.serialize = help.serialize = false;
}});