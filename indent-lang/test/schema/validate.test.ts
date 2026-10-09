import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser.js";
import { parseSchema } from "../../src/schema/parse.js";
import { validateAgainstSchema } from "../../src/schema/validate.js";

const c4Schema = parseSchema(`
kind "workspace"
    attr "name" type="string" required=true
    kind //kind[.="person"]
    kind //kind[.="softwareSystem"]

kind "person"
    attr "name" type="string" required=true

kind "softwareSystem"
    attr "name" type="string" required=true
    kind //kind[.="container"]

kind "container"
    attr "name" type="string" required=true
    kind //kind[.="container"]
`);

describe("validateAgainstSchema", () => {
  it("returns no diagnostics for a valid document", () => {
    const doc = parse(`
workspace name="Acme"
    person name="User"
    softwareSystem name="App"
        container name="API"
        container name="DB"
`);
    expect(validateAgainstSchema(doc.roots, c4Schema)).toEqual([]);
  });

  it("flags an unknown kind at the document root", () => {
    const doc = parse(`bogus name="x"\n`);
    const diagnostics = validateAgainstSchema(doc.roots, c4Schema);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toMatch(/unknown kind 'bogus'/);
  });

  it("flags an unknown attribute", () => {
    const doc = parse(`workspace name="Acme" color="blue"\n`);
    const diagnostics = validateAgainstSchema(doc.roots, c4Schema);
    expect(diagnostics.some((d) => /unknown attribute 'color'/.test(d.message))).toBe(true);
  });

  it("flags a missing required attribute", () => {
    const doc = parse(`workspace\n`);
    const diagnostics = validateAgainstSchema(doc.roots, c4Schema);
    expect(diagnostics.some((d) => /missing required attribute 'name'/.test(d.message))).toBe(
      true,
    );
  });

  it("flags a mistyped attribute value", () => {
    const schema = parseSchema(`
kind "service"
    attr "port" type="number" required=true
`);
    const doc = parse(`service port="8080"\n`); // quoted string, not a number
    const diagnostics = validateAgainstSchema(doc.roots, schema);
    expect(diagnostics.some((d) => /must be of type 'number'/.test(d.message))).toBe(true);
  });

  it("flags under-minimum cardinality", () => {
    const schema = parseSchema(`
kind "workspace"
    kind //kind[.="person"] minCount=1

kind "person"
`);
    const doc = parse(`workspace\n`);
    const diagnostics = validateAgainstSchema(doc.roots, schema);
    expect(diagnostics.some((d) => /at least 1 time/.test(d.message))).toBe(true);
  });

  it("flags over-maximum cardinality", () => {
    const schema = parseSchema(`
kind "workspace"
    kind //kind[.="person"] maxCount=1

kind "person"
`);
    const doc = parse(`
workspace
    person
    person
`);
    const diagnostics = validateAgainstSchema(doc.roots, schema);
    expect(diagnostics.some((d) => /at most 1 time/.test(d.message))).toBe(true);
  });

  it("allows exact-range cardinality within bounds and flags outside it", () => {
    const schema = parseSchema(`
kind "container"
    kind //kind[.="component"] minCount=1 maxCount=2

kind "component"
`);
    const ok = parse(`
container
    component
    component
`);
    expect(validateAgainstSchema(ok.roots, schema)).toEqual([]);

    const tooMany = parse(`
container
    component
    component
    component
`);
    expect(validateAgainstSchema(tooMany.roots, schema).length).toBeGreaterThan(0);
  });

  it("validates self-referential kinds (container nested in container)", () => {
    const doc = parse(`
workspace name="Acme"
    softwareSystem name="App"
        container name="Outer"
            container name="Inner"
`);
    expect(validateAgainstSchema(doc.roots, c4Schema)).toEqual([]);
  });

  it("permits zero or many children by default (no min/max declared)", () => {
    const schema = parseSchema(`
kind "ul"
    kind //kind[.="li"]

kind "li"
`);
    expect(validateAgainstSchema(parse(`ul\n`).roots, schema)).toEqual([]);
    expect(
      validateAgainstSchema(
        parse(`
ul
    li
    li
    li
`).roots,
        schema,
      ),
    ).toEqual([]);
  });

  it("validates a sequence-diagram-shaped document (repeated '->' edges)", () => {
    const schema = parseSchema(`
kind "diagram"
    kind //kind[.="actor"]
    kind //kind[.="->"]

kind "actor"
    attr "name" type="string" required=true

kind "->"
    attr "label" type="string" required=true
`);
    const doc = parse(`
diagram
    actor name="User"
    actor name="System"
    -> label="request"
    -> label="response"
`);
    expect(validateAgainstSchema(doc.roots, schema)).toEqual([]);
  });
});
