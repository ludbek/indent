import { Parser, Language, Tree } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { walkCstTree, type CstIndentNode, type CstNode } from "indent-lang/cst";
import type {
  AstAttribute,
  AstDocument,
  AstStatement,
  AstSyntaxError,
  AstValue,
} from "./types.js";

declare const __dirname: string | undefined;

function resolveModuleDir(): string {
  // esbuild/tsup emit both CJS and ESM builds from this same source. In the
  // CJS build, native __dirname exists and import.meta.url is empty; in the
  // ESM build it's the reverse. Support both without breaking either format.
  if (typeof __dirname !== "undefined") return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}

const currentDir = resolveModuleDir();

// Grammar wasm ships alongside the built dist output (copied by the
// `copy-wasm` build step -- see package.json's `build` script and
// scripts/copy-wasm.js). In dev (running src/ directly under ts-node/vitest)
// it resolves to the sibling treesitter-indent workspace package instead.
function resolveGrammarWasmPath(): string {
  const bundled = join(currentDir, "tree-sitter-indent.wasm");
  const workspace = join(currentDir, "..", "..", "treesitter-indent", "tree-sitter-indent.wasm");
  return existsSync(bundled) ? bundled : workspace;
}

let languagePromise: Promise<Language> | null = null;

async function getLanguage(): Promise<Language> {
  if (!languagePromise) {
    languagePromise = (async () => {
      await Parser.init();
      return Language.load(resolveGrammarWasmPath());
    })();
  }
  return languagePromise;
}

/**
 * Projects a `CstIndentNode` (produced by the shared `indent-lang/cst`
 * tree-walker) down to this package's richer `AstStatement` shape, adding
 * the LSP-only fields: a globally unique `id`, the owning document's `uri`,
 * and a `parent` back-pointer. Also appends every visited statement to
 * `allStatements` (flat, for fast position lookups -- see
 * `WorkspaceIndex.getStatementAtPosition`).
 *
 * All range-bearing fields (`kindRange`, `lineRange`, `range`, `attrs`,
 * `rawValue`) are structurally identical between `CstIndentNode` and
 * `AstStatement` (both ultimately describe `{line, character}` positions),
 * so they're reused directly with no conversion.
 */
function toAstStatement(
  node: CstIndentNode,
  uri: string,
  parent: AstStatement | undefined,
  allStatements: AstStatement[],
  nextId: () => number
): AstStatement {
  const value: AstValue | undefined = node.rawValue;

  const statement: AstStatement = {
    id: `${uri}#stmt-${nextId()}`,
    uri,
    kind: node.kind,
    kindRange: node.kindRange,
    value,
    isInclude: node.isInclude,
    includePath: node.includePath,
    isSchema: node.isSchema,
    schemaPath: node.schemaPath,
    attrs: node.attrs as unknown as Record<string, AstAttribute>,
    parent,
    children: [],
    range: node.range,
    lineRange: node.lineRange,
    depth: node.depth,
  };

  allStatements.push(statement);
  statement.children = node.children.map((child) =>
    toAstStatement(child, uri, statement, allStatements, nextId)
  );

  return statement;
}

export class CstParser {
  private parser: Parser;
  private static globalId = 0;

  static async create(): Promise<CstParser> {
    const lang = await getLanguage();
    return new CstParser(lang);
  }

  private constructor(lang: Language) {
    this.parser = new Parser();
    this.parser.setLanguage(lang);
  }

  public parse(uri: string, text: string, version: number = 1): { doc: AstDocument; tree: Tree } {
    const tree = this.parser.parse(text);
    if (!tree) {
      throw new Error(`Failed to parse ${uri}: parser returned no tree`);
    }

    const { roots: cstRoots, errors: cstErrors } = walkCstTree(tree.rootNode as unknown as CstNode);

    const errors: AstSyntaxError[] = cstErrors;
    const allStatements: AstStatement[] = [];
    const nextId = () => CstParser.globalId++;

    const roots: AstStatement[] = cstRoots.map((node) =>
      toAstStatement(node, uri, undefined, allStatements, nextId)
    );

    const doc: AstDocument = {
      uri,
      version,
      text,
      roots,
      allStatements,
      errors,
    };

    return { doc, tree };
  }
}
