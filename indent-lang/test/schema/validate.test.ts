import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser.js";
import { parseSchema } from "../../src/schema/parse.js";
import { validateAgainstSchema } from "../../src/schema/validate.js";

const c4Schema = parseSchema(`
element "workspace"
    attr "name" type="string" required=true
    element //element[.="person"]
    element //element[.="softwareSystem"]

element "person"
    attr "name" type="string" required=true

element "softwareSystem"
    attr "name" type="string" required=true
    element //element[.="container"]

element "container"
    attr "name" type="string" required=true
    element //element[.="container"]
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

  it("flags an unknown element at the document root", () => {
    const doc = parse(`bogus name="x"\n`);
    const diagnostics = validateAgainstSchema(doc.roots, c4Schema);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toMatch(/unknown element 'bogus'/);
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
element "service"
    attr "port" type="number" required=true
`);
    const doc = parse(`service port="8080"\n`); // quoted string, not a number
    const diagnostics = validateAgainstSchema(doc.roots, schema);
    expect(diagnostics.some((d) => /must be of type 'number'/.test(d.message))).toBe(true);
  });

  it("flags under-minimum cardinality", () => {
    const schema = parseSchema(`
element "workspace"
    element //element[.="person"] minCount=1

element "person"
`);
    const doc = parse(`workspace\n`);
    const diagnostics = validateAgainstSchema(doc.roots, schema);
    expect(diagnostics.some((d) => /at least 1 time/.test(d.message))).toBe(true);
  });

  it("flags over-maximum cardinality", () => {
    const schema = parseSchema(`
element "workspace"
    element //element[.="person"] maxCount=1

element "person"
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
element "container"
    element //element[.="component"] minCount=1 maxCount=2

element "component"
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

  it("validates self-referential elements (container nested in container)", () => {
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
element "ul"
    element //element[.="li"]

element "li"
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
element "diagram"
    element //element[.="actor"]
    element //element[.="->"]

element "actor"
    attr "name" type="string" required=true

element "->"
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

  it("validates a document against an inline-nested element definition", () => {
    const schema = parseSchema(`
element "org"
    attr "name" type="string" required=true
    element "team" minCount=1
        attr "name" type="string" required=true
`);
    const ok = parse(`
org name="Acme"
    team name="Platform"
`);
    expect(validateAgainstSchema(ok.roots, schema)).toEqual([]);

    const missing = parse(`org name="Acme"\n`);
    const diagnostics = validateAgainstSchema(missing.roots, schema);
    expect(diagnostics.some((d) => /at least 1 time/.test(d.message))).toBe(true);
  });

  describe("'value type=' schema", () => {
    const teamSchema = parseSchema(`
element "team"
    value type="string" required=true
`);

    it("passes when the declared value type matches", () => {
      const doc = parse(`team "Platform"\n`);
      expect(validateAgainstSchema(doc.roots, teamSchema)).toEqual([]);
    });

    it("flags a missing required value", () => {
      const doc = parse(`team\n`);
      const diagnostics = validateAgainstSchema(doc.roots, teamSchema);
      expect(diagnostics.some((d) => /missing required value/.test(d.message))).toBe(true);
    });

    it("flags a mistyped value", () => {
      const doc = parse(`team 42\n`);
      const diagnostics = validateAgainstSchema(doc.roots, teamSchema);
      expect(diagnostics.some((d) => /must be of type 'string'/.test(d.message))).toBe(true);
    });

    it("flags an unexpected value when the element doesn't declare one", () => {
      const noValueSchema = parseSchema(`element "team"\n`);
      const doc = parse(`team "Platform"\n`);
      const diagnostics = validateAgainstSchema(doc.roots, noValueSchema);
      expect(diagnostics.some((d) => /does not declare a 'value' schema/.test(d.message))).toBe(
        true,
      );
    });

    it("permits an undeclared-but-optional value to be absent", () => {
      const optionalSchema = parseSchema(`
element "team"
    value type="string"
`);
      expect(validateAgainstSchema(parse(`team\n`).roots, optionalSchema)).toEqual([]);
    });
  });

  describe("ref-constrained 'type=' (attr and value)", () => {
    const refSchema = parseSchema(`
element "org"
    element "team"
        attr "name" type="string" required=true
    element "service"
        attr "team" type=//element[.="team"]
    element "assignment"
        value type=//element[.="team"]
`);

    it("passes when a ref-constrained attr resolves to the right element kind", () => {
      const doc = parse(`
org
    team name="Platform"
    service team=//team[name="Platform"]
`);
      expect(validateAgainstSchema(doc.roots, refSchema)).toEqual([]);
    });

    it("flags a ref-constrained attr resolving to the wrong element kind", () => {
      const doc = parse(`
org
    team name="Platform"
    service team=/org
`);
      const diagnostics = validateAgainstSchema(doc.roots, refSchema);
      expect(
        diagnostics.some((d) => /must resolve to an element of kind 'team'/.test(d.message)),
      ).toBe(true);
    });

    it("flags a ref-constrained attr that doesn't resolve to any node", () => {
      const doc = parse(`
org
    service team=//nonexistent
`);
      const diagnostics = validateAgainstSchema(doc.roots, refSchema);
      expect(diagnostics.some((d) => /does not resolve to any node/.test(d.message))).toBe(true);
    });

    it("passes when a ref-constrained value resolves to the right element kind", () => {
      const doc = parse(`
org
    team name="Platform"
    assignment //team[name="Platform"]
`);
      expect(validateAgainstSchema(doc.roots, refSchema)).toEqual([]);
    });

    it("flags a ref-constrained value resolving to the wrong element kind", () => {
      const doc = parse(`
org
    team name="Platform"
    assignment /org
`);
      const diagnostics = validateAgainstSchema(doc.roots, refSchema);
      expect(
        diagnostics.some((d) => /must resolve to an element of kind 'team'/.test(d.message)),
      ).toBe(true);
    });
  });
});
