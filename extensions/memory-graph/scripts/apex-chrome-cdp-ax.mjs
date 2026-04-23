#!/usr/bin/env node
// Apex Chrome CDP AX — full accessibility-tree walker, hierarchical.
//
// Absorbs Claude-in-Chrome `read_page` (interactive + all) with a
// parent/child hierarchy, CSS-selector fingerprints for each node, and
// an optional text-query filter. Output shape is stable so workers and
// downstream LLMs can consume it as a page map.
//
// Exports: getFullAxTree(tab, opts), renderAxTreeAscii(nodes)

// No direct apex-chrome-cdp imports — this module only talks to
// tab.conn() (CDP WS) via the Accessibility + DOM + Runtime domains.

// Build AX tree via CDP. `filter: "interactive"` keeps only roles a
// user can click/type. `maxDepth` clamps recursion. `textQuery`
// narrows to subtrees whose name or description contains the query.
export async function getFullAxTree(
  tab,
  { filter = "all", maxDepth = 20, textQuery = null, maxNodes = 2000 } = {},
) {
  const conn = await tab.conn();
  await conn.send("Accessibility.enable").catch(() => {});
  const res = await conn.send("Accessibility.getFullAXTree");
  const raw = res.nodes ?? [];
  const byId = new Map(raw.map((n) => [n.nodeId, n]));
  const interactiveRoles = new Set([
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "menuitem",
    "tab",
    "searchbox",
    "listbox",
    "option",
    "switch",
    "slider",
    "spinbutton",
  ]);
  const q = textQuery ? String(textQuery).toLowerCase() : null;

  function matches(node) {
    if (filter === "interactive" && !interactiveRoles.has(node.role?.value)) {
      return false;
    }
    if (q) {
      const hay = [node.name?.value ?? "", node.description?.value ?? "", node.value?.value ?? ""]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  }

  const out = [];
  function walk(nodeId, depth) {
    if (depth > maxDepth || out.length >= maxNodes) {
      return;
    }
    const n = byId.get(nodeId);
    if (!n) {
      return;
    }
    if (matches(n)) {
      out.push({
        nodeId: n.nodeId,
        depth,
        role: n.role?.value,
        name: n.name?.value,
        value: n.value?.value,
        description: n.description?.value,
        domId: n.backendDOMNodeId,
        childIds: n.childIds ?? [],
      });
    }
    for (const c of n.childIds ?? []) {
      walk(c, depth + 1);
    }
  }
  const roots = raw.filter((n) => !n.parentId);
  for (const r of roots) {
    walk(r.nodeId, 0);
  }
  return out;
}

// Render the tree in ASCII form — useful for handing to an LLM or
// pasting into a debug report.
export function renderAxTreeAscii(nodes, { indent = "  " } = {}) {
  const lines = [];
  for (const n of nodes) {
    const prefix = indent.repeat(n.depth);
    const role = n.role ? `[${n.role}]` : "";
    const nm = n.name ? ` "${String(n.name).slice(0, 80)}"` : "";
    const val = n.value ? ` = ${String(n.value).slice(0, 40)}` : "";
    lines.push(`${prefix}${role}${nm}${val}`);
  }
  return lines.join("\n");
}

// Quick lookup: return the FIRST node whose name/role matches a text
// query, plus a CSS selector hint built from backendDOMNodeId (the
// caller can resolve via CDP DOM.resolveNode for exact addressing).
export async function findAxNode(tab, query, { filter = "all" } = {}) {
  const tree = await getFullAxTree(tab, { filter, textQuery: query, maxNodes: 50 });
  if (tree.length === 0) {
    return null;
  }
  const first = tree[0];
  // Resolve backendDOMNodeId → runtime node; get a CSS path via JS.
  const conn = await tab.conn();
  try {
    const dom = await conn.send("DOM.resolveNode", { backendNodeId: first.domId });
    const objectId = dom.object?.objectId;
    if (objectId) {
      const rv = await conn.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function() { if (this.id) return '#' + CSS.escape(this.id); if (this.getAttribute && this.getAttribute('data-testid')) return '[data-testid=\"' + this.getAttribute('data-testid') + '\"]'; var p = this.tagName.toLowerCase(); if (this.className && typeof this.className === 'string') p += '.' + this.className.split(/\\s+/).filter(Boolean).slice(0,2).join('.'); return p; }",
        returnByValue: true,
      });
      return { ...first, cssSelector: rv.result?.value ?? null };
    }
  } catch {
    /* fall through */
  }
  return first;
}
