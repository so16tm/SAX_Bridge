import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "SAX.Output",

    async setup() {
        api.addEventListener("executed", (e) => {
            const output = e.detail?.output;
            if (!output?.filename_index) return;

            const node = app.graph.getNodeById(parseInt(e.detail.node));
            if (!node || node.comfyClass !== "SAX_Bridge_Output") return;

            const widget = node.widgets?.find((w) => w.name === "filename_index");
            if (widget) {
                widget.value = output.filename_index[0];
            }
        });
    },
});
