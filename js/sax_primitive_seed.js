// Primitive Store の SEED 更新ロジック (純粋関数。ComfyUI 依存なし)

export const SEED_MAX = 2 ** 53 - 1;
export const SEED_MODES = ["fixed", "random", "increment"];
/** ノード上に表示する短縮ラベル */
export const SEED_MODE_LABELS = { random: "rnd", increment: "inc" };

export function randomSeed(max) {
    return Math.floor(Math.random() * ((max ?? SEED_MAX) + 1));
}

/** fixed → random → increment → fixed の順に切り替える。未知の値は fixed 扱い */
export function nextSeedMode(mode) {
    const i = SEED_MODES.indexOf(mode);
    return SEED_MODES[(i + 1) % SEED_MODES.length];
}

/**
 * 更新イベントごとに seed を進める。
 *   queue-before: キュー登録の直前
 *   queue-after : キュー登録の直後 (一括登録でも実行ごとに異なる値を使うため、実行完了を待たない)
 *   executed    : 実行完了時
 * random は従来どおり queue-before と executed、increment は timing に応じて
 * queue-before (Before) か queue-after (After) だけで進める。
 * 戻り値は更新した件数。
 */
export function advanceSeeds(items, event) {
    let changed = 0;
    for (const item of items ?? []) {
        if (item?.type !== "SEED") continue;
        const timing = item.timing === "after" ? "after" : "before";
        const max = item.max ?? SEED_MAX;
        if (item.mode === "random") {
            if (event === "executed" || (event === "queue-before" && timing === "before")) {
                item.value = randomSeed(max);
                changed++;
            }
        } else if (item.mode === "increment") {
            const hit = timing === "before" ? event === "queue-before" : event === "queue-after";
            if (!hit) continue;
            const step = Math.max(1, Math.round(item.step ?? 1));
            item.value = Math.min(max, Math.max(0, Math.round(item.value ?? 0)) + step);
            changed++;
        }
    }
    return changed;
}
