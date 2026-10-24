import type { Schema } from "indent-lang/schema";
import type { Position } from "vscode-languageserver";
import type { AstDocument, AstStatement } from "./types.js";

/**
 * Resolves the scoped schema element id (see `ElementSchema.id` in
 * `indent-lang/schema`) a document statement is declared by, by walking its
 * ancestor chain from the document root: the root statement's kind is
 * looked up in `schema.roots`, then each descendant's kind in the previous
 * element's `children` (keyed by local name).
 *
 * Because element names are only unique per parent, a bare `stmt.kind` does
 * not identify a schema element -- any lookup of a statement's attrs,
 * children, or value schema must go through this. Returns `undefined` when
 * the statement (or any ancestor) isn't permitted by the schema.
 */
export function schemaIdForStatement(schema: Schema, stmt: AstStatement): string | undefined {
  const chain: AstStatement[] = [];
  for (let cur: AstStatement | undefined = stmt; cur; cur = cur.parent) {
    chain.unshift(cur);
  }

  let id: string | undefined;
  for (let i = 0; i < chain.length; i++) {
    const kind = chain[i].kind;
    if (i === 0) {
      id = schema.roots.get(kind)?.element;
    } else if (id !== undefined) {
      id = schema.elements.get(id)?.children.get(kind)?.element;
    }
    if (id === undefined) return undefined;
  }
  return id;
}

/**
 * Finds the nearest preceding statement at `currentDepth - 1` (the
 * enclosing parent of whatever is being typed at `currentDepth`), by
 * scanning statements that start before `position`. Returns `undefined` at
 * the document root (`currentDepth <= 0`).
 */
export function findEnclosingStatement(
  doc: AstDocument,
  position: Position,
  currentDepth: number,
): AstStatement | undefined {
  if (currentDepth <= 0) return undefined;
  const parentDepth = currentDepth - 1;
  let best: AstStatement | undefined;
  for (const stmt of doc.allStatements) {
    if (stmt.depth !== parentDepth) continue;
    if (stmt.range.start.line >= position.line) continue;
    if (!best || stmt.range.start.line > best.range.start.line) best = stmt;
  }
  return best;
}

/**
 * Resolves the scoped schema element id for a statement *being typed* at
 * `position` (so it may not exist in the CST yet, or be unparsable): `kind`
 * is looked up under the enclosing statement's schema element, or among
 * the schema roots at depth 0.
 */
export function schemaIdForTypedKind(
  schema: Schema,
  doc: AstDocument,
  position: Position,
  depth: number,
  kind: string,
): string | undefined {
  if (depth <= 0) return schema.roots.get(kind)?.element;
  const parent = findEnclosingStatement(doc, position, depth);
  if (!parent) return undefined;
  const parentId = schemaIdForStatement(schema, parent);
  return parentId === undefined ? undefined : schema.elements.get(parentId)?.children.get(kind)?.element;
}
