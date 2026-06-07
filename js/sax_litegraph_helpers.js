/**
 * sax_litegraph_helpers.js — LiteGraph グラフ操作ユーティリティ
 *
 * Exports:
 *   getNodesInGroup(group) — グループ内ノード取得（_children + バウンディングボックスフォールバック）
 *   findGroup(item)        — アイテムに対応するグループをグラフから検索
 *   matchGroup(group, item) — グループとアイテムが一致するか判定（8px tolerance）
 */

import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// getNodesInGroup
// ---------------------------------------------------------------------------

/**
 * グループ内のノードを取得する。
 *
 * `group._children`（Set）が存在する場合は最優先で使用する。
 * lazy 計算の都合で空になることがあるため、
 * 空の場合はバウンディングボックスで判定するフォールバックを実行する。
 *
 * @param {object} group - LiteGraph グループ
 * @returns {object[]} グループ内ノードの配列
 */
export function getNodesInGroup(group) {
    if (group._children?.size > 0) {
        return Array.from(group._children).filter(c => c?.id != null && typeof c.mode === "number");
    }
    const x1 = group.pos[0];
    const y1 = group.pos[1];
    const x2 = x1 + group.size[0];
    const y2 = y1 + group.size[1];
    return (app.graph._nodes ?? []).filter(n =>
        n.pos[0] >= x1 && n.pos[0] < x2 &&
        n.pos[1] >= y1 && n.pos[1] < y2
    );
}

// ---------------------------------------------------------------------------
// findGroup
// ---------------------------------------------------------------------------

/**
 * アイテムに対応する LiteGraph グループをグラフから検索する。
 *
 * 検索優先順:
 *   1. title + pos 両方一致（8px tolerance）
 *   2. pos のみ一致
 *   3. title のみ一致
 *
 * `item.pos` が null の場合は title のみで検索する。
 *
 * @param {{ title: string, pos?: [number, number] | null }} item
 * @returns {object|null}
 */
export function findGroup(item) {
    const groups = app.graph._groups ?? [];
    if (item.pos == null) return groups.find(g => g.title === item.title) ?? null;
    const exact = groups.find(g =>
        g.title === item.title &&
        Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8
    );
    if (exact) return exact;
    const byPos = groups.find(g =>
        Math.abs(g.pos[0] - item.pos[0]) <= 8 && Math.abs(g.pos[1] - item.pos[1]) <= 8
    );
    if (byPos) return byPos;
    return groups.find(g => g.title === item.title) ?? null;
}

// ---------------------------------------------------------------------------
// matchGroup
// ---------------------------------------------------------------------------

/**
 * グループとアイテムが一致するか判定する。
 *
 * pos が存在する場合は 8px tolerance での位置一致 OR title 一致を返す。
 * pos が null の場合は title 一致のみ。
 *
 * @param {object} group - LiteGraph グループ
 * @param {{ title: string, pos?: [number, number] | null }} item
 * @returns {boolean}
 */
export function matchGroup(group, item) {
    if (item.pos == null) return group.title === item.title;
    const posMatch = Math.abs(group.pos[0] - item.pos[0]) <= 8 && Math.abs(group.pos[1] - item.pos[1]) <= 8;
    return posMatch || group.title === item.title;
}
