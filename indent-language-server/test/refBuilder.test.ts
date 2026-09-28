import { describe, it, expect } from "vitest";
import { parseXPath, selectNodes } from "indent-xpath";
import { WorkspaceIndex } from "../src/indexer.js";
import { buildXPathForest } from "../src/xpathTree.js";
import {
  buildNodeRef,
  computeRefFrequencyMaps,
} from "../src/refBuilder.js";
import { getSearchableNodes } from "../src/nodeSearch.js";

describe("refBuilder", () => {
  // Fixture exercises all 3 tiers:
  // - Tier 1 (globally unique kind): `org`, `endpoint`.
  // - Tier 2 (unique kind+value pair): both `service` nodes, `api "Logout"`.
  // - Tier 3 (fallback, fully indexed path): both `team` nodes (no
  //   positional value, non-unique kind), and both `api "Login"` nodes
  //   (positional value collides across the two services).
  const uri = "file:///workspace/fixture.inml";
  const source = `org name="Acme"
    team name="Platform"
        service "Auth Service" owner="ateam" port=8080 active=true
            api "Login" method="POST"
                endpoint "Login Endpoint" path=/login
            api "Logout" method="POST"
    team name="Data"
        service "Data Service" owner="dteam" port=9090 active=false
            api "Login" method="GET"
`;

  function makeIndex(): WorkspaceIndex {
    const index = new WorkspaceIndex();
    index.setDocument(uri, source);
    return index;
  }

  it("Tier 1: emits //kind for a globally unique kind", () => {
    const index = makeIndex();
    const org = index.getNodeByPath("/org")!;
    expect(org).toBeDefined();
    expect(buildNodeRef(index, org)).toBe("//org");

    const endpoint = [...index.nodesByPath.values()].find((n) => n.kind === "endpoint")!;
    expect(endpoint).toBeDefined();
    expect(buildNodeRef(index, endpoint)).toBe("//endpoint");
  });

  it("Tier 2: emits //kind[.=value] for a unique (kind, value) pair", () => {
    const index = makeIndex();
    const authService = [...index.nodesByPath.values()].find(
      (n) => n.kind === "service" && n.value?.value === "Auth Service",
    )!;
    const dataService = [...index.nodesByPath.values()].find(
      (n) => n.kind === "service" && n.value?.value === "Data Service",
    )!;
    expect(buildNodeRef(index, authService)).toBe('//service[.="Auth Service"]');
    expect(buildNodeRef(index, dataService)).toBe('//service[.="Data Service"]');

    const logout = [...index.nodesByPath.values()].find(
      (n) => n.kind === "api" && n.value?.value === "Logout",
    )!;
    expect(buildNodeRef(index, logout)).toBe('//api[.="Logout"]');
  });

  it("Tier 3: falls back to a fully-indexed path when kind and (kind,value) both collide", () => {
    const index = makeIndex();
    const platformTeam = [...index.nodesByPath.values()].find(
      (n) => n.kind === "team" && n.attrs.name?.value === "Platform",
    )!;
    const dataTeam = [...index.nodesByPath.values()].find(
      (n) => n.kind === "team" && n.attrs.name?.value === "Data",
    )!;
    expect(buildNodeRef(index, platformTeam)).toBe("/org[0]/team[0]");
    expect(buildNodeRef(index, dataTeam)).toBe("/org[0]/team[1]");

    // Two distinct `api "Login"` nodes under different services -- kind
    // collides (3 api nodes total) AND (kind,value) collides (2 "Login"
    // nodes), so both must fall all the way to Tier 3, indexing every
    // segment from the root.
    const loginNodes = [...index.nodesByPath.values()].filter(
      (n) => n.kind === "api" && n.value?.value === "Login",
    );
    expect(loginNodes).toHaveLength(2);
    const refs = loginNodes.map((n) => buildNodeRef(index, n)).sort();
    expect(refs).toEqual([
      "/org[0]/team[0]/service[0]/api[0]",
      "/org[0]/team[1]/service[0]/api[0]",
    ]);
  });

  it("Tier 2 distinguishes string vs number/boolean values with the same textual form", () => {
    // A synthetic pair where the same kind has both a numeric and string
    // positional value that stringify identically -- must not collide.
    const index2 = new WorkspaceIndex();
    index2.setDocument(
      "file:///workspace/typed.inml",
      `org name="X"
    widget 42
    widget "42"
`,
    );
    const numeric = [...index2.nodesByPath.values()].find(
      (n) => n.kind === "widget" && typeof n.value?.value === "number",
    )!;
    const stringy = [...index2.nodesByPath.values()].find(
      (n) => n.kind === "widget" && typeof n.value?.value === "string",
    )!;
    expect(buildNodeRef(index2, numeric)).toBe("//widget[.=42]");
    expect(buildNodeRef(index2, stringy)).toBe('//widget[.="42"]');
  });

  it("computeRefFrequencyMaps can be precomputed once and reused across calls", () => {
    const index = makeIndex();
    const freq = computeRefFrequencyMaps(index);
    for (const node of index.nodesByPath.values()) {
      expect(buildNodeRef(index, node, freq)).toBe(buildNodeRef(index, node));
    }
  });

  it("round-trips: every generated ref resolves back through indent-xpath to exactly its own node", () => {
    const index = makeIndex();
    const forest = buildXPathForest(index.rootNodes, index.nodesByPath);
    for (const node of index.nodesByPath.values()) {
      const ref = buildNodeRef(index, node);
      const parsed = parseXPath(ref);
      const results = selectNodes(forest, parsed);
      expect(results, `ref ${ref} for ${node.canonicalPath} should resolve to exactly 1 node`).toHaveLength(1);
      expect(results[0].indexedNode.id).toBe(node.id);
    }
  });

  it("getSearchableNodes returns one entry per workspace node with label/description/detail/ref", () => {
    const index = makeIndex();
    const items = getSearchableNodes(index);
    expect(items.length).toBe(index.nodesByPath.size);
    const org = items.find((i) => i.ref === "//org")!;
    expect(org).toBeDefined();
    expect(org.detail).toBe('org name="Acme"');
    expect(org.description).toBe("org");
    expect(org.label).toBe("Acme");
  });

  it("getSearchableNodes detail is the node's own source statement, excluding children", () => {
    const index = makeIndex();
    const items = getSearchableNodes(index);
    const authService = items.find((i) => i.ref === '//service[.="Auth Service"]')!;
    expect(authService).toBeDefined();
    expect(authService.detail).toBe(
      'service "Auth Service" owner="ateam" port=8080 active=true',
    );

    const endpoint = items.find((i) => i.ref === "//endpoint")!;
    expect(endpoint).toBeDefined();
    expect(endpoint.detail).toBe('endpoint "Login Endpoint" path=/login');
  });
});
