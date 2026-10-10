import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import type { ChildRef, Schema, ValueSchema } from "indent-lang/schema";
import type { AstDocument, AstStatement, AstValue } from "./types.js";
import type { WorkspaceIndex } from "./indexer.js";

/**
 * Line-anchored port of `indent-lang/src/schema/validate.ts`'s
 * `validateAgainstSchema`. That function operates on `IndentNode`, which
 * carries no line/position info (see the comment on `validateAgainstSchema`),
 * so it can't be reused directly for LSP diagnostics. This mirrors its
 * logic -- unknown element, cardinality min/max, unknown/missing/mistyped
 * attrs/value, and ref-target-kind constraints -- against the language
 * server's own `AstStatement` CST, using `kindRange`/`nameRange`/
 * `valueRange` to produce precise diagnostic ranges.
 *
 * Ref-target-kind checks (`AttrSchema`/`ValueSchema.refElement`) need to
 * know what a ref actually resolves to in the workspace -- that resolution
 * is precomputed once per index rebuild in `WorkspaceIndex` (see
 * `indexer.ts`), so `index` is threaded through here to look it up via
 * `index.refReferences`/`index.getNodeByPath` rather than re-resolving
 * xpath from scratch.
 */
export function validateDocumentAgainstSchema(
  doc: AstDocument,
  schema: Schema,
  index: WorkspaceIndex,
): Diagnostic[] {
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

  /**
   * Looks up the precomputed resolution for a ref carried by `stmt` -- as
   * an attribute (`attrName` set) or as the statement's own positional
   * value (`attrName` undefined) -- and checks every resolved target's
   * `kind` against `refElement`. Pushes a diagnostic (at `range`) if the
   * ref is unresolved or resolves to the wrong kind anywhere.
   */
  function checkRefTargetKind(
    stmt: AstStatement,
    attrName: string | undefined,
    refElement: string,
    range: AstStatement["kindRange"],
    describeWhat: string,
  ) {
    const sourceNode = index.nodesById.get(stmt.id);
    if (!sourceNode) return;

    const ref = index.refReferences.find(
      (r) => r.uri === doc.uri && r.sourceNodePath === sourceNode.canonicalPath && r.attrName === attrName,
    );
    if (!ref) return;

    if (ref.resolvedTargetPaths.length === 0) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range,
        message: `${describeWhat}: ref '${ref.rawRef}' does not resolve to any node in the document`,
        source: "indent-schema",
      });
      return;
    }

    const mismatched = ref.resolvedTargetPaths
      .map((path) => index.getNodeByPath(path)?.kind)
      .filter((kind): kind is string => kind !== undefined && kind !== refElement);
    if (mismatched.length > 0) {
      const uniqueMismatched = [...new Set(mismatched)];
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range,
        message: `${describeWhat}: ref '${ref.rawRef}' must resolve to an element of kind '${refElement}', resolved to '${uniqueMismatched.join("', '")}'`,
        source: "indent-schema",
      });
    }
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
          message: `unknown element '${stmt.kind}' is not allowed ${scopeLabel}`,
          source: "indent-schema",
        });
        continue;
      }

      validateStatement(stmt, childRef.element);
    }

    for (const [elementName, ref] of allowed) {
      const count = counts.get(elementName) ?? 0;
      if (count < ref.minCount) {
        if (fallbackRange) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: fallbackRange,
            message: `element '${elementName}' must appear at least ${pluralCount(ref.minCount)} ${scopeLabel}, found ${count}`,
            source: "indent-schema",
          });
        }
      } else if (count > ref.maxCount) {
        // Flag every occurrence beyond the max so the diagnostic is
        // anchored somewhere visible in the editor.
        const offenders = stmts.filter((s) => s.kind === elementName).slice(ref.maxCount);
        for (const offender of offenders) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: offender.kindRange,
            message: `element '${elementName}' must appear at most ${pluralCount(ref.maxCount)} ${scopeLabel}, found ${count}`,
            source: "indent-schema",
          });
        }
      }
    }
  }

  function validateValue(stmt: AstStatement, elementName: string, valueSchema: ValueSchema | undefined) {
    if (!valueSchema) {
      if (stmt.value) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: stmt.value.range,
          message: `element '${elementName}' does not declare a 'value' schema but has a positional value`,
          source: "indent-schema",
        });
      }
      return;
    }

    if (!stmt.value) {
      if (valueSchema.required) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: stmt.kindRange,
          message: `missing required value on element '${elementName}'`,
          source: "indent-schema",
        });
      }
      return;
    }

    const value: AstValue = stmt.value;
    if (!attrMatchesType(value.value, value.valueType, valueSchema.type)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: value.range,
        message: `value on element '${elementName}' must be of type '${valueSchema.type}', got '${value.valueType}'`,
        source: "indent-schema",
      });
      return;
    }

    if (valueSchema.refElement && value.valueType === "ref") {
      checkRefTargetKind(
        stmt,
        undefined,
        valueSchema.refElement,
        value.range,
        `value on element '${elementName}'`,
      );
    }
  }

  function validateStatement(stmt: AstStatement, elementName: string) {
    const elementSchema = schema.elements.get(elementName);
    if (!elementSchema) return;

    validateValue(stmt, elementName, elementSchema.value);

    const seenAttrs = new Set<string>();
    for (const [attrName, attr] of Object.entries(stmt.attrs)) {
      seenAttrs.add(attrName);
      const attrSchema = elementSchema.attrs.get(attrName);
      if (!attrSchema) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: attr.nameRange,
          message: `unknown attribute '${attrName}' on element '${elementName}'`,
          source: "indent-schema",
        });
        continue;
      }
      if (!attrMatchesType(attr.value, attr.valueType, attrSchema.type)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: attr.valueRange,
          message: `attribute '${attrName}' on element '${elementName}' must be of type '${attrSchema.type}', got '${attr.valueType}'`,
          source: "indent-schema",
        });
        continue;
      }
      if (attrSchema.refElement && attr.valueType === "ref") {
        checkRefTargetKind(
          stmt,
          attrName,
          attrSchema.refElement,
          attr.valueRange,
          `attribute '${attrName}' on element '${elementName}'`,
        );
      }
    }
    for (const [attrName, attrSchema] of elementSchema.attrs) {
      if (attrSchema.required && !seenAttrs.has(attrName)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: stmt.kindRange,
          message: `missing required attribute '${attrName}' on element '${elementName}'`,
          source: "indent-schema",
        });
      }
    }

    validateSiblings(stmt.children, elementSchema.children, `under element '${elementName}'`, stmt.kindRange);
  }

  // The `!schema` directive itself is a root-level statement but is not
  // part of the document's content model -- it must not be validated
  // against the schema's declared root elements.
  const contentRoots = doc.roots.filter((s) => !s.isSchema);
  validateSiblings(contentRoots, schema.roots, "at the document root", contentRoots[0]?.kindRange);

  return diagnostics;
}
