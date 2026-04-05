import { app } from "../../scripts/app.js";
import { getComfyTheme, rrect, txt, PAD, BOTTOM_PAD } from "./sax_ui_base.js";

const EXT_NAME = "SAX.Debug";
const NODE_TYPES = [
    "SAX_Bridge_Debug_Inspector",
    "SAX_Bridge_Debug_Text",
    "SAX_Bridge_Assert",
    "SAX_Bridge_Assert_Pipe",
];
const LINE_H    = 14;     // 行高 (px)
const MIN_H     = 24;     // 空表示時の最小高さ
const INNER_PAD = 6;      // テキスト領域内側余白

/**
 * 4 つの Debug/Assert ノードに共通するテキスト表示ウィジェット。
 * onExecuted で受け取った ui.text を表示し、PASS/FAIL を色分けする。
 */
function makeDebugTextWidget() {
    const widget = {
        name:  "__sax_debug_text",
        type:  "__sax_debug_text",
        value: null,
        _text: "",
        _status: "neutral", // "pass" | "fail" | "error" | "neutral"

        computeSize(W) {
            const w = W ?? 200;
            const lines = widget._text ? widget._text.split("\n").length : 1;
            const h = widget._text
                ? lines * LINE_H + INNER_PAD * 2
                : MIN_H;
            return [w, h + BOTTOM_PAD];
        },

        draw(ctx, node, W, y) {
            const t = getComfyTheme();
            const lines = widget._text ? widget._text.split("\n") : ["(no output yet)"];
            const boxH  = lines.length * LINE_H + INNER_PAD * 2;

            // 状態に応じた枠線色
            let stroke = t.contentBg;
            if (widget._status === "pass")  stroke = "#4caf50";
            if (widget._status === "fail")  stroke = "#e04040";
            if (widget._status === "error") stroke = "#ff9800";

            rrect(ctx, PAD, y + 2, W - PAD * 2, boxH, 4, t.inputBg, stroke);

            const textColor = widget._text ? t.inputText : t.border;
            for (let i = 0; i < lines.length; i++) {
                txt(
                    ctx,
                    lines[i],
                    PAD + INNER_PAD,
                    y + INNER_PAD + i * LINE_H + LINE_H / 2,
                    textColor,
                    "left",
                    11,
                );
            }
        },
    };
    return widget;
}

function detectStatus(text) {
    if (!text) return "neutral";
    if (text.includes("PASS")) return "pass";
    if (text.includes("ERROR")) return "error";
    if (text.includes("FAIL")) return "fail";
    return "neutral";
}

app.registerExtension({
    name: EXT_NAME,

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._debugTextWidget = makeDebugTextWidget();
            this.addCustomWidget(this._debugTextWidget);
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            onExecuted?.apply(this, arguments);
            const w = this._debugTextWidget;
            if (!w) return;

            const textArr = output?.text;
            const text = Array.isArray(textArr) ? textArr.join("\n") : (textArr ?? "");
            w._text = text;
            w._status = detectStatus(text);
            this.size[1] = 1; // 再計算させる
            app.graph.setDirtyCanvas(true, true);
        };
    },
});
