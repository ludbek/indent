import type { AttrValue, IndentNode, RefValue } from "../types.js";
import type { ChildRef, Schema, SchemaDiagnostic } from "./types.js";

function isRefValue(value: unknown): value is RefValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RefValue).type === "ref" &&
    typeof (value as RefValue).raw === "string"
  );
}

function attrMatchesType(value: AttrValue, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "ref":
      return isRefValue(value);
    default:
      return false;
  }
}

function pluralCount(n: number): string {
  return n === 1 ? "1 time" : `${n} times`;
}

/**
 * Validates a parsed tree against a `Schema`, returning every violation as a
 * `SchemaDiagnostic`. Does not throw -- callers decide how to surface
 * errors/warnings (e.g. CLI exit code, LSP diagnostics).
 *
 * Because `IndentNode` carries no line/position information (dropped by
 * `buildTree`), diagnostics are structural/kind-identified rather than
 * line-anchored. Line-anchored diagnostics are a follow-up that would
 * validate against the language server's CST instead.
 */
export function validateAgainstSchema(roots: IndentNode[], schema: Schema): SchemaDiagnostic[] {
  const diagnostics: SchemaDiagnostic[] = [];

  function validateSiblings(nodes: IndentNode[], allowed: Map<string, ChildRef>, scopeLabel: string) {
    // Count occurrences per kind among these siblings.
    const counts = new Map<string, number>();
    for (const node of nodes) {
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);

      const childRef = allowed.get(node.kind);
      if (!childRef) {
        diagnostics.push({
          severity: "error",
          message: `unknown kind '${node.kind}' is not allowed ${scopeLabel}`,
          kind: node.kind,
        });
        continue;
      }

      validateNode(node, childRef.kind);
    }

    // Cardinality: check every declared child kind's count against min/max,
    // including kinds with zero occurrences (to catch missing required
    // children).
    for (const [kindName, ref] of allowed) {
      const count = counts.get(kindName) ?? 0;
      if (count < ref.minCount) {
        diagnostics.push({
          severity: "error",
          message: `kind '${kindName}' must appear at least ${pluralCount(ref.minCount)} ${scopeLabel}, found ${count}`,
          kind: kindName,
        });
      } else if (count > ref.maxCount) {
        diagnostics.push({
          severity: "error",
          message: `kind '${kindName}' must appear at most ${pluralCount(ref.maxCount)} ${scopeLabel}, found ${count}`,
          kind: kindName,
        });
      }
    }
  }

  function validateNode(node: IndentNode, kindName: string) {
    const kindSchema = schema.kinds.get(kindName);
    if (!kindSchema) {
      // Should not happen -- `allowed` is only ever populated from
      // `schema.kinds`/`schema.roots`, both of which only reference known
      // kinds. Defensive guard only.
      return;
    }

    // Attrs: unknown, missing required, mistyped.
    const seenAttrs = new Set<string>();
    for (const [attrName, attrValue] of Object.entries(node.attrs)) {
      seenAttrs.add(attrName);
      const attrSchema = kindSchema.attrs.get(attrName);
      if (!attrSchema) {
        diagnostics.push({
          severity: "error",
          message: `unknown attribute '${attrName}' on kind '${kindName}'`,
          kind: kindName,
        });
        continue;
      }
      if (!attrMatchesType(attrValue, attrSchema.type)) {
        diagnostics.push({
          severity: "error",
          message: `attribute '${attrName}' on kind '${kindName}' must be of type '${attrSchema.type}', got '${typeof attrValue}'`,
          kind: kindName,
        });
      }
    }
    for (const [attrName, attrSchema] of kindSchema.attrs) {
      if (attrSchema.required && !seenAttrs.has(attrName)) {
        diagnostics.push({
          severity: "error",
          message: `missing required attribute '${attrName}' on kind '${kindName}'`,
          kind: kindName,
        });
      }
    }

    // Recurse into children, scoped to this kind's declared child kinds.
    validateSiblings(node.children, kindSchema.children, `under kind '${kindName}'`);
  }

  validateSiblings(roots, schema.roots, "at the document root");

  return diagnostics;
}
