import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// SAX Bridge ノードの Seed 制御項目に "pipe" を動的に追加する
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "SAX.SeedControl",

    async nodeCreated(node) {
        if (!node.comfyClass || !node.comfyClass.startsWith("SAX_Bridge_")) return;

        // UI拡張によってシードコントローラ(Combo)が生成されるのを待機
        setTimeout(() => {
            if (!node.widgets || !node.inputs) return;

            // 仕様: pipe 入力を持つノードのみを対象とする (SAX Loader 等を除外)
            const hasPipeInput = node.inputs.some(input => input.name === "pipe");
            if (!hasPipeInput) return;

            node.widgets.forEach((widget, index) => {
                const isSeedInput = widget.name === "seed" || widget.name === "seed_override";
                
                if (isSeedInput) {
                    // シード制御用ウィジェット (Combo) を特定
                    const nextWidget = node.widgets[index + 1];
                    const controlWidget = (nextWidget && (nextWidget.type === "combo" || nextWidget.name.includes("control"))) ? nextWidget : 
                        node.widgets.find(w => w.type === "combo" && (w.options?.values?.includes("fixed") || w.name.includes("control")));

                    if (controlWidget && controlWidget.options && controlWidget.options.values) {
                        // 1. 選択肢に "pipe" を追加
                        if (!controlWidget.options.values.includes("pipe")) {
                            controlWidget.options.values.push("pipe");
                        }

                        // 2. モード選択(Combo) -> 数値入力(Num) への同期
                        const originalControlCallback = controlWidget.callback;
                        controlWidget.callback = function(value) {
                            if (value === "pipe") {
                                widget.value = -1;
                            }
                            if (originalControlCallback) return originalControlCallback.apply(this, arguments);
                        };

                        // 3. 数値入力(Num) -> モード選択(Combo) への同期
                        const originalValueCallback = widget.callback;
                        widget.callback = function(v) {
                            if (v === -1 || String(v) === "-1") {
                                if (controlWidget.value !== "pipe") {
                                    controlWidget.value = "pipe";
                                }
                            } else {
                                if (controlWidget.value === "pipe") {
                                    controlWidget.value = "fixed";
                                }
                            }
                            if (originalValueCallback) return originalValueCallback.apply(this, arguments);
                        };

                        // 4. 初期表示の同期
                        if (widget.value === -1 || String(widget.value) === "-1") {
                            controlWidget.value = "pipe";
                        }
                    }
                }
            });
        }, 500);
    }
});
