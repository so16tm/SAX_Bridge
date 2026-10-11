import { app } from "../../scripts/app.js";
import { prepareAutocompletePrompt } from "./sax_autocomplete_bridge.js";
import { flushCatalogPrompt } from "./sax_text_catalog_v2_shared.js";

app.registerExtension({
    name: "SAX.AutocompletePlusPlus",
    async setup() {
        const { api } = await import("../../scripts/api.js");
        if (!api.queuePrompt || api._saxAutocompleteQueue) return;
        api._saxAutocompleteQueue = true;
        const queue = api.queuePrompt;
        api.queuePrompt = async function (number, prompt, ...args) {
            // setup 順にかかわらず未保存編集を先に保存し、送信ごとに snapshot を取得する。
            await flushCatalogPrompt(prompt?.output);
            const output = await prepareAutocompletePrompt(prompt?.output, async id => {
                const response = await api.fetchApi(`/sax/text-catalog/v2/catalogs/${encodeURIComponent(id)}`);
                if (!response.ok) throw new Error("共有カタログを取得できないためQueueを停止しました");
                return response.json();
            });
            return queue.call(this, number, { ...prompt, output }, ...args);
        };
    },
});
