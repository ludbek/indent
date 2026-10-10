import type { Range, Position, SymbolKind } from "vscode-languageserver";

export interface SourceLocation {
  line: number; // 0-based
  character: number; // 0-based
}

export type AstValueType = "string" | "number" | "boolean" | "ref";

export interface AstValue {
  value: string | number | boolean;
  valueRaw: string;
  valueType: AstValueType;
  range: Range;
}

export interface AstAttribute {
  name: string;
  nameRange: Range;
  value: string | number | boolean;
  valueRaw: string;
  valueType: AstValueType;
  valueRange: Range;
  range: Range;
}

export interface AstStatement {
  id: string; // unique internal ID in document
  uri: string;
  kind: string;
  kindRange: Range;
  value?: AstValue;
  isInclude: boolean;
  includePath?: string;
  isSchema: boolean;
  schemaPath?: string;
  attrs: Record<string, AstAttribute>;
  parent?: AstStatement;
  children: AstStatement[];
  range: Range; // whole statement range including block
  lineRange: Range; // just the header statement line
  depth: number;
}

export interface AstDocument {
  uri: string;
  version: number;
  text: string;
  roots: AstStatement[];
  allStatements: AstStatement[];
  errors: AstSyntaxError[];
}

export interface AstSyntaxError {
  message: string;
  range: Range;
  severity: "error" | "warning";
}

export interface IndexedNode {
  id: string;
  uri: string;
  canonicalPath: string; // e.g. "/org/service/api"
  label: string; // positional value, name attribute, or kind
  kind: string;
  value?: AstValue;
  attrs: Record<string, AstAttribute>;
  parentPath?: string;
  childPaths: string[];
  statement: AstStatement;
}

export interface SchemaLink {
  sourceUri: string;
  rawPath: string;
  resolvedFsPath: string;
  resolvedUri?: string;
  range: Range; // range of the !schema statement's value
  exists: boolean;
  isValidSchemaFile: boolean; // target exists, is suffix-classified, and parses as valid schema grammar
}

export interface RefReference {
  uri: string;
  sourceNodeId: string;
  sourceNodePath: string;
  // Absent when the ref is a node's own positional value rather than an
  // attribute (e.g. `alias /org/service`, as opposed to `entity=/org/service`).
  attrName?: string;
  rawRef: string;
  range: Range; // range of the value in source
  resolvedTargetPaths: string[];
}
