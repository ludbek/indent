import { readFileSync } from "node:fs";
import { parse } from "../parser.js";
import { selectNodes } from "../xpath/evaluate.js";
import type { XPathNode } from "../xpath/types.js";
import type { IndentNode, RefValue } from "../types.js";
import {
  AttrSchema,
  AttrType,
  ChildRef,
  KindSchema,
  Schema,
  SchemaDefinitionError,
} from "./types.js";

const ATTR_TYPES: readonly AttrType[] = ["string", "number", "boolean", "ref"];

function isRefValue(value: unknown): value is RefValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RefValue).type === "ref" &&
    typeof (value as RefValue).raw === "string"
  );
}

/**
 * Parses cardinality attrs (`minCount`/`maxCount`) off a `kind` child
 * reference line. Both default when omitted: `minCount` to `0`, `maxCount`
 * to `Infinity` (unbounded).
 */
function parseCardinality(
  node: IndentNode,
): { minCount: number; maxCount: number } {
  let minCount = 0;
  let maxCount = Infinity;

  if ("minCount" in node.attrs) {
    const raw = node.attrs.minCount;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new SchemaDefinitionError(
        `'minCount' must be a non-negative integer, got '${String(raw)}'`,
      );
    }
    minCount = raw;
  }

  if ("maxCount" in node.attrs) {
    const raw = node.attrs.maxCount;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      throw new SchemaDefinitionError(
        `'maxCount' must be a positive integer, got '${String(raw)}'`,
      );
    }
    maxCount = raw;
  }

  if (minCount > maxCount) {
    throw new SchemaDefinitionError(
      `'minCount' (${minCount}) cannot exceed 'maxCount' (${maxCount})`,
    );
  }

  const allowedKeys = new Set(["minCount", "maxCount"]);
  for (const key of Object.keys(node.attrs)) {
    if (!allowedKeys.has(key)) {
      throw new SchemaDefinitionError(
        `unexpected attribute '${key}' on a child 'kind' reference -- only 'minCount'/'maxCount' are allowed`,
      );
    }
  }

  return { minCount, maxCount };
}

function parseAttrDef(node: IndentNode): AttrSchema {
  if (typeof node.value !== "string") {
    throw new SchemaDefinitionError(
      `'attr' requires a quoted string name, e.g. 'attr "name" type="string"'`,
    );
  }

  const rawType = node.attrs.type;
  if (typeof rawType !== "string" || !ATTR_TYPES.includes(rawType as AttrType)) {
    throw new SchemaDefinitionError(
      `attr '${node.value}' requires a 'type=' attribute, one of: ${ATTR_TYPES.join(", ")}`,
    );
  }

  let required = false;
  if ("required" in node.attrs) {
    const rawRequired = node.attrs.required;
    if (typeof rawRequired !== "boolean") {
      throw new SchemaDefinitionError(
        `attr '${node.value}' 'required=' must be a boolean (true/false)`,
      );
    }
    required = rawRequired;
  }

  const allowedKeys = new Set(["type", "required"]);
  for (const key of Object.keys(node.attrs)) {
    if (!allowedKeys.has(key)) {
      throw new SchemaDefinitionError(
        `unexpected attribute '${key}' on attr '${node.value}' -- only 'type'/'required' are allowed`,
      );
    }
  }

  return { name: node.value, type: rawType as AttrType, required };
}

/**
 * Parses a schema definition written in Indent syntax itself. Top-level
 * `kind "name"` lines are canonical kind definitions; their `attr`/`kind`
 * children declare allowed attributes and child kinds respectively.
 *
 * A nested `kind //kind[.="name"] minCount=.. maxCount=..` line is a
 * *reference* to a top-level definition (resolved via `indent-lang`'s xpath module's
 * self-axis predicate against the schema's own tree), not a redefinition --
 * this is what allows self-referential kinds (e.g. `container` nested in
 * `container`) and sharing one kind under multiple parents with different
 * cardinality.
 */
export function parseSchema(source: string): Schema {
  const { roots: schemaRoots } = parse(source);

  const kinds = new Map<string, KindSchema>();
  const defNodes: IndentNode[] = [];

  // Pass 1: collect canonical top-level kind definitions.
  for (const node of schemaRoots) {
    if (node.kind !== "kind") {
      throw new SchemaDefinitionError(
        `schema root statements must be 'kind' definitions, got '${node.kind}'`,
      );
    }
    if (typeof node.value !== "string") {
      throw new SchemaDefinitionError(
        `top-level 'kind' definition requires a quoted string name, e.g. 'kind "name"'`,
      );
    }
    if (kinds.has(node.value)) {
      throw new SchemaDefinitionError(`duplicate top-level kind definition '${node.value}'`);
    }
    kinds.set(node.value, { name: node.value, attrs: new Map(), children: new Map() });
    defNodes.push(node);
  }

  // Pass 2: fill in attrs/children, now that every top-level kind is known
  // (so forward references resolve regardless of declaration order).
  for (const defNode of defNodes) {
    const name = defNode.value as string;
    const kindSchema = kinds.get(name)!;

    for (const child of defNode.children) {
      if (child.kind === "attr") {
        const attrSchema = parseAttrDef(child);
        if (kindSchema.attrs.has(attrSchema.name)) {
          throw new SchemaDefinitionError(
            `duplicate attr '${attrSchema.name}' on kind '${name}'`,
          );
        }
        kindSchema.attrs.set(attrSchema.name, attrSchema);
        continue;
      }

      if (child.kind === "kind") {
        if (!isRefValue(child.value)) {
          throw new SchemaDefinitionError(
            `a nested 'kind' line must reference a declared kind via an xpath self-axis ref, e.g. 'kind //kind[.="name"]', got a plain value instead`,
          );
        }

        // `selectNodes` is generic over `XPathNode`, whose `value` type
        // doesn't include `RefValue` (xpath stays decoupled from Indent's
        // concrete value typing). Schema files only ever self-match against
        // the string-valued top-level `kind "name"` definitions, so this
        // cast is safe here.
        const matches = selectNodes(schemaRoots as unknown as XPathNode[], child.value.raw) as unknown as IndentNode[];
        const defMatches = matches.filter(
          (m) => m.kind === "kind" && typeof m.value === "string",
        );

        if (defMatches.length === 0) {
          throw new SchemaDefinitionError(
            `could not resolve child kind reference '${child.value.raw}' to a declared kind`,
          );
        }
        if (defMatches.length > 1) {
          throw new SchemaDefinitionError(
            `child kind reference '${child.value.raw}' is ambiguous -- it matches ${defMatches.length} declared kinds`,
          );
        }

        const resolvedName = defMatches[0].value as string;
        if (kindSchema.children.has(resolvedName)) {
          throw new SchemaDefinitionError(
            `duplicate child kind reference to '${resolvedName}' on kind '${name}'`,
          );
        }

        const { minCount, maxCount } = parseCardinality(child);
        const childRef: ChildRef = { kind: resolvedName, minCount, maxCount };
        kindSchema.children.set(resolvedName, childRef);
        continue;
      }

      throw new SchemaDefinitionError(
        `expected 'attr' or 'kind' inside a kind definition, got '${child.kind}'`,
      );
    }
  }

  // Every top-level kind definition is implicitly allowed at the document
  // root, with the default (unbounded) cardinality.
  const roots = new Map<string, ChildRef>();
  for (const name of kinds.keys()) {
    roots.set(name, { kind: name, minCount: 0, maxCount: Infinity });
  }

  return { kinds, roots };
}

/** Reads and parses a schema definition file from disk. */
export function parseSchemaFile(path: string): Schema {
  const source = readFileSync(path, "utf8");
  return parseSchema(source);
}
