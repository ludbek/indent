/**
 * Generic node shape this package operates on. Structurally compatible with
 * `indent-parser`'s `IndentNode` (kind/value/attrs/children) but declared
 * independently -- this package has no runtime or dev dependency on
 * `indent-parser`, so it stays reusable for any tree-shaped data with the
 * same basic fields (kind, optional positional value, optional attrs,
 * optional children).
 */
export interface XPathNode {
  kind: string;
  /** Optional positional value (string, number, or boolean), matched via `[.=value]`. */
  value?: string | number | boolean;
  /** Optional key/value attributes, matched via `[prop]` / `[prop=value]`. */
  attrs?: Record<string, unknown>;
  children?: XPathNode[];
}

/**
 * A literal value used in a predicate, typed per Indent's own value rules:
 * quoted (`"..."`) is always a string; unquoted `true`/`false` is a boolean;
 * unquoted numeric text (`/^-?\d+(\.\d+)?$/`) is a number. Anything else
 * unquoted is a parse error (matches `indent-parser`'s attribute typing).
 */
export type XPathLiteral = string | number | boolean;

/**
 * A single `name` or `name=value` clause inside a `[...]` attribute
 * predicate. `value === undefined` means an existence-only check (`[prop]`).
 * Only valid on its own (not inside a multi-clause comma list, where every
 * clause must carry a value -- see `parsePredicate`).
 */
export interface XPathAttrPredicate {
  name: string;
  value?: XPathLiteral;
}

/**
 * Predicate attached to a step:
 * - `[prop]`               -- attribute existence check
 * - `[prop=value]`         -- attribute value equality (typed, not stringified)
 * - `[prop1=v1,prop2=v2]`  -- multiple attribute equality checks, ANDed
 *   together (comma-separated clauses must all be `name=value`; bare
 *   existence checks are only allowed when there's a single clause)
 * - `[.=value]`            -- self-axis: match the node's own positional value
 * - `[N]`                  -- positional index: the Nth (0-based) node among
 *   this step's kind-matching candidates. For a `child` axis step, that's
 *   the Nth same-kind child under the current parent (in registration
 *   order). For a `descendant` axis step, that's the Nth same-kind node in
 *   depth-first pre-order across the whole matched candidate set. A bare
 *   digit-only bracket body (`/^\d+$/`) is unambiguous since real attribute
 *   names are always identifier-like text, never pure digits.
 */
export type XPathPredicate =
  | { type: "attr"; predicates: XPathAttrPredicate[] }
  | { type: "self"; value: XPathLiteral }
  | { type: "index"; index: number };

/**
 * Axis for a single path step. Only `child` (default, single `/`) and
 * `descendant` (`//`, any depth) are supported in this subset. Not
 * supported yet: `parent` (`..`), `self` (`.`) as a standalone step,
 * `attribute` (`@name`) as a standalone step, and wildcard (`*`) names.
 */
export type XPathAxis = "child" | "descendant";

export interface XPathStep {
  axis: XPathAxis;
  /** Node kind to match, e.g. "service". No wildcard support in this subset. */
  name: string;
  predicate?: XPathPredicate;
}

export interface ParsedXPath {
  /** True if the expression starts with a single `/` (absolute, from root). */
  isAbsolute: boolean;
  /** True if the expression starts with `//` (descendant, from anywhere). */
  isDescendant: boolean;
  steps: XPathStep[];
  /** The original, unparsed xpath source text. */
  raw: string;
}

/** Thrown when an xpath expression cannot be parsed under this subset's grammar. */
export class XPathParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(`Invalid XPath "${raw}": ${message}`);
    this.name = "XPathParseError";
  }
}
