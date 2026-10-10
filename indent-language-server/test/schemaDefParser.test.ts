import { describe, expect, it, beforeAll } from "vitest";
import { CstParser } from "../src/cst.js";
import { parseSchemaFromCst, SchemaCstDefinitionError } from "../src/schemaDefParser.js";

let parser: CstParser;

beforeAll(async () => {
  parser = await CstParser.create();
});

const parse = (source: string) => {
  const { doc } = parser.parse("file:///test.schema.inml", source);
  return parseSchemaFromCst(doc.roots);
};

describe("parseSchemaFromCst", () => {
  it("parses a schema with attrs and references, applying cardinality defaults", () => {
    const source = `
element "workspace"
    attr "name" type="string" required=true
    element //element[.="person"]
    element //element[.="system"] minCount=1

element "person"
    attr "name" type="string" required=true

element "system"
    attr "name" type="string" required=true
`;
    const schema = parse(source);

    expect([...schema.elements.keys()].sort()).toEqual(["person", "system", "workspace"]);

    const workspace = schema.elements.get("workspace")!;
    expect(workspace.attrs.get("name")).toEqual({ name: "name", type: "string", required: true });
    expect(workspace.children.get("person")).toEqual({
      element: "person",
      minCount: 0,
      maxCount: Infinity,
    });
    expect(workspace.children.get("system")).toEqual({
      element: "system",
      minCount: 1,
      maxCount: Infinity,
    });

    expect(schema.roots.get("workspace")).toEqual({
      element: "workspace",
      minCount: 0,
      maxCount: Infinity,
    });
    expect(schema.roots.get("person")).toEqual({
      element: "person",
      minCount: 0,
      maxCount: Infinity,
    });
  });

  it("supports exact min/max cardinality bounds", () => {
    const source = `
element "container"
    element //element[.="component"] minCount=1 maxCount=3

element "component"
    attr "name" type="string" required=true
`;
    const schema = parse(source);
    expect(schema.elements.get("container")!.children.get("component")).toEqual({
      element: "component",
      minCount: 1,
      maxCount: 3,
    });
  });

  it("supports self-referential elements (e.g. container containing container)", () => {
    const source = `
element "container"
    element //element[.="container"]
`;
    const schema = parse(source);
    const container = schema.elements.get("container")!;
    expect(container.children.get("container")).toEqual({
      element: "container",
      minCount: 0,
      maxCount: Infinity,
    });
  });

  it("supports edge elements like '->' via quoted ref predicates", () => {
    const source = `
element "->"
    attr "label" type="string" required=true
    attr "to" type="ref" required=true

element "node"
    element //element[.="->"]
`;
    const schema = parse(source);
    expect(schema.elements.has("->")).toBe(true);
    expect(schema.elements.get("node")!.children.get("->")).toEqual({
      element: "->",
      minCount: 0,
      maxCount: Infinity,
    });
  });

  it("throws when a child-element reference is unresolved", () => {
    const source = `
element "workspace"
    element //element[.="nonexistent"]
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
    expect(() => parse(source)).toThrow(/could not resolve/i);
  });

  it("supports inline nested element definitions, registering them globally", () => {
    const source = `
element "org"
    attr "name" type="string" required=true
    element "team"
        attr "name" type="string" required=true
`;
    const schema = parse(source);
    expect([...schema.elements.keys()].sort()).toEqual(["org", "team"]);
    expect(schema.elements.get("org")!.children.get("team")).toEqual({
      element: "team",
      minCount: 0,
      maxCount: Infinity,
    });
    expect(schema.roots.has("team")).toBe(false);
    expect(schema.roots.has("org")).toBe(true);
  });

  it("supports multi-level inline nesting with cardinality at each level", () => {
    const source = `
element "org"
    element "team" minCount=1
        element "member" maxCount=5
`;
    const schema = parse(source);
    expect([...schema.elements.keys()].sort()).toEqual(["member", "org", "team"]);
    expect(schema.elements.get("org")!.children.get("team")).toEqual({
      element: "team",
      minCount: 1,
      maxCount: Infinity,
    });
    expect(schema.elements.get("team")!.children.get("member")).toEqual({
      element: "member",
      minCount: 0,
      maxCount: 5,
    });
  });

  it("allows a ref elsewhere to cross-reference an inline-nested definition", () => {
    const source = `
element "org"
    element "team"
        attr "name" type="string" required=true

element "other"
    element //element[.="team"]
`;
    const schema = parse(source);
    expect(schema.elements.get("other")!.children.get("team")).toEqual({
      element: "team",
      minCount: 0,
      maxCount: Infinity,
    });
  });

  it("throws when the same element name is inline-defined twice", () => {
    const source = `
element "org"
    element "team"
    element "other"
        element "team"
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
    expect(() => parse(source)).toThrow(/duplicate element definition 'team'/);
  });

  it("throws when an inline nested definition tries to directly self-nest (must use a ref)", () => {
    const source = `
element "team"
    element "team"
`;
    expect(() => parse(source)).toThrow(/duplicate element definition 'team'/);
  });

  it("throws on duplicate top-level element definitions", () => {
    const source = `
element "person"
element "person"
`;
    expect(() => parse(source)).toThrow(/duplicate/i);
  });

  it("throws on an invalid attr type=", () => {
    const source = `
element "person"
    attr "name" type="weird"
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
  });

  it("throws on invalid cardinality (minCount > maxCount)", () => {
    const source = `
element "workspace"
    element //element[.="person"] minCount=5 maxCount=2

element "person"
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
  });

  it("throws on negative minCount or maxCount < 1", () => {
    const negative = `
element "workspace"
    element //element[.="person"] minCount=-1

element "person"
`;
    expect(() => parse(negative)).toThrow(SchemaCstDefinitionError);

    const zeroMax = `
element "workspace"
    element //element[.="person"] maxCount=0

element "person"
`;
    expect(() => parse(zeroMax)).toThrow(SchemaCstDefinitionError);
  });

  it("throws when a non-element/attr line appears inside an element definition", () => {
    const source = `
element "person"
    bogus "x"
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
  });

  it("throws when a root-level line isn't an 'element' node", () => {
    const source = `attr "name" type="string"\n`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
  });

  it("parses a 'value type=' declaration, defaulting required to false", () => {
    const source = `
element "team"
    value type="string"
`;
    const schema = parse(source);
    expect(schema.elements.get("team")!.value).toEqual({ type: "string", required: false });
  });

  it("parses a 'value type=' declaration with required=true", () => {
    const source = `
element "team"
    value type="string" required=true
`;
    const schema = parse(source);
    expect(schema.elements.get("team")!.value).toEqual({ type: "string", required: true });
  });

  it("throws on duplicate 'value' declarations on the same element", () => {
    const source = `
element "team"
    value type="string"
    value type="number"
`;
    expect(() => parse(source)).toThrow(/duplicate 'value' declaration/);
  });

  it("throws when 'value' carries a positional name", () => {
    const source = `
element "team"
    value "oops" type="string"
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
  });

  it("throws on an invalid 'value' type=", () => {
    const source = `
element "team"
    value type="weird"
`;
    expect(() => parse(source)).toThrow(SchemaCstDefinitionError);
  });

  it("supports a ref-constrained attr type= resolving to a declared element", () => {
    const source = `
element "org"
    attr "team" type=//element[.="team"]

element "team"
    attr "name" type="string" required=true
`;
    const schema = parse(source);
    expect(schema.elements.get("org")!.attrs.get("team")).toEqual({
      name: "team",
      type: "ref",
      required: false,
      refElement: "team",
    });
  });

  it("supports a ref-constrained attr type= resolving to an inline-nested element", () => {
    const source = `
element "org"
    attr "team" type=//element[.="team"]
    element "team"
        attr "name" type="string" required=true
`;
    const schema = parse(source);
    expect(schema.elements.get("org")!.attrs.get("team")!.refElement).toBe("team");
  });

  it("throws when a ref-constrained attr type= cannot be resolved", () => {
    const source = `
element "org"
    attr "team" type=//element[.="nonexistent"]
`;
    expect(() => parse(source)).toThrow(/could not resolve/i);
  });

  it("supports a ref-constrained value type= resolving to a declared element", () => {
    const source = `
element "service"
    value type=//element[.="team"]

element "team"
    attr "name" type="string" required=true
`;
    const schema = parse(source);
    expect(schema.elements.get("service")!.value).toEqual({
      type: "ref",
      required: false,
      refElement: "team",
    });
  });

  it("throws when a ref-constrained value type= cannot be resolved", () => {
    const source = `
element "service"
    value type=//element[.="nonexistent"]
`;
    expect(() => parse(source)).toThrow(/could not resolve/i);
  });

  it("supports a wildcard '//*' xpath ref, matching any node", () => {
    const source = `
element "service"
    attr "team" type=//*[.="team"]

element "team"
    attr "name" type="string" required=true
`;
    const schema = parse(source);
    expect(schema.elements.get("service")!.attrs.get("team")!.refElement).toBe("team");
  });

  it("anchors an unparsable xpath ref error (e.g. '/*foo') at the offending type= range, not line 0", () => {
    const source = `element "org"
    attr "name" type="string" required=true

element "service"
    attr "team" type=//*foo
`;
    try {
      parse(source);
      expect.fail("expected parse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaCstDefinitionError);
      expect((err as Error).message).toMatch(/could not resolve/i);
      const cstErr = err as SchemaCstDefinitionError;
      // The offending line ("attr \"team\" type=//*foo") is line index 4 (0-based).
      expect(cstErr.range.start.line).toBe(4);
      expect(cstErr.range.start.line).not.toBe(0);
    }
  });

  it("anchors the thrown error's range at the actual offending nested line, not line 0", () => {
    const source = `element "org"
    attr "name" type="string" required=true
    element //element[.="service"] minCount=1

element "service"
    attr "name" type="string" required=true
    attr "team" type="weird"
`;
    try {
      parse(source);
      expect.fail("expected parse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaCstDefinitionError);
      const cstErr = err as SchemaCstDefinitionError;
      // The offending line ("attr \"team\" type=\"weird\"") is line index 6 (0-based).
      expect(cstErr.range.start.line).toBe(6);
      expect(cstErr.range.start.line).not.toBe(0);
    }
  });
});
