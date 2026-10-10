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

/** Adapts an `AstStatement` tree to `indent-lang`'s xpath module's generic `XPathNode` shape. */
function toXPathNode(stmt: AstStatement): XPathNode {
  const attrs: Record<string, unknown> = {};
  for (const [name, attr] of Object.entries(stmt.attrs)) {
    attrs[name] = attr.value;
  }
  return {
    kind: stmt.kind,
    value: stmt.value?.value,
    attrs,
    children: stmt.children.map(toXPathNode),
  };
}

/**
 * Resolves an xpath self-axis ref (e.g. `//element[.="team"]`) against the
 * schema's own root statements to the declared element name(s) it points
 * at, as a node-set-style array -- matching standard xpath semantics,
 * where a query always yields a collection regardless of cardinality (0,
 * 1, or many). Shared by child-element references and `attr`/`value`
 * `type=` ref-constraints.
 *
 * Matching more than one declared element is only permitted when the raw
 * xpath contains a wildcard (`*`) step *and* the caller opts in via
 * `allowMultiple` (set for `type=` ref-constraints; not set for
 * child-element references, which only ever name a single element to
 * nest). Otherwise >1 match is treated as a likely authoring mistake and
 * rejected as ambiguous.
 */
function resolveElementRef(
  schemaRoots: AstStatement[],
  raw: string,
  range: Range,
  describeWhat: string,
  options?: { allowMultiple?: boolean },
): string[] {
  const allowMultiple = options?.allowMultiple ?? false;
  const forest = schemaRoots.map(toXPathNode);

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
  const isWildcard = parsed.steps.some((step) => step.name === "*");

  const matches = selectNodes(forest, parsed);
  const defMatches = matches.filter((m) => m.kind === "element" && typeof m.value === "string");
  const names = [...new Set(defMatches.map((m) => m.value as string))];

  if (names.length === 0) {
    throw new SchemaCstDefinitionError(
      `could not resolve ${describeWhat} '${raw}' to a declared element`,
      range,
    );
  }
  if (names.length > 1 && !(allowMultiple && isWildcard)) {
    throw new SchemaCstDefinitionError(
      `${describeWhat} '${raw}' is ambiguous -- it matches ${names.length} declared elements`,
      range,
    );
  }

  return names;
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
  schemaRoots: AstStatement[],
  stmt: AstStatement,
  describeWhat: string,
): { type: AttrType; refElement?: string[] } {
  const typeAttr = stmt.attrs.type;
  if (typeAttr && typeAttr.valueType === "string" && ATTR_TYPES.includes(typeAttr.value as AttrType)) {
    return { type: typeAttr.value as AttrType };
  }
  if (typeAttr && typeAttr.valueType === "ref") {
    const refElement = resolveElementRef(
      schemaRoots,
      typeAttr.valueRaw,
      typeAttr.valueRange,
      `${describeWhat} type ref`,
      { allowMultiple: true },
    );
    return { type: "ref", refElement };
  }
  throw new SchemaCstDefinitionError(
    `${describeWhat} requires a 'type=' attribute, one of: ${ATTR_TYPES.join(", ")}, or an xpath self-axis ref (e.g. 'type=//element[.="name"]')`,
    typeAttr?.valueRange ?? stmt.kindRange,
  );
}

function parseAttrDef(schemaRoots: AstStatement[], stmt: AstStatement): AttrSchema {
  if (!stmt.value || stmt.value.valueType !== "string") {
    throw new SchemaCstDefinitionError(
      `'attr' requires a quoted string name, e.g. 'attr "name" type="string"'`,
      stmt.kindRange,
    );
  }
  const name = stmt.value.value as string;

  const { type, refElement } = parseTypeDef(schemaRoots, stmt, `attr '${name}'`);

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

function parseValueDef(schemaRoots: AstStatement[], stmt: AstStatement, elementName: string): ValueSchema {
  if (stmt.value !== undefined) {
    throw new SchemaCstDefinitionError(
      `'value' takes no positional name, e.g. 'value type="string"' -- got a positional value on element '${elementName}'`,
      stmt.value.range,
    );
  }

  const { type, refElement } = parseTypeDef(schemaRoots, stmt, `'value' on element '${elementName}'`);

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
  const topLevelNames: string[] = [];

  function registerDef(stmt: AstStatement, name: string): void {
    if (elements.has(name)) {
      throw new SchemaCstDefinitionError(`duplicate element definition '${name}'`, stmt.kindRange);
    }
    elements.set(name, { name, attrs: new Map(), children: new Map() });
    defStmts.set(name, stmt);

    for (const child of stmt.children) {
      if (child.kind === "element" && child.value?.valueType === "string") {
        registerDef(child, child.value.value as string);
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
    registerDef(stmt, stmt.value.value as string);
    topLevelNames.push(stmt.value.value as string);
  }

  for (const [name, defStmt] of defStmts) {
    const elementSchema = elements.get(name)!;

    for (const child of defStmt.children) {
      if (child.kind === "attr") {
        const attrSchema = parseAttrDef(schemaRoots, child);
        if (elementSchema.attrs.has(attrSchema.name)) {
          throw new SchemaCstDefinitionError(
            `duplicate attr '${attrSchema.name}' on element '${name}'`,
            child.value!.range,
          );
        }
        elementSchema.attrs.set(attrSchema.name, attrSchema);
        continue;
      }

      if (child.kind === "value") {
        if (elementSchema.value) {
          throw new SchemaCstDefinitionError(
            `duplicate 'value' declaration on element '${name}'`,
            child.kindRange,
          );
        }
        elementSchema.value = parseValueDef(schemaRoots, child, name);
        continue;
      }

      if (child.kind === "element") {
        let resolvedName: string;

        if (child.value?.valueType === "string") {
          resolvedName = child.value.value as string;
        } else if (isRefValue(child)) {
          [resolvedName] = resolveElementRef(
            schemaRoots,
            child.value!.valueRaw,
            child.value!.range,
            "child element reference",
          );
        } else {
          throw new SchemaCstDefinitionError(
            `a nested 'element' line must either inline-define a new element (e.g. 'element "name"') or reference a declared element via an xpath self-axis ref (e.g. 'element //element[.="name"]'), got a plain value instead`,
            child.value?.range ?? child.kindRange,
          );
        }

        if (elementSchema.children.has(resolvedName)) {
          throw new SchemaCstDefinitionError(
            `duplicate child element reference to '${resolvedName}' on element '${name}'`,
            child.kindRange,
          );
        }

        const { minCount, maxCount } = parseCardinality(child);
        const childRef: ChildRef = { element: resolvedName, minCount, maxCount };
        elementSchema.children.set(resolvedName, childRef);
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
