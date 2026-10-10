import { Parser, Language, Node, Tree } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { Range, Position } from "vscode-languageserver";
import type {
  AstAttribute,
  AstDocument,
  AstStatement,
  AstSyntaxError,
  AstValue,
  AstValueType,
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
    const errors: AstSyntaxError[] = [];
    const allStatements: AstStatement[] = [];

    const tsPointToPosition = (p: { row: number; column: number }): Position => ({
      line: p.row,
      character: p.column,
    });

    const tsNodeToRange = (n: Node): Range => ({
      start: tsPointToPosition(n.startPosition),
      end: tsPointToPosition(n.endPosition),
    });

    const collectErrors = (node: Node) => {
      const isMissing = typeof (node as any).isMissing === "function" ? (node as any).isMissing() : Boolean((node as any).isMissing);
      if (isMissing) {
        errors.push({
          message: `Syntax error: missing expected element at line ${node.startPosition.row + 1}`,
          range: tsNodeToRange(node),
          severity: "error",
        });
      } else if (node.type === "ERROR") {
        errors.push({
          message: `Syntax error near '${node.text.slice(0, 30)}' at line ${node.startPosition.row + 1}`,
          range: tsNodeToRange(node),
          severity: "error",
        });
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) collectErrors(child);
      }
    };

    collectErrors(tree.rootNode);

    const parseStatement = (
      node: Node,
      parent?: AstStatement,
      depth: number = 0
    ): AstStatement | null => {
      if (node.type !== "statement") return null;

      const typeNode = node.childForFieldName("type") ?? node.children.find((c) => c.type === "type");
      const kind = typeNode ? typeNode.text : "";
      const kindRange = typeNode ? tsNodeToRange(typeNode) : tsNodeToRange(node);

      const isInclude = kind === "!include";
      const isSchema = kind === "!schema";

      // Parse optional positional value immediately after type
      const posValNode =
        node.childForFieldName("value") ??
        node.children.find((c) => c.type === "positional_value");

      let stmtValue: AstValue | undefined;
      if (posValNode) {
        const inner = posValNode.firstNamedChild ?? posValNode;
        const text = inner.text;
        const valueRange = tsNodeToRange(inner);
        let valType: AstValueType = "string";
        let parsedVal: string | number | boolean = text;

        if (inner.type === "string") {
          valType = "string";
          parsedVal = text.startsWith('"') && text.endsWith('"') && text.length >= 2
            ? text.slice(1, -1).replace(/\\"/g, '"')
            : text;
        } else if (inner.type === "number") {
          valType = "number";
          parsedVal = Number(text);
        } else if (inner.type === "boolean") {
          valType = "boolean";
          parsedVal = text === "true";
        } else if (inner.type === "xpath") {
          valType = "ref";
          parsedVal = text;
        }

        stmtValue = {
          value: parsedVal,
          valueRaw: text,
          valueType: valType,
          range: valueRange,
        };
      }

      const attrs: Record<string, AstAttribute> = {};
      const attrNodes = node.children.filter((c) => c.type === "attribute");

      for (const attrNode of attrNodes) {
        const nameNode =
          attrNode.childForFieldName("name") ??
          attrNode.children.find((c) => c.type === "attribute_name");
        const valNode =
          attrNode.childForFieldName("value") ??
          attrNode.children.find((c) => c.type === "value");

        if (!nameNode) continue;
        const attrName = nameNode.text;
        const nameRange = tsNodeToRange(nameNode);

        let valueRaw = "";
        let valType: AstValueType = "string";
        let parsedVal: string | number | boolean = "";
        let valueRange: Range = valNode ? tsNodeToRange(valNode) : nameRange;

        if (valNode) {
          const inner = valNode.firstNamedChild ?? valNode;
          const text = inner.text;
          valueRaw = text;
          valueRange = tsNodeToRange(inner);

          if (inner.type === "string") {
            valType = "string";
            // Strip leading/trailing quotes and unescape
            const unquoted = text.startsWith('"') && text.endsWith('"') && text.length >= 2
              ? text.slice(1, -1).replace(/\\"/g, '"')
              : text;
            parsedVal = unquoted;
          } else if (inner.type === "number") {
            valType = "number";
            parsedVal = Number(text);
          } else if (inner.type === "boolean") {
            valType = "boolean";
            parsedVal = text === "true";
          } else if (inner.type === "xpath") {
            valType = "ref";
            parsedVal = text;
          } else {
            valType = "string";
            parsedVal = text;
          }
        }

        attrs[attrName] = {
          name: attrName,
          nameRange,
          value: parsedVal,
          valueRaw,
          valueType: valType,
          valueRange,
          range: tsNodeToRange(attrNode),
        };
      }

      // Compute line range (just the header line before any child block)
      const blockNode = node.children.find((c) => c.type === "block");
      let lineEndPosition = node.endPosition;
      if (blockNode) {
        // Line ends right before block starts
        lineEndPosition = {
          row: blockNode.startPosition.row - 1 >= node.startPosition.row ? blockNode.startPosition.row - 1 : node.startPosition.row,
          column: 1000,
        };
      }
      const lineRange: Range = {
        start: tsPointToPosition(node.startPosition),
        end: blockNode ? { line: node.startPosition.row, character: 1000 } : tsPointToPosition(node.endPosition),
      };

      const statement: AstStatement = {
        id: `${uri}#stmt-${CstParser.globalId++}`,
        uri,
        kind,
        kindRange,
        value: stmtValue,
        isInclude,
        includePath: isInclude && stmtValue && stmtValue.valueType === "string"
          ? (stmtValue.value as string)
          : undefined,
        isSchema,
        schemaPath: isSchema && stmtValue && stmtValue.valueType === "string"
          ? (stmtValue.value as string)
          : undefined,
        attrs,
        parent,
        children: [],
        range: tsNodeToRange(node),
        lineRange,
        depth,
      };

      allStatements.push(statement);

      if (blockNode) {
        for (let i = 0; i < blockNode.childCount; i++) {
          const childNode = blockNode.child(i);
          if (childNode && childNode.type === "statement") {
            const childStmt = parseStatement(childNode, statement, depth + 1);
            if (childStmt) {
              statement.children.push(childStmt);
            }
          }
        }
      }

      return statement;
    };

    const roots: AstStatement[] = [];
    for (let i = 0; i < tree.rootNode.childCount; i++) {
      const child = tree.rootNode.child(i);
      if (child && child.type === "statement") {
        const stmt = parseStatement(child, undefined, 0);
        if (stmt) {
          roots.push(stmt);
        }
      }
    }

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
