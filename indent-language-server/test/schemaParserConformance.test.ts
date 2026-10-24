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
      id: el.id,
      reusable: el.reusable,
      localName: el.name,
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
  scopedSameName: `
element "org"
    element "service" minCount=1
        attr "name" type="string" required=true
    element "group"
        element "service"
            attr "tier" type="string"
        element //element[.="org"]/element[.="group"]
`,
  recursiveSelfName: `
element "group"
    element "group"
        attr "label" type="string"
`,
  qualifiedRefNarrows: `
element "team" reusable=true
    attr "x" type="string"

element "a"
    element "team"
        attr "y" type="string"

element "holder"
    element /element[.="team"]
    attr "t" type=//element[.="a"]/element[.="team"]
`,
  reusableShared: `
element "link" reusable=true
    attr "href" type="string" required=true

element "html"
    element "head"
        element //element[.="link"]
    element "body"
        element //element[.="link"]
        element "div"
            element //element[.="link"]
`,
  reusableRecursive: `
element "group" reusable=true
    element //element[.="group"]

element "doc"
    element //element[.="group"]
`,
  nestedSelfAndAncestorRef: `
element "softwareSystem"
    element "container"
        element //element[.="container"]
        element //element[.="softwareSystem"]
`,
  broadTypeRefMatchesMany: `
element "a"
    element "team"

element "b"
    element "team"

element "holder"
    attr "t" type=//element[.="team"]
`,
  basic: `
element "workspace"
    attr "name" type="string" required=true
    element //element[.="person"]
    element //element[.="system"] minCount=1

element "person" reusable=true
    attr "name" type="string" required=true

element "system" reusable=true
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
  refToUnmarkedTopLevel: `
element "service"
element "org"
    element //element[.="service"]
`,
  refIntoOtherSubtree: `
element "org"
    element "team"

element "other"
    element //element[.="team"]
`,
  reusableOnNestedLine: `
element "org"
    element "team" reusable=true
`,
  reusableNotBoolean: `
element "a" reusable="yes"
`,
  unknownTopLevelAttr: `
element "a" bogus=1
`,
  onlyReusableElements: `
element "a" reusable=true
`,
  duplicateInlineDef: `
element "org"
    element "team"
    element "team"
`,

  refAndInlineShareName: `
element "team" reusable=true

element "org"
    element "team"
    element //element[.="team"]
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

element "person" reusable=true
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
