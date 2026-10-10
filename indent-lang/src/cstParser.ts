import Parser from "tree-sitter";
import IndentGrammar from "treesitter-indent";
import type { AttrValue, IndentNode, RefValue } from "./types.js";

/**
 * Minimal structural subset of the tree-sitter `Node` API that this module
 * depends on. Both `tree-sitter` (native, used here) and `web-tree-sitter`
 * (WASM, used by indent-language-server) implement this same shape, so this
 * file's tree-walking logic is shared/ported directly from
 * `indent-language-server/src/cst.ts` and works unmodified against either
 * binding.
 */
export interface CstNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  children: CstNode[];
  firstNamedChild: CstNode | null;
  child(index: number): CstNode | null;
  childForFieldName(name: string): CstNode | null;
  isMissing?: boolean | (() => boolean);
}

export interface CstPosition {
  line: number;
  character: number;
}

export interface CstRange {
  start: CstPosition;
  end: CstPosition;
}

export interface CstSyntaxError {
  message: string;
  range: CstRange;
  severity: "error";
}

export type CstValueType = "string" | "number" | "boolean" | "ref";

export interface CstValue {
  value: string | number | boolean;
  valueRaw: string;
  valueType: CstValueType;
  range: CstRange;
}

export interface CstAttribute {
  name: string;
  nameRange: CstRange;
  value: string | number | boolean;
  valueRaw: string;
  valueType: CstValueType;
  valueRange: CstRange;
  range: CstRange;
}

/**
 * A single node in the CST-backed Indent tree -- a superset of `IndentNode`
 * that additionally carries source ranges and a parent back-pointer. See
 * `toIndentNode()` to project this down to the plain legacy `IndentNode`
 * shape for the existing public API / xpath / schema modules.
 */
export interface CstIndentNode {
  kind: string;
  kindRange: CstRange;
  value?: string | number | boolean | RefValue;
  /**
   * The statement's own positional value, retaining its full ranged shape
   * (value/valueRaw/valueType/range) -- unlike `value` above, which is
   * projected down to the plain legacy-compatible shape (ref values
   * collapsed to `RefValue`, losing their range). Consumers that need
   * position info for the positional value itself (e.g.
   * `indent-language-server`'s `AstStatement.value`) should read this field
   * instead of `value`.
   */
  rawValue?: CstValue;
  isInclude: boolean;
  includePath?: string;
  isSchema: boolean;
  schemaPath?: string;
  attrs: Record<string, CstAttribute>;
  parent?: CstIndentNode;
  children: CstIndentNode[];
  range: CstRange;
  lineRange: CstRange;
  depth: number;
}

export interface CstParseResult {
  roots: CstIndentNode[];
  errors: CstSyntaxError[];
}

function tsPointToPosition(p: { row: number; column: number }): CstPosition {
  return { line: p.row, character: p.column };
}

function tsNodeToRange(n: CstNode): CstRange {
  return { start: tsPointToPosition(n.startPosition), end: tsPointToPosition(n.endPosition) };
}

function collectErrors(node: CstNode, errors: CstSyntaxError[]): void {
  const isMissing = typeof node.isMissing === "function" ? node.isMissing() : Boolean(node.isMissing);
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
    if (child) collectErrors(child, errors);
  }
}

function parseLeafValue(inner: CstNode): { valueType: CstValueType; value: string | number | boolean } {
  const text = inner.text;
  if (inner.type === "string") {
    const value =
      text.startsWith('"') && text.endsWith('"') && text.length >= 2
        ? text.slice(1, -1).replace(/\\"/g, '"')
        : text;
    return { valueType: "string", value };
  }
  if (inner.type === "number") {
    return { valueType: "number", value: Number(text) };
  }
  if (inner.type === "boolean") {
    return { valueType: "boolean", value: text === "true" };
  }
  if (inner.type === "xpath") {
    return { valueType: "ref", value: text };
  }
  return { valueType: "string", value: text };
}

function parseStatement(node: CstNode, parent: CstIndentNode | undefined, depth: number): CstIndentNode | null {
  if (node.type !== "statement") return null;

  const typeNode = node.childForFieldName("type") ?? node.children.find((c) => c.type === "type") ?? null;
  const kind = typeNode ? typeNode.text : "";
  const kindRange = typeNode ? tsNodeToRange(typeNode) : tsNodeToRange(node);

  const isInclude = kind === "!include";
  const isSchema = kind === "!schema";

  const posValNode =
    node.childForFieldName("value") ?? node.children.find((c) => c.type === "positional_value") ?? null;

  let stmtValue: CstValue | undefined;
  if (posValNode) {
    const inner = posValNode.firstNamedChild ?? posValNode;
    const { valueType, value } = parseLeafValue(inner);
    stmtValue = { value, valueRaw: inner.text, valueType, range: tsNodeToRange(inner) };
  }

  const attrs: Record<string, CstAttribute> = {};
  const attrNodes = node.children.filter((c) => c.type === "attribute");

  for (const attrNode of attrNodes) {
    const nameNode =
      attrNode.childForFieldName("name") ?? attrNode.children.find((c) => c.type === "attribute_name") ?? null;
    const valNode = attrNode.childForFieldName("value") ?? attrNode.children.find((c) => c.type === "value") ?? null;

    if (!nameNode) continue;
    const attrName = nameNode.text;
    const nameRange = tsNodeToRange(nameNode);

    let valueRaw = "";
    let valueType: CstValueType = "string";
    let value: string | number | boolean = "";
    let valueRange: CstRange = valNode ? tsNodeToRange(valNode) : nameRange;

    if (valNode) {
      const inner = valNode.firstNamedChild ?? valNode;
      valueRaw = inner.text;
      valueRange = tsNodeToRange(inner);
      const parsed = parseLeafValue(inner);
      valueType = parsed.valueType;
      value = parsed.value;
    }

    attrs[attrName] = {
      name: attrName,
      nameRange,
      value,
      valueRaw,
      valueType,
      valueRange,
      range: tsNodeToRange(attrNode),
    };
  }

  const blockNode = node.children.find((c) => c.type === "block") ?? null;
  const lineRange: CstRange = {
    start: tsPointToPosition(node.startPosition),
    end: blockNode ? { line: node.startPosition.row, character: 1000 } : tsPointToPosition(node.endPosition),
  };

  const statement: CstIndentNode = {
    kind,
    kindRange,
    value: stmtValue ? (stmtValue.valueType === "ref" ? { type: "ref", raw: stmtValue.valueRaw } : stmtValue.value) : undefined,
    rawValue: stmtValue,
    isInclude,
    includePath: isInclude && stmtValue && stmtValue.valueType === "string" ? (stmtValue.value as string) : undefined,
    isSchema,
    schemaPath: isSchema && stmtValue && stmtValue.valueType === "string" ? (stmtValue.value as string) : undefined,
    attrs,
    parent,
    children: [],
    range: tsNodeToRange(node),
    lineRange,
    depth,
  };

  if (blockNode) {
    for (let i = 0; i < blockNode.childCount; i++) {
      const childNode = blockNode.child(i);
      if (childNode && childNode.type === "statement") {
        const childStmt = parseStatement(childNode, statement, depth + 1);
        if (childStmt) statement.children.push(childStmt);
      }
    }
  }

  return statement;
}

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(IndentGrammar as unknown as Parser.Language);
  }
  return parser;
}

/**
 * Walks an already-parsed tree-sitter root node into a `CstIndentNode`
 * tree. Generic over the `CstNode` shape, so it works unmodified against a
 * root node produced by either the native `tree-sitter` binding (see
 * `parseCst` below) or `web-tree-sitter` (WASM) -- callers that already
 * manage their own `Parser`/`Tree` instance (e.g. `indent-language-server`,
 * which needs to retain the `Tree` for incremental re-parse via
 * `tree.edit()`) should call this directly with `tree.rootNode` rather than
 * going through `parseCst`.
 */
export function walkCstTree(rootNode: CstNode): CstParseResult {
  const errors: CstSyntaxError[] = [];
  collectErrors(rootNode, errors);

  const roots: CstIndentNode[] = [];
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child && child.type === "statement") {
      const stmt = parseStatement(child, undefined, 0);
      if (stmt) roots.push(stmt);
    }
  }

  return { roots, errors };
}

/**
 * Parses Indent source text into a `CstIndentNode` tree using the shared
 * tree-sitter grammar (`treesitter-indent`), via the native Node binding.
 *
 * This is the single source of truth for parsing: `indent-lang`'s legacy
 * `parse()`/`buildTree()` API (see `parser.ts`) is a thin wrapper around
 * this function that projects the result down to the plain `IndentNode`
 * shape via `toIndentNode()`. `indent-language-server` calls `walkCstTree`
 * directly against `web-tree-sitter` instead, for incremental re-parse
 * support.
 */
export function parseCst(source: string): CstParseResult {
  const tree = getParser().parse(source);
  return walkCstTree(tree.rootNode as unknown as CstNode);
}

/** Projects a `CstIndentNode`'s `attrs` map down to the plain legacy `AttrValue` shape. */
export function cstAttrsToPlain(attrs: Record<string, CstAttribute>): Record<string, AttrValue> {
  const result: Record<string, AttrValue> = {};
  for (const [name, attr] of Object.entries(attrs)) {
    result[name] = attr.valueType === "ref" ? { type: "ref", raw: attr.valueRaw } : attr.value;
  }
  return result;
}

/** Projects a `CstIndentNode` down to the plain legacy `IndentNode` shape. */
export function toIndentNode(node: CstIndentNode): IndentNode {
  return {
    kind: node.kind,
    ...(node.value !== undefined ? { value: node.value } : {}),
    attrs: cstAttrsToPlain(node.attrs),
    children: node.children.map(toIndentNode),
  };
}
