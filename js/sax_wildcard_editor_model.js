const basename = path => String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? "";
const compareJa = (left, right) => left.localeCompare(right, "ja", {numeric:true});

function sortTree(nodes) {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return compareJa(a.label, b.label) || (a._order ?? 0) - (b._order ?? 0);
  });
  return nodes;
}

export function buildWildcardTree(roots, files) {
  const tree = roots.map((root, rootOrder) => ({
    key: `root:${root.id}`, label: root.label, root_id: root.id, kind: "folder", children: [], count: 0,
    _order: rootOrder, _folders: new Map(),
  }));
  const rootById = new Map(tree.map(node => [node.root_id, node]));
  let order = 0;
  for (const entry of files) {
    const root = rootById.get(entry.root_id);
    if (!root) continue;
    const parts = String(entry.name).split(/[\\/]/).filter(Boolean);
    if (!parts.length) continue;
    let parent = root, path = "";
    for (const part of parts.slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      let folder = parent._folders.get(part);
      if (!folder) {
        folder = { key: `folder:${root.root_id}:${path}`, name: part, path, label: part, kind: "folder", children: [], count: 0, root_id: root.root_id, _path: path, _order: order++, _folders: new Map() };
        parent.children.push(folder);
        parent._folders.set(part, folder);
      }
      parent = folder;
    }
    const fileName = parts.join("/");
    parent.children.push({ key: `file:${root.root_id}:${fileName}`, label: `${basename(fileName)}.txt`, kind: "file", entry, root_id: root.root_id, _order: order++ });
  }

  function finish(node) {
    if (node.kind !== "folder") {
      delete node._order;
      return 1;
    }
    node.count = node.children.reduce((sum, child) => sum + finish(child), 0);
    sortTree(node.children);
    delete node._order;
    delete node._folders;
    if (node.key.startsWith("folder:")) delete node._path;
    return node.count;
  }
  for (const root of tree) finish(root);
  return tree.filter(root => root.count > 0);
}

export function visibleWildcardTree(tree, expanded, query = "") {
  const needle = String(query).toLocaleLowerCase();
  const result = [];
  function visit(node, depth, rootLabel) {
    const label = node.key.startsWith("root:") ? node.label : rootLabel;
    if (!needle) {
      result.push({ ...node, depth });
      if (node.kind === "folder" && expanded.has(node.key)) for (const child of node.children) visit(child, depth + 1, label);
      return;
    }
    if (node.kind === "file") {
      const name = String(node.entry?.name ?? "").toLocaleLowerCase();
      if (name.includes(needle) || String(label ?? "").toLocaleLowerCase().includes(needle)) result.push({ ...node, depth });
      return;
    }
    const children = node.children;
    const start = result.length;
    for (const child of children) visit(child, depth + 1, label);
    if (result.length > start) result.splice(start, 0, { ...node, depth });
  }
  for (const root of tree) visit(root, 0, root.label);
  return result;
}
