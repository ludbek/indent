/**
 * Starts with // or /. It is used to reference elements in a tree.
 * A subset of XML xpath
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
  /**
   * Resolved path from an in-document `!schema "<path>"` directive, when
   * present. The directive itself is stripped from `roots` -- it never
   * appears as a node in the tree. Only set by `parseFile`/`parseFileWithSources`
   * (which know the source file's location to resolve the path against);
   * plain `parse()` on an in-memory string leaves this `undefined` even if
   * the directive is present, since there is no base path to resolve
   * against.
   */
  schemaRef?: string;
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

  /**
   * 0-based column offset within `line`, when known (e.g. from a CST-backed
   * syntax error). Not set by most parse errors, which only carry a line.
   */
  public readonly character?: number;

  constructor(message: string, public readonly line: number, file?: string, character?: number) {
    super(file ? `${file}:${line}: ${message}` : `Line ${line}: ${message}`);
    this.name = "IndentParseError";
    this.file = file;
    this.character = character;
  }
}
