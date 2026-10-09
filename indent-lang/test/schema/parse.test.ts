import { describe, expect, it } from "vitest";
import { parseSchema } from "../../src/schema/parse.js";
import { SchemaDefinitionError } from "../../src/schema/types.js";

describe("parseSchema", () => {
  it("parses a schema with attrs and references, applying cardinality defaults", () => {
    const source = `
kind "workspace"
    attr "name" type="string" required=true
    kind //kind[.="person"]
    kind //kind[.="system"] minCount=1

kind "person"
    attr "name" type="string" required=true

kind "system"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);

    expect([...schema.kinds.keys()].sort()).toEqual(["person", "system", "workspace"]);

    const workspace = schema.kinds.get("workspace")!;
    expect(workspace.attrs.get("name")).toEqual({ name: "name", type: "string", required: true });
    expect(workspace.children.get("person")).toEqual({
      kind: "person",
      minCount: 0,
      maxCount: Infinity,
    });
    expect(workspace.children.get("system")).toEqual({
      kind: "system",
      minCount: 1,
      maxCount: Infinity,
    });

    // Every top-level kind is implicitly allowed at the document root with
    // the default (unbounded) cardinality.
    expect(schema.roots.get("workspace")).toEqual({
      kind: "workspace",
      minCount: 0,
      maxCount: Infinity,
    });
    expect(schema.roots.get("person")).toEqual({ kind: "person", minCount: 0, maxCount: Infinity });
  });

  it("supports exact min/max cardinality bounds", () => {
    const source = `
kind "container"
    kind //kind[.="component"] minCount=1 maxCount=3

kind "component"
    attr "name" type="string" required=true
`;
    const schema = parseSchema(source);
    expect(schema.kinds.get("container")!.children.get("component")).toEqual({
      kind: "component",
      minCount: 1,
      maxCount: 3,
    });
  });

  it("supports self-referential kinds (e.g. container containing container)", () => {
    const source = `
kind "container"
    kind //kind[.="container"]
`;
    const schema = parseSchema(source);
    const container = schema.kinds.get("container")!;
    expect(container.children.get("container")).toEqual({
      kind: "container",
      minCount: 0,
      maxCount: Infinity,
    });
  });

  it("supports edge kinds like '->' via quoted ref predicates", () => {
    const source = `
kind "->"
    attr "label" type="string" required=true
    attr "to" type="ref" required=true

kind "node"
    kind //kind[.="->"]
`;
    const schema = parseSchema(source);
    expect(schema.kinds.has("->")).toBe(true);
    expect(schema.kinds.get("node")!.children.get("->")).toEqual({
      kind: "->",
      minCount: 0,
      maxCount: Infinity,
    });
  });

  it("throws when a child-kind reference is unresolved", () => {
    const source = `
kind "workspace"
    kind //kind[.="nonexistent"]
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
    expect(() => parseSchema(source)).toThrow(/could not resolve/i);
  });

  it("throws when a nested kind line uses a plain quoted name instead of a ref", () => {
    const source = `
kind "workspace"
    kind "person"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on duplicate top-level kind definitions", () => {
    const source = `
kind "person"
kind "person"
`;
    expect(() => parseSchema(source)).toThrow(/duplicate/i);
  });

  it("throws on an invalid attr type=", () => {
    const source = `
kind "person"
    attr "name" type="weird"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on invalid cardinality (minCount > maxCount)", () => {
    const source = `
kind "workspace"
    kind //kind[.="person"] minCount=5 maxCount=2

kind "person"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws on negative minCount or maxCount < 1", () => {
    const negative = `
kind "workspace"
    kind //kind[.="person"] minCount=-1

kind "person"
`;
    expect(() => parseSchema(negative)).toThrow(SchemaDefinitionError);

    const zeroMax = `
kind "workspace"
    kind //kind[.="person"] maxCount=0

kind "person"
`;
    expect(() => parseSchema(zeroMax)).toThrow(SchemaDefinitionError);
  });

  it("throws when a non-kind/attr line appears inside a kind definition", () => {
    const source = `
kind "person"
    bogus "x"
`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });

  it("throws when a root-level line isn't a 'kind' node", () => {
    const source = `attr "name" type="string"\n`;
    expect(() => parseSchema(source)).toThrow(SchemaDefinitionError);
  });
});
