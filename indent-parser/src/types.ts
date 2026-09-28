/**
 * A parsed ref value -- an XPath-like reference to another node in the
 * tree, e.g. `entity=/Member/Rollover` or `entity=//Rollover[type="REST"]`.
 * A ref can also be used as a node's own positional value, e.g.
 * `alias /Member/Rollover`.
 *
 * Only the `raw` source text is kept; it is not parsed into steps (parsing
 * is done downstream by the `indent-xpath` package). This is a simplified
 * subset of XPath syntax intended as a native reference mechanism between
 * nodes in the tree (e.g. for the Language Server), supporting:
 *
 * - Absolute path: `/Member/Rollover`
 * - Descendant (anywhere in the tree): `//Rollover`
 * - Mid-path descendant: `/Member//Rollover`
 * - Attribute existence predicate: `Member[name]`
 * - Attribute equality predicate: `Member[name="Rollover"]`
 * - Comma-separated multi-predicate AND list: `Member[name="Rollover",port=8080]`
 * - Self-value predicate (matches a node's own positional value): `Member[.="Rollover"]`
 * - Positional index predicate (0-based, among same-kind siblings/matches): `Member[0]`
 *
 * It does not support the full XPath grammar: no bare relative paths
 * (a leading `/` or `//` is always required), no `..` parent axis, no `.`
 * or `@name` as standalone steps, no wildcard `*`, no multiple separate
 * bracket groups on one step (`[a][b]` -- use `[a,b]` instead), and no
 * `name=value` self-value shorthand (use the bracketed `[.=value]` form
 * instead).
 */
export interface RefValue {
  type: "ref";
  /** The original, unparsed ref source text. */
  raw: string;
}

/**
 * The value of a single `key=value` attribute.
 *
 * - Double-quoted values (`key="..."`) are always `string`.
 * - Unquoted values are inferred: `true`/`false` become `boolean`, values
 *   matching a numeric literal (e.g. `42`, `-3.5`) become `number`, and
 *   anything else must be a valid XPath-like reference (see `RefValue`)
 *   or it is a parse error.
 */
export type AttrValue = string | number | boolean | RefValue;

/**
 * A single node in the parsed Indent tree.
 *
 * Every construct in Indent -- including reference/edge lines written as
 * `-> key="value"` -- parses into this same generic shape. There is no
 * special-cased "edge" or "reference" type: `->` is just a `kind`, exactly
 * like `org`, `team`, or `service`. This keeps the model reusable for
 * arbitrary tree-shaped configs, not just system diagrams.
 */
export interface IndentNode {
  /** The leading keyword/tag of the line, e.g. "org", "service", "->". */
  kind: string;
  /** Optional positional value (string, number, boolean, or ref) immediately following the kind. */
  value?: string | number | boolean | RefValue;
  /** All `key=value` pairs declared on the line, in source order. */
  attrs: Record<string, AttrValue>;
  /** Nested nodes (lines indented one level deeper than this node). */
  children: IndentNode[];
}

/** Result of parsing a full Indent document. */
export interface ParseResult {
  /** Top-level (zero-indentation) nodes, in source order. */
  roots: IndentNode[];
}

/** Thrown when the Indent source cannot be parsed. */
export class IndentParseError extends Error {
  /**
   * Path of the file in which the error occurred, when known. Only set for
   * errors surfaced while resolving `parseFile`/includes; plain `parse()`
   * calls (which only ever see a single in-memory source string) leave this
   * `undefined`.
   */
  public readonly file?: string;

  constructor(message: string, public readonly line: number, file?: string) {
    super(file ? `${file}:${line}: ${message}` : `Line ${line}: ${message}`);
    this.name = "IndentParseError";
    this.file = file;
  }
}
