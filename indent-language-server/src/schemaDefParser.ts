import type { Range } from "vscode-languageserver";
import { parseXPath, selectNodes } from "indent-lang/xpath";
import type { XPathNode } from "indent-lang/xpath";
import type {
  AttrSchema,
  AttrType,
  ChildRef,
  ElementSchema,
  Schema,
  ValueSchema,
} from "indent-lang/schema";
import type { AstStatement } from "./types.js";

const ATTR_TYPES: readonly AttrType[] = ["string", "number", "boolean", "ref"];

/**
 * Line-anchored port of `indent-lang/src/schema/parse.ts`'s `parseSchema`.
 * That function operates on `IndentNode`, which carries no line/position
 * info (see the comment on `SchemaDefinitionError`), so a schema file's own
 * grammar errors can't be anchored to the offending line when parsed that
 * way -- the LSP previously fell back to always pointing at the first root
 * statement (see `diagnostics.ts`'s former behavior). This mirrors
 * `parseSchema`'s full algorithm -- the two-pass inline-nested-definition
 * registration, `attr`/`value`/ref-constraint resolution, and cardinality
 * parsing -- against the language server's own `AstStatement` CST, using
 * `kindRange`/`nameRange`/`valueRange` to produce precise error ranges.
 *
 * IMPORTANT: this is a second, parallel implementation of schema-grammar
 * parsing. Any change to `indent-lang/src/schema/parse.ts`'s grammar or
 * error conditions must be mirrored here by hand (same caution called out
 * atop `schemaValidator.ts` for `validate.ts`). A conformance test
 * (`test/schemaParserConformance.test.ts`) cross-checks both
 * implementations against shared fixtures to catch drift.
 */
export class SchemaCstDefinitionError extends Error {
  constructor(
    message: string,
    public readonly range: Range,
  ) {
    super(message);
    this.name = "SchemaCstDefinitionError";
  }
}

function isRefValue(stmt: AstStatement | undefined): boolean {
  return stmt?.value?.valueType === "ref";
}

/**
 * The schema's own tree in `indent-lang`'s xpath module's generic
 * `XPathNode` shape, plus a map from each converted *definition* node to
 * its scoped element id. Built once, after pass 1 has assigned ids.
 */
interface RefContext {
  forest: XPathNode[];
  ids: Map<XPathNode, string>;
}

/**
 * Adapts an `AstStatement` tree to the xpath module's `XPathNode` shape,
 * recording each definition statement's scoped id (from `stmtIds`) against
 * its converted node in `ids`.
 */
function toXPathNode(
  stmt: AstStatement,
  stmtIds: Map<AstStatement, string>,
  ids: Map<XPathNode, string>,
): XPathNode {
  const attrs: Record<string, unknown> = {};
  for (const [name, attr] of Object.entries(stmt.attrs)) {
    attrs[name] = attr.value;
  }
  const node: XPathNode = {
    kind: stmt.kind,
    value: stmt.value?.value,
    attrs,
    children: stmt.children.map((c) => toXPathNode(c, stmtIds, ids)),
  };
  const id = stmtIds.get(stmt);
  if (id !== undefined) ids.set(node, id);
  return node;
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
 */
function resolveElementRef(
  ctx: RefContext,
  raw: string,
  range: Range,
  describeWhat: string,
): string[] {
  let parsed;
  try {
    parsed = parseXPath(raw);
  } catch {
    // Covers an unparsable xpath (e.g. a typo'd `type=//*`), surfaced with
    // the same message as a syntactically valid ref that simply resolves
    // to nothing, anchored at the offending `type=`/ref range rather than
    // left to escape uncaught (which would otherwise fall back to the
    // document's first root statement -- see indexer.ts's
    // `SchemaCstDefinitionError` catch).
    throw new SchemaCstDefinitionError(
      `could not resolve ${describeWhat} '${raw}' to a declared element`,
      range,
    );
  }

  const matches = selectNodes(ctx.forest, parsed);
  const ids = [
    ...new Set(matches.map((m) => ctx.ids.get(m)).filter((id): id is string => id !== undefined)),
  ];

  if (ids.length === 0) {
    throw new SchemaCstDefinitionError(
      `could not resolve ${describeWhat} '${raw}' to a declared element`,
      range,
    );
  }
  return ids;
}

/**
 * Parses cardinality attrs (`minCount`/`maxCount`) off an `element` child
 * reference/definition line. Both default when omitted: `minCount` to `0`,
 * `maxCount` to `Infinity` (unbounded).
 */
function parseCardinality(stmt: AstStatement): { minCount: number; maxCount: number } {
  let minCount = 0;
  let maxCount = Infinity;

  const minAttr = stmt.attrs.minCount;
  if (minAttr) {
    if (minAttr.valueType !== "number" || !Number.isInteger(minAttr.value) || (minAttr.value as number) < 0) {
      throw new SchemaCstDefinitionError(
        `'minCount' must be a non-negative integer, got '${minAttr.valueRaw}'`,
        minAttr.valueRange,
      );
    }
    minCount = minAttr.value as number;
  }

  const maxAttr = stmt.attrs.maxCount;
  if (maxAttr) {
    if (maxAttr.valueType !== "number" || !Number.isInteger(maxAttr.value) || (maxAttr.value as number) < 1) {
      throw new SchemaCstDefinitionError(
        `'maxCount' must be a positive integer, got '${maxAttr.valueRaw}'`,
        maxAttr.valueRange,
      );
    }
    maxCount = maxAttr.value as number;
  }

  if (minCount > maxCount) {
    throw new SchemaCstDefinitionError(
      `'minCount' (${minCount}) cannot exceed 'maxCount' (${maxCount})`,
      stmt.kindRange,
    );
  }

  const allowedKeys = new Set(["minCount", "maxCount"]);
  for (const [key, attr] of Object.entries(stmt.attrs)) {
    if (!allowedKeys.has(key)) {
      throw new SchemaCstDefinitionError(
        `unexpected attribute '${key}' on a child 'element' reference -- only 'minCount'/'maxCount' are allowed`,
        attr.nameRange,
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
 * of one of the declared element(s) the ref matches here.
 */
function parseTypeDef(
  ctx: RefContext,
  stmt: AstStatement,
  describeWhat: string,
): { type: AttrType; refElement?: string[] } {
  const typeAttr = stmt.attrs.type;
  if (typeAttr && typeAttr.valueType === "string" && ATTR_TYPES.includes(typeAttr.value as AttrType)) {
    return { type: typeAttr.value as AttrType };
  }
  if (typeAttr && typeAttr.valueType === "ref") {
    const refElement = resolveElementRef(
      ctx,
      typeAttr.valueRaw,
      typeAttr.valueRange,
      `${describeWhat} type ref`,
    );
    return { type: "ref", refElement };
  }
  throw new SchemaCstDefinitionError(
    `${describeWhat} requires a 'type=' attribute, one of: ${ATTR_TYPES.join(", ")}, or an xpath self-axis ref (e.g. 'type=//element[.="name"]')`,
    typeAttr?.valueRange ?? stmt.kindRange,
  );
}

function parseAttrDef(ctx: RefContext, stmt: AstStatement): AttrSchema {
  if (!stmt.value || stmt.value.valueType !== "string") {
    throw new SchemaCstDefinitionError(
      `'attr' requires a quoted string name, e.g. 'attr "name" type="string"'`,
      stmt.kindRange,
    );
  }
  const name = stmt.value.value as string;

  const { type, refElement } = parseTypeDef(ctx, stmt, `attr '${name}'`);

  let required = false;
  const requiredAttr = stmt.attrs.required;
  if (requiredAttr) {
    if (requiredAttr.valueType !== "boolean") {
      throw new SchemaCstDefinitionError(
        `attr '${name}' 'required=' must be a boolean (true/false)`,
        requiredAttr.valueRange,
      );
    }
    required = requiredAttr.value as boolean;
  }

  const allowedKeys = new Set(["type", "required"]);
  for (const [key, attr] of Object.entries(stmt.attrs)) {
    if (!allowedKeys.has(key)) {
      throw new SchemaCstDefinitionError(
        `unexpected attribute '${key}' on attr '${name}' -- only 'type'/'required' are allowed`,
        attr.nameRange,
      );
    }
  }

  return { name, type, required, ...(refElement ? { refElement } : {}) };
}

function parseValueDef(ctx: RefContext, stmt: AstStatement, elementName: string): ValueSchema {
  if (stmt.value !== undefined) {
    throw new SchemaCstDefinitionError(
      `'value' takes no positional name, e.g. 'value type="string"' -- got a positional value on element '${elementName}'`,
      stmt.value.range,
    );
  }

  const { type, refElement } = parseTypeDef(ctx, stmt, `'value' on element '${elementName}'`);

  let required = false;
  const requiredAttr = stmt.attrs.required;
  if (requiredAttr) {
    if (requiredAttr.valueType !== "boolean") {
      throw new SchemaCstDefinitionError(
        `'value' on element '${elementName}' 'required=' must be a boolean (true/false)`,
        requiredAttr.valueRange,
      );
    }
    required = requiredAttr.value as boolean;
  }

  const allowedKeys = new Set(["type", "required"]);
  for (const [key, attr] of Object.entries(stmt.attrs)) {
    if (!allowedKeys.has(key)) {
      throw new SchemaCstDefinitionError(
        `unexpected attribute '${key}' on 'value' (element '${elementName}') -- only 'type'/'required' are allowed`,
        attr.nameRange,
      );
    }
  }

  return { type, required, ...(refElement ? { refElement } : {}) };
}

/**
 * CST-based mirror of `indent-lang`'s `parseSchema`, operating on a schema
 * file's own `AstStatement[]` roots (from its `AstDocument`) instead of
 * `IndentNode[]`, so every error can carry a precise `Range` instead of
 * nothing. See the module doc comment for the grammar this implements --
 * it must stay in lockstep with `indent-lang/src/schema/parse.ts`.
 */
export function parseSchemaFromCst(schemaRoots: AstStatement[]): Schema {
  const elements = new Map<string, ElementSchema>();
  const defStmts = new Map<string, AstStatement>();
  /** Definition statement -> scoped id, for resolving xpath matches. */
  const stmtIds = new Map<AstStatement, string>();
  const topLevelNames: string[] = [];

  function registerDef(stmt: AstStatement, name: string, parentId: string | undefined): void {
    if (name.includes("/")) {
      throw new SchemaCstDefinitionError(
        `element name '${name}' must not contain '/'`,
        stmt.value?.range ?? stmt.kindRange,
      );
    }
    const id = parentId === undefined ? name : `${parentId}/${name}`;
    if (elements.has(id)) {
      throw new SchemaCstDefinitionError(
        parentId === undefined
          ? `duplicate element definition '${name}'`
          : `duplicate child element '${name}' on element '${parentId}'`,
        stmt.kindRange,
      );
    }
    elements.set(id, { name, id, attrs: new Map(), children: new Map() });
    defStmts.set(id, stmt);
    stmtIds.set(stmt, id);

    for (const child of stmt.children) {
      if (child.kind === "element" && child.value?.valueType === "string") {
        registerDef(child, child.value.value as string, id);
      }
    }
  }

  for (const stmt of schemaRoots) {
    if (stmt.kind !== "element") {
      throw new SchemaCstDefinitionError(
        `schema root statements must be 'element' definitions, got '${stmt.kind}'`,
        stmt.kindRange,
      );
    }
    if (!stmt.value || stmt.value.valueType !== "string") {
      throw new SchemaCstDefinitionError(
        `top-level 'element' definition requires a quoted string name, e.g. 'element "name"'`,
        stmt.kindRange,
      );
    }
    registerDef(stmt, stmt.value.value as string, undefined);
    topLevelNames.push(stmt.value.value as string);
  }

  const xpathIds = new Map<XPathNode, string>();
  const ctx: RefContext = {
    forest: schemaRoots.map((r) => toXPathNode(r, stmtIds, xpathIds)),
    ids: xpathIds,
  };

  for (const [id, defStmt] of defStmts) {
    const elementSchema = elements.get(id)!;

    for (const child of defStmt.children) {
      if (child.kind === "attr") {
        const attrSchema = parseAttrDef(ctx, child);
        if (elementSchema.attrs.has(attrSchema.name)) {
          throw new SchemaCstDefinitionError(
            `duplicate attr '${attrSchema.name}' on element '${id}'`,
            child.value!.range,
          );
        }
        elementSchema.attrs.set(attrSchema.name, attrSchema);
        continue;
      }

      if (child.kind === "value") {
        if (elementSchema.value) {
          throw new SchemaCstDefinitionError(
            `duplicate 'value' declaration on element '${id}'`,
            child.kindRange,
          );
        }
        elementSchema.value = parseValueDef(ctx, child, id);
        continue;
      }

      if (child.kind === "element") {
        let resolvedIds: string[];

        if (child.value?.valueType === "string") {
          resolvedIds = [stmtIds.get(child)!];
        } else if (isRefValue(child)) {
          resolvedIds = resolveElementRef(
            ctx,
            child.value!.valueRaw,
            child.value!.range,
            "child element reference",
          );
        } else {
          throw new SchemaCstDefinitionError(
            `a nested 'element' line must either inline-define a new element (e.g. 'element "name"') or reference a declared element via an xpath ref (e.g. 'element //element[.="name"]'), got a plain value instead`,
            child.value?.range ?? child.kindRange,
          );
        }

        const { minCount, maxCount } = parseCardinality(child);

        for (const resolvedId of resolvedIds) {
          const localName = elements.get(resolvedId)!.name;
          const existing = elementSchema.children.get(localName);
          if (existing) {
            throw new SchemaCstDefinitionError(
              existing.element === resolvedId
                ? `duplicate child element reference to '${resolvedId}' on element '${id}'`
                : `child elements '${existing.element}' and '${resolvedId}' share the name '${localName}' on element '${id}' -- an element may have only one child per name`,
              child.kindRange,
            );
          }
          elementSchema.children.set(localName, { element: resolvedId, minCount, maxCount });
        }
        continue;
      }

      throw new SchemaCstDefinitionError(
        `expected 'attr', 'value', or 'element' inside an element definition, got '${child.kind}'`,
        child.kindRange,
      );
    }
  }

  const roots = new Map<string, ChildRef>();
  for (const name of topLevelNames) {
    roots.set(name, { element: name, minCount: 0, maxCount: Infinity });
  }

  return { elements, roots };
}
