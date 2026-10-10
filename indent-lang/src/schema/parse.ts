import { readFileSync } from "node:fs";
import { parse } from "../parser.js";
import { selectNodes } from "../xpath/evaluate.js";
import type { XPathNode } from "../xpath/types.js";
import type { IndentNode, RefValue } from "../types.js";
import {
  AttrSchema,
  AttrType,
  ChildRef,
  ElementSchema,
  Schema,
  SchemaDefinitionError,
  ValueSchema,
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
 * Resolves an xpath self-axis ref (e.g. `//element[.="team"]`) against the
 * schema's own root nodes to the single declared element name it points
 * at. Shared by child-element references, and by `attr`/`value` `type=`
 * ref-constraints -- all three use the exact same resolution semantics:
 * match string-valued `element` definition nodes, require exactly one.
 */
function resolveElementRef(
  schemaRoots: IndentNode[],
  raw: string,
  describeWhat: string,
): string {
  // `selectNodes` is generic over `XPathNode`, whose `value` type doesn't
  // include `RefValue` (xpath stays decoupled from Indent's concrete value
  // typing). Schema files only ever self-match against string-valued
  // `element "name"` definitions, so this cast is safe here.
  let matches: IndentNode[];
  try {
    matches = selectNodes(schemaRoots as unknown as XPathNode[], raw) as unknown as IndentNode[];
  } catch {
    // An unparsable xpath (e.g. a typo'd `type=//*`) is reported the same
    // way as a syntactically valid ref that resolves to nothing -- this
    // package has no line/position info to anchor a more specific error
    // to (see `SchemaDefinitionError`'s comment), so the message is all
    // that distinguishes it; the CST-based mirror in the language server's
    // `schemaDefParser.ts` anchors this same failure to a precise range.
    throw new SchemaDefinitionError(`could not resolve ${describeWhat} '${raw}' to a declared element`);
  }
  const defMatches = matches.filter((m) => m.kind === "element" && typeof m.value === "string");

  if (defMatches.length === 0) {
    throw new SchemaDefinitionError(`could not resolve ${describeWhat} '${raw}' to a declared element`);
  }
  if (defMatches.length > 1) {
    throw new SchemaDefinitionError(
      `${describeWhat} '${raw}' is ambiguous -- it matches ${defMatches.length} declared elements`,
    );
  }

  return defMatches[0].value as string;
}

/**
 * Parses cardinality attrs (`minCount`/`maxCount`) off an `element` child
 * reference/definition line. Both default when omitted: `minCount` to `0`,
 * `maxCount` to `Infinity` (unbounded).
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
        `unexpected attribute '${key}' on a child 'element' reference -- only 'minCount'/'maxCount' are allowed`,
      );
    }
  }

  return { minCount, maxCount };
}

/**
 * Resolves a `type=` value common to both `attr` and `value` declarations:
 * either one of the plain `AttrType` string literals, or an xpath self-axis
 * ref (e.g. `type=//element[.="team"]`) constraining a `"ref"`-typed
 * attribute/value to resolve (in the document being validated) to a node
 * of that specific declared element.
 */
function parseTypeDef(
  schemaRoots: IndentNode[],
  rawType: unknown,
  describeWhat: string,
): { type: AttrType; refElement?: string } {
  if (typeof rawType === "string" && ATTR_TYPES.includes(rawType as AttrType)) {
    return { type: rawType as AttrType };
  }
  if (isRefValue(rawType)) {
    const refElement = resolveElementRef(schemaRoots, rawType.raw, `${describeWhat} type ref`);
    return { type: "ref", refElement };
  }
  throw new SchemaDefinitionError(
    `${describeWhat} requires a 'type=' attribute, one of: ${ATTR_TYPES.join(", ")}, or an xpath self-axis ref (e.g. 'type=//element[.="name"]')`,
  );
}

function parseAttrDef(schemaRoots: IndentNode[], node: IndentNode): AttrSchema {
  if (typeof node.value !== "string") {
    throw new SchemaDefinitionError(
      `'attr' requires a quoted string name, e.g. 'attr "name" type="string"'`,
    );
  }

  const { type, refElement } = parseTypeDef(schemaRoots, node.attrs.type, `attr '${node.value}'`);

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

  return { name: node.value, type, required, ...(refElement ? { refElement } : {}) };
}

function parseValueDef(schemaRoots: IndentNode[], node: IndentNode, elementName: string): ValueSchema {
  if (node.value !== undefined) {
    throw new SchemaDefinitionError(
      `'value' takes no positional name, e.g. 'value type="string"' -- got a positional value on element '${elementName}'`,
    );
  }

  const { type, refElement } = parseTypeDef(
    schemaRoots,
    node.attrs.type,
    `'value' on element '${elementName}'`,
  );

  let required = false;
  if ("required" in node.attrs) {
    const rawRequired = node.attrs.required;
    if (typeof rawRequired !== "boolean") {
      throw new SchemaDefinitionError(
        `'value' on element '${elementName}' 'required=' must be a boolean (true/false)`,
      );
    }
    required = rawRequired;
  }

  const allowedKeys = new Set(["type", "required"]);
  for (const key of Object.keys(node.attrs)) {
    if (!allowedKeys.has(key)) {
      throw new SchemaDefinitionError(
        `unexpected attribute '${key}' on 'value' (element '${elementName}') -- only 'type'/'required' are allowed`,
      );
    }
  }

  return { type, required, ...(refElement ? { refElement } : {}) };
}

/**
 * Parses a schema definition written in Indent syntax itself. Top-level
 * `element "name"` lines are canonical element definitions; their children
 * declare:
 *
 * - `attr "name" type="..."` -- an allowed attribute. `type=` is one of the
 *   plain `string`/`number`/`boolean`/`ref` literals, or an xpath self-axis
 *   ref (e.g. `type=//element[.="team"]`) constraining a ref-typed
 *   attribute to resolve to a node of that specific declared element.
 * - `value type="..."` -- a schema for the element's own positional value,
 *   following the same `type=` rules as `attr` (including ref-target
 *   constraints). At most one per element definition.
 * - `element` children, declaring allowed child elements, either as:
 *   - An **inline definition**: a nested `element "name"` line with a plain
 *     quoted string value. This both declares a brand-new element
 *     (registered globally, exactly as if it had been written at the top
 *     level) *and* wires it up as an allowed child of the enclosing
 *     element, at the cardinality declared on this line. Inline
 *     definitions may themselves nest further inline definitions, to any
 *     depth.
 *   - A **reference**: `element //element[.="name"]`, resolved via
 *     `indent-lang`'s xpath module's self-axis predicate against the
 *     schema's own tree. This points at an element definition declared
 *     elsewhere (top-level or nested) without redefining it -- required
 *     for self-referential elements (e.g. `container` nested in
 *     `container`, which can't be expressed inline since the name wouldn't
 *     exist yet) and for sharing one element under multiple parents with
 *     different cardinality.
 *
 * Every element name must be defined exactly once, whether at the top
 * level or inline under some parent; every other mention of that name must
 * use the ref form.
 */
export function parseSchema(source: string): Schema {
  const { roots: schemaRoots } = parse(source);

  const elements = new Map<string, ElementSchema>();
  const defNodes = new Map<string, IndentNode>();
  const topLevelNames: string[] = [];

  function registerDef(node: IndentNode, name: string): void {
    if (elements.has(name)) {
      throw new SchemaDefinitionError(`duplicate element definition '${name}'`);
    }
    elements.set(name, { name, attrs: new Map(), children: new Map() });
    defNodes.set(name, node);

    // Recurse into this definition's children to discover further inline
    // nested definitions (refs are left alone -- they don't define anything
    // new, they're resolved in the fill pass below).
    for (const child of node.children) {
      if (child.kind === "element" && typeof child.value === "string") {
        registerDef(child, child.value);
      }
    }
  }

  // Pass 1: collect every element definition (top-level and inline-nested),
  // so forward/cross references resolve regardless of declaration order or
  // nesting depth.
  for (const node of schemaRoots) {
    if (node.kind !== "element") {
      throw new SchemaDefinitionError(
        `schema root statements must be 'element' definitions, got '${node.kind}'`,
      );
    }
    if (typeof node.value !== "string") {
      throw new SchemaDefinitionError(
        `top-level 'element' definition requires a quoted string name, e.g. 'element "name"'`,
      );
    }
    registerDef(node, node.value);
    topLevelNames.push(node.value);
  }

  // Pass 2: fill in attrs/value/children for every definition, now that
  // every element name (top-level or nested) is known.
  for (const [name, defNode] of defNodes) {
    const elementSchema = elements.get(name)!;

    for (const child of defNode.children) {
      if (child.kind === "attr") {
        const attrSchema = parseAttrDef(schemaRoots, child);
        if (elementSchema.attrs.has(attrSchema.name)) {
          throw new SchemaDefinitionError(
            `duplicate attr '${attrSchema.name}' on element '${name}'`,
          );
        }
        elementSchema.attrs.set(attrSchema.name, attrSchema);
        continue;
      }

      if (child.kind === "value") {
        if (elementSchema.value) {
          throw new SchemaDefinitionError(`duplicate 'value' declaration on element '${name}'`);
        }
        elementSchema.value = parseValueDef(schemaRoots, child, name);
        continue;
      }

      if (child.kind === "element") {
        let resolvedName: string;

        if (typeof child.value === "string") {
          // Inline definition -- already registered in pass 1 under its own
          // name; just wire it up as a child here.
          resolvedName = child.value;
        } else if (isRefValue(child.value)) {
          resolvedName = resolveElementRef(schemaRoots, child.value.raw, "child element reference");
        } else {
          throw new SchemaDefinitionError(
            `a nested 'element' line must either inline-define a new element (e.g. 'element "name"') or reference a declared element via an xpath self-axis ref (e.g. 'element //element[.="name"]'), got a plain value instead`,
          );
        }

        if (elementSchema.children.has(resolvedName)) {
          throw new SchemaDefinitionError(
            `duplicate child element reference to '${resolvedName}' on element '${name}'`,
          );
        }

        const { minCount, maxCount } = parseCardinality(child);
        const childRef: ChildRef = { element: resolvedName, minCount, maxCount };
        elementSchema.children.set(resolvedName, childRef);
        continue;
      }

      throw new SchemaDefinitionError(
        `expected 'attr', 'value', or 'element' inside an element definition, got '${child.kind}'`,
      );
    }
  }

  // Every top-level element definition is implicitly allowed at the
  // document root, with the default (unbounded) cardinality. Inline-nested
  // definitions are NOT implicitly allowed at the root -- only explicitly
  // declared top-level ones are.
  const roots = new Map<string, ChildRef>();
  for (const name of topLevelNames) {
    roots.set(name, { element: name, minCount: 0, maxCount: Infinity });
  }

  return { elements, roots };
}

/** Reads and parses a schema definition file from disk. */
export function parseSchemaFile(path: string): Schema {
  const source = readFileSync(path, "utf8");
  return parseSchema(source);
}
