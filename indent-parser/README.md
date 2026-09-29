# Indent, a Markup Language
A markup language that is expressive enough to represent wide range of domains.

## Syntax

```
<node> [value] [key1=value1 ...]
    ...
```

```
org "Org" color="green"
    team "Foo"
    service "Web App" owner=//team[.="Foo"]
        -> //API[.="login"] label="POST credentials"
org "Idp"
    service "auth"
        API "login"

```

- Each line is `<kind> [value] [key="value" ...]`: a leading keyword (`kind`),
  an optional positional `value`, and zero or more `key="value"` attributes.
- Indentation (leading **4 spaces per level, no tabs**) determines nesting
  under the nearest preceding line at a shallower depth.
- Blank lines and full-line `; comment` lines are ignored.
- `\"` inside a quoted string is an escaped quote.

## Supported value types

Attribute values and a node's own optional positional value can be quoted
or unquoted, which determines how they're parsed:

### string

- `key="..."` is always a `string`, even if it looks like a number or
  boolean (e.g. `count="42"` stays `"42"`).
- Strings must always be quoted; an unquoted value that isn't a boolean,
  number, or valid ref is a parse error.

### number

- Unquoted numeric literals (e.g. `42`, `-3.5`) become `number`.

### boolean

- Unquoted `true`/`false` become `boolean`.

### ref

An unquoted value that isn't `true`/`false`/a number is parsed as a **ref**
— a simplified subset of XPath-like syntax (implemented by the sibling
`indent-xpath` package, and used by `indent-language-server` to
resolve/navigate references) intended as a native way to point at other
nodes in the tree. It parses into `{ type: "ref", raw: string }`; only the
raw text is kept, it is not resolved or split into steps by this package.

Supported syntax:

```
/HiTech/AService/AnAPI                 ; absolute path, from the tree root
//AnAPI
/UpstreamOrg//Rollover                       ; mid-path descendant
//Member[name]                                 ; predicate: has attribute
//Member[name="Rollover"]                      ; predicate: attribute equals value
//Member[name="Rollover",type="REST"]          ; predicate: comma-separated AND list
//Member[.="Rollover"]                         ; predicate: self-value equals (node's own positional value)
//Member[0]                                    ; predicate: positional index (0-based)
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
`; comment` immediately after the kind — a leading-`//` descendant ref can
still be written as an *attribute* value.

## Usecases

The grammar is deliberately generic — `kind`, `value`, and `attrs` don't
carry any built-in meaning — so the same syntax can model quite different
kinds of documents.

### HTML alternative

Node `kind` maps to a tag name, attributes map to HTML attributes, and a
node's positional `value` stands in for text content:

```
html
    body
        div class="container"
            h1 "Welcome"
            p "Hello, world!"
            a "Docs" href="/docs"
```

### JSON alternative

Node `kind` maps to a key, and either a positional `value` (for scalars) or
nested children (for objects/arrays) supplies the value:

```
user
    name "Ada Lovelace"
    age 36
    active true
    address
        city "London"
        zip "SW1A 1AA"
    tags
        tag "engineer"
        tag "mathematician"
```

### Sequence diagram markup

`kind` is the message/action name (e.g. `->` for a call), nested under the
participant issuing it, with `entity=` (a ref) pointing at the target:

```
User type="actor"
WebApp type="participant"
AuthService type="participant"
begin //User description="Login sequence diagram"
    -> //WebApp message="Enters username and password"
        -> //AuthService message="Post /login api"
        <- message="An access token"
    <- message="Redirects to dashboard"
```

### C4 diagram markup

`kind` is a C4 element type (`system`, `container`, `component`, `rel`),
with attributes carrying name/description/technology, and `rel` nodes
pointing at other elements via ref:

```
system "Ordering System"
    container "Auth Service" tech="Node.js"
        component "Login API"
            -> //component[.="maindb"] label="Get users"
    container "Booking Service"
        component "List booking API"
            -> //component[.="maindb"] label="Get bookings"
    container "Database" tech="PostgreSQL"
        component "maindb"
            table "users"
            table "bookings"
```

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
