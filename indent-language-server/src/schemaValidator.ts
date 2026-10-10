import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import type { ChildRef, Schema } from "indent-lang/schema";
import type { AstDocument, AstStatement } from "./types.js";

/**
 * Line-anchored port of `indent-lang/src/schema/validate.ts`'s
 * `validateAgainstSchema`. That function operates on `IndentNode`, which
 * carries no line/position info (see the comment on `validateAgainstSchema`),
 * so it can't be reused directly for LSP diagnostics. This mirrors its
 * logic -- unknown kind, cardinality min/max, unknown/missing/mistyped
 * attrs -- against the language server's own `AstStatement` CST, using
 * `kindRange`/`nameRange`/`valueRange` to produce precise diagnostic ranges.
 */
export function validateDocumentAgainstSchema(doc: AstDocument, schema: Schema): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function attrMatchesType(value: string | number | boolean, valueType: string, type: string): boolean {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "ref":
        return valueType === "ref";
      default:
        return false;
    }
  }

  function pluralCount(n: number): string {
    return n === 1 ? "1 time" : `${n} times`;
  }

  function validateSiblings(
    stmts: AstStatement[],
    allowed: Map<string, ChildRef>,
    scopeLabel: string,
    fallbackRange: AstStatement["kindRange"] | undefined,
  ) {
    const counts = new Map<string, number>();
    for (const stmt of stmts) {
      counts.set(stmt.kind, (counts.get(stmt.kind) ?? 0) + 1);

      const childRef = allowed.get(stmt.kind);
      if (!childRef) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: stmt.kindRange,
          message: `unknown kind '${stmt.kind}' is not allowed ${scopeLabel}`,
          source: "indent-schema",
        });
        continue;
      }

      validateStatement(stmt, childRef.kind);
    }

    for (const [kindName, ref] of allowed) {
      const count = counts.get(kindName) ?? 0;
      if (count < ref.minCount) {
        if (fallbackRange) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: fallbackRange,
            message: `kind '${kindName}' must appear at least ${pluralCount(ref.minCount)} ${scopeLabel}, found ${count}`,
            source: "indent-schema",
          });
        }
      } else if (count > ref.maxCount) {
        // Flag every occurrence beyond the max so the diagnostic is
        // anchored somewhere visible in the editor.
        const offenders = stmts.filter((s) => s.kind === kindName).slice(ref.maxCount);
        for (const offender of offenders) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: offender.kindRange,
            message: `kind '${kindName}' must appear at most ${pluralCount(ref.maxCount)} ${scopeLabel}, found ${count}`,
            source: "indent-schema",
          });
        }
      }
    }
  }

  function validateStatement(stmt: AstStatement, kindName: string) {
    const kindSchema = schema.kinds.get(kindName);
    if (!kindSchema) return;

    const seenAttrs = new Set<string>();
    for (const [attrName, attr] of Object.entries(stmt.attrs)) {
      seenAttrs.add(attrName);
      const attrSchema = kindSchema.attrs.get(attrName);
      if (!attrSchema) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: attr.nameRange,
          message: `unknown attribute '${attrName}' on kind '${kindName}'`,
          source: "indent-schema",
        });
        continue;
      }
      if (!attrMatchesType(attr.value, attr.valueType, attrSchema.type)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: attr.valueRange,
          message: `attribute '${attrName}' on kind '${kindName}' must be of type '${attrSchema.type}', got '${attr.valueType}'`,
          source: "indent-schema",
        });
      }
    }
    for (const [attrName, attrSchema] of kindSchema.attrs) {
      if (attrSchema.required && !seenAttrs.has(attrName)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: stmt.kindRange,
          message: `missing required attribute '${attrName}' on kind '${kindName}'`,
          source: "indent-schema",
        });
      }
    }

    validateSiblings(stmt.children, kindSchema.children, `under kind '${kindName}'`, stmt.kindRange);
  }

  // The `!schema` directive itself is a root-level statement but is not
  // part of the document's content model -- it must not be validated
  // against the schema's declared root kinds.
  const contentRoots = doc.roots.filter((s) => !s.isSchema);
  validateSiblings(contentRoots, schema.roots, "at the document root", contentRoots[0]?.kindRange);

  return diagnostics;
}
