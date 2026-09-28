# indent-parser

Parser for a generic, human-friendly, Indent Markup Language ("XML-light").

## Grammar

```
org name="Org" color="green"
    team name="OrgFoo"
    service name="user-service"
        API name="rollover"
            -> entity="UpstreamOrg/super/rollover"
```

- Each line is `<kind> key="value" key="value" ...`.
- Indentation (leading **4 spaces per level, no tabs**) determines nesting
  under the nearest preceding line at a shallower depth.
- Blank lines and full-line `// comment` lines are ignored.
- Attribute values (and a node's own optional positional value) can be
  quoted or unquoted:
  - `key="..."` is always a `string`, even if it looks like a number or
    boolean (e.g. `count="42"` stays `"42"`).
  - Unquoted `true`/`false` become `boolean`.
  - Unquoted numeric literals (e.g. `42`, `-3.5`) become `number`.
  - Unquoted values that aren't a boolean or number are interpreted as a
    **ref** (see below), e.g. `entity=/UpstreamOrg/super/rollover`.
  - Strings must always be quoted; an unquoted value that is not a boolean,
    number, or valid ref is a parse error.
  - `\"` inside a quoted string is an escaped quote.
- `->` is not special-cased. It is an ordinary node whose `kind` happens to
  be `"->"`, nested like any other child — analogous to a plain XML child
  element with no children of its own. This keeps the model generic enough
  to reuse for configs, data generation, etc., not just system diagrams.

## Ref values

An unquoted attribute value (or a node's own positional value) that is not
`true`/`false`/a number is parsed as a **ref** — a simplified subset of
XPath-like syntax (implemented by the sibling `indent-xpath` package, and
used by `indent-language-server` to resolve/navigate references) intended as a
native way to point at other nodes in the tree. It parses into
`{ type: "ref", raw: string }`; only the raw text is kept, it is not
resolved or split into steps by this package.

Supported syntax:

```
/UpstreamOrg/Member/Rollover                        // absolute path, from the tree root
//Rollover                                   // descendant ("anywhere in the tree")
/UpstreamOrg//Rollover                              // mid-path descendant
Member[name]                                 // predicate: has attribute
Member[name="Rollover"]                      // predicate: attribute equals value
Member[name="Rollover",type="REST"]          // predicate: comma-separated AND list
Member[.="Rollover"]                         // predicate: self-value equals (node's own positional value)
Member[0]                                    // predicate: positional index (0-based)
```

This is not the full XPath grammar — bare relative paths without a leading
`/`, `..` (parent axis), `.`/`@name` as standalone steps, wildcard `*`,
a `name=value` self-value shorthand (use the bracketed `[.=value]` form
instead), and multiple separate bracket groups on one step (`[a][b]` — use
`[a,b]` instead) are all **not** supported. An unquoted value that matches
none of the boolean/number/ref forms above (e.g. a typo like `Foo[` or
`Foo$Bar`) is a parse error, same as before; an empty unquoted value (e.g.
`entity=` with nothing after it) is also still a parse error, not treated
as a ref.

A node's own positional value can also be a ref (e.g.
`alias /Org/Service/Database`), with one caveat: a positional value can't
start with `//`, since that's indistinguishable from a trailing full-line
`// comment` immediately after the kind — a leading-`//` descendant ref can
still be written as an *attribute* value.



## Includes

Multiple `.inml` files can be stitched together with an **include line**: a
line whose entire content is a bare path starting with `/`, `./`, or `../`
(no attributes allowed), e.g.:

```
org name="Acme"
    ./shared/team.inml
    service name="user-service"
```

- The path is resolved relative to the directory of the file containing the
  include line (`/...` paths are used as-is).
- The include line is **replaced** by the referenced file's content: the
  included file's top-level lines land at the same indentation depth as the
  include line itself, and all of their descendants shift by that same
  amount. If the included file has multiple root-level lines, they all
  become siblings at that depth.
- Includes may be nested (an included file can itself include other files).
- Include lines must not have attributes (e.g. `./team.inml foo="bar"` is a
  parse error).
- Circular includes are detected and raise a `IndentParseError`.

Include resolution requires filesystem access, so it is only available via
`parseFile`, not the fs-free `parse`.

## API

```ts
import { parse, parseFile } from "indent-parser";

const { roots } = parse(source);
// roots: IndentNode[]
// IndentNode = { kind: string; value?: string | number | boolean | RefValue; attrs: Record<string, AttrValue>; children: IndentNode[] }
// AttrValue = string | number | boolean | RefValue
// RefValue = { type: "ref", raw: string }

// Reads `entry.inml` from disk and resolves any include lines within it
// (and transitively within included files) before building the tree.
const { roots: rootsFromDisk } = parseFile("entry.inml");
```

`parse` and `parseFile` throw `IndentParseError` (with `line` and, for
`parseFile`, a `file` property) on malformed input.

## Development

```
npm install
npm run build
npm test
```
