import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { IndentParseError } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("parse", () => {
  it("returns an empty roots array for empty input", () => {
    expect(parse("")).toEqual({ roots: [] });
    expect(parse("\n\n; only comments\n")).toEqual({ roots: [] });
  });

  it("parses multiple root-level siblings", () => {
    const result = parse('org name="Acme"\norg name="Globex"\n');
    expect(result.roots).toHaveLength(2);
    expect(result.roots[0].attrs.name).toBe("Acme");
    expect(result.roots[1].attrs.name).toBe("Globex");
  });

  it("builds nested children from indentation depth", () => {
    const result = parse(
      'org name="Acme"\n    team name="AcmePhoenix"\n    team name="AcmeDataTeam"\n',
    );
    expect(result.roots).toHaveLength(1);
    const org = result.roots[0];
    expect(org.kind).toBe("org");
    expect(org.children).toHaveLength(2);
    expect(org.children[0]).toEqual({ kind: "team", attrs: { name: "AcmePhoenix" }, children: [] });
    expect(org.children[1].attrs.name).toBe("AcmeDataTeam");
  });

  it("parses a line continued across multiple physical lines with '\\'", () => {
    const result = parse(
      'org name="Acme" \\\n    color="blue" \\\n    pk=true\n    team name="Phoenix"\n',
    );
    expect(result.roots).toHaveLength(1);
    const org = result.roots[0];
    expect(org.kind).toBe("org");
    expect(org.attrs).toEqual({ name: "Acme", color: "blue", pk: true });
    expect(org.children).toHaveLength(1);
    expect(org.children[0].attrs.name).toBe("Phoenix");
  });

  it("parses the full sample fixture, including -> as a generic child node", () => {
    const source = readFileSync(join(__dirname, "fixtures/sample.inml"), "utf8");
    const result = parse(source);

    expect(result.roots).toHaveLength(2);
    const org = result.roots[0];
    expect(org).toMatchObject({ kind: "org", attrs: { name: "Acme", color: "green" } });
    expect(org.children.map((c) => c.kind)).toEqual(["team", "team", "service"]);

    const service = org.children[2];
    expect(service.attrs.name).toBe("user-service");
    expect(service.children).toHaveLength(1);

    const api = service.children[0];
    expect(api.kind).toBe("API");
    expect(api.attrs.name).toBe("rollover");
    expect(api.children).toHaveLength(1);

    const ref = api.children[0];
    expect(ref).toEqual({
      kind: "->",
      attrs: { entity: "Globex/super/rollover" },
      children: [],
    });

    const globexOrg = result.roots[1];
    expect(globexOrg).toMatchObject({ kind: "org", attrs: { name: "Globex" } });
    expect(globexOrg.children).toHaveLength(1);

    const globexService = globexOrg.children[0];
    expect(globexService.kind).toBe("service");
    expect(globexService.attrs.name).toBe("super");
    expect(globexService.children).toHaveLength(1);

    const globexApi = globexService.children[0];
    expect(globexApi).toEqual({ kind: "API", attrs: { name: "rollover" }, children: [] });
  });

  it("parses spaces indentation, inline comments, and => edges", () => {
    const input = `org name="Org" color="green"
    team name="Foo"
    service name="user-service"
        API name="Rollover" type="REST"
            => entity="/UpstreamOrg/Member/Rollover" ; synchronous API call
            -> entity="/Org/Event Handlers/PII Handler" ; asynchronous
    service name="Event Handlers"
        event-handler name="PII Handler"
`;
    const result = parse(input);
    expect(result.roots).toHaveLength(1);
    const org = result.roots[0];
    expect(org.children).toHaveLength(3);
    const smApi = org.children[1];
    expect(smApi.children[0].children).toHaveLength(2);
    expect(smApi.children[0].children[0]).toEqual({
      kind: "=>",
      attrs: { entity: "/UpstreamOrg/Member/Rollover" },
      children: [],
    });
    expect(smApi.children[0].children[1]).toEqual({
      kind: "->",
      attrs: { entity: "/Org/Event Handlers/PII Handler" },
      children: [],
    });
  });

  it("throws on an invalid indentation jump", () => {
    expect(() => parse('org name="Acme"\n        team name="AcmePhoenix"\n')).toThrow(
      IndentParseError,
    );
  });

  it("throws on indentation with no preceding root", () => {
    expect(() => parse('    team name="AcmePhoenix"\n')).toThrow(IndentParseError);
  });

  it("builds AST with positional values for nodes and nested children", () => {
    const input = `org "Org"
    service "Auth Service" owner="ateam"
        database 123 active=true
        -> "/UpstreamOrg/Member"
`;
    const result = parse(input);
    expect(result.roots).toEqual([
      {
        kind: "org",
        value: "Org",
        attrs: {},
        children: [
          {
            kind: "service",
            value: "Auth Service",
            attrs: { owner: "ateam" },
            children: [
              {
                kind: "database",
                value: 123,
                attrs: { active: true },
                children: [],
              },
              {
                kind: "->",
                value: "/UpstreamOrg/Member",
                attrs: {},
                children: [],
              },
            ],
          },
        ],
      },
    ]);
  });
});
