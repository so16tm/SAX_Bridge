/**
 * Node module resolve フック (ベンチ専用)。
 *
 * `../../scripts/app.js` (ComfyUI 本体) への import を tests/bench/stubs/comfy_app.js に
 * 差し替える。これにより js/sax_*.js を本番コードのまま Node 上で計測できる。
 */
export async function resolve(specifier, context, next) {
    if (specifier.endsWith("scripts/app.js")) {
        return {
            url: new URL("./stubs/comfy_app.js", import.meta.url).href,
            shortCircuit: true,
        };
    }
    return next(specifier, context);
}
