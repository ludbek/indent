import type { ParsedXPath, XPathAttrPredicate, XPathLiteral, XPathPredicate, XPathStep } from "./types.js";
import { XPathParseError } from "./types.js";

// Attribute/predicate name: must start with a letter or underscore, followed
// by letters, digits, underscores, or hyphens. Anchoring the first char
// this way also guarantees a pure-digit string (e.g. "123") never matches,
// which is what makes the `[N]` positional-index predicate unambiguous
// from a `[name]` attribute-existence predicate (see INDEX_REGEX below).
const NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// Node kind/step name (e.g. "Service" in "/Service/API", or an edge kind
// like "->"/"=>"): must start with a letter, underscore, or one of
// `- = < >`, followed by any number of letters, digits, underscores,
// hyphens, or `< = >`. This mirrors tokenizer.ts's KIND_NAME_PATTERN and
// treesitter-indent grammar.js's `type` rule, so a ref path can reference
// any valid Indent kind, including edge markers "->"/"=>".
const KIND_NAME_REGEX = /^[-_=<>A-Za-z][-_=<>A-Za-z0-9]*$/;
const NUMBER_REGEX = /^-?\d+(\.\d+)?$/;

/**
 * Minimal cursor-based scanner over the (already leading-slash-stripped)
 * remainder of an xpath expression. A manual scanner -- rather than a naive
 * `split("/")` -- is required because predicate values can themselves
 * contain `/` or `]` inside a quoted string, e.g. `[.="a/b"]`.
 */
class Scanner {
  private pos = 0;

  constructor(private readonly text: string, private readonly raw: string) {}

  get eof(): boolean {
    return this.pos >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  advance(n = 1): void {
    this.pos += n;
  }

  error(message: string): never {
    throw new XPathParseError(message, this.raw);
  }

  /** Reads a bare node-kind/step name matching {@link KIND_NAME_REGEX}. */
  readName(context: string): string {
    const start = this.pos;
    while (!this.eof && /[-_=<>A-Za-z0-9]/.test(this.peek())) {
      this.advance();
    }
    const name = this.text.slice(start, this.pos);
    if (!name) this.error(`expected ${context} at position ${start}`);
    if (!KIND_NAME_REGEX.test(name)) {
      this.error(
        `invalid ${context} "${name}": must start with a letter, underscore, or one of - = < >, followed by letters, digits, underscores, hyphens, or < = >`,
      );
    }
    return name;
  }

  /**
   * Reads (and consumes) the contents between a `[` and its matching `]`,
   * respecting `"..."` quoted spans so a `]`/`/` inside a quoted predicate
   * literal doesn't terminate the predicate or step early.
   */
  readBracketedPredicate(): string {
    if (this.peek() !== "[") this.error("expected '['");
    this.advance(); // consume '['
    const start = this.pos;
    let inString = false;
    while (!this.eof) {
      const ch = this.peek();
      if (inString) {
        if (ch === "\\") {
          this.advance(2); // skip escaped char, e.g. \"
          continue;
        }
        if (ch === '"') inString = false;
        this.advance();
        continue;
      }
      if (ch === '"') {
        inString = true;
        this.advance();
        continue;
      }
      if (ch === "]") {
        const body = this.text.slice(start, this.pos);
        this.advance(); // consume ']'
        return body;
      }
      this.advance();
    }
    this.error("unterminated '[' predicate");
  }

}

function parseLiteral(text: string, raw: string): XPathLiteral {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    // Unescape simple backslash escapes, e.g. \" -> "
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (NUMBER_REGEX.test(trimmed)) return Number(trimmed);
  throw new XPathParseError(
    `invalid predicate literal "${trimmed}" -- must be a quoted string, number, or true/false`,
    raw,
  );
}

/**
 * Splits a predicate body on top-level `,` (i.e. not inside a `"..."`
 * quoted span), so `[label="a,b",owner="x"]` splits into two clauses, not
 * three.
 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Parses a single `name` or `name=value` clause within a `[...]` predicate. */
function parseAttrClause(clause: string, raw: string): XPathAttrPredicate {
  const trimmed = clause.trim();
  if (trimmed.length === 0) {
    throw new XPathParseError("empty predicate clause", raw);
  }
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) {
    if (!NAME_REGEX.test(trimmed)) {
      throw new XPathParseError(`invalid attribute name "${trimmed}" in predicate`, raw);
    }
    return { name: trimmed };
  }
  const name = trimmed.slice(0, eqIndex).trim();
  if (!NAME_REGEX.test(name)) {
    throw new XPathParseError(`invalid attribute name "${name}" in predicate`, raw);
  }
  const value = parseLiteral(trimmed.slice(eqIndex + 1), raw);
  return { name, value };
}

const INDEX_REGEX = /^\d+$/;

function parsePredicate(body: string, raw: string): XPathPredicate {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new XPathParseError("empty predicate '[]'", raw);
  }

  // Positional index predicate: [N] -- a bare digit-only bracket body.
  // Unambiguous since real attribute names are always identifier-like text
  // (see NAME_REGEX), never pure digits.
  if (INDEX_REGEX.test(trimmed)) {
    return { type: "index", index: Number(trimmed) };
  }

  // Self-axis value predicate: [.=value]
  if (trimmed.startsWith(".")) {
    const rest = trimmed.slice(1).trim();
    if (!rest.startsWith("=")) {
      throw new XPathParseError(
        `self predicate must be in the form [.=value], got "[${trimmed}]"`,
        raw,
      );
    }
    const value = parseLiteral(rest.slice(1), raw);
    return { type: "self", value };
  }

  // Attribute predicate(s): [prop], [prop=value], or [prop1=v1,prop2=v2]
  const clauses = splitTopLevelCommas(trimmed);
  const predicates = clauses.map((clause) => parseAttrClause(clause, raw));

  if (predicates.length > 1) {
    for (const p of predicates) {
      if (p.value === undefined) {
        throw new XPathParseError(
          `bare attribute existence check "${p.name}" is not allowed inside a multi-predicate list -- combine only "name=value" pairs, e.g. [${p.name}=value,other=value]`,
          raw,
        );
      }
    }
  }

  return { type: "attr", predicates };
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
export function parseXPath(raw: string): ParsedXPath {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }

  if (text.length === 0) {
    throw new XPathParseError("xpath expression is empty", raw);
  }

  let isAbsolute = false;
  let isDescendant = false;
  let nextAxis: "child" | "descendant";

  if (text.startsWith("//")) {
    isDescendant = true;
    nextAxis = "descendant";
    text = text.slice(2);
  } else if (text.startsWith("/")) {
    isAbsolute = true;
    nextAxis = "child";
    text = text.slice(1);
  } else {
    throw new XPathParseError(
      "only absolute paths ('/a/b') or descendant paths ('//a') are supported in this subset",
      raw,
    );
  }

  const scanner = new Scanner(text, raw);
  const steps: XPathStep[] = [];

  for (;;) {
    const name = scanner.readName("a node kind");

    let predicate: XPathPredicate | undefined;
    if (scanner.peek() === "[") {
      const body = scanner.readBracketedPredicate();
      predicate = parsePredicate(body, raw);
    }

    steps.push({ axis: nextAxis, name, predicate });

    if (scanner.eof) break;

    if (scanner.startsWith("//")) {
      scanner.advance(2);
      nextAxis = "descendant";
    } else if (scanner.startsWith("/")) {
      scanner.advance(1);
      nextAxis = "child";
    } else {
      scanner.error(`unexpected character "${scanner.peek()}" after step "${name}"`);
    }
  }

  return { isAbsolute, isDescendant, steps, raw };
}
