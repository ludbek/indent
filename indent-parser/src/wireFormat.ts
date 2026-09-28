import { IndentParseError } from "./types.js";

/**
 * Encodes/decodes Indent source text between its normal 4-space-indented,
 * newline-separated form and a compact "wire format" that replaces every
 * `\n` + indentation change with a run of `\+` (indent one level deeper)
 * or `\-` (dedent one level shallower) escape sequences -- one character
 * per depth level crossed. A newline between two lines at the *same*
 * depth (siblings) is left as a bare `\n`, since no indentation change
 * needs to be communicated.
 *
 * This is a pure text transform: it does not tokenize or parse Indent,
 * and it round-trips arbitrary Indent source (including blank lines,
 * comments, and `\` line-continuations) byte-for-byte through
 * `decodeWireFormat(encodeWireFormat(x)) === x`, modulo normalizing all
 * line endings to `\n`.
 *
 * The purpose is to allow the same `.inml` structure to be transmitted as a
 * single "flat" string (no embedded raw newlines needed to convey nesting)
 * -- analogous to how XML conveys nesting via inline open/close tags
 * rather than positional whitespace.
 *
 * Indentation depth is computed exactly like `tokenizer.ts`: depth is the
 * count of full leading 4-space groups, and any stray/partial whitespace
 * after that (a lone space or a tab) is rejected with the same error
 * message/contract as the tokenizer. Blank lines and lines that are
 * entirely a comment (`;...`) are not depth-bearing; they carry no
 * indentation info of their own, so they are encoded as a same-depth
 * (bare `\n`) transition with any leading whitespace stripped from their
 * content. A genuinely empty line round-trips back to an empty line; a
 * comment-only line's indentation is normalized to the current depth's
 * 4-space convention on decode -- this does not change how Indent parses
 * (which ignores both blank and comment lines regardless of indentation),
 * but means such a line's exact leading-whitespace byte sequence is not
 * guaranteed to round-trip verbatim.
 *
 * Known limitation: a literal backslash sequence inside quoted string
 * content that happens to read as `\+` or `\-` (e.g.
 * `description="a\+b"`) is ambiguous with the escape sequences introduced
 * here. The Indent tokenizer does not currently define any string escapes
 * beyond `\"`, so this is a narrow, pre-existing kind of collision risk
 * rather than one newly introduced by this format.
 */

/** Computes the indentation depth of a single raw (non-blank) line, and
 * returns the depth plus the index of the first non-indentation character.
 * Mirrors `tokenizer.ts`'s depth-counting/validation exactly. */
function measureIndent(rawLine: string, lineNumber: number): { depth: number; contentStart: number } {
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
  return { depth, contentStart: pos };
}

/** Returns true for a line that carries no depth info of its own (blank,
 * or entirely a `;` comment once leading whitespace is stripped). */
function isDepthless(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  return trimmed.length === 0 || trimmed.startsWith(";");
}

/**
 * Converts normal 4-space-indented Indent source text into the compact
 * `\+`/`\-` wire format described above.
 */
export function encodeWireFormat(source: string): string {
  const rawLines = source.split(/\r\n|\r|\n/);
  let out = "";
  let currentDepth = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const lineNumber = i + 1;

    let content: string;
    let depth: number;
    if (isDepthless(rawLine)) {
      // Blank/comment-only lines carry no indentation info of their own;
      // strip any leading whitespace and treat them as a same-depth
      // transition.
      content = rawLine.replace(/^[ \t]+/, "");
      depth = currentDepth;
    } else {
      const measured = measureIndent(rawLine, lineNumber);
      content = rawLine.slice(measured.contentStart);
      depth = measured.depth;
    }

    if (i === 0) {
      out += content;
    } else {
      const delta = depth - currentDepth;
      if (delta === 0) {
        out += "\n" + content;
      } else if (delta > 0) {
        out += "\\+".repeat(delta) + content;
      } else {
        out += "\\-".repeat(-delta) + content;
      }
    }
    currentDepth = depth;
  }

  return out;
}

/**
 * Reverses `encodeWireFormat`, expanding `\+`/`\-` escape runs back into
 * `\n` plus the appropriate 4-space indentation, and bare `\n` back into
 * `\n` plus the current (unchanged) depth's indentation.
 */
export function decodeWireFormat(encoded: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  const n = encoded.length;
  // True right after a `\n` (or `\+`/`\-` run) has been emitted, until the
  // first regular content char of that line is seen. Indentation spaces
  // are only materialized lazily, right before that first char -- so a
  // line that turns out to be genuinely empty (immediately followed by
  // another newline/marker or end of string) never gets spaces invented
  // for it.
  let pendingIndent = false;

  while (i < n) {
    const ch = encoded[i];
    if (ch === "\n") {
      out += "\n";
      pendingIndent = true;
      i++;
      continue;
    }
    if (ch === "\\" && (encoded[i + 1] === "+" || encoded[i + 1] === "-")) {
      const marker = encoded[i + 1];
      let runLen = 0;
      let j = i;
      while (j < n && encoded[j] === "\\" && encoded[j + 1] === marker) {
        runLen++;
        j += 2;
      }
      depth += marker === "+" ? runLen : -runLen;
      if (depth < 0) {
        throw new IndentParseError(
          "invalid wire format: '\\-' run dedents past depth 0",
          1,
        );
      }
      out += "\n";
      pendingIndent = true;
      i = j;
      continue;
    }
    if (pendingIndent) {
      out += "    ".repeat(depth);
      pendingIndent = false;
    }
    out += ch;
    i++;
  }

  return out;
}
