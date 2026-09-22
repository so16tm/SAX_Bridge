/**
 * Manager Dialog アイテムリストの「行再利用 + 仮想化」不変条件テスト
 *
 * renderItemList は以前、毎回リストを空にして全行を作り直していた。
 * MAX_ITEMS=256 ではダイアログのオープンと検索 1 打鍵がそのまま
 * 256 行分の DOM 生成コストになるため、次の 2 段構えに変更した。
 *
 *   1. 仮想化   — 可視範囲 + overscan の行だけを DOM に載せる
 *   2. 行再利用 — 行 DOM を item_id でキャッシュし、変わった部分だけ書き換える
 *
 * ここでは「速くなったこと」ではなく「速くしても表示が変わっていないこと」を
 * 検証する。具体的には
 *   - 載っている行は可視範囲分だけで、リスト全体の件数に比例しない
 *   - スクロールで全件を辿れば、全件が重複なく正しい位置に出る
 *   - 検索・フィルタ変更で行 DOM が作り直されない（再利用される）
 *   - 行の中身（名前 / 参照数バッジ / タグバッジ）と選択ハイライトが保たれる
 *   - 選択がクリック以外で動いたとき、その行が可視範囲に入る
 *
 * 実行: node --test tests/js/text_catalog_list_virtualization.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { installDomStub, captureElements, makeGraph, makeNode, resizeObservers } from "../bench/env.mjs";

register("../bench/hooks.mjs", import.meta.url);
installDomStub();

const { app } = await import("../bench/stubs/comfy_app.js");
await import("../../js/sax_text_catalog.js");

const SCHEMA_VERSION = 1;
const TAG_VOCAB = ["style", "quality", "camera", "light", "mood"];

// js/sax_text_catalog.js 側の仮想化パラメータと一致させること。
const ROW_HEIGHT   = 26;
const ROW_STRIDE   = 28;
const ROW_OVERSCAN = 6;
const FALLBACK_VIEWPORT = 440;

/** DOM スタブでは clientHeight が取れないため、既定の可視高から窓サイズを求める。 */
function expectedWindowSize(total, viewport = FALLBACK_VIEWPORT, scrollTop = 0) {
    const first = Math.max(0, Math.floor(scrollTop / ROW_STRIDE) - ROW_OVERSCAN);
    const last  = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_STRIDE) + ROW_OVERSCAN);
    return Math.max(0, last - first);
}

const nodeType = function TextCatalogNode() {};
nodeType.prototype = {};

before(async () => {
    const ext = app.extensions.find(e => e.name === "SAX.TextCatalog");
    assert.ok(ext, "SAX.TextCatalog extension registered");
    await ext.beforeRegisterNodeDef(nodeType, { name: "SAX_Bridge_Text_Catalog" });
});

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

function makeItems(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: `item-${i}`,
        name: `Preset ${i}`,
        text: `text body ${i}`,
        tags: TAG_VOCAB.slice(i % 3, (i % 3) + (i % 3)),
    }));
}

function buildNode({ itemCount, relations = [] }) {
    const graph = makeGraph();
    const node = makeNode({ id: 1, graph });
    node.widgets = [
        {
            name: "items_json", type: "text",
            value: JSON.stringify({
                version: SCHEMA_VERSION,
                catalog: {
                    items: makeItems(itemCount),
                    tag_definitions: TAG_VOCAB,
                    favorite_tags: TAG_VOCAB.slice(0, 2),
                },
                relations: relations.map(({ item_id, on }) => ({ item_id, on: on !== false })),
            }),
        },
        { name: "select_to_add_lora", type: "combo", value: "", options: { values: [] } },
        { name: "select_to_add_wildcard", type: "combo", value: "", options: { values: [] } },
    ];
    nodeType.prototype.onConfigure.call(node, {});
    return { node };
}

/** 行 DOM かどうか（click と mouseenter の両方を持つ div）。 */
const isRow = el => el.tagName === "div" && el._listeners.has("click") && el._listeners.has("mouseenter");

/**
 * ダイアログを開き、リストまわりのハンドルを取り出す。
 * leftListEl は「スクロールコンテナ」、その唯一の子が全行分の高さを持つ土台。
 */
function openManager(node) {
    const created = captureElements(() => node._openTextCatalogManager());
    const listEl = created.find(el => el.tagName === "div"
        && el.style.cssText === "flex:1;overflow-y:auto;position:relative;");
    assert.ok(listEl, "アイテムリストのスクロールコンテナが存在する");
    const canvasEl = listEl.children[0];
    assert.ok(canvasEl, "行を載せる土台が存在する");
    const searchInput = created.find(el => el.tagName === "input"
        && el.placeholder.startsWith("Search by name"));
    const newBtn = created.find(el => el.tagName === "button" && el.textContent === "+ New");
    return { created, listEl, canvasEl, searchInput, newBtn };
}

/** 現在マウントされている行を top 昇順で返す。 */
const mountedRows = canvasEl =>
    canvasEl.children.filter(isRow).sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top));

const rowName  = row => row._nameEl.textContent;
const rowIndex = row => parseInt(row.style.top) / ROW_STRIDE;
/** 表示されている（display が none でない）バッジのテキスト。 */
const rowBadges = row => row._badges.filter(b => b.style.display !== "none").map(b => b.textContent);

/** スクロールしながら全行を辿り、index → 表示名 の対応を集める。 */
function collectAllRows(listEl, canvasEl, total) {
    const seen = new Map();
    const maxScroll = Math.max(0, total * ROW_STRIDE - FALLBACK_VIEWPORT);
    for (let scrollTop = 0; ; scrollTop += Math.floor(FALLBACK_VIEWPORT / 2)) {
        const at = Math.min(scrollTop, maxScroll);
        listEl.scrollTop = at;
        listEl.fire("scroll");
        for (const row of mountedRows(canvasEl)) {
            const idx = rowIndex(row);
            const prev = seen.get(idx);
            if (prev !== undefined) {
                assert.equal(prev, rowName(row), `index ${idx} の表示名がスクロールで変わっていない`);
            }
            seen.set(idx, rowName(row));
        }
        if (at >= maxScroll) break;
    }
    return seen;
}

// ---------------------------------------------------------------------------

describe("TextCatalog: アイテムリストの仮想化", () => {
    it("256 件でも DOM に載るのは可視範囲分だけ", () => {
        const { node } = buildNode({ itemCount: 256 });
        const { created, canvasEl } = openManager(node);

        const expected = expectedWindowSize(256);
        assert.equal(mountedRows(canvasEl).length, expected);
        // 生成された行 DOM も可視範囲分だけ（256 行分は作らない）
        assert.equal(created.filter(isRow).length, expected);
        assert.ok(expected < 256, "窓サイズが全件より小さい");
    });

    it("件数が窓より少なければ全件が載る", () => {
        const { node } = buildNode({ itemCount: 5 });
        const { canvasEl } = openManager(node);
        assert.equal(mountedRows(canvasEl).length, 5);
    });

    it("土台の高さが 件数 × ストライド になる（スクロールバーの長さが実件数どおり）", () => {
        const { node } = buildNode({ itemCount: 64 });
        const { canvasEl, searchInput } = openManager(node);
        assert.equal(canvasEl.style.height, `${64 * ROW_STRIDE}px`);

        // "Preset 1", "Preset 10".."Preset 19" の 11 件
        searchInput.value = "Preset 1";
        searchInput.fire("input");
        assert.equal(canvasEl.style.height, `${11 * ROW_STRIDE}px`);
    });

    it("行は index × ストライド の位置に絶対配置され、高さは固定", () => {
        const { node } = buildNode({ itemCount: 64 });
        const { canvasEl } = openManager(node);
        const rows = mountedRows(canvasEl);
        rows.forEach((row, i) => {
            assert.equal(row.style.top, `${i * ROW_STRIDE}px`);
            assert.ok(row.style.cssText.includes(`height:${ROW_HEIGHT}px`), "行の高さが固定されている");
            assert.ok(row.style.cssText.includes("position:absolute"), "行が絶対配置されている");
        });
    });

    it("スクロールで全 256 件を重複なく辿れる", () => {
        const { node } = buildNode({ itemCount: 256 });
        const { listEl, canvasEl } = openManager(node);

        const seen = collectAllRows(listEl, canvasEl, 256);
        assert.equal(seen.size, 256, "全 index が一度は描画される");
        // index は 0..255 が隙間なく埋まる
        for (let i = 0; i < 256; i++) assert.ok(seen.has(i), `index ${i} が描画された`);
        // 表示名は 256 件の item 名と 1:1 対応（重複・欠落なし）
        const names = new Set(seen.values());
        assert.equal(names.size, 256);
        for (let i = 0; i < 256; i++) assert.ok(names.has(`Preset ${i}`), `Preset ${i} が描画された`);
    });

    it("スクロールしても行 DOM はプールから再利用される", () => {
        const { node } = buildNode({ itemCount: 256 });
        const { listEl, canvasEl } = openManager(node);

        const scrollTo = (top) => captureElements(() => {
            listEl.scrollTop = top;
            listEl.fire("scroll");
        }).filter(isRow).length;

        // 先頭では上方向の overscan が 0 で頭打ちになるぶん窓が狭いので、
        // 初回の下方向スクロールでその差分だけは新規生成される。
        const firstScroll = scrollTo(2000);
        const start = Math.floor(2000 / ROW_STRIDE) - ROW_OVERSCAN;
        assert.equal(mountedRows(canvasEl)[0].style.top, `${start * ROW_STRIDE}px`);
        assert.ok(firstScroll <= ROW_OVERSCAN + 1, `新規生成は overscan 分まで (${firstScroll})`);

        // 一度プールが温まれば、以降の往復では 1 行も作らない。
        assert.equal(scrollTo(0), 0, "戻りで行 DOM を作り直さない");
        assert.equal(scrollTo(4000), 0, "再度のスクロールでも行 DOM を作り直さない");
        assert.equal(scrollTo(2000), 0, "往復しても行 DOM を作り直さない");
    });

    it("レイアウト確定後に可視高が測れたら窓を測り直す", () => {
        // showDialog は build() の後に overlay を document へ追加するため、初回描画時点では
        // clientHeight が測れない。ResizeObserver で測り直さないと、背の高いダイアログで
        // 下側に空白が残る。
        const { node } = buildNode({ itemCount: 256 });
        const { listEl, canvasEl } = openManager(node);
        assert.equal(mountedRows(canvasEl).length, expectedWindowSize(256));

        const observer = resizeObservers.at(-1);
        assert.ok(observer?.targets.includes(listEl), "リストが ResizeObserver で監視されている");

        listEl.clientHeight = 900;   // レイアウト確定後の実際の可視高
        observer.trigger();
        assert.equal(mountedRows(canvasEl).length, expectedWindowSize(256, 900));
    });

    it("ダイアログを閉じると ResizeObserver を解除する", () => {
        const { node } = buildNode({ itemCount: 32 });
        const { created } = openManager(node);
        const observer = resizeObservers.at(-1);
        assert.equal(observer.disconnected, false);

        const closeBtn = created.find(el => el.tagName === "button" && el.textContent === "Close");
        assert.ok(closeBtn, "[Close] ボタンが存在する");
        closeBtn.fire("click");
        assert.equal(observer.disconnected, true);
    });

    it("同じ窓のままスクロールイベントが来ても何もしない", () => {
        const { node } = buildNode({ itemCount: 256 });
        const { listEl, canvasEl } = openManager(node);
        const rows = mountedRows(canvasEl);
        listEl.fire("scroll");
        assert.deepEqual(mountedRows(canvasEl), rows, "同一の行 DOM がそのまま残る");
    });
});

describe("TextCatalog: アイテムリストの行再利用", () => {
    it("検索で絞り込んでも行 DOM は作り直されず、11 件が正しく出る", () => {
        const { node } = buildNode({ itemCount: 64 });
        const { canvasEl, searchInput } = openManager(node);
        const poolBefore = new Set(mountedRows(canvasEl));

        const createdOnSearch = captureElements(() => {
            searchInput.value = "Preset 1";
            searchInput.fire("input");
        }).filter(isRow);
        assert.equal(createdOnSearch.length, 0, "絞り込みで行 DOM を新規生成しない");

        const rows = mountedRows(canvasEl);
        assert.equal(rows.length, 11, '"Preset 1" は 11 件ヒットする');
        for (const row of rows) {
            assert.ok(poolBefore.has(row), "既存の行 DOM が再利用されている");
            assert.ok(rowName(row).startsWith("Preset 1"), `${rowName(row)} が検索条件に一致する`);
        }
    });

    it("絞り込みを解除すると全件表示に戻る", () => {
        const { node } = buildNode({ itemCount: 64 });
        const { canvasEl, searchInput } = openManager(node);

        searchInput.value = "Preset 63";
        searchInput.fire("input");
        assert.equal(mountedRows(canvasEl).length, 1);

        searchInput.value = "";
        searchInput.fire("input");
        assert.equal(mountedRows(canvasEl).length, expectedWindowSize(64));
        assert.equal(canvasEl.style.height, `${64 * ROW_STRIDE}px`);
    });

    it("絞り込み後の行をクリックするとハイライトが移る", () => {
        const { node } = buildNode({ itemCount: 64 });
        const { canvasEl, searchInput } = openManager(node);

        searchInput.value = "Preset 1";
        searchInput.fire("input");
        const rows = mountedRows(canvasEl);
        rows[2].fire("click");
        assert.notEqual(rows[2].style.background, "", "クリックした行がハイライトされる");
        for (const other of rows) {
            if (other !== rows[2]) assert.equal(other.style.background, "");
        }
    });

    it("再利用された行に前の item のバッジが残らない", () => {
        const { node } = buildNode({
            itemCount: 64,
            // item-2 はタグ 2 個 + 参照 1 件、item-0 はタグ 0 個 + 参照 0 件
            relations: [{ item_id: "item-2", on: true }],
        });
        const { canvasEl, searchInput } = openManager(node);

        searchInput.value = "Preset 2";
        searchInput.fire("input");
        const withBadges = mountedRows(canvasEl).find(r => rowName(r) === "Preset 2");
        assert.ok(withBadges, "Preset 2 が表示されている");
        assert.deepEqual(rowBadges(withBadges), ["×1", "camera", "light"]);

        // 同じ行 DOM がタグなし・参照なしの item に再利用されるケース
        searchInput.value = "Preset 0";
        searchInput.fire("input");
        const plain = mountedRows(canvasEl).find(r => rowName(r) === "Preset 0");
        assert.ok(plain, "Preset 0 が表示されている");
        assert.deepEqual(rowBadges(plain), [], "前の item のバッジが残っていない");
    });

    it("名前を編集するとリスト行の表示名が追随する", () => {
        const { node } = buildNode({ itemCount: 8 });
        const { created, canvasEl } = openManager(node);
        // Editor の Name 入力 = placeholder を持たない text input（検索欄とタグ追加欄は placeholder 付き）
        const nameInput = created.find(el => el.tagName === "input" && el.type === "text" && !el.placeholder);
        assert.ok(nameInput, "Editor の Name 入力が存在する");
        const before = nameInput.value;
        assert.ok(mountedRows(canvasEl).some(r => rowName(r) === before), "編集前の名前が行に出ている");

        nameInput.value = "Renamed";
        nameInput.fire("input");
        assert.ok(mountedRows(canvasEl).some(r => rowName(r) === "Renamed"),
            "リスト行に編集後の名前が反映される");
    });
});

describe("TextCatalog: 仮想化と選択・空表示", () => {
    it("該当 0 件ならメッセージだけが出て行は載らない", () => {
        const { node } = buildNode({ itemCount: 32 });
        const { listEl, canvasEl, searchInput } = openManager(node);

        searchInput.value = "該当なし";
        searchInput.fire("input");
        assert.equal(mountedRows(canvasEl).length, 0);
        assert.equal(canvasEl.style.height, "0px");
        const msg = listEl.children.find(el => el !== canvasEl && el.textContent.includes("No items match"));
        assert.ok(msg, "フィルタ不一致のメッセージが出る");
        assert.notEqual(msg.style.display, "none");

        // 戻すとメッセージは消え、行が復帰する
        searchInput.value = "";
        searchInput.fire("input");
        assert.equal(msg.style.display, "none");
        assert.equal(mountedRows(canvasEl).length, expectedWindowSize(32));
    });

    it("+ New で追加された item が選択され、可視範囲に入る", () => {
        const { node } = buildNode({ itemCount: 128 });
        const { canvasEl, newBtn } = openManager(node);
        assert.ok(newBtn, "[+ New] ボタンが存在する");

        newBtn.fire("click");
        const selected = mountedRows(canvasEl).filter(r => r.style.background !== "");
        assert.equal(selected.length, 1, "選択行がちょうど 1 行、DOM 上に載っている");
        assert.equal(rowName(selected[0]), "untitled");
    });

    it("選択行が窓の外へスクロールしても、戻れば選択が保たれる", () => {
        const { node } = buildNode({ itemCount: 256 });
        const { listEl, canvasEl } = openManager(node);
        const first = mountedRows(canvasEl)[0];
        assert.notEqual(first.style.background, "", "初期選択はリスト先頭");
        const selectedName = rowName(first);

        listEl.scrollTop = 4000;
        listEl.fire("scroll");
        assert.ok(!mountedRows(canvasEl).some(r => rowName(r) === selectedName),
            "選択行は窓の外なので DOM から外れている");

        listEl.scrollTop = 0;
        listEl.fire("scroll");
        const back = mountedRows(canvasEl).find(r => rowName(r) === selectedName);
        assert.ok(back, "戻ると選択行が再び載る");
        assert.notEqual(back.style.background, "", "選択ハイライトが復元される");
    });

    it("窓の外の行をクリック扱いしない（再利用時に item の取り違えが起きない）", () => {
        const { node } = buildNode({ itemCount: 256 });
        const { listEl, canvasEl } = openManager(node);

        listEl.scrollTop = 4000;
        listEl.fire("scroll");
        const rows = mountedRows(canvasEl);
        const target = rows[3];
        const targetName = rowName(target);
        target.fire("click");

        assert.notEqual(target.style.background, "", "クリックした行がハイライトされる");
        assert.equal(rowName(target), targetName, "クリックで表示名が入れ替わらない");
        assert.equal(rows.filter(r => r.style.background !== "").length, 1,
            "ハイライトはちょうど 1 行");
    });
});
