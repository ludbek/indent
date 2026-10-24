import { readFileSync } from "node:fs";
import { parse } from "../parser.js";
import { selectNodes } from "../xpath/evaluate.js";
import { parseXPath } from "../xpath/parser.js";
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
 * Resolves an xpath ref (e.g. `//element[.="team"]`) against the schema's
 * own tree to the scoped id(s) of the declared element(s) it matches, as a
 * node-set-style array -- matching standard xpath semantics, where a query
 * always yields a collection regardless of cardinality (0, 1, or many).
 * Shared by child-element references and `attr`/`value` `type=`
 * ref-constraints.
 *
 * The xpath is authoritative: every declaration it matches is returned, and
 * it's up to the schema designer to qualify the path (e.g.
 * `//element[.="org"]/element[.="service"]`) when a narrower match is
 * wanted. Only a ref matching nothing is an error.
 *
 * `nodeIds` maps each definition node (top-level or inline-nested) to its
 * scoped id.
 */
function resolveElementRef(
  schemaRoots: IndentNode[],
  nodeIds: Map<IndentNode, string>,
  raw: string,
  describeWhat: string,
): string[] {
  let parsed;
  try {
    parsed = parseXPath(raw);
  } catch {
    // An unparsable xpath is reported the same way as a syntactically valid
    // ref that resolves to nothing -- this package has no line/position
    // info to anchor a more specific error to (see `SchemaDefinitionError`'s
    // comment); the CST-based mirror in the language server's
    // `schemaDefParser.ts` anchors this same failure to a precise range.
    throw new SchemaDefinitionError(`could not resolve ${describeWhat} '${raw}' to a declared element`);
  }

  // `selectNodes` is generic over `XPathNode`, whose `value` type doesn't
  // include `RefValue` (xpath stays decoupled from Indent's concrete value
  // typing). It returns the original node objects, so they can be looked up
  // in `nodeIds` by identity.
  const matches = selectNodes(schemaRoots as unknown as XPathNode[], parsed) as unknown as IndentNode[];
  const ids = [
    ...new Set(matches.map((m) => nodeIds.get(m)).filter((id): id is string => id !== undefined)),
  ];

  if (ids.length === 0) {
    throw new SchemaDefinitionError(`could not resolve ${describeWhat} '${raw}' to a declared element`);
  }
  return ids;
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
    if (key === "reusable") {
      throw new SchemaDefinitionError(
        `'reusable' is only allowed on a top-level 'element' definition`,
      );
    }
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
 * of one of the declared element(s) the ref matches here (a set when the
 * ref matches several declarations; a singleton array otherwise), by
 * scoped id.
 */
function parseTypeDef(
  schemaRoots: IndentNode[],
  nodeIds: Map<IndentNode, string>,
  rawType: unknown,
  describeWhat: string,
): { type: AttrType; refElement?: string[] } {
  if (typeof rawType === "string" && ATTR_TYPES.includes(rawType as AttrType)) {
    return { type: rawType as AttrType };
  }
  if (isRefValue(rawType)) {
    const refElement = resolveElementRef(schemaRoots, nodeIds, rawType.raw, `${describeWhat} type ref`);
    return { type: "ref", refElement };
  }
  throw new SchemaDefinitionError(
    `${describeWhat} requires a 'type=' attribute, one of: ${ATTR_TYPES.join(", ")}, or an xpath self-axis ref (e.g. 'type=//element[.="name"]')`,
  );
}

function parseAttrDef(
  schemaRoots: IndentNode[],
  nodeIds: Map<IndentNode, string>,
  node: IndentNode,
): AttrSchema {
  if (typeof node.value !== "string") {
    throw new SchemaDefinitionError(
      `'attr' requires a quoted string name, e.g. 'attr "name" type="string"'`,
    );
  }

  const { type, refElement } = parseTypeDef(schemaRoots, nodeIds, node.attrs.type, `attr '${node.value}'`);

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

function parseValueDef(
  schemaRoots: IndentNode[],
  nodeIds: Map<IndentNode, string>,
  node: IndentNode,
  elementName: string,
): ValueSchema {
  if (node.value !== undefined) {
    throw new SchemaDefinitionError(
      `'value' takes no positional name, e.g. 'value type="string"' -- got a positional value on element '${elementName}'`,
    );
  }

  const { type, refElement } = parseTypeDef(
    schemaRoots,
    nodeIds,
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
 *     (scoped under its parent: `service` inside `org` is `org/service`,
 *     distinct from any `service` declared elsewhere) *and* wires it up as an allowed child of the enclosing
 *     element, at the cardinality declared on this line. Inline
 *     definitions may themselves nest further inline definitions, to any
 *     depth.
 *   - A **reference**: `element //element[.="name"]`, resolved via
 *     `indent-lang`'s xpath module's self-axis predicate against the
 *     schema's own tree. It may target only a top-level element marked
 *     `reusable=true` (a shared shape, never a document root), or the
 *     referring element itself / one of its ancestors (recursion, e.g.
 *     `container` nested in `container`, which can't be expressed inline
 *     since the name wouldn't exist yet). This is what lets one shape be
 *     shared under multiple parents with different cardinality.
 *
 * A top-level `element` line may carry `reusable=true`; reusable elements
 * are excluded from the document roots.
 *
 * Element declarations are scoped: the same name may be declared under
 * different parents (each is a distinct element with its own attrs and
 * children), but a name may be declared only once per parent, and top-level
 * names are unique. A ref's xpath is authoritative -- every declaration it
 * matches is used -- so qualify the path (e.g.
 * `//element[.="org"]/element[.="service"]`) to narrow it. A ref that
 * makes one parent hold two children of the same name is an error.
 */
export function parseSchema(source: string): Schema {
  const { roots: schemaRoots } = parse(source);

  const elements = new Map<string, ElementSchema>();
  const defNodes = new Map<string, IndentNode>();
  /** Definition node -> scoped id, for resolving xpath matches. */
  const nodeIds = new Map<IndentNode, string>();
  const topLevelNames: string[] = [];

  function registerDef(node: IndentNode, name: string, parentId: string | undefined): void {
    if (name.includes("/")) {
      throw new SchemaDefinitionError(`element name '${name}' must not contain '/'`);
    }
    const id = parentId === undefined ? name : `${parentId}/${name}`;
    if (elements.has(id)) {
      throw new SchemaDefinitionError(
        parentId === undefined
          ? `duplicate element definition '${name}'`
          : `duplicate child element '${name}' on element '${parentId}'`,
      );
    }
    elements.set(id, { name, id, reusable: false, attrs: new Map(), children: new Map() });
    defNodes.set(id, node);
    nodeIds.set(node, id);

    // Recurse into this definition's children to discover further inline
    // nested definitions (refs are left alone -- they don't define anything
    // new, they're resolved in the fill pass below).
    for (const child of node.children) {
      if (child.kind === "element" && typeof child.value === "string") {
        registerDef(child, child.value, id);
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
    registerDef(node, node.value, undefined);
    topLevelNames.push(node.value);

    for (const key of Object.keys(node.attrs)) {
      if (key !== "reusable") {
        throw new SchemaDefinitionError(
          `unexpected attribute '${key}' on top-level element '${node.value}' -- only 'reusable' is allowed`,
        );
      }
    }
    if ("reusable" in node.attrs) {
      if (typeof node.attrs.reusable !== "boolean") {
        throw new SchemaDefinitionError(
          `element '${node.value}' 'reusable=' must be a boolean (true/false)`,
        );
      }
      elements.get(node.value)!.reusable = node.attrs.reusable;
    }
  }

  // Pass 2: fill in attrs/value/children for every definition, now that
  // every element (top-level or nested) is known.
  for (const [id, defNode] of defNodes) {
    const elementSchema = elements.get(id)!;

    for (const child of defNode.children) {
      if (child.kind === "attr") {
        const attrSchema = parseAttrDef(schemaRoots, nodeIds, child);
        if (elementSchema.attrs.has(attrSchema.name)) {
          throw new SchemaDefinitionError(
            `duplicate attr '${attrSchema.name}' on element '${id}'`,
          );
        }
        elementSchema.attrs.set(attrSchema.name, attrSchema);
        continue;
      }

      if (child.kind === "value") {
        if (elementSchema.value) {
          throw new SchemaDefinitionError(`duplicate 'value' declaration on element '${id}'`);
        }
        elementSchema.value = parseValueDef(schemaRoots, nodeIds, child, id);
        continue;
      }

      if (child.kind === "element") {
        let resolvedIds: string[];

        if (typeof child.value === "string") {
          // Inline definition -- already registered in pass 1 under its own
          // scoped id; just wire it up as a child here.
          resolvedIds = [nodeIds.get(child)!];
        } else if (isRefValue(child.value)) {
          resolvedIds = resolveElementRef(schemaRoots, nodeIds, child.value.raw, "child element reference");
        } else {
          throw new SchemaDefinitionError(
            `a nested 'element' line must either inline-define a new element (e.g. 'element "name"') or reference a declared element via an xpath ref (e.g. 'element //element[.="name"]'), got a plain value instead`,
          );
        }

        const { minCount, maxCount } = parseCardinality(child);

        // A child *reference* may only point at a shared (`reusable=true`)
        // top-level element, or at the referring element itself / one of its
        // ancestors (recursion). Anything else would make the target's
        // scoped id misstate where it sits in the tree. This restriction is
        // deliberately NOT applied to `attr`/`value` `type=` refs: those
        // only constrain where a document ref may point, so targeting a
        // nested element there is legitimate.
        if (typeof child.value !== "string") {
          const raw = (child.value as RefValue).raw;
          for (const resolvedId of resolvedIds) {
            const target = elements.get(resolvedId)!;
            const isShared = target.reusable && !resolvedId.includes("/");
            const isSelfOrAncestor = id === resolvedId || id.startsWith(`${resolvedId}/`);
            if (!isShared && !isSelfOrAncestor) {
              throw new SchemaDefinitionError(
                `child element reference '${raw}' resolves to '${resolvedId}', which is not reusable -- add 'reusable=true' to its top-level definition, or reference an ancestor for recursion`,
              );
            }
          }
        }

        // The xpath is authoritative: every matched declaration becomes a
        // child at this cardinality. Children are keyed by local name, so
        // two matches (or a match and an existing sibling) sharing a local
        // name collide -- the one-child-per-name-per-parent rule.
        for (const resolvedId of resolvedIds) {
          const localName = elements.get(resolvedId)!.name;
          const existing = elementSchema.children.get(localName);
          if (existing) {
            throw new SchemaDefinitionError(
              existing.element === resolvedId
                ? `duplicate child element reference to '${resolvedId}' on element '${id}'`
                : `child elements '${existing.element}' and '${resolvedId}' share the name '${localName}' on element '${id}' -- an element may have only one child per name`,
            );
          }
          elementSchema.children.set(localName, { element: resolvedId, minCount, maxCount });
        }
        continue;
      }

      throw new SchemaDefinitionError(
        `expected 'attr', 'value', or 'element' inside an element definition, got '${child.kind}'`,
      );
    }
  }

  // Every top-level element definition that is not `reusable` is implicitly
  // allowed at the document root, with the default (unbounded) cardinality.
  // Inline-nested and reusable definitions are NOT allowed at the root.
  const roots = new Map<string, ChildRef>();
  for (const name of topLevelNames) {
    if (elements.get(name)!.reusable) continue;
    roots.set(name, { element: name, minCount: 0, maxCount: Infinity });
  }
  if (topLevelNames.length > 0 && roots.size === 0) {
    throw new SchemaDefinitionError(
      `schema declares no document root -- every top-level element is 'reusable=true'`,
    );
  }

  return { elements, roots };
}

/** Reads and parses a schema definition file from disk. */
export function parseSchemaFile(path: string): Schema {
  const source = readFileSync(path, "utf8");
  return parseSchema(source);
}
