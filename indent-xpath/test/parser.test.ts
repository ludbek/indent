import { describe, expect, it } from "vitest";
import { parseXPath } from "../src/parser.js";
import { XPathParseError } from "../src/types.js";

describe("parseXPath", () => {
  it("parses an absolute path", () => {
    const parsed = parseXPath("/org/service/api");
    expect(parsed.isAbsolute).toBe(true);
    expect(parsed.isDescendant).toBe(false);
    expect(parsed.steps).toEqual([
      { axis: "child", name: "org", predicate: undefined },
      { axis: "child", name: "service", predicate: undefined },
      { axis: "child", name: "api", predicate: undefined },
    ]);
  });

  it("parses a leading descendant path", () => {
    const parsed = parseXPath("//api");
    expect(parsed.isAbsolute).toBe(false);
    expect(parsed.isDescendant).toBe(true);
    expect(parsed.steps).toEqual([{ axis: "descendant", name: "api", predicate: undefined }]);
  });

  it("parses a mid-path descendant step", () => {
    const parsed = parseXPath("//service//endpoint");
    expect(parsed.steps).toEqual([
      { axis: "descendant", name: "service", predicate: undefined },
      { axis: "descendant", name: "endpoint", predicate: undefined },
    ]);
  });

  it("parses an absolute path with a mid-path descendant step", () => {
    const parsed = parseXPath("/org//endpoint");
    expect(parsed.isAbsolute).toBe(true);
    expect(parsed.steps).toEqual([
      { axis: "child", name: "org", predicate: undefined },
      { axis: "descendant", name: "endpoint", predicate: undefined },
    ]);
  });

  describe("kind/step names", () => {
    it("parses a hyphenated kind/step name", () => {
      const parsed = parseXPath("/auth-server/api");
      expect(parsed.steps).toEqual([
        { axis: "child", name: "auth-server", predicate: undefined },
        { axis: "child", name: "api", predicate: undefined },
      ]);
    });

    it("parses an underscore-prefixed kind/step name", () => {
      const parsed = parseXPath("/_foo/api");
      expect(parsed.steps[0]).toEqual({ axis: "child", name: "_foo", predicate: undefined });
    });

    it("parses an edge-marker kind/step name ('->'/'=>')", () => {
      const parsed = parseXPath("/api/->");
      expect(parsed.steps).toEqual([
        { axis: "child", name: "api", predicate: undefined },
        { axis: "child", name: "->", predicate: undefined },
      ]);

      const parsed2 = parseXPath("/api/=>");
      expect(parsed2.steps[1]).toEqual({ axis: "child", name: "=>", predicate: undefined });
    });
  });

  describe("attribute predicates", () => {
    it("parses an existence-only predicate", () => {
      const parsed = parseXPath("//service[owner]");
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "owner" }],
      });
    });

    it("parses a quoted string value", () => {
      const parsed = parseXPath('//service[type="REST"]');
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "type", value: "REST" }],
      });
    });

    it("parses an unquoted number value", () => {
      const parsed = parseXPath("//port[number=8080]");
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "number", value: 8080 }],
      });
    });

    it("parses a negative decimal number value", () => {
      const parsed = parseXPath("//metric[delta=-3.5]");
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "delta", value: -3.5 }],
      });
    });

    it("parses an unquoted boolean value", () => {
      const parsed = parseXPath("//flag[active=true]");
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "active", value: true }],
      });
    });

    it("unescapes a quoted string containing an escaped quote", () => {
      const parsed = parseXPath('//node[label="say \\"hi\\""]');
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "label", value: 'say "hi"' }],
      });
    });

    it("parses a hyphenated attribute name", () => {
      const parsed = parseXPath("//service[foo-bar]");
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "foo-bar" }],
      });
    });

    it("parses an underscore-prefixed attribute name", () => {
      const parsed = parseXPath("//service[_foo]");
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [{ name: "_foo" }],
      });
    });

    it("allows a `/` inside a quoted predicate value without splitting the path", () => {
      const parsed = parseXPath('//node[path="a/b"]/child');
      expect(parsed.steps).toEqual([
        {
          axis: "descendant",
          name: "node",
          predicate: { type: "attr", predicates: [{ name: "path", value: "a/b" }] },
        },
        { axis: "child", name: "child", predicate: undefined },
      ]);
    });

    it("parses a comma-separated multi-predicate list, ANDed together", () => {
      const parsed = parseXPath('//service[owner="ateam",port=8080]');
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [
          { name: "owner", value: "ateam" },
          { name: "port", value: 8080 },
        ],
      });
    });

    it("allows a `,` inside a quoted value without splitting the predicate list", () => {
      const parsed = parseXPath('//node[label="a,b",owner="x"]');
      expect(parsed.steps[0].predicate).toEqual({
        type: "attr",
        predicates: [
          { name: "label", value: "a,b" },
          { name: "owner", value: "x" },
        ],
      });
    });
  });

  describe("self-value predicates", () => {
    it("parses a quoted string self value", () => {
      const parsed = parseXPath('//service[.="Auth Service"]');
      expect(parsed.steps[0].predicate).toEqual({ type: "self", value: "Auth Service" });
    });

    it("parses a numeric self value", () => {
      const parsed = parseXPath("//port[.=8080]");
      expect(parsed.steps[0].predicate).toEqual({ type: "self", value: 8080 });
    });

    it("parses a boolean self value", () => {
      const parsed = parseXPath("//flag[.=true]");
      expect(parsed.steps[0].predicate).toEqual({ type: "self", value: true });
    });
  });

  describe("index predicates", () => {
    it("parses a bare digit-only bracket body as a positional index", () => {
      const parsed = parseXPath("/org/service[2]");
      expect(parsed.steps[1].predicate).toEqual({ type: "index", index: 2 });
    });

    it("parses index 0", () => {
      const parsed = parseXPath("//api[0]");
      expect(parsed.steps[0].predicate).toEqual({ type: "index", index: 0 });
    });

    it("does not confuse a numeric attribute name with an index predicate (attribute names are never pure digits)", () => {
      // Sanity check: a name=value clause with a leading digit-like name is
      // still invalid per NAME_REGEX rules elsewhere -- this test just pins
      // that a bare digit body always takes the index branch, never attr.
      const parsed = parseXPath("//service[3]");
      expect(parsed.steps[0].predicate).toEqual({ type: "index", index: 3 });
    });
  });

  describe("errors", () => {
    it("rejects a relative path with no leading slash", () => {
      expect(() => parseXPath("service/api")).toThrow(XPathParseError);
    });

    it("rejects an empty expression", () => {
      expect(() => parseXPath("")).toThrow(XPathParseError);
    });

    it("rejects an empty predicate", () => {
      expect(() => parseXPath("//service[]")).toThrow(XPathParseError);
    });

    it("rejects an unquoted, non-numeric, non-boolean predicate value", () => {
      expect(() => parseXPath("//service[type=REST]")).toThrow(XPathParseError);
    });

    it("rejects a self predicate missing '='", () => {
      expect(() => parseXPath('//service[."Auth Service"]')).toThrow(XPathParseError);
    });

    it("rejects an unterminated predicate", () => {
      expect(() => parseXPath("//service[type=\"REST\"")).toThrow(XPathParseError);
    });

    it("rejects multiple separate bracket groups on one step", () => {
      expect(() => parseXPath('//service[type="REST"][active=true]')).toThrow(XPathParseError);
    });

    it("rejects an invalid attribute name", () => {
      expect(() => parseXPath("//service[na me=true]")).toThrow(XPathParseError);
    });

    it("rejects a digit-led attribute name", () => {
      expect(() => parseXPath("//service[1abc]")).toThrow(XPathParseError);
    });

    it("rejects a bare existence check mixed into a multi-predicate list", () => {
      expect(() => parseXPath("//service[owner,port=8080]")).toThrow(XPathParseError);
    });

    it("rejects a digit-led kind/step name in a ref path", () => {
      expect(() => parseXPath("/1abc/foo")).toThrow(XPathParseError);
    });
  });
});
