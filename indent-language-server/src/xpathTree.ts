import type { XPathNode } from "indent-xpath";
import type { IndexedNode } from "./types.js";

/**
 * Adapter node bridging `IndexedNode` (whose `childPaths` are canonical-path
 * strings requiring a `nodesByPath` map lookup to resolve) to `indent-xpath`'s
 * `XPathNode` shape (which expects real, inlined `children` arrays). Carries
 * a back-reference to the original `IndexedNode` so callers can recover
 * canonical paths / statements / etc. from `selectNodes` results.
 */
export interface XPathTreeNode extends XPathNode {
  indexedNode: IndexedNode;
  children: XPathTreeNode[];
}

function toXPathNode(
  node: IndexedNode,
  nodesByPath: Map<string, IndexedNode>,
): XPathTreeNode {
  const attrs: Record<string, unknown> = {};
  for (const [name, attr] of Object.entries(node.attrs)) {
    attrs[name] = attr.value;
  }
  return {
    kind: node.kind,
    value: node.value?.value,
    attrs,
    children: node.childPaths
      .map((p) => nodesByPath.get(p))
      .filter((n): n is IndexedNode => n !== undefined)
      .map((n) => toXPathNode(n, nodesByPath)),
    indexedNode: node,
  };
}

/**
 * Builds a `indent-xpath`-compatible forest from the workspace's root
 * `IndexedNode`s, resolving `childPaths` through `nodesByPath` once so the
 * resulting tree has real inlined `children` arrays. Intended to be built
 * once per `WorkspaceIndex.rebuildIndex()` call, then reused across all
 * xpath-reference resolutions in that rebuild.
 */
export function buildXPathForest(
  rootNodes: IndexedNode[],
  nodesByPath: Map<string, IndexedNode>,
): XPathTreeNode[] {
  return rootNodes.map((n) => toXPathNode(n, nodesByPath));
}
