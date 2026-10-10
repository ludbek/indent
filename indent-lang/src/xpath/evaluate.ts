import type { ParsedXPath, XPathNode, XPathPredicate, XPathStep } from "./types.js";
import { parseXPath } from "./parser.js";

/** Strict, typed equality -- a quoted `"42"` (string) never matches an unquoted `42` (number). */
function matchesLiteral(nodeValue: unknown, literal: unknown): boolean {
  return typeof nodeValue === typeof literal && nodeValue === literal;
}

function matchesPredicate<T extends XPathNode>(node: T, predicate: XPathPredicate): boolean {
  if (predicate.type === "self") {
    return node.value !== undefined && matchesLiteral(node.value, predicate.value);
  }
  if (predicate.type === "index") {
    // Index predicates are resolved positionally in `selectNodes` before
    // `matchesStep`/`matchesPredicate` are ever consulted -- never reached.
    throw new Error("index predicates must be resolved positionally, not via matchesPredicate");
  }
  const attrs = node.attrs ?? {};
  return predicate.predicates.every((p) => {
    if (!(p.name in attrs)) return false;
    if (p.value === undefined) return true; // existence-only clause: [prop]
    return matchesLiteral(attrs[p.name], p.value);
  });
}

function matchesStep<T extends XPathNode>(node: T, step: XPathStep): boolean {
  if (step.name !== "*" && node.kind.toLowerCase() !== step.name.toLowerCase()) return false;
  if (step.predicate && !matchesPredicate(node, step.predicate)) return false;
  return true;
}

/** All descendants (children, grandchildren, ...) of the given nodes -- excludes the nodes themselves. */
function collectDescendants<T extends XPathNode>(nodes: T[]): T[] {
  const result: T[] = [];
  const visit = (n: T) => {
    for (const child of (n.children ?? []) as T[]) {
      result.push(child);
      visit(child);
    }
  };
  for (const n of nodes) visit(n);
  return result;
}

/**
 * Selects nodes from a tree (given as an array of root nodes) matching the
 * given xpath expression. Accepts either a raw string (parsed internally
 * via {@link parseXPath}) or an already-parsed {@link ParsedXPath}, so
 * callers evaluating the same expression repeatedly can parse once.
 *
 * Supported subset: absolute paths (`/a/b/c`), descendant paths (`//a`,
 * `//a//b`), attribute predicates (`[prop]`, `[prop=value]`,
 * `[prop1=v1,prop2=v2]`), self-value predicates (`[.=value]`), and
 * positional index predicates (`[N]`). See `parseXPath` for the full list
 * of what's out of scope.
 */
export function selectNodes<T extends XPathNode>(
  roots: T[],
  xpath: string | ParsedXPath,
): T[] {
  const parsed = typeof xpath === "string" ? parseXPath(xpath) : xpath;

  // Initial candidate set for the first step: all top-level roots for an
  // absolute path, or every node in the tree (roots + all descendants) for
  // a leading `//` descendant path.
  let currentSet: T[] = parsed.isDescendant ? [...roots, ...collectDescendants(roots)] : [...roots];

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];

    const candidates: T[] =
      i === 0
        ? currentSet
        : step.axis === "descendant"
          ? collectDescendants(currentSet)
          : currentSet.flatMap((n) => (n.children ?? []) as T[]);

    if (step.predicate?.type === "index") {
      // Positional index predicate: pick the Nth (0-based) kind-matching
      // candidate, using whatever order `candidates` already carries for
      // this axis (sibling/registration order for `child`, depth-first
      // pre-order for `descendant`) -- no separate traversal needed.
      const kindMatches =
        step.name === "*"
          ? candidates
          : candidates.filter((n) => n.kind.toLowerCase() === step.name.toLowerCase());
      const target = kindMatches[step.predicate.index];
      currentSet = target ? [target] : [];
      if (currentSet.length === 0) break;
      continue;
    }

    const matched: T[] = [];
    for (const node of candidates) {
      if (matchesStep(node, step) && !matched.includes(node)) {
        matched.push(node);
      }
    }

    currentSet = matched;
    if (currentSet.length === 0) break;
  }

  return currentSet;
}
