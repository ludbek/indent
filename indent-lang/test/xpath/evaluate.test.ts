import { describe, expect, it } from "vitest";
import { selectNodes } from "../../src/xpath/evaluate.js";
import type { XPathNode } from "../../src/xpath/types.js";

/**
 * Builds a small fixture tree, hand-written as plain object literals
 * satisfying `XPathNode` -- deliberately not using `indent-lang` so this
 * package stays fully decoupled, even in tests.
 *
 *   org (name="Acme")
 *     team (name="Platform")
 *       service "Auth Service" (owner="ateam", port=8080, active=true)
 *         api "Login" (method="POST")
 *           endpoint "Login Endpoint" (path="/login")
 *         api "Logout" (method="POST")
 *     team (name="Data")
 *       service "Data Service" (owner="dteam", port=9090, active=false)
 *         api "Query" (method="GET")
 */
function buildFixture(): XPathNode[] {
  const loginEndpoint: XPathNode = {
    kind: "endpoint",
    value: "Login Endpoint",
    attrs: { path: "/login" },
    children: [],
  };
  const loginApi: XPathNode = {
    kind: "api",
    value: "Login",
    attrs: { method: "POST" },
    children: [loginEndpoint],
  };
  const logoutApi: XPathNode = {
    kind: "api",
    value: "Logout",
    attrs: { method: "POST" },
    children: [],
  };
  const authService: XPathNode = {
    kind: "service",
    value: "Auth Service",
    attrs: { owner: "ateam", port: 8080, active: true },
    children: [loginApi, logoutApi],
  };
  const platformTeam: XPathNode = {
    kind: "team",
    attrs: { name: "Platform" },
    children: [authService],
  };

  const queryApi: XPathNode = {
    kind: "api",
    value: "Query",
    attrs: { method: "GET" },
    children: [],
  };
  const dataService: XPathNode = {
    kind: "service",
    value: "Data Service",
    attrs: { owner: "dteam", port: 9090, active: false },
    children: [queryApi],
  };
  const dataTeam: XPathNode = {
    kind: "team",
    attrs: { name: "Data" },
    children: [dataService],
  };

  const org: XPathNode = {
    kind: "org",
    attrs: { name: "Acme" },
    children: [platformTeam, dataTeam],
  };

  return [org];
}

describe("selectNodes", () => {
  const roots = buildFixture();

  it("selects an exact node via an absolute path", () => {
    const result = selectNodes(roots, "/org/team/service");
    expect(result.map((n) => n.value)).toEqual(["Auth Service", "Data Service"]);
  });

  it("selects a deeply nested node via an absolute path", () => {
    const result = selectNodes(roots, "/org/team/service/api/endpoint");
    expect(result.map((n) => n.value)).toEqual(["Login Endpoint"]);
  });

  it("returns no matches for a wrong absolute path", () => {
    expect(selectNodes(roots, "/org/service")).toEqual([]);
  });

  it("selects any node anywhere via a leading descendant path", () => {
    const result = selectNodes(roots, "//api");
    expect(result.map((n) => n.value)).toEqual(["Login", "Logout", "Query"]);
  });

  it("finds the root itself when it matches a descendant path", () => {
    const result = selectNodes(roots, "//org");
    expect(result).toEqual(roots);
  });

  it("selects nested descendants via a mid-path descendant step", () => {
    const result = selectNodes(roots, "//service//endpoint");
    expect(result.map((n) => n.value)).toEqual(["Login Endpoint"]);
  });

  it("matches case-insensitively on kind", () => {
    const result = selectNodes(roots, "//SERVICE");
    expect(result).toHaveLength(2);
  });

  describe("wildcard step name", () => {
    it("'//*' matches every node in the tree (root + all descendants)", () => {
      const result = selectNodes(roots, "//*");
      // 1 org + 2 team + 2 service + 3 api + 1 endpoint = 9
      expect(result).toHaveLength(9);
    });

    it("'/*' matches only top-level roots", () => {
      const result = selectNodes(roots, "/*");
      expect(result).toEqual(roots);
    });

    it("'/org/*' matches only direct children of a matched step", () => {
      const result = selectNodes(roots, "/org/*");
      expect(result.map((n) => n.kind)).toEqual(["team", "team"]);
    });

    it("combines a wildcard with a self-value predicate", () => {
      const result = selectNodes(roots, '//*[.="Login"]');
      expect(result.map((n) => n.kind)).toEqual(["api"]);
    });

    it("combines a wildcard with a positional index predicate", () => {
      const result = selectNodes(roots, "//*[1]");
      // 0-indexed, so this is the 2nd node in depth-first pre-order
      // across the whole tree (the `*` kind-match is universal).
      expect(result).toHaveLength(1);
    });
  });

  describe("attribute predicates", () => {
    it("filters by exact string attribute value", () => {
      const result = selectNodes(roots, '//service[owner="ateam"]');
      expect(result.map((n) => n.value)).toEqual(["Auth Service"]);
    });

    it("filters by numeric attribute value", () => {
      const result = selectNodes(roots, "//service[port=9090]");
      expect(result.map((n) => n.value)).toEqual(["Data Service"]);
    });

    it("filters by boolean attribute value", () => {
      const result = selectNodes(roots, "//service[active=true]");
      expect(result.map((n) => n.value)).toEqual(["Auth Service"]);
    });

    it("filters by attribute existence only", () => {
      const result = selectNodes(roots, "//service[owner]");
      expect(result).toHaveLength(2);
    });

    it("does not match when attribute is missing", () => {
      const result = selectNodes(roots, "//api[owner]");
      expect(result).toEqual([]);
    });

    it("does not match a numeric attribute against a same-looking quoted string", () => {
      const result = selectNodes(roots, '//service[port="9090"]');
      expect(result).toEqual([]);
    });

    it("filters by a comma-separated multi-predicate list, ANDed together", () => {
      const result = selectNodes(roots, '//service[owner="ateam",port=8080]');
      expect(result.map((n) => n.value)).toEqual(["Auth Service"]);
    });

    it("does not match when only some clauses of a multi-predicate list are satisfied", () => {
      const result = selectNodes(roots, '//service[owner="ateam",port=9090]');
      expect(result).toEqual([]);
    });
  });

  describe("self-value predicates", () => {
    it("filters by exact positional value (string)", () => {
      const result = selectNodes(roots, '//service[.="Auth Service"]');
      expect(result.map((n) => n.attrs?.owner)).toEqual(["ateam"]);
    });

    it("filters by exact positional value (across kinds)", () => {
      const result = selectNodes(roots, '//api[.="Query"]');
      expect(result).toHaveLength(1);
      expect(result[0].attrs?.method).toBe("GET");
    });

    it("does not match a node with no positional value", () => {
      const result = selectNodes(roots, '//team[.="Platform"]');
      expect(result).toEqual([]);
    });
  });

  it("accepts a pre-parsed ParsedXPath to avoid re-parsing", () => {
    const parsed = { isAbsolute: false, isDescendant: true, raw: "//api", steps: [{ axis: "descendant" as const, name: "api" }] };
    const result = selectNodes(roots, parsed);
    expect(result).toHaveLength(3);
  });

  describe("index predicates", () => {
    it("selects the Nth same-kind child on a child-axis step", () => {
      // org's children (mixed kinds): [platformTeam, dataTeam] -- both "team"
      const result = selectNodes(roots, "/org/team[1]");
      expect(result.map((n) => n.attrs?.name)).toEqual(["Data"]);
    });

    it("selects the 0th same-kind child on a child-axis step", () => {
      const result = selectNodes(roots, "/org/team[0]");
      expect(result.map((n) => n.attrs?.name)).toEqual(["Platform"]);
    });

    it("resolves a full path built entirely from index predicates", () => {
      // /org[0]/team[0]/service[0]/api[1] -> authService's second api (Logout)
      const result = selectNodes(roots, "/org[0]/team[0]/service[0]/api[1]");
      expect(result.map((n) => n.value)).toEqual(["Logout"]);
    });

    it("selects the Nth same-kind node in depth-first pre-order on a descendant-axis step", () => {
      // //api in DFS pre-order across the whole tree: Login, Logout, Query
      const result = selectNodes(roots, "//api[2]");
      expect(result.map((n) => n.value)).toEqual(["Query"]);
    });

    it("returns no matches for an out-of-range child-axis index", () => {
      expect(selectNodes(roots, "/org/team[5]")).toEqual([]);
    });

    it("returns no matches for an out-of-range descendant-axis index", () => {
      expect(selectNodes(roots, "//api[99]")).toEqual([]);
    });

    it("combines a descendant index step with a subsequent child step", () => {
      // //service[1] -> Data Service, then its api child
      const result = selectNodes(roots, "//service[1]/api");
      expect(result.map((n) => n.value)).toEqual(["Query"]);
    });
  });
});
