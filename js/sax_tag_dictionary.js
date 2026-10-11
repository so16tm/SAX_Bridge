import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const ROUTE = "/sax/tag-dictionary";
const FILENAME = "sax_danbooru.csv";

async function readResponse(response) {
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`応答を読み取れませんでした (${response.status})`); }
    if (!response.ok) throw new Error(result.error || `取得に失敗しました (${response.status})`);
    return result;
}

async function downloadCsv(request) {
    const response = await request(`${ROUTE}/danbooru.csv`);
    if (!response.ok) {
        await readResponse(response);
        return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = FILENAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function installDictionaryControls(node, request = api.fetchApi.bind(api), download = downloadCsv) {
    let generation = 0;
    let updating = false;
    let downloading = false;
    let statusValue = "状態を確認中…";
    let messageValue = "更新はボタンを押したときだけ実行します。";
    const options = { serialize: false, readOnly: true };
    const status = node.addWidget("text", "状態", statusValue, () => { status.value = statusValue; }, { ...options });
    const message = node.addWidget("text", "案内", messageValue, () => { message.value = messageValue; }, { ...options });
    status.serialize = message.serialize = false;
    const dirty = () => node.setDirtyCanvas?.(true, true);
    const show = (value, detail) => {
        status.value = statusValue = value;
        if (detail !== undefined) message.value = messageValue = detail;
        dirty();
    };
    const showResult = (result, updated = false) => {
        if (!result.available) {
            show("CSV未取得", "「最新CSVを取得」で辞書を保存できます。");
            return;
        }
        const prefix = updated ? (result.changed ? "更新完了" : "変更なし") : "保存済み";
        show(`${prefix}: ${result.date} / ${result.tags}タグ`, result.installed
            ? `ブラウザ再読込後、Autocomplete++ Main Tag Fileで${FILENAME}を選択`
            : result.autocomplete_available
                ? "Autocomplete++への辞書配置は未完了です。「最新CSVを取得」で同期できます。"
            : "Autocomplete++未導入。CSVはSAXに保存済みで、ダウンロードできます。");
    };
    const update = node.addWidget("button", "最新CSVを取得", null, async () => {
        if (updating || downloading) return;
        updating = true;
        const current = ++generation;
        update.name = "取得中…";
        show("最新CSVを取得中…", "取得が完了するまでお待ちください。");
        try {
            const result = await readResponse(await request(`${ROUTE}/update`, { method: "POST" }));
            if (current === generation) showResult(result, true);
        } catch (error) {
            if (current === generation) show("更新失敗", error.message || String(error));
        } finally {
            updating = false;
            update.name = "最新CSVを取得";
            dirty();
        }
    }, { serialize: false });
    const downloadButton = node.addWidget("button", "CSVをダウンロード", null, async () => {
        if (downloading || updating) return;
        downloading = true;
        ++generation;
        try { await download(request); }
        catch (error) { show("ダウンロード失敗", error.message || String(error)); }
        finally { downloading = false; }
    }, { serialize: false });
    update.serialize = downloadButton.serialize = false;
    const current = generation;
    const ready = (async () => {
        try {
            const result = await readResponse(await request(`${ROUTE}/status`));
            if (current === generation) showResult(result);
        } catch (error) {
            if (current === generation) show("状態取得失敗", error.message || String(error));
        }
    })();
    return { ready };
}

app.registerExtension({
    name: "SAX.TagDictionary",
    nodeCreated(node) {
        if (node.comfyClass === "SAX_Bridge_Tag_Dictionary") installDictionaryControls(node);
    },
});
