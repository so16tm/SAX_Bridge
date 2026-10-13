import { resolve as baseResolve } from "./hooks.mjs";
export async function resolve(specifier, context, next) {
    if (specifier.endsWith("scripts/api.js")) return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const api={fetchApi:(...args)=>window._saxTestRequest(...args),queuePrompt:async(...args)=>{window._saxTestSent.push(args);return 'sent'}};") };
    return baseResolve(specifier, context, next);
}
