import type { WorkspaceIndex } from "./indexer.js";
import type { IndexedNode } from "./types.js";

/**
 * Precomputed frequency tables used to decide, in O(1) per node, whether a
 * node's `kind` (Tier 1) or `(kind, positional value)` pair (Tier 2) is
 * globally unique across the whole workspace. Building these once and
 * reusing them across many `buildNodeRef` calls avoids re-scanning
 * `nodesByPath` for every node (important when generating refs for an
 * entire workspace's worth of searchable nodes at once).
 */
export interface RefFrequencyMaps {
  /** kind (lowercased) -> count of nodes with that kind, workspace-wide. */
  kindCounts: Map<string, number>;
  /** `${kind}\0${typeof value}\0${value}` -> count of nodes sharing that
   * exact (kind, typed value) pair, workspace-wide. */
  kindValueCounts: Map<string, number>;
}

function makeKindValueKey(kind: string, value: string | number | boolean): string {
  // Include `typeof value` in the key so that a quoted string "42" and an
  // unquoted number 42 are never conflated -- mirrors the strict
  // typeof+=== equality semantics `indent-lang`'s xpath module's `matchesLiteral` uses
  // when resolving `[.=value]` self-value predicates.
  return `${kind.toLowerCase()}\u0000${typeof value}\u0000${String(value)}`;
}

/**
 * Scans every indexed node in the workspace once (O(n)) to build the
 * frequency tables `buildNodeRef` needs for its Tier 1 / Tier 2 checks.
 */
export function computeRefFrequencyMaps(index: WorkspaceIndex): RefFrequencyMaps {
  const kindCounts = new Map<string, number>();
  const kindValueCounts = new Map<string, number>();
  for (const node of index.nodesByPath.values()) {
    const kindKey = node.kind.toLowerCase();
    kindCounts.set(kindKey, (kindCounts.get(kindKey) ?? 0) + 1);
    if (node.value !== undefined) {
      const kvKey = makeKindValueKey(node.kind, node.value.value);
      kindValueCounts.set(kvKey, (kindValueCounts.get(kvKey) ?? 0) + 1);
    }
  }
  return { kindCounts, kindValueCounts };
}

/**
 * Serializes a literal value using the same grammar `indent-lang`'s xpath module's
 * `parseLiteral` accepts: quoted + `\`-escaped for strings, bare for
 * numbers/booleans.
 */
function serializeLiteral(value: string | number | boolean): string {
  if (typeof value === "string") {
    return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  }
  return String(value);
}

/** Returns this node's siblings (same parent, all kinds), in the same
 * relative order the indexer registered them in -- i.e. `parent.childPaths`
 * order for non-root nodes, or `index.rootNodes` order for root-level
 * nodes. This is the exact ordering `indent-lang`'s xpath module's evaluator will
 * independently reproduce when resolving a `kind[N]` child-axis index
 * predicate back to a node, so re-deriving positions from it guarantees
 * round-trip correctness. */
function getSiblings(node: IndexedNode, index: WorkspaceIndex): IndexedNode[] {
  if (node.parentPath !== undefined) {
    const parent = index.nodesByPath.get(node.parentPath);
    if (!parent) return [node];
    return parent.childPaths
      .map((p) => index.nodesByPath.get(p))
      .filter((n): n is IndexedNode => n !== undefined);
  }
  return index.rootNodes;
}

/** 0-based position of `node` among its same-kind (case-insensitive)
 * siblings, matching the `[N]` index-predicate semantics `indent-lang`'s xpath module
 * resolves for the child axis. */
function indexAmongSameKindSiblings(node: IndexedNode, index: WorkspaceIndex): number {
  const siblings = getSiblings(node, index);
  const sameKind = siblings.filter((n) => n.kind.toLowerCase() === node.kind.toLowerCase());
  return sameKind.findIndex((n) => n.id === node.id);
}

/**
 * Tier 3 fallback: builds a fully-indexed absolute path from the workspace
 * root down to `node`, emitting a `kind[N]` segment (0-based, among
 * same-kind siblings) at EVERY level -- never mixing in attribute-based
 * disambiguation the way `IndexedNode.canonicalPath` does. This guarantees
 * the resulting ref is unambiguous regardless of sibling attribute
 * collisions, and round-trips correctly through `indent-lang`'s xpath module's
 * `parseXPath`/`selectNodes`.
 */
function buildIndexedPath(node: IndexedNode, index: WorkspaceIndex): string {
  const segments: string[] = [];
  let current: IndexedNode | undefined = node;
  while (current) {
    const idx = indexAmongSameKindSiblings(current, index);
    segments.unshift(`${current.kind}[${idx}]`);
    current = current.parentPath !== undefined ? index.nodesByPath.get(current.parentPath) : undefined;
  }
  return "/" + segments.join("/");
}

/**
 * Builds a `indent-lang`'s xpath module ref string that uniquely identifies `node`
 * within the whole workspace, using a 3-tier strategy (shortest/most
 * readable form that stays unique):
 *
 * 1. If `node.kind` is globally unique across the workspace -> `//kind`.
 * 2. Else, if `node` has a positional value and the (kind, value) pair is
 *    globally unique -> `//kind[.=value]`.
 * 3. Else, fall back to a fully-indexed absolute path from the root,
 *    e.g. `/org[0]/service[2]/API[1]`.
 *
 * Pass a precomputed `freq` (from `computeRefFrequencyMaps`) when calling
 * this for many nodes in the same workspace snapshot to avoid recomputing
 * the O(n) frequency tables on every call.
 */
export function buildNodeRef(
  index: WorkspaceIndex,
  node: IndexedNode,
  freq: RefFrequencyMaps = computeRefFrequencyMaps(index),
): string {
  const kindKey = node.kind.toLowerCase();

  // Tier 1: kind is globally unique.
  if ((freq.kindCounts.get(kindKey) ?? 0) === 1) {
    return `//${node.kind}`;
  }

  // Tier 2: (kind, positional value) pair is globally unique.
  if (node.value !== undefined) {
    const kvKey = makeKindValueKey(node.kind, node.value.value);
    if ((freq.kindValueCounts.get(kvKey) ?? 0) === 1) {
      return `//${node.kind}[.=${serializeLiteral(node.value.value)}]`;
    }
  }

  // Tier 3: fully indexed path from root, `kind[N]` at every segment.
  return buildIndexedPath(node, index);
}
