/**
 * Generic node shape this package operates on. Structurally compatible with
 * `tree-dsl-parser`'s `DslNode` (kind/value/attrs/children) but declared
 * independently -- this package has no runtime or dev dependency on
 * `tree-dsl-parser`, so it stays reusable for any tree-shaped data with the
 * same basic fields (kind, optional positional value, optional attrs,
 * optional children).
 */
interface XPathNode {
    kind: string;
    /** Optional positional value (string, number, or boolean), matched via `[.=value]`. */
    value?: string | number | boolean;
    /** Optional key/value attributes, matched via `[prop]` / `[prop=value]`. */
    attrs?: Record<string, unknown>;
    children?: XPathNode[];
}
/**
 * A literal value used in a predicate, typed per the DSL's own value rules:
 * quoted (`"..."`) is always a string; unquoted `true`/`false` is a boolean;
 * unquoted numeric text (`/^-?\d+(\.\d+)?$/`) is a number. Anything else
 * unquoted is a parse error (matches `tree-dsl-parser`'s attribute typing).
 */
type XPathLiteral = string | number | boolean;
/**
 * A single `name` or `name=value` clause inside a `[...]` attribute
 * predicate. `value === undefined` means an existence-only check (`[prop]`).
 * Only valid on its own (not inside a multi-clause comma list, where every
 * clause must carry a value -- see `parsePredicate`).
 */
interface XPathAttrPredicate {
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
type XPathPredicate = {
    type: "attr";
    predicates: XPathAttrPredicate[];
} | {
    type: "self";
    value: XPathLiteral;
} | {
    type: "index";
    index: number;
};
/**
 * Axis for a single path step. Only `child` (default, single `/`) and
 * `descendant` (`//`, any depth) are supported in this subset. Not
 * supported yet: `parent` (`..`), `self` (`.`) as a standalone step,
 * `attribute` (`@name`) as a standalone step, and wildcard (`*`) names.
 */
type XPathAxis = "child" | "descendant";
interface XPathStep {
    axis: XPathAxis;
    /** Node kind to match, e.g. "service". No wildcard support in this subset. */
    name: string;
    predicate?: XPathPredicate;
}
interface ParsedXPath {
    /** True if the expression starts with a single `/` (absolute, from root). */
    isAbsolute: boolean;
    /** True if the expression starts with `//` (descendant, from anywhere). */
    isDescendant: boolean;
    steps: XPathStep[];
    /** The original, unparsed xpath source text. */
    raw: string;
}
/** Thrown when an xpath expression cannot be parsed under this subset's grammar. */
declare class XPathParseError extends Error {
    readonly raw: string;
    constructor(message: string, raw: string);
}

/**
 * Parses an xpath expression under this package's supported subset:
 * - Absolute paths: `/parent/children/grandchildren`
 * - Descendant paths: `//node`, `//node//grandchild`, `/a//b`
 * - Attribute predicates: `[prop]`, `[prop=value]`, `[prop1=v1,prop2=v2]`
 *   (comma-separated clauses ANDed together; bare existence checks only
 *   allowed alone, not mixed into a multi-clause list)
 * - Self-value predicates: `[.=value]`
 * - Positional index predicates: `[N]` (0-based, bare digit-only bracket
 *   body -- unambiguous since real attribute names are never pure digits)
 *
 * Not supported (throws `XPathParseError`): relative paths without a
 * leading `/`, `..`/parent axis, `@name` as a standalone step, wildcard
 * `*` names, multiple separate bracket groups on one step (`[a][b]` --
 * use `[a,b]` instead), and a `name=value` self-value shorthand (use the
 * bracketed `[.=value]` form instead).
 */
declare function parseXPath(raw: string): ParsedXPath;

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
declare function selectNodes<T extends XPathNode>(roots: T[], xpath: string | ParsedXPath): T[];

export { type ParsedXPath, type XPathAttrPredicate, type XPathAxis, type XPathLiteral, type XPathNode, XPathParseError, type XPathPredicate, type XPathStep, parseXPath, selectNodes };
