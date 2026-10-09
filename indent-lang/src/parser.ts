import { tokenize, LineToken } from "./tokenizer.js";
import { IndentNode, IndentParseError, ParseResult } from "./types.js";

interface StackEntry {
  depth: number;
  node: IndentNode;
}

/**
 * Parses Indent source text into a generic tree of `IndentNode`s.
 *
 * The grammar is intentionally simple and uniform, similar to XML: every
 * line is `<kind> key="value" ...`, and its indentation depth (leading
 * 4-space groups) determines nesting under the nearest preceding line at a
 * shallower depth. There is no special handling for `->` lines -- they are
 * ordinary nodes that happen to use `->` as their `kind`.
 */
export function parse(source: string): ParseResult {
  return buildTree(tokenize(source));
}

/**
 * Builds a `IndentNode` tree from an already-tokenized stream of lines.
 *
 * Split out from `parse()` so that `parseFile()` (which splices tokens from
 * included files into the stream before tree-building) can reuse the same
 * depth-stack logic without re-tokenizing a stitched-together source string.
 */
export function buildTree(tokens: LineToken[]): ParseResult {
  const roots: IndentNode[] = [];
  const stack: StackEntry[] = [];

  for (const token of tokens) {
    const node: IndentNode = {
      kind: token.kind,
      ...(token.value !== undefined ? { value: token.value } : {}),
      attrs: token.attrs,
      children: [],
    };

    if (token.depth === 0) {
      roots.push(node);
      stack.length = 0;
      stack.push({ depth: 0, node });
      continue;
    }

    if (stack.length === 0) {
      throw new IndentParseError(
        "unexpected indentation with no parent at a shallower depth",
        token.line,
      );
    }

    while (stack.length > 0 && stack[stack.length - 1].depth >= token.depth) {
      stack.pop();
    }

    if (stack.length === 0 || token.depth !== stack[stack.length - 1].depth + 1) {
      throw new IndentParseError(
        `invalid indentation jump to depth ${token.depth}`,
        token.line,
      );
    }

    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth: token.depth, node });
  }

  return { roots };
}
