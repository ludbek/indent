import type { AttrValue, IndentNode, RefValue } from "../types.js";
import { selectNodes } from "../xpath/evaluate.js";
import type { XPathNode } from "../xpath/types.js";
import type { ChildRef, Schema, SchemaDiagnostic, ValueSchema } from "./types.js";

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
 * Resolves a ref's raw xpath text against the full document tree, returning
 * every matched node. An invalid/unparsable xpath expression (shouldn't
 * normally occur -- the tokenizer already requires refs to look like a valid
 * leading `/`/`//` path -- but defensively guarded) resolves to no matches,
 * same as a ref that legitimately matches nothing.
 */
function resolveRefTargets(roots: IndentNode[], raw: string): IndentNode[] {
  try {
    return selectNodes(roots as unknown as XPathNode[], raw) as unknown as IndentNode[];
  } catch {
    return [];
  }
}

/**
 * Validates a ref-typed value's target constraint (`AttrSchema`/
 * `ValueSchema.refElement`): the ref is resolved against the full document
 * tree and every matched node must have been validated against one of the
 * declared elements (compared by scoped id, so a `service` under `org` is
 * distinct from a `service` under `team`). `nodeSchemaIds` maps each
 * document node to the scoped id it was validated against; nodes absent
 * from it (e.g. unknown elements) never satisfy a constraint. Returns an
 * error message describing the violation, or `undefined` if satisfied.
 */
function checkRefTargetKind(
  roots: IndentNode[],
  nodeSchemaIds: Map<IndentNode, string>,
  raw: string,
  refElement: string[],
): string | undefined {
  const targets = resolveRefTargets(roots, raw);
  if (targets.length === 0) {
    return `ref '${raw}' does not resolve to any node in the document`;
  }
  const mismatched = targets
    .map((t) => ({ kind: t.kind, id: nodeSchemaIds.get(t) }))
    .filter((t) => t.id === undefined || !refElement.includes(t.id));
  if (mismatched.length > 0) {
    const uniqueMismatched = [...new Set(mismatched.map((t) => t.id ?? t.kind))];
    const expected =
      refElement.length > 1
        ? `one of kind '${refElement.join("', '")}'`
        : `an element of kind '${refElement[0]}'`;
    return `ref '${raw}' must resolve to ${expected}, resolved to '${uniqueMismatched.join("', '")}'`;
  }
  return undefined;
}

/**
 * Validates a parsed tree against a `Schema`, returning every violation as a
 * `SchemaDiagnostic`. Does not throw -- callers decide how to surface
 * errors/warnings (e.g. CLI exit code, LSP diagnostics).
 *
 * Because `IndentNode` carries no line/position information (dropped by
 * `buildTree`), diagnostics are structural/element-identified rather than
 * line-anchored. Line-anchored diagnostics are a follow-up that would
 * validate against the language server's CST instead.
 */
export function validateAgainstSchema(roots: IndentNode[], schema: Schema): SchemaDiagnostic[] {
  const diagnostics: SchemaDiagnostic[] = [];

  // Document node -> scoped id of the schema element it was validated
  // against. Ref-target constraints are checked after the whole tree has
  // been walked (see `deferredRefChecks`), so forward refs resolve too.
  const nodeSchemaIds = new Map<IndentNode, string>();
  const deferredRefChecks: Array<() => void> = [];

  function validateSiblings(nodes: IndentNode[], allowed: Map<string, ChildRef>, scopeLabel: string) {
    // Count occurrences per element among these siblings.
    const counts = new Map<string, number>();
    for (const node of nodes) {
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);

      const childRef = allowed.get(node.kind);
      if (!childRef) {
        diagnostics.push({
          severity: "error",
          message: `unknown element '${node.kind}' is not allowed ${scopeLabel}`,
          element: node.kind,
        });
        continue;
      }

      validateNode(node, childRef.element);
    }

    // Cardinality: check every declared child element's count against
    // min/max, including elements with zero occurrences (to catch missing
    // required children).
    for (const [elementName, ref] of allowed) {
      const count = counts.get(elementName) ?? 0;
      if (count < ref.minCount) {
        diagnostics.push({
          severity: "error",
          message: `element '${elementName}' must appear at least ${pluralCount(ref.minCount)} ${scopeLabel}, found ${count}`,
          element: elementName,
        });
      } else if (count > ref.maxCount) {
        diagnostics.push({
          severity: "error",
          message: `element '${elementName}' must appear at most ${pluralCount(ref.maxCount)} ${scopeLabel}, found ${count}`,
          element: elementName,
        });
      }
    }
  }

  function validateValue(node: IndentNode, elementName: string, valueSchema: ValueSchema | undefined) {
    if (!valueSchema) {
      if (node.value !== undefined) {
        diagnostics.push({
          severity: "error",
          message: `element '${elementName}' does not declare a 'value' schema but has a positional value`,
          element: elementName,
        });
      }
      return;
    }

    if (node.value === undefined) {
      if (valueSchema.required) {
        diagnostics.push({
          severity: "error",
          message: `missing required value on element '${elementName}'`,
          element: elementName,
        });
      }
      return;
    }

    if (!attrMatchesType(node.value, valueSchema.type)) {
      diagnostics.push({
        severity: "error",
        message: `value on element '${elementName}' must be of type '${valueSchema.type}', got '${typeof node.value}'`,
        element: elementName,
      });
      return;
    }

    if (valueSchema.refElement && isRefValue(node.value)) {
      const { raw } = node.value;
      const refElement = valueSchema.refElement;
      deferredRefChecks.push(() => {
        const violation = checkRefTargetKind(roots, nodeSchemaIds, raw, refElement);
        if (violation) {
          diagnostics.push({
            severity: "error",
            message: `value on element '${elementName}': ${violation}`,
            element: elementName,
          });
        }
      });
    }
  }

  function validateNode(node: IndentNode, elementName: string) {
    const elementSchema = schema.elements.get(elementName);
    if (!elementSchema) {
      // Should not happen -- `allowed` is only ever populated from
      // `schema.elements`/`schema.roots`, both of which only reference
      // known elements. Defensive guard only.
      return;
    }

    nodeSchemaIds.set(node, elementName);
    validateValue(node, elementName, elementSchema.value);

    // Attrs: unknown, missing required, mistyped, and ref-target-kind
    // mismatches.
    const seenAttrs = new Set<string>();
    for (const [attrName, attrValue] of Object.entries(node.attrs)) {
      seenAttrs.add(attrName);
      const attrSchema = elementSchema.attrs.get(attrName);
      if (!attrSchema) {
        diagnostics.push({
          severity: "error",
          message: `unknown attribute '${attrName}' on element '${elementName}'`,
          element: elementName,
        });
        continue;
      }
      if (!attrMatchesType(attrValue, attrSchema.type)) {
        diagnostics.push({
          severity: "error",
          message: `attribute '${attrName}' on element '${elementName}' must be of type '${attrSchema.type}', got '${typeof attrValue}'`,
          element: elementName,
        });
        continue;
      }
      if (attrSchema.refElement && isRefValue(attrValue)) {
        const { raw } = attrValue;
        const refElement = attrSchema.refElement;
        deferredRefChecks.push(() => {
          const violation = checkRefTargetKind(roots, nodeSchemaIds, raw, refElement);
          if (violation) {
            diagnostics.push({
              severity: "error",
              message: `attribute '${attrName}' on element '${elementName}': ${violation}`,
              element: elementName,
            });
          }
        });
      }
    }
    for (const [attrName, attrSchema] of elementSchema.attrs) {
      if (attrSchema.required && !seenAttrs.has(attrName)) {
        diagnostics.push({
          severity: "error",
          message: `missing required attribute '${attrName}' on element '${elementName}'`,
          element: elementName,
        });
      }
    }

    // Recurse into children, scoped to this element's declared child elements.
    validateSiblings(node.children, elementSchema.children, `under element '${elementName}'`);
  }

  validateSiblings(roots, schema.roots, "at the document root");
  for (const check of deferredRefChecks) check();

  return diagnostics;
}
