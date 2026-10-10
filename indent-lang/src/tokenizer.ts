import { AttrValue, IndentParseError, RefValue } from "./types.js";
import { cstAttrsToPlain, CstIndentNode, parseCst } from "./cstParser.js";

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
 * Flattens a `CstIndentNode` tree (produced by the shared `treesitter-indent`
 * grammar via `cstParser.ts`) into a document-order `LineToken[]` stream.
 *
 * This is a thin adapter layer, not a parser: `treesitter-indent` is the
 * single source of truth for lexical analysis (comment/blank-line skipping,
 * `\`-continuation joining, quoted-string/number/boolean/ref scanning). This
 * function only re-derives each statement's indentation `depth` from its
 * literal source column (matching the original 4-space-group convention
 * exactly) rather than trusting the grammar's own block nesting, so that
 * `parser.ts`'s depth-stack `buildTree()` -- and its existing indentation
 * validation/error messages -- keep working completely unchanged on top of
 * this flattened token stream.
 */
function flatten(nodes: CstIndentNode[], tokens: LineToken[]): void {
  for (const node of nodes) {
    const startChar = node.kindRange.start.character;
    const line = node.kindRange.start.line + 1;

    if (startChar % 4 !== 0) {
      throw new IndentParseError(
        "inconsistent indentation (expected 4 spaces per level, found stray whitespace)",
        line,
      );
    }

    tokens.push({
      depth: startChar / 4,
      kind: node.kind,
      ...(node.value !== undefined ? { value: node.value } : {}),
      attrs: cstAttrsToPlain(node.attrs),
      line,
    });

    // Recurse in source order so the flattened stream stays purely
    // document-ordered, independent of how the grammar nested the block.
    flatten(node.children, tokens);
  }
}

/**
 * Splits Indent source into lexical line tokens, via the shared
 * `treesitter-indent` tree-sitter grammar (see `cstParser.ts`).
 *
 * - Blank lines and `;` comments (full-line or trailing) are skipped.
 * - Indentation is measured in leading 4-space groups only; tabs are not
 *   allowed for indentation and any stray/partial whitespace is a parse
 *   error.
 * - Each remaining line is lexed into a `kind`, an optional positional
 *   `value` (string, number, boolean, or ref), plus zero or more
 *   `key="value"` attribute pairs.
 * - A line may end with a trailing `\` to continue onto the next physical
 *   line (Python-style line continuation); the grammar joins these into a
 *   single logical statement before this function ever sees it.
 */
export function tokenize(source: string): LineToken[] {
  const { roots, errors } = parseCst(source);

  if (errors.length > 0) {
    const first = errors[0];
    throw new IndentParseError(first.message, first.range.start.line + 1);
  }

  const tokens: LineToken[] = [];
  flatten(roots, tokens);
  return tokens;
}
