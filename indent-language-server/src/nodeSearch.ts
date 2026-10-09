import type { WorkspaceIndex } from "./indexer.js";
import { buildNodeRef, computeRefFrequencyMaps } from "./refBuilder.js";
import type { IndexedNode } from "./types.js";

/**
 * One entry in the workspace-wide fuzzy-search list surfaced to the client
 * for the "insert node reference" feature. Field names double as
 * VS Code `QuickPickItem` fields (`label`/`description`/`detail`) so the
 * client can hand the array straight to `showQuickPick` without remapping.
 */
export interface NodeSearchItem {
  /** Display label -- the node's `label` (positional value, `name` attr,
   * or bare kind, in that precedence order -- see `IndexedNode.label`). */
  label: string;
  /** Short grouping hint shown next to the label -- the node's `kind`. */
  description: string;
  /** Disambiguating detail -- the node's own source statement (kind,
   * positional value, and attributes, excluding children), so identically
   * labeled nodes (e.g. two `service` nodes both named "Auth") remain
   * distinguishable in the picker. See `formatNodeSource`. */
  detail: string;
  /** The `indent-lang`'s xpath module ref string to insert at the cursor on selection. */
  ref: string;
}

/**
 * Reconstructs a node's own source statement -- `kind [value] [key=value ...]`
 * -- from its indexed fields, excluding any children. Uses each value's
 * `valueRaw` (the exact original source text) so quoting/escaping matches
 * the source file verbatim.
 */
export function formatNodeSource(node: IndexedNode): string {
  const parts = [node.kind];
  if (node.value) parts.push(node.value.valueRaw);
  for (const [name, attr] of Object.entries(node.attrs)) {
    parts.push(`${name}=${attr.valueRaw}`);
  }
  return parts.join(" ");
}

/**
 * Returns every indexed node across the whole workspace (not just the
 * active document) as a flat, pre-ranked-by-nothing list ready for a
 * client-side fuzzy picker (e.g. VS Code's `showQuickPick`, which already
 * does its own fuzzy matching over `label`/`description`/`detail`).
 */
export function getSearchableNodes(index: WorkspaceIndex): NodeSearchItem[] {
  const freq = computeRefFrequencyMaps(index);
  const items: NodeSearchItem[] = [];
  for (const node of index.nodesByPath.values()) {
    items.push({
      label: node.label,
      description: node.kind,
      detail: formatNodeSource(node),
      ref: buildNodeRef(index, node, freq),
    });
  }
  return items;
}
