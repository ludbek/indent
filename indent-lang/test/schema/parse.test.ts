import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/schema/parse.js";
import { SchemaDefinitionError } from "../../src/schema/types.js";

describe("parseSchema", () => {
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
    const schema = parseSchema(source);

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

    // Every top-level element is implicitly allowed at the document root
    // with the default (unbounded) cardinality.
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
    const schema = parseSchema(source);
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
    const schema = parseSchema(source);
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
    const schema = parseSchema(source);
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
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
    expect(() => parseSchema(source)).toThrow(/could not resolve/i);
  });

  it("supports inline nested element definitions, registering them globally", () => {
    const source = `
element "org"
    attr "name" type="string" required=true
    element "team"
        attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect([...schema.elements.keys()].sort()).toEqual(["org", "team"]);
    expect(schema.elements.get("org")!.children.get("team")).toEqual({
      element: "team",
      minCount: 0,
      maxCount: Infinity,
    });
    // Inline-nested definitions are NOT implicitly allowed at the document
    // root -- only explicit top-level definitions are.
    expect(schema.roots.has("team")).toBe(false);
    expect(schema.roots.has("org")).toBe(true);
  });

  it("supports multi-level inline nesting with cardinality at each level", () => {
    const source = `
element "org"
    element "team" minCount=1
        element "member" maxCount=5
`;
    const schema = parseSchema(source);
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
    const schema = parseSchema(source);
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
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
    expect(() => parseSchema(source)).toThrow(/duplicate element definition 'team'/);
  });

  it("throws when an inline nested definition tries to directly self-nest (must use a ref)", () => {
    const source = `
element "team"
    element "team"
`;
    expect(() => parseSchema(source)).toThrow(/duplicate element definition 'team'/);
  });

  it("throws on duplicate top-level element definitions", () => {
    const source = `
element "person"
element "person"
`;
    expect(() => parseSchema(source)).toThrow(/duplicate/i);
  });

  it("throws on an invalid attr type=", () => {
    const source = `
element "person"
    attr "name" type="weird"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on invalid cardinality (minCount > maxCount)", () => {
    const source = `
element "workspace"
    element //element[.="person"] minCount=5 maxCount=2

element "person"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on negative minCount or maxCount < 1", () => {
    const negative = `
element "workspace"
    element //element[.="person"] minCount=-1

element "person"
`;
    expect(() => parseSchema(negative)).toThrow(SchemaDefinitionError);

    const zeroMax = `
element "workspace"
    element //element[.="person"] maxCount=0

element "person"
`;
    expect(() => parseSchema(zeroMax)).toThrow(SchemaDefinitionError);
  });

  it("throws when a non-element/attr line appears inside an element definition", () => {
    const source = `
element "person"
    bogus "x"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws when a root-level line isn't an 'element' node", () => {
    const source = `attr "name" type="string"\n`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("parses a 'value type=' declaration, defaulting required to false", () => {
    const source = `
element "team"
    value type="string"
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("team")!.value).toEqual({ type: "string", required: false });
  });

  it("parses a 'value type=' declaration with required=true", () => {
    const source = `
element "team"
    value type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("team")!.value).toEqual({ type: "string", required: true });
  });

  it("throws on duplicate 'value' declarations on the same element", () => {
    const source = `
element "team"
    value type="string"
    value type="number"
`;
    expect(() => parseSchema(source)).toThrow(/duplicate 'value' declaration/);
  });

  it("throws when 'value' carries a positional name", () => {
    const source = `
element "team"
    value "oops" type="string"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on an invalid 'value' type=", () => {
    const source = `
element "team"
    value type="weird"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("supports a ref-constrained attr type= resolving to a declared element", () => {
    const source = `
element "org"
    attr "team" type=//element[.="team"]

element "team"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("org")!.attrs.get("team")).toEqual({
      name: "team",
      type: "ref",
      required: false,
      refElement: ["team"],
    });
  });

  it("supports a ref-constrained attr type= resolving to an inline-nested element", () => {
    const source = `
element "org"
    attr "team" type=//element[.="team"]
    element "team"
        attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("org")!.attrs.get("team")!.refElement).toEqual(["team"]);
  });

  it("throws when a ref-constrained attr type= cannot be resolved", () => {
    const source = `
element "org"
    attr "team" type=//element[.="nonexistent"]
`;
    expect(() => parseSchema(source)).toThrow(/could not resolve/i);
  });

  it("supports a wildcard '//*' xpath ref, matching any node", () => {
    const source = `
element "org"
    attr "team" type=//*[.="team"]

element "team"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("org")!.attrs.get("team")!.refElement).toEqual(["team"]);
  });

  it("allows a wildcard '//*' type= ref to match several declared elements, collecting them all", () => {
    const source = `
element "org"
    attr "member" type=//*

element "team"
    attr "name" type="string" required=true

element "service"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("org")!.attrs.get("member")!.refElement).toEqual(["org", "team", "service"]);
  });

  it("throws when a non-wildcard ref resolves to more than one declared element", () => {
    const source = `
element "org"
    attr "member" type=//element

element "team"
    attr "name" type="string" required=true

element "service"
    attr "name" type="string" required=true
`;
    expect(() => parseSchema(source)).toThrow(/is ambiguous -- it matches 3 declared elements/i);
  });

  it("supports a ref-constrained value type= resolving to a declared element", () => {
    const source = `
element "service"
    value type=//element[.="team"]

element "team"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("service")!.value).toEqual({
      type: "ref",
      required: false,
      refElement: ["team"],
    });
  });

  it("throws when a ref-constrained value type= cannot be resolved", () => {
    const source = `
element "service"
    value type=//element[.="nonexistent"]
`;
    expect(() => parseSchema(source)).toThrow(/could not resolve/i);
  });
});
