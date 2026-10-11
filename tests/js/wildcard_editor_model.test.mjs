import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWildcardTree, visibleWildcardTree } from "../../js/sax_wildcard_editor_model.js";

const files = [
  { root_id: "a", name: "clothing/dresses/long" },
  { root_id: "a", name: "clothing/dresses/short" },
  { root_id: "a", name: "clothing/hats" },
  { root_id: "a", name: "root-file" },
  { root_id: "b", name: "clothing/dresses/long" },
];

test("数字を含むフォルダー・ファイル名は自然順で表示する", () => {
  const tree = buildWildcardTree([{id:"a",label:"root"}], ["dir10/item", "dir2/item10", "dir2/item2"].map(name=>({root_id:"a",name})));
  assert.deepEqual(tree[0].children.map(n=>n.label), ["dir2", "dir10"]);
  assert.deepEqual(tree[0].children[0].children.map(n=>n.label), ["item2.txt", "item10.txt"]);
});

test("root別の階層を作り、フォルダー優先・日本語順で並べて再帰件数を数える", () => {
  const tree = buildWildcardTree([{ id: "a", label: "Zulu" }, { id: "empty", label: "空" }, { id: "b", label: "Alpha" }], files);
  assert.deepEqual(tree.map(n => n.key), ["root:a", "root:empty", "root:b"]);
  assert.equal(tree[0].count, 4);
  assert.equal(tree[1].count, 0);
  assert.equal(tree[2].count, 1);
  assert.deepEqual(tree[0].children.map(n => n.kind), ["folder", "file"]);
  assert.equal(tree[0].children[0].path, "clothing");
  assert.equal(tree[0].children[0].count, 3);
  assert.equal(tree[0].children[0].children[0].path, "clothing/dresses");
  assert.equal(tree[0].children[0].children[0].children[0].label, "long.txt");
  assert.equal(tree[0].children[0].children[0].children[0].entry, files[0]);
  assert.notEqual(tree[0].children[0].children[0].children[0].key, tree[2].children[0].key);

  const ordered = buildWildcardTree([{ id: "r", label: "R" }], ["人物", "背景", "アイテム"].map(name => ({ root_id: "r", name })));
  assert.deepEqual(ordered[0].children.map(n => n.label), ["アイテム.txt", "人物.txt", "背景.txt"].sort((a, b) => a.localeCompare(b, "ja")));
});

test("閉じた階層は隠し、検索時は一致ファイルと祖先だけを展開して返す", () => {
  const tree = buildWildcardTree([{ id: "a", label: "服" }, { id: "b", label: "背景" }], files);
  assert.deepEqual(visibleWildcardTree(tree, new Set()).map(n => n.key), ["root:a", "root:b"]);
  assert.deepEqual(visibleWildcardTree(tree, new Set(), "LONG").map(n => n.key), ["root:a", "folder:a:clothing", "folder:a:clothing/dresses", "file:a:clothing/dresses/long", "root:b", "folder:b:clothing", "folder:b:clothing/dresses", "file:b:clothing/dresses/long"]);
  assert.ok(visibleWildcardTree(tree, new Set(), "服").some(n => n.kind === "file" && n.root_id === "a"));
  const expanded = new Set(["root:a", "folder:a:clothing"]);
  assert.deepEqual(visibleWildcardTree(tree, expanded).map(n => n.key), ["root:a", "folder:a:clothing", "folder:a:clothing/dresses", "file:a:clothing/hats", "file:a:root-file", "root:b"]);
});

test("1万ファイルを階層化し、深いフォルダーの件数を保持する", () => {
  const deepPath = Array.from({ length: 16 }, (_, i) => `dir-${i}`).join("/");
  const entries = Array.from({ length: 10000 }, (_, i) => ({ root_id: "r", name: `${deepPath}/item-${String(i).padStart(5, "0")}` }));
  const tree = buildWildcardTree([{ id: "r", label: "R" }], entries);
  assert.equal(tree[0].count, 10000);
  let deepest = tree[0];
  for (let i = 0; i < 16; i++) { deepest = deepest.children[0]; assert.equal(deepest.count, 10000); }
  const filtered = visibleWildcardTree(tree, new Set(), "item-09999");
  assert.equal(filtered.at(-1).entry, entries[9999]);
  assert.equal(filtered.length, 18);
});
