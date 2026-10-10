import { AttrValue, IndentParseError, RefValue } from "./types.js";

/** A lexical token for a single, non-blank, non-comment Indent line. */
export interface LineToken {
  /** Indentation depth, measured in leading 4-space groups. */
  depth: number;
  /** The leading keyword, e.g. "org", "service", "->". */
  kind: string;
  /** Optional positional value (string, number, boolean, or ref). */
  value?: string | number | boolean | RefValue;
  /** Parsed `key=value` attribute pairs, in source order. */
  attrs: Record<string, AttrValue>;
  /** 1-based source line number, used for error reporting. */
  line: number;
}

/**
 * Splits Indent source into lexical line tokens.
 *
 * - Blank lines and `;` comments (full-line or trailing) are skipped.
 * - Indentation is measured in leading 4-space groups only; tabs are not
 *   allowed for indentation and any stray/partial whitespace is a parse
 *   error.
 * - Each remaining line is lexed into a `kind`, an optional positional
 *   `value` (string, number, or boolean), plus zero or more `key="value"`
 *   attribute pairs via a small hand-written character scanner.
 * - A line may end with a trailing `\` to continue onto the next physical
 *   line (Python-style line continuation), once a positional value or first
 *   `key="value"` attribute pair has already been written on that line.
 *   Continuation lines are trimmed and joined with a single space; the
 *   resulting logical line is lexed as a whole and reports errors using
 *   the line number of its first physical line.
 */
export function tokenize(source: string): LineToken[] {
  const tokens: LineToken[] = [];
  const rawLines = source.split(/\r\n|\r|\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const lineNumber = i + 1;

    if (rawLine.trim().length === 0) continue;
    if (rawLine.trimStart().startsWith(";")) continue;

    let depth = 0;
    let pos = 0;
    while (pos < rawLine.length) {
      if (rawLine.startsWith("    ", pos)) {
        depth++;
        pos += 4;
      } else {
        break;
      }
    }
    if (pos < rawLine.length && (rawLine[pos] === " " || rawLine[pos] === "\t")) {
      throw new IndentParseError(
        "inconsistent indentation (expected 4 spaces per level, found stray whitespace)",
        lineNumber,
      );
    }

    let content = rawLine.slice(pos);

    let continuation = stripContinuationBackslash(content);
    while (continuation !== null) {
      if (!hasValueOrAttrPairBefore(continuation)) {
        throw new IndentParseError(
          "line continuation with '\\' is only allowed after a positional value or key=\"value\" attribute",
          lineNumber,
        );
      }
      i++;
      const nextLine = i < rawLines.length ? rawLines[i].trim() : "";
      if (nextLine.length === 0) {
        throw new IndentParseError("line continuation '\\' has no following line", lineNumber);
      }
      content = `${continuation} ${nextLine}`;
      continuation = stripContinuationBackslash(content);
    }

    const { kind, value, attrs } = lexContent(content, lineNumber);
    tokens.push({
      depth,
      kind,
      ...(value !== undefined ? { value } : {}),
      attrs,
      line: lineNumber,
    });
  }

  return tokens;
}

/**
 * If `content` ends with a trailing `\` line-continuation marker, returns
 * the content with that marker (and any trailing whitespace before it)
 * stripped. Returns `null` if there is no trailing continuation marker.
 */
function stripContinuationBackslash(content: string): string | null {
  const trimmed = content.replace(/[ \t]+$/, "");
  if (trimmed.endsWith("\\")) {
    return trimmed.slice(0, -1).replace(/[ \t]+$/, "");
  }
  return null;
}

/**
 * Checks whether `content` (the portion of a line before a trailing `\`)
 * contains a positional value or at least one `key=value` attribute pair
 * after the leading keyword.
 */
function hasValueOrAttrPairBefore(content: string): boolean {
  const spaceIndex = content.indexOf(" ");
  if (spaceIndex === -1) return false;
  const rest = content.slice(spaceIndex + 1).trimStart();
  return rest.length > 0;
}

/**
 * Scans a double-quoted string from `startIndex`, handling `\"` escapes.
 */
function scanQuotedString(
  content: string,
  startIndex: number,
  lineNumber: number,
  contextDesc: string,
): { value: string; nextIndex: number } {
  let i = startIndex;
  const n = content.length;
  if (content[i] !== '"') {
    throw new IndentParseError(`expected '"' for ${contextDesc}`, lineNumber);
  }
  i++; // consume opening quote
  let raw = "";
  let closed = false;
  while (i < n) {
    const ch = content[i];
    if (ch === "\\" && content[i + 1] === '"') {
      raw += '"';
      i += 2;
      continue;
    }
    if (ch === '"') {
      closed = true;
      i++;
      break;
    }
    raw += ch;
    i++;
  }
  if (!closed) {
    throw new IndentParseError(`unterminated string value for ${contextDesc}`, lineNumber);
  }
  return { value: raw, nextIndex: i };
}

function lexContent(
  content: string,
  lineNumber: number,
): { kind: string; value?: string | number | boolean | RefValue; attrs: Record<string, AttrValue> } {
  let i = 0;
  const n = content.length;

  const skipSpaces = () => {
    while (i < n && content[i] === " ") i++;
  };

  skipSpaces();
  const kindStart = i;
  while (i < n && content[i] !== " ") i++;
  const kind = content.slice(kindStart, i);
  if (kind.length === 0) {
    throw new IndentParseError("expected a keyword at start of line", lineNumber);
  }
  if (!KIND_NAME_PATTERN.test(kind)) {
    throw new IndentParseError(
      `invalid kind '${kind}': must start with a letter, underscore, one of - = < >, or a leading '!' for a built-in directive (e.g. '!include'), followed by letters, digits, underscores, hyphens, or < = >`,
      lineNumber,
    );
  }

  skipSpaces();

  let value: string | number | boolean | RefValue | undefined;

  // Check for optional positional value immediately after kind
  if (i < n && !content.slice(i).startsWith(";")) {
    if (content[i] === '"') {
      const res = scanQuotedString(content, i, lineNumber, "node value");
      value = res.value;
      i = res.nextIndex;
      skipSpaces();
    } else if (content[i] === "/") {
      // A positional value starting with `/` or `//` is unambiguously a ref
      // -- attribute-less positional refs never start with `/`, so there is
      // no need to look ahead for `=` to disambiguate from a `key=value`
      // attribute here, unlike the boolean/number branch below.
      const valStart = i;
      i = scanUnquotedSpan(content, i);
      const raw = content.slice(valStart, i);
      if (!XPATH_PATTERN.test(raw)) {
        throw new IndentParseError(
          `unquoted value '${raw}' is not a boolean, number, or valid ref; strings must be quoted`,
          lineNumber,
        );
      }
      value = { type: "ref", raw };
      skipSpaces();
    } else {
      // Look ahead to check if this token is a number/boolean positional value vs key=...
      const tokenStart = i;
      while (i < n && content[i] !== " " && !content.slice(i).startsWith(";")) {
        if (content[i] === "=") {
          break;
        }
        i++;
      }
      if (i < n && content[i] === "=") {
        // Found '=', so this token is the start of an attribute key, not a positional value
        i = tokenStart;
      } else {
        // No '=' found in the first token; parse as a positional value (boolean or number)
        const raw = content.slice(tokenStart, i);
        if (raw === "true") {
          value = true;
        } else if (raw === "false") {
          value = false;
        } else if (NUMBER_PATTERN.test(raw)) {
          value = Number(raw);
        } else {
          throw new IndentParseError(
            `unquoted value '${raw}' is not a boolean or number; strings must be quoted`,
            lineNumber,
          );
        }
        skipSpaces();
      }
    }
  }

  const attrs: Record<string, AttrValue> = {};

  while (i < n) {
    if (content.slice(i).startsWith(";")) {
      break;
    }
    const keyStart = i;
    while (i < n && content[i] !== "=" && content[i] !== " ") i++;
    const key = content.slice(keyStart, i);
    if (key.length === 0) {
      throw new IndentParseError(`unexpected character '${content[i]}' in attributes`, lineNumber);
    }
    if (!ATTR_NAME_PATTERN.test(key)) {
      throw new IndentParseError(
        `invalid attribute name '${key}': must start with a letter or underscore, followed by letters, digits, underscores, or hyphens`,
        lineNumber,
      );
    }
    if (content[i] !== "=") {
      throw new IndentParseError(`expected '=' after attribute name '${key}'`, lineNumber);
    }
    i++; // consume '='

    let attrVal: AttrValue;
    if (content[i] === '"') {
      const res = scanQuotedString(content, i, lineNumber, `attribute '${key}'`);
      attrVal = res.value;
      i = res.nextIndex;
    } else {
      // Unquoted value (e.g. pk=true, count=42, entity=/Member[name="Foo"]).
      // Unquoted values must be a boolean, number, or ref literal; strings
      // must be quoted.
      const valStart = i;
      i = scanUnquotedSpan(content, i);
      const raw = content.slice(valStart, i);
      if (raw.length === 0) {
        throw new IndentParseError(`expected value for attribute '${key}'`, lineNumber);
      }
      attrVal = parseUnquotedValue(raw, key, lineNumber);
    }

    attrs[key] = attrVal;
    skipSpaces();
  }

  return { kind, ...(value !== undefined ? { value } : {}), attrs };
}

/**
 * Scans an unquoted value span starting at `startIndex`, honoring nested
 * `[...]` brackets and `"..."` quoted spans (so a space inside a bracketed
 * predicate/quoted literal, e.g. `[name="Auth Service"]`, doesn't
 * prematurely terminate the scan). Stops at the first top-level space.
 * Returns the index immediately after the scanned span.
 *
 * `//` inside an unquoted value is a legitimate descendant-step separator
 * (e.g. `/org//service`), not a comment -- comments use `;`, and a bare
 * top-level space already terminates the value scan before any trailing
 * `; comment` could be reached.
 */
function scanUnquotedSpan(content: string, startIndex: number): number {
  const n = content.length;
  let i = startIndex;
  let bracketDepth = 0;
  let inQuote = false;
  while (i < n) {
    const ch = content[i];
    if (inQuote) {
      if (ch === "\\" && content[i + 1] === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === "[") {
      bracketDepth++;
      i++;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--;
      i++;
      continue;
    }
    if (bracketDepth === 0 && ch === " ") break;
    i++;
  }
  return i;
}

/** Matches a full numeric literal, e.g. "42", "-3.5", "0.5", "-0". */
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

/** A single path/attribute name, e.g. "Member", "Roll-Over", "_foo", "owner". */
const REF_NAME = "[A-Za-z_][A-Za-z0-9_-]*";

/**
 * Validates a plain `key=value` attribute name: must start with a letter or
 * underscore, followed by letters, digits, underscores, or hyphens (same
 * shape as `REF_NAME`, so e.g. `background-color` remains valid but `123`
 * or `1abc` do not).
 */
const ATTR_NAME_PATTERN = new RegExp(`^${REF_NAME}$`);

/**
 * Validates a line's leading `kind` keyword: must start with a letter,
 * underscore, or one of `- = < >` (so bareword edge markers like `->` and
 * `=>` remain valid), followed by any number of letters, digits,
 * underscores, hyphens, or `< = >`. A leading `!` marks a built-in
 * directive kind (e.g. `!include`, and future directives like `!schema`),
 * reserved generically for the parser's/tooling's own directives rather
 * than user-defined node kinds; the rest of the name after `!` follows the
 * same identifier shape. A pure-numeric or otherwise symbol-led kind (e.g.
 * `123`, `@foo`) is rejected.
 */
const KIND_NAME_PATTERN = /^!?[-_=<>A-Za-z][-_=<>A-Za-z0-9]*$/;


/** A quoted string literal inside a ref value/predicate, e.g. `"Auth Service"` (supports `\"` escapes). */
const REF_STRING = `"(?:[^"\\\\]|\\\\.)*"`;

/** A literal value used in a predicate: quoted string, boolean, or number. */
const REF_LITERAL = `(?:${REF_STRING}|true|false|-?\\d+(?:\\.\\d+)?)`;

/** One clause inside a predicate bracket: a bare name (existence check) or `name=value` (equality). */
const REF_ATTR_CLAUSE = `${REF_NAME}(?:=${REF_LITERAL})?`;

/**
 * A predicate bracket body: either a self-value match (`.=value`, matching
 * a node's own positional value) or a comma-separated list of attribute
 * clauses (ANDed together; stricter checks, like rejecting a bare
 * existence clause mixed into a multi-clause list, are left to the
 * downstream ref evaluator, not this validation regex).
 */
const REF_PREDICATE_BODY = `(?:\\.=${REF_LITERAL}|${REF_ATTR_CLAUSE}(?:,${REF_ATTR_CLAUSE})*)`;

/**
 * A single ref step: a node kind name, or the wildcard `*` (matches any
 * node kind -- see `indent-lang`'s xpath module), optionally followed by a
 * `[predicate]` bracket. (No `name=value` self-value shorthand -- use the
 * bracketed `[.=value]` form instead.) Wildcard must be the entire step
 * name, not mixed with other characters (e.g. `*foo` is rejected, since
 * this alternation only matches a bare `*` or a full `REF_NAME`).
 */
const REF_STEP = `(?:\\*|${REF_NAME})(?:\\[${REF_PREDICATE_BODY}\\])?`;

/** Step separator: `/` (child, one level) or `//` (descendant, any depth). */
const REF_SEPARATOR = "(?://|/)";

/**
 * Full simplified-xpath grammar for a `ref` value: an absolute (`/`) or
 * descendant (`//`) prefix, then separator-joined steps. Only absolute and
 * descendant paths are supported -- no bare relative paths, `..`, `.`,
 * standalone `@name`, or `name=value` shorthand (matches the subset
 * implemented by the `indent-lang`'s xpath module package). A step may be
 * the wildcard `*` (matches any node kind).
 */
const XPATH_PATTERN = new RegExp(`^${REF_SEPARATOR}${REF_STEP}(?:${REF_SEPARATOR}${REF_STEP})*$`);

/**
 * Infers the type of an unquoted attribute value: `true`/`false` become
 * `boolean`, a numeric literal becomes `number`, and a value matching the
 * simplified ref grammar (see `RefValue`) becomes a tagged ref. Unquoted
 * values must be one of these; strings must always be quoted, so anything
 * else is a parse error.
 */
function parseUnquotedValue(raw: string, key: string, lineNumber: number): AttrValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (NUMBER_PATTERN.test(raw)) return Number(raw);
  if (XPATH_PATTERN.test(raw)) {
    const ref: RefValue = { type: "ref", raw };
    return ref;
  }
  throw new IndentParseError(
    `unquoted value '${raw}' for attribute '${key}' is not a boolean, number, or valid ref; strings must be quoted`,
    lineNumber,
  );
}
