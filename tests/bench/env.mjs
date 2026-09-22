/**
 * ベンチ共通のブラウザ環境スタブと計測ユーティリティ。
 *
 * 計測対象はあくまで「SAX_Bridge の JS ロジック」であり、実ブラウザの
 * ラスタライズ / レイアウトコストは含まない。canvas ctx は no-op スタブなので、
 * draw ベンチの数値は「1 フレーム分の描画呼び出しで走る自前 JS の時間」を表す。
 */

// ---------------------------------------------------------------------------
// DOM スタブ (getComfyTheme / h() が参照する最小限)
// ---------------------------------------------------------------------------

function makeElement(tag) {
    const el = {
        tagName: tag,
        style: { cssText: "", display: "" },
        children: [],
        textContent: "",
        className: "",
        value: "",
        type: "",
        placeholder: "",
        disabled: false,
        _listeners: new Map(),
        classList: { add() {}, remove() {}, contains() { return false; } },
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter(x => x !== c); },
        addEventListener(type, fn) {
            const arr = this._listeners.get(type) ?? [];
            arr.push(fn);
            this._listeners.set(type, arr);
        },
        removeEventListener() {},
        setAttribute() {},
        focus() {},
        select() {},
        remove() {},
        /** ベンチから UI 操作を再現するための簡易ディスパッチ。 */
        fire(type, evt = {}) {
            for (const fn of this._listeners.get(type) ?? []) fn({ target: this, ...evt });
        },
        get innerHTML() { return ""; },
        set innerHTML(_v) { this.children = []; },
    };
    return el;
}

/** document.createElement をフックし、その間に生成された要素を収集する。 */
export function captureElements(fn) {
    const created = [];
    const orig = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
        const el = orig(tag);
        created.push(el);
        return el;
    };
    try { fn(); } finally { globalThis.document.createElement = orig; }
    return created;
}

/**
 * installDomStub で作られた ResizeObserver スタブの一覧。
 * テストから `resizeObservers.at(-1).trigger()` でレイアウト確定を再現できる。
 */
export const resizeObservers = [];

export function installDomStub() {
    if (globalThis.document) return;
    const documentElement = makeElement("html");
    globalThis.document = {
        documentElement,
        body: makeElement("body"),
        head: makeElement("head"),
        createElement: makeElement,
        addEventListener() {},
        removeEventListener() {},
    };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    globalThis.ResizeObserver = class {
        constructor(cb) { this._cb = cb; this.targets = []; this.disconnected = false; resizeObservers.push(this); }
        observe(el) { this.targets.push(el); }
        unobserve(el) { this.targets = this.targets.filter(t => t !== el); }
        disconnect() { this.targets = []; this.disconnected = true; }
        /** テスト用: 監視中の要素についてコールバックを走らせる。 */
        trigger() { this._cb(this.targets.map(target => ({ target })), this); }
    };
    globalThis.window = globalThis;
}

// ---------------------------------------------------------------------------
// canvas 2D context スタブ (no-op)
// ---------------------------------------------------------------------------

export function makeCtxStub() {
    const noop = () => {};
    return {
        save: noop, restore: noop, beginPath: noop, closePath: noop,
        clip: noop, fill: noop, stroke: noop,
        rect: noop, fillRect: noop, roundRect: noop,
        moveTo: noop, lineTo: noop, arcTo: noop,
        fillText: noop,
        fillStyle: "", strokeStyle: "", lineWidth: 1,
        font: "", textAlign: "", textBaseline: "", globalAlpha: 1,
    };
}

// ---------------------------------------------------------------------------
// LiteGraph グラフ / ノードのモック
//
// tests/unit/dynamic_slot_coordinator.test.mjs のモックと同じ振る舞い
// (removeOutput の native origin_slot 再採番を含む) を踏襲する。
// ---------------------------------------------------------------------------

export function makeGraph() {
    const links = {};
    const nodes = new Map();
    let nextLinkId = 1;
    return {
        links,
        _nodes: nodes,
        getNodeById(id) { return nodes.get(id) ?? null; },
        registerNode(node) { nodes.set(node.id, node); node._graph = this; node.graph = this; return node; },
        addLink({ origin_id, origin_slot, target_id, target_slot }) {
            const id = nextLinkId++;
            links[id] = { id, origin_id, origin_slot, target_id, target_slot };
            return id;
        },
        removeLink(linkId) {
            const link = links[linkId];
            if (!link) return;
            const origin = nodes.get(link.origin_id);
            const slot = origin?.outputs?.[link.origin_slot];
            if (slot?.links) slot.links = slot.links.filter(id => id !== linkId);
            const target = nodes.get(link.target_id);
            const targetInput = target?.inputs?.[link.target_slot];
            if (targetInput && targetInput.link === linkId) targetInput.link = null;
            delete links[linkId];
        },
        setDirtyCanvas() {},
    };
}

export function makeNode({ id = 1, graph, outputCount = 0 } = {}) {
    const node = {
        id,
        outputs: Array.from({ length: outputCount }, (_, i) => ({
            name: `out_${i}`, type: "*", links: [],
        })),
        inputs: [],
        widgets: [],
        size: [280, 200],
        addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
        removeOutput(idx) {
            const removed = this.outputs.splice(idx, 1)[0];
            if (removed?.links) {
                for (const lid of [...removed.links]) this._graph.removeLink(lid);
            }
            for (const link of Object.values(this._graph.links)) {
                if (link.origin_id === this.id && link.origin_slot > idx) link.origin_slot -= 1;
            }
        },
        addInput(name, type) { this.inputs.push({ name, type, link: null }); },
        removeInput(idx) { this.inputs.splice(idx, 1); },
        connect(slotIndex, targetNode, targetSlot) {
            const linkId = this._graph.addLink({
                origin_id: this.id, origin_slot: slotIndex,
                target_id: targetNode.id, target_slot: targetSlot,
            });
            this.outputs[slotIndex].links.push(linkId);
            const inp = targetNode.inputs?.[targetSlot];
            if (inp) inp.link = linkId;
            return linkId;
        },
        addWidget(type, name, value, callback) {
            const w = { type, name, value, callback };
            this.widgets.push(w);
            return w;
        },
        addCustomWidget(w) { this.widgets.push(w); return w; },
        computeSize() { return [this.size[0], this.size[1]]; },
        setDirtyCanvas() {},
    };
    if (graph) graph.registerNode(node);
    return node;
}

export function makeTargetNode(id, graph, { inputCount = 1 } = {}) {
    const node = {
        id,
        outputs: [],
        inputs: Array.from({ length: inputCount }, (_, i) => ({
            name: `in_${i}`, type: "*", link: null,
        })),
        disconnectInput() {},
    };
    graph.registerNode(node);
    return node;
}

// ---------------------------------------------------------------------------
// 計測ユーティリティ
// ---------------------------------------------------------------------------

/**
 * `fn` を warmup 後に反復実行し、1 回あたりの所要時間統計 (ms) を返す。
 *
 * @param {() => void} fn          計測対象。setup が必要な場合は setup 側で用意する。
 * @param {object} [opts]
 * @param {number} [opts.iterations] 本計測の反復回数
 * @param {number} [opts.warmup]     ウォームアップ回数 (JIT 安定化用、計測に含めない)
 * @param {() => void} [opts.setup]  各反復の前に呼ぶ準備処理 (計測に含めない)
 */
export function bench(fn, { iterations = 200, warmup = 30, setup = null } = {}) {
    for (let i = 0; i < warmup; i++) { setup?.(); fn(); }
    const samples = new Array(iterations);
    for (let i = 0; i < iterations; i++) {
        setup?.();
        const t0 = process.hrtime.bigint();
        fn();
        const t1 = process.hrtime.bigint();
        samples[i] = Number(t1 - t0) / 1e6;
    }
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    return {
        iterations,
        mean:   sum / iterations,
        median: samples[Math.floor(iterations * 0.5)],
        p95:    samples[Math.floor(iterations * 0.95)],
        min:    samples[0],
        max:    samples[iterations - 1],
    };
}

export function fmt(ms) {
    if (ms >= 1) return `${ms.toFixed(3)} ms`;
    return `${(ms * 1000).toFixed(1)} µs`;
}

export function row(label, stat) {
    return `${label.padEnd(46)} median ${fmt(stat.median).padStart(11)}   mean ${fmt(stat.mean).padStart(11)}   p95 ${fmt(stat.p95).padStart(11)}`;
}
