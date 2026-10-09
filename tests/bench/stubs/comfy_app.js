/**
 * ComfyUI `scripts/app.js` の最小スタブ (ベンチ専用)。
 *
 * js/*.js は `../../scripts/app.js` を import するため、ComfyUI 本体なしでは
 * Node から読み込めない。tests/bench/hooks.mjs の resolve フックがその specifier を
 * 本ファイルへ差し替えることで、本番コードを無改変のまま import できるようにする。
 *
 * registerExtension は登録された extension を配列に貯めるだけで、ベンチ側が
 * beforeRegisterNodeDef を任意のタイミングで呼び出せるようにする。
 */
export const app = {
    extensions: [],
    registerExtension(ext) {
        this.extensions.push(ext);
    },
    graph: null,
    canvas: {
        setDirty() {},
        setDirtyCanvas() {},
        ds: { offset: [0, 0], scale: 1 },
    },
};
