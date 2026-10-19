/**
 * Text Catalog V2 共有エディタの検索入力 1 回あたりの絞り込み＋並べ替え（P3 3-7）。
 * 10,000 件（本文 540 文字）で、改善前の方式（localeCompare('ja')・毎回の正規化）と現在の selectItems を比べる。
 *
 * 実行:
 *   node tests/bench/text_catalog_v2_search.bench.mjs            # 計測だけ
 *   node tests/bench/text_catalog_v2_search.bench.mjs --assert   # 検索 1 回の中央値が 100ms を超えたら終了コード 1
 *
 * 計測するもの: 検索語の正規化→全件の絞り込み→名前順の並べ替え（エディタが入力のたびに行う JS）。
 * 計測しないもの: DOM の生成・レイアウト・描画。ブラウザでの入力→描画は tests/bench/text_catalog_v2_p3_browser.cjs で測る。
 */
import { bench, row } from "./env.mjs";
import { selectItems, searchTokens, normalizeSearch, warmSearchIndex } from "../../js/sax_text_catalog_v2_model.js";

const LIMIT_MS = 100;
const make = () => Array.from({ length: 10000 }, (_, i) => ({
    id: `id-${String(i).padStart(5, "0")}`, name: `素材${i % 700}`,
    text: `本文 Masterpiece ${i} ` + "あいうえお漢字 ".repeat(48), tags: [`tag${i % 37}`, i % 2 ? "style" : "camera"],
}));
const queries = ["素材12", "masterpiece 漢字", "tag3 style", "Ｍａｓｔｅｒｐｉｅｃｅ 9999", ""];

// 改善前: 毎回すべてのアイテムを正規化し、localeCompare('ja') で並べ替える。
function before(items, query) {
    const tokens = normalizeSearch(query).split(/\s+/u).filter(Boolean);
    return items.filter(item => !tokens.length || tokens.every(token => normalizeSearch(`${item.name}\n${item.text}\n${item.tags.join(" ")}`).includes(token)))
        .sort((a, b) => a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id));
}

const cold = make();
const t0 = process.hrtime.bigint();
selectItems(cold, { tokens: searchTokens(queries[0]) });
const firstSearch = Number(process.hrtime.bigint() - t0) / 1e6;

const items = make();
const stop = warmSearchIndex(items, { chunk: 10000, schedule: fn => { fn(); return 0; }, cancel() {} });
stop();
let at = 0;
const now = bench(() => { selectItems(items, { tokens: searchTokens(queries[at++ % queries.length]) }); }, { iterations: 100, warmup: 10 });
const old = bench(() => { before(items, queries[at++ % queries.length]); }, { iterations: 15, warmup: 2 });

console.log(`10,000 件 · 検索語 ${queries.length} 種を順に実行`);
console.log(`初回の検索（正規化の下準備なし）          ${firstSearch.toFixed(1)} ms`);
console.log(row("現在 (selectItems・下準備済み)", now));
console.log(row("改善前の方式", old));
if (process.argv.includes("--assert") && now.median > LIMIT_MS) { console.error(`検索 1 回の中央値が ${LIMIT_MS}ms を超えています`); process.exit(1); }
