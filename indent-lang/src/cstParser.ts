import Parser from "tree-sitter";
import IndentGrammar from "treesitter-indent";
import { walkCstTree, type CstNode, type CstParseResult } from "./cstWalker.js";

export * from "./cstWalker.js";

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(IndentGrammar as unknown as Parser.Language);
  }
  return parser;
}

/**
 * Parses Indent source text into a `CstIndentNode` tree using the shared
 * tree-sitter grammar (`treesitter-indent`), via the native Node binding.
 *
 * This is the single source of truth for parsing: `indent-lang`'s legacy
 * `parse()`/`buildTree()` API (see `parser.ts`) is a thin wrapper around
 * this function that projects the result down to the plain `IndentNode`
 * shape via `toIndentNode()`.
 *
 * This file (and only this file) imports the native `tree-sitter`/
 * `treesitter-indent` bindings. `indent-language-server` must never import
 * from here -- it imports `walkCstTree` and the shared types directly from
 * `./cstWalker.js` (re-exported as `indent-lang/cst`) against its own
 * `web-tree-sitter` (WASM) `Tree`/`Parser` instance, so it can retain the
 * `Tree` for incremental re-parse via `tree.edit()` without ever requiring
 * a native `.node` addon to load.
 */
export function parseCst(source: string): CstParseResult {
  const tree = getParser().parse(source);
  return walkCstTree(tree.rootNode as unknown as CstNode);
}
