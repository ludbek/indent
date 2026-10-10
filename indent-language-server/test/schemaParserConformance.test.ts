import { describe, expect, it, beforeAll } from "vitest";
import { CstParser } from "../src/cst.js";
import { parseSchemaFromCst } from "../src/schemaDefParser.js";
import { parseSchema } from "indent-lang/schema";
import type { Schema } from "indent-lang/schema";

let cstParser: CstParser;

beforeAll(async () => {
  cstParser = await CstParser.create();
});

const parseCst = (source: string) => {
  const { doc } = cstParser.parse("file:///conformance.schema.inml", source);
  return parseSchemaFromCst(doc.roots);
};

// Normalize a Schema into a structurally-comparable plain object (Maps and
// Infinity don't compare cleanly with toEqual against differently-sourced
// instances, so we serialize to JSON-friendly shapes before comparing).
const normalize = (schema: Schema) => ({
  elements: [...schema.elements.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, el]) => ({
      name,
      attrs: [...el.attrs.entries()].sort(([a], [b]) => a.localeCompare(b)),
      children: [...el.children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [
          k,
          { ...v, maxCount: v.maxCount === Infinity ? "INF" : v.maxCount },
        ]),
      value: el.value
        ? { ...el.value, maxCount: undefined }
        : undefined,
    })),
  roots: [...schema.roots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [
      k,
      { ...v, maxCount: v.maxCount === Infinity ? "INF" : v.maxCount },
    ]),
});

const VALID_FIXTURES: Record<string, string> = {
  basic: `
element "workspace"
    attr "name" type="string" required=true
    element //element[.="person"]
    element //element[.="system"] minCount=1

element "person"
    attr "name" type="string" required=true

element "system"
    attr "name" type="string" required=true
`,
  inlineNesting: `
element "org"
    attr "name" type="string" required=true
    element "team" minCount=1
        attr "name" type="string" required=true
        element "member" maxCount=5
            attr "name" type="string" required=true
`,
  refConstrainedTypes: `
element "org"
    attr "team" type=//element[.="team"]
    value type=//element[.="team"]

element "team"
    attr "name" type="string" required=true
`,
  valueTypes: `
element "team"
    value type="string" required=true
`,
};

const MALFORMED_FIXTURES: Record<string, string> = {
  rootNotElement: `attr "name" type="string"\n`,
  duplicateTopLevel: `
element "person"
element "person"
`,
  duplicateInlineDef: `
element "org"
    element "team"
    element "other"
        element "team"
`,
  unresolvedRef: `
element "workspace"
    element //element[.="nonexistent"]
`,
  invalidAttrType: `
element "person"
    attr "name" type="weird"
`,
  invalidCardinality: `
element "workspace"
    element //element[.="person"] minCount=5 maxCount=2

element "person"
`,
  unexpectedChildKind: `
element "person"
    bogus "x"
`,
  duplicateValue: `
element "team"
    value type="string"
    value type="number"
`,
};

describe("schema parser conformance: indent-lang parseSchema vs parseSchemaFromCst", () => {
  for (const [name, source] of Object.entries(VALID_FIXTURES)) {
    it(`produces structurally equivalent Schema for valid fixture '${name}'`, () => {
      const fromText = parseSchema(source);
      const fromCst = parseCst(source);
      expect(normalize(fromCst)).toEqual(normalize(fromText));
    });
  }

  for (const [name, source] of Object.entries(MALFORMED_FIXTURES)) {
    it(`both parsers throw for malformed fixture '${name}'`, () => {
      expect(() => parseSchema(source)).toThrow();
      expect(() => parseCst(source)).toThrow();
    });
  }
});
