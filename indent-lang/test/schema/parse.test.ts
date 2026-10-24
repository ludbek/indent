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

element "person" reusable=true
    attr "name" type="string" required=true

element "system" reusable=true
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

    // Every unmarked top-level element is implicitly allowed at the document
    // root with the default (unbounded) cardinality.
    expect(schema.roots.get("workspace")).toEqual({
      element: "workspace",
      minCount: 0,
      maxCount: Infinity,
    });
    // `person` is reusable, so it is not a document root.
    expect(schema.roots.has("person")).toBe(false);
  });

  it("supports exact min/max cardinality bounds", () => {
    const source = `
element "container"
    element //element[.="component"] minCount=1 maxCount=3

element "component" reusable=true
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
element "->" reusable=true
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

  it("supports inline nested element definitions, scoped under their parent", () => {
    const source = `
element "org"
    attr "name" type="string" required=true
    element "team"
        attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect([...schema.elements.keys()].sort()).toEqual(["org", "org/team"]);
    expect(schema.elements.get("org")!.children.get("team")).toEqual({
      element: "org/team",
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
    expect([...schema.elements.keys()].sort()).toEqual(["org", "org/team", "org/team/member"]);
    expect(schema.elements.get("org")!.children.get("team")).toEqual({
      element: "org/team",
      minCount: 1,
      maxCount: Infinity,
    });
    expect(schema.elements.get("org/team")!.children.get("member")).toEqual({
      element: "org/team/member",
      minCount: 0,
      maxCount: 5,
    });
  });

  it("rejects a child ref into another element's subtree, pointing at reusable=true", () => {
    const source = `
element "org"
    element "team"
        attr "name" type="string" required=true

element "other"
    element //element[.="team"]
`;
    expect(() => parseSchema(source)).toThrow(/resolves to 'org\/team', which is not reusable -- add 'reusable=true'/);
  });

  it("allows a child ref to a reusable top-level element, from several parents", () => {
    const source = `
element "link" reusable=true
    attr "href" type="string" required=true

element "html"
    element "head"
        element //element[.="link"]
    element "body"
        element //element[.="link"]
        element "div"
            element //element[.="link"]
`;
    const schema = parseSchema(source);
    for (const parent of ["html/head", "html/body", "html/body/div"]) {
      expect(schema.elements.get(parent)!.children.get("link")!.element).toBe("link");
    }
    expect(schema.elements.get("link")!.reusable).toBe(true);
    expect(schema.roots.has("link")).toBe(false);
    expect(schema.roots.has("html")).toBe(true);
  });

  it("rejects a child ref to an unmarked top-level element", () => {
    const source = `
element "service"
element "org"
    element //element[.="service"]
`;
    expect(() => parseSchema(source)).toThrow(/resolves to 'service', which is not reusable/);
  });

  it("allows a reusable element to reference itself (recursion)", () => {
    const source = `
element "group" reusable=true
    element //element[.="group"]

element "doc"
    element //element[.="group"]
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("group")!.children.get("group")!.element).toBe("group");
  });

  it("allows a nested element to reference itself or an ancestor (recursion)", () => {
    const source = `
element "softwareSystem"
    element "container"
        element //element[.="container"]
        element //element[.="softwareSystem"]
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("softwareSystem/container")!.children.get("container")!.element).toBe("softwareSystem/container");
    expect(schema.elements.get("softwareSystem/container")!.children.get("softwareSystem")!.element).toBe("softwareSystem");
  });

  it("rejects 'reusable' on a nested element line", () => {
    const source = `
element "org"
    element "team" reusable=true
`;
    expect(() => parseSchema(source)).toThrow(/'reusable' is only allowed on a top-level 'element' definition/);
  });

  it("rejects a non-boolean 'reusable' value", () => {
    expect(() => parseSchema(`element "a" reusable="yes"\n`)).toThrow(/'reusable=' must be a boolean/);
  });

  it("rejects an unknown attribute on a top-level element line", () => {
    expect(() => parseSchema(`element "a" bogus=1\n`)).toThrow(/unexpected attribute 'bogus' on top-level element 'a'/);
  });

  it("excludes reusable elements from roots, and rejects a schema with no root", () => {
    const ok = parseSchema(`
element "a"
element "b" reusable=true
`);
    expect([...ok.roots.keys()]).toEqual(["a"]);
    expect(() => parseSchema(`element "b" reusable=true\n`)).toThrow(/declares no document root/);
  });

  it("allows the same element name to be declared under different parents, as distinct elements", () => {
    const source = `
element "org"
    element "team"
        attr "name" type="string" required=true
    element "other"
        element "team"
            attr "title" type="string"
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("org/team")!.attrs.has("name")).toBe(true);
    expect(schema.elements.get("org/team")!.attrs.has("title")).toBe(false);
    expect(schema.elements.get("org/other/team")!.attrs.has("title")).toBe(true);
    expect(schema.elements.get("org/other")!.children.get("team")!.element).toBe("org/other/team");
  });

  it("allows an inline nested definition to reuse its parent's name", () => {
    const source = `
element "group"
    element "group"
        attr "label" type="string"
`;
    const schema = parseSchema(source);
    expect([...schema.elements.keys()].sort()).toEqual(["group", "group/group"]);
    expect(schema.elements.get("group")!.children.get("group")!.element).toBe("group/group");
  });

  it("throws when the same name is inline-defined twice under one parent", () => {
    const source = `
element "org"
    element "team"
    element "team"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
    expect(() => parseSchema(source)).toThrow(/duplicate child element 'team' on element 'org'/);
  });

  it("throws when a reusable ref and an inline definition give one parent two children of the same name", () => {
    const source = `
element "team" reusable=true

element "org"
    element "team"
    element /element[.="team"]
`;
    expect(() => parseSchema(source)).toThrow(/share the name 'team' on element 'org'/);
  });

  it("throws on a duplicate child ref to the same reusable element", () => {
    const source = `
element "team" reusable=true

element "org"
    element //element[.="team"]
    element //element[.="team"]
`;
    expect(() => parseSchema(source)).toThrow(/duplicate child element reference to 'team' on element 'org'/);
  });

  it("lets a top-level-qualified ref narrow a name that is also declared nested", () => {
    const source = `
element "team" reusable=true
    attr "x" type="string"

element "org"
    element "other"
        element "team"
            attr "y" type="string"

element "holder"
    element /element[.="team"]
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("holder")!.children.get("team")!.element).toBe("team");
    // The unqualified ref also matches the nested declaration, which is not shareable.
    expect(() => parseSchema(source.replace('/element[.="team"]', '//element[.="team"]'))).toThrow(
      /resolves to 'org\/other\/team', which is not reusable/,
    );
  });

  it("throws when an inline nested definition tries to directly self-nest with a duplicate sibling", () => {
    const source = `
element "team"
    element "team"
    element "team"
`;
    expect(() => parseSchema(source)).toThrow(/duplicate child element 'team' on element 'team'/);
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

element "person" reusable=true
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on negative minCount or maxCount < 1", () => {
    const negative = `
element "workspace"
    element //element[.="person"] minCount=-1

element "person" reusable=true
`;
    expect(() => parseSchema(negative)).toThrow(SchemaDefinitionError);

    const zeroMax = `
element "workspace"
    element //element[.="person"] maxCount=0

element "person" reusable=true
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
    expect(schema.elements.get("org")!.attrs.get("team")!.refElement).toEqual(["org/team"]);
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

  it("lets a non-wildcard type= ref match several declared elements -- the xpath is authoritative", () => {
    const source = `
element "org"
    attr "member" type=//element

element "team"
    attr "name" type="string" required=true

element "service"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.elements.get("org")!.attrs.get("member")!.refElement).toEqual(["org", "team", "service"]);
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
