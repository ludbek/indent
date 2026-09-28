import { describe, it, expect } from "vitest";
import { parseXPath, selectNodes } from "indent-xpath";
import { WorkspaceIndex } from "../src/indexer.js";
import { buildXPathForest } from "../src/xpathTree.js";

describe("Ref Reference Resolver", () => {
  const index = new WorkspaceIndex();
  index.setDocument(
    "file:///main.inml",
    `org name="Rest"
    service name="partner"
        API name="Health"
            -> entity=/org[name="Rest"]/service[name="RDS"]/database
    service name="RDS"
        database name="api_data"
            table "users"
org name="Globex"
    service name="core"
`
  );

  const forest = () => buildXPathForest(index.rootNodes, index.nodesByPath);

  it("parses absolute XPath expressions (only absolute/descendant paths are supported)", () => {
    const abs = parseXPath('/org[name="Rest"]/service[name="RDS"]/database');
    expect(abs.isAbsolute).toBe(true);
    expect(abs.steps.map((s) => s.name)).toEqual(["org", "service", "database"]);
    expect(abs.steps[0].predicate).toEqual({
      type: "attr",
      predicates: [{ name: "name", value: "Rest" }],
    });
  });

  it("rejects relative paths -- no longer supported by the new dialect", () => {
    expect(() => parseXPath('../service[name="RDS"]/database')).toThrow();
  });

  it("evaluates absolute XPath correctly", () => {
    const parsed = parseXPath('/org[name="Rest"]/service[name="RDS"]/database');
    const results = selectNodes(forest(), parsed);
    expect(results).toHaveLength(1);
    expect(results[0].indexedNode.canonicalPath).toBe(
      '/org[name="Rest"]/service[name="RDS"]/database'
    );
  });

  it("evaluates descendant search //", () => {
    const parsed = parseXPath("//table");
    const results = selectNodes(forest(), parsed);
    expect(results).toHaveLength(1);
    expect(results[0].indexedNode.canonicalPath).toBe(
      '/org[name="Rest"]/service[name="RDS"]/database/table'
    );
  });

  it("supports mid-path descendant axis //", () => {
    // /org[name="Rest"]//table should find the table node deep under Rest
    const parsed = parseXPath('/org[name="Rest"]//table');
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].axis).toBe("child");
    expect(parsed.steps[1].axis).toBe("descendant");
    expect(parsed.steps[1].name).toBe("table");

    const results = selectNodes(forest(), parsed);
    expect(results).toHaveLength(1);
    expect(results[0].indexedNode.kind).toBe("table");
  });

  it("supports comma-separated multi-predicate AND lists", () => {
    const parsed = parseXPath('/org[name="Rest"]/service[name="RDS",name="RDS"]');
    const results = selectNodes(forest(), parsed);
    expect(results).toHaveLength(1);
    expect(results[0].indexedNode.canonicalPath).toBe('/org[name="Rest"]/service[name="RDS"]');
  });

  it("supports the bracketed [.=value] self-value predicate", () => {
    const parsed = parseXPath('//table[.="users"]');
    const results = selectNodes(forest(), parsed);
    expect(results).toHaveLength(1);
    expect(results[0].indexedNode.canonicalPath).toBe(
      '/org[name="Rest"]/service[name="RDS"]/database/table'
    );
  });

  it("resolves a node's own positional value when it is a ref", () => {
    const refIndex = new WorkspaceIndex();
    refIndex.setDocument(
      "file:///positional.inml",
      `org name="Rest"
    service name="RDS"
        database name="api_data"
alias /org[name="Rest"]/service[name="RDS"]/database
`
    );
    const aliasRef = refIndex.refReferences.find((r) => r.attrName === undefined);
    expect(aliasRef).toBeDefined();
    // No sibling collisions in this fixture (single org/service/database),
    // so canonical paths have no disambiguating predicates.
    expect(aliasRef!.resolvedTargetPaths).toEqual(["/org/service/database"]);
  });
});
