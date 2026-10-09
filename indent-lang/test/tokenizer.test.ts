import { describe, expect, it } from "vitest";
import { tokenize } from "../src/tokenizer.js";
import { IndentParseError } from "../src/types.js";

describe("tokenize", () => {
  it("measures indentation depth from leading 4-space groups", () => {
    const tokens = tokenize('a name="x"\n    b name="y"\n        c name="z"\n');
    expect(tokens.map((t) => t.depth)).toEqual([0, 1, 2]);
  });

  it("skips blank lines and full-line comments", () => {
    const tokens = tokenize('a name="x"\n\n; a comment\n    b name="y"\n');
    expect(tokens).toHaveLength(2);
    expect(tokens[0].kind).toBe("a");
    expect(tokens[1].kind).toBe("b");
  });

  it("parses multiple key=\"value\" attrs in source order", () => {
    const tokens = tokenize('org name="Org" color="green"\n');
    expect(tokens[0].attrs).toEqual({ name: "Org", color: "green" });
  });

  it("supports escaped quotes inside values", () => {
    const tokens = tokenize('node label="say \\"hi\\""\n');
    expect(tokens[0].attrs.label).toBe('say "hi"');
  });

  it("treats -> as an ordinary kind", () => {
    const tokens = tokenize('            -> entity="UpstreamOrg/super/rollover"\n');
    expect(tokens[0].kind).toBe("->");
    expect(tokens[0].attrs).toEqual({ entity: "UpstreamOrg/super/rollover" });
  });

  it("throws on stray space indentation", () => {
    expect(() => tokenize(' a name="x"\n')).toThrow(IndentParseError);
  });

  it("throws on tab indentation", () => {
    expect(() => tokenize('\ta name="x"\n')).toThrow(IndentParseError);
  });

  it("throws on unterminated string value", () => {
    expect(() => tokenize('a name="unterminated\n')).toThrow(IndentParseError);
  });

  it("throws on missing '=' after attribute name", () => {
    expect(() => tokenize('a name"x"\n')).toThrow(IndentParseError);
  });

  it("throws on a purely numeric attribute name", () => {
    expect(() => tokenize('a 123="x"\n')).toThrow(IndentParseError);
  });

  it("throws on an attribute name starting with a digit", () => {
    expect(() => tokenize('a 1abc="x"\n')).toThrow(IndentParseError);
  });

  it("accepts an attribute name starting with an underscore", () => {
    const tokens = tokenize('a _foo="x"\n');
    expect(tokens[0].attrs).toEqual({ _foo: "x" });
  });

  it("accepts an attribute name with digits after the first letter", () => {
    const tokens = tokenize('a foo123="x"\n');
    expect(tokens[0].attrs).toEqual({ foo123: "x" });
  });

  it("accepts a hyphenated attribute name", () => {
    const tokens = tokenize('a background-color="blue"\n');
    expect(tokens[0].attrs).toEqual({ "background-color": "blue" });
  });

  it("throws on a purely numeric kind", () => {
    expect(() => tokenize('123 name="x"\n')).toThrow(IndentParseError);
  });

  it("throws on a kind starting with a digit", () => {
    expect(() => tokenize('1foo name="x"\n')).toThrow(IndentParseError);
  });

  it("throws on a kind with an invalid symbol", () => {
    expect(() => tokenize('@foo name="x"\n')).toThrow(IndentParseError);
  });

  it("throws on a bare absolute-path line (only './' and '../' are valid include prefixes)", () => {
    expect(() => tokenize("/abs/path.inml\n")).toThrow(IndentParseError);
  });

  it("accepts '->' and '=>' as ordinary kinds", () => {
    expect(tokenize('-> entity="x"\n')[0].kind).toBe("->");
    expect(tokenize('=> entity="x"\n')[0].kind).toBe("=>");
  });

  it("accepts a hyphenated kind", () => {
    const tokens = tokenize('auth-server name="x"\n');
    expect(tokens[0].kind).toBe("auth-server");
  });

  it("accepts a kind starting with an underscore", () => {
    const tokens = tokenize('_foo name="x"\n');
    expect(tokens[0].kind).toBe("_foo");
  });

  it("throws on a bare relative-path line (no longer a special include form; must use '!include \"path\"')", () => {
    expect(() => tokenize("./team.inml\n")).toThrow(IndentParseError);
    expect(() => tokenize("../team.inml\n")).toThrow(IndentParseError);
  });

  it("accepts a leading '!' as a built-in directive kind, e.g. '!include'", () => {
    const tokens = tokenize('!include "./team.inml"\n');
    expect(tokens[0].kind).toBe("!include");
    expect(tokens[0].value).toBe("./team.inml");
  });

  it("accepts other '!'-prefixed directive kinds generically (e.g. a future '!schema')", () => {
    expect(tokenize('!schema "./foo.inml"\n')[0].kind).toBe("!schema");
  });

  it("supports line continuation with trailing backslash after first attr", () => {
    const tokens = tokenize('org name="Org" \\\n    color="green"\n');
    expect(tokens[0].attrs).toEqual({ name: "Org", color: "green" });
  });

  it("supports multiple chained line continuations", () => {
    const tokens = tokenize('org name="Org" \\\n    color="green" \\\n    pk=true\n');
    expect(tokens[0].attrs).toEqual({ name: "Org", color: "green", pk: true });
  });

  it("throws when '\\' is used before the first attr pair", () => {
    expect(() => tokenize('org \\\n    name="Org"\n')).toThrow(IndentParseError);
  });

  it("throws when '\\' has no following line", () => {
    expect(() => tokenize('org name="Org" \\\n')).toThrow(IndentParseError);
  });

  it("infers boolean type for unquoted true/false", () => {
    const tokens = tokenize('a active=true disabled=false\n');
    expect(tokens[0].attrs).toEqual({ active: true, disabled: false });
  });

  it("infers number type for unquoted numeric literals", () => {
    const tokens = tokenize('a count=42 ratio=-3.5 zero=0\n');
    expect(tokens[0].attrs).toEqual({ count: 42, ratio: -3.5, zero: 0 });
  });

  it("keeps quoted values as strings even if they look like a number or boolean", () => {
    const tokens = tokenize('a count="42" active="true"\n');
    expect(tokens[0].attrs).toEqual({ count: "42", active: "true" });
  });

  it("infers ref type for unquoted path-like references", () => {
    const tokens = tokenize(
      [
        'a p1=/UpstreamOrg/Member/Rollover',
        'a p2=//Rollover',
        'a p3=/UpstreamOrg//Rollover',
        'a p4=/Member[name]',
        'a p5=/Member[name="Roll Over"]',
        'a p6=/Member[a="x",b=42]',
        'a p7=/Member[.="Roll Over"]',
        "",
      ].join("\n"),
    );
    expect(
      tokens.map(
        (t) => t.attrs.p1 ?? t.attrs.p2 ?? t.attrs.p3 ?? t.attrs.p4 ?? t.attrs.p5 ?? t.attrs.p6 ?? t.attrs.p7,
      ),
    ).toEqual([
      { type: "ref", raw: "/UpstreamOrg/Member/Rollover" },
      { type: "ref", raw: "//Rollover" },
      { type: "ref", raw: "/UpstreamOrg//Rollover" },
      { type: "ref", raw: "/Member[name]" },
      { type: "ref", raw: '/Member[name="Roll Over"]' },
      { type: "ref", raw: '/Member[a="x",b=42]' },
      { type: "ref", raw: '/Member[.="Roll Over"]' },
    ]);
  });

  it("treats -> entity as a ref reference", () => {
    const tokens = tokenize('            -> entity=/UpstreamOrg/super/rollover\n');
    expect(tokens[0].kind).toBe("->");
    expect(tokens[0].attrs).toEqual({ entity: { type: "ref", raw: "/UpstreamOrg/super/rollover" } });
  });

  it("throws on an unquoted value that is not a boolean, number, or valid ref", () => {
    expect(() => tokenize("a bad=Foo$Bar\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=Foo[\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=-Foo\n")).toThrow(IndentParseError);
  });

  it("throws on old-dialect / unsupported ref forms no longer accepted by the new subset", () => {
    // Bare relative paths (no leading `/` or `//`) are no longer supported.
    expect(() => tokenize("a bad=Member/Rollover\n")).toThrow(IndentParseError);
    // Explicit-relative (`./`) and parent (`../`) axes are no longer supported.
    expect(() => tokenize("a bad=./Rollover\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=../Rollover\n")).toThrow(IndentParseError);
    // `.`/`..` alone, wildcard `*`, and standalone `@name` (attribute axis
    // outside a predicate) are no longer supported.
    expect(() => tokenize("a bad=.\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=..\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=/Member/*\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=@kind\n")).toThrow(IndentParseError);
    expect(() => tokenize("a bad=/Member/@name\n")).toThrow(IndentParseError);
    // Old XML-style `[@attr="value"]` predicates (with the `@`) are no
    // longer supported -- only bare `[attr="value"]` is.
    expect(() => tokenize('a bad=/Member[@name="Roll Over"]\n')).toThrow(IndentParseError);
    // The `name=value` self-value shorthand was removed -- use the
    // bracketed `[.=value]` form instead.
    expect(() => tokenize('a bad=/Member="Roll Over"\n')).toThrow(IndentParseError);
    expect(() => tokenize('a bad=/Member="Roll Over"[name="x"]\n')).toThrow(IndentParseError);
  });

  it("throws on an empty unquoted value (still requires a value, not swallowed as a ref)", () => {
    expect(() => tokenize("a entity=\n")).toThrow(IndentParseError);
  });

  it("parses positional string value followed by attributes", () => {
    const tokens = tokenize('service "Auth Service" owner="ateam"\n');
    expect(tokens[0].kind).toBe("service");
    expect(tokens[0].value).toBe("Auth Service");
    expect(tokens[0].attrs).toEqual({ owner: "ateam" });
  });

  it("parses positional number value followed by attributes", () => {
    const tokens = tokenize("database 123 is_active=true\n");
    expect(tokens[0].kind).toBe("database");
    expect(tokens[0].value).toBe(123);
    expect(tokens[0].attrs).toEqual({ is_active: true });
  });

  it("parses positional boolean value followed by attributes", () => {
    const tokens = tokenize('flag true env="prod"\n');
    expect(tokens[0].kind).toBe("flag");
    expect(tokens[0].value).toBe(true);
    expect(tokens[0].attrs).toEqual({ env: "prod" });
  });

  it("parses positional value without attributes", () => {
    const tokens = tokenize('org "Org"\ndatabase 42\nflag false\n');
    expect(tokens[0]).toMatchObject({ kind: "org", value: "Org", attrs: {} });
    expect(tokens[1]).toMatchObject({ kind: "database", value: 42, attrs: {} });
    expect(tokens[2]).toMatchObject({ kind: "flag", value: false, attrs: {} });
  });

  it("supports line continuation after positional value", () => {
    const tokens = tokenize('service "Auth Service" \\\n    owner="ateam"\n');
    expect(tokens[0].kind).toBe("service");
    expect(tokens[0].value).toBe("Auth Service");
    expect(tokens[0].attrs).toEqual({ owner: "ateam" });
  });

  it("throws when unquoted positional string is provided", () => {
    expect(() => tokenize('service Auth owner="ateam"\n')).toThrow(IndentParseError);
  });

  it("throws on multiple positional values", () => {
    expect(() => tokenize('service "Auth" "Service" owner="ateam"\n')).toThrow(IndentParseError);
    expect(() => tokenize("service 123 456\n")).toThrow(IndentParseError);
  });

  it("parses a positional ref value", () => {
    const tokens = tokenize("alias /Org/Service/Database owner=\"ateam\"\n");
    expect(tokens[0].kind).toBe("alias");
    expect(tokens[0].value).toEqual({ type: "ref", raw: "/Org/Service/Database" });
    expect(tokens[0].attrs).toEqual({ owner: "ateam" });
  });

  it("parses a positional ref value with a predicate, without attributes", () => {
    const tokens = tokenize('alias /Org/Service[name="RDS"]\n');
    expect(tokens[0]).toMatchObject({
      kind: "alias",
      value: { type: "ref", raw: '/Org/Service[name="RDS"]' },
      attrs: {},
    });
  });

  it("parses a leading `//` positional value as a descendant ref", () => {
    // Comments now use `;`, so `//` is no longer ambiguous in value position
    // -- a positional value starting with `//` is an unambiguous descendant
    // ref (matching the `entity=//...` attribute-ref form).
    const tokens = tokenize("alias //Rollover\n");
    expect(tokens[0]).toMatchObject({
      kind: "alias",
      value: { type: "ref", raw: "//Rollover" },
      attrs: {},
    });
  });

  it("skips a trailing `;` comment after a positional value", () => {
    const tokens = tokenize('service "Auth" ; the auth service\n');
    expect(tokens[0]).toMatchObject({
      kind: "service",
      value: "Auth",
      attrs: {},
    });
  });

  it("skips a trailing `;` comment after attributes", () => {
    const tokens = tokenize('org name="Org" ; root org\n');
    expect(tokens[0]).toMatchObject({
      kind: "org",
      attrs: { name: "Org" },
    });
  });
});
