import { describe, it, expect, beforeAll } from "vitest";
import { CstParser } from "../src/cst.js";

describe("CstParser", () => {
  let parser: CstParser;

  beforeAll(async () => {
    parser = await CstParser.create();
  });

  it("parses basic statements with exact positions", () => {
    const text = `org name="Acme" color="green"
    team name="Platform"
        API name="Health"
`;
    const { doc } = parser.parse("file:///test.inml", text);
    expect(doc.roots).toHaveLength(1);
    const org = doc.roots[0];
    expect(org.kind).toBe("org");
    expect(org.attrs.name.value).toBe("Acme");
    expect(org.attrs.name.valueRange).toEqual({
      start: { line: 0, character: 9 },
      end: { line: 0, character: 15 },
    });
    expect(org.attrs.color.value).toBe("green");
    expect(org.children).toHaveLength(1);

    const team = org.children[0];
    expect(team.kind).toBe("team");
    expect(team.children).toHaveLength(1);

    const api = team.children[0];
    expect(api.kind).toBe("API");
    expect(api.attrs.name.value).toBe("Health");
  });

  it("parses unquoted numbers, booleans, and ref values", () => {
    const text = `service name="api" count=10 active=true
    -> entity=/Rest/RDS/table
    => entity=//other/api
`;
    const { doc } = parser.parse("file:///test.inml", text);
    const service = doc.roots[0];
    expect(service.attrs.count.value).toBe(10);
    expect(service.attrs.count.valueType).toBe("number");
    expect(service.attrs.active.value).toBe(true);
    expect(service.attrs.active.valueType).toBe("boolean");

    expect(service.children).toHaveLength(2);
    const edge1 = service.children[0];
    expect(edge1.kind).toBe("->");
    expect(edge1.attrs.entity.value).toBe("/Rest/RDS/table");
    expect(edge1.attrs.entity.valueType).toBe("ref");

    const edge2 = service.children[1];
    expect(edge2.kind).toBe("=>");
    expect(edge2.attrs.entity.value).toBe("//other/api");
    expect(edge2.attrs.entity.valueType).toBe("ref");
  });

  it("identifies include paths", () => {
    const text = `org name="Acme"
    !include "./teams/platform.inml"
`;
    const { doc } = parser.parse("file:///test.inml", text);
    expect(doc.roots[0].children[0].isInclude).toBe(true);
    expect(doc.roots[0].children[0].includePath).toBe("./teams/platform.inml");
  });

  it("parses positional values (string, number, boolean)", () => {
    const text = `service "Auth Service" owner="ateam"
database 123 is_active=true
flag false
`;
    const { doc } = parser.parse("file:///test.inml", text);
    expect(doc.roots).toHaveLength(3);

    const service = doc.roots[0];
    expect(service.kind).toBe("service");
    expect(service.value?.value).toBe("Auth Service");
    expect(service.value?.valueType).toBe("string");
    expect(service.attrs.owner.value).toBe("ateam");

    const db = doc.roots[1];
    expect(db.kind).toBe("database");
    expect(db.value?.value).toBe(123);
    expect(db.value?.valueType).toBe("number");
    expect(db.attrs.is_active.value).toBe(true);

    const flag = doc.roots[2];
    expect(flag.kind).toBe("flag");
    expect(flag.value?.value).toBe(false);
    expect(flag.value?.valueType).toBe("boolean");
  });
});
