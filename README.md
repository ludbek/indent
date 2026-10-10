# Indent, a Markup Language
A markup language that is expressive enough to represent wide range of domains.

Indent is a dialect of XML that drops the verbose opening/closing tags,
using indentation for nesting instead. It natively supports typed values
-- string, number, boolean, and ref -- so you don't need extra schema or
string-parsing to know what a value means.

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
— a simplified subset of XPath-like syntax (implemented by `indent-lang`'s
`xpath` module, and used by `indent-language-server` to
resolve/navigate references) intended as a native way to point at other
nodes in the tree. It parses into `{ type: "ref", raw: string }`; only the
raw text is kept, it is not resolved or split into steps by this package.

Supported syntax:

```
//api                       // descendant: match anywhere in the tree, any depth
//service//endpoint         // mid-path descendant: any depth under a matched service
/org/team/service           // absolute path: from the tree root, one level per step
//service[owner]              // predicate: attribute exists
//service[owner="ateam"]      // predicate: attribute equals a quoted string
//service[port=8080]          // predicate: attribute equals an unquoted number
//service[active=true]        // predicate: attribute equals an unquoted boolean
//service[owner="ateam",port=8080]     // multi-predicate: comma-separated, ANDed together
//service[.="Auth Service"]            // self-axis: match the node's own positional `value`
```

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
`kind` is an instance of actor or participant. `->` and `<-` represent the messages being passed between the participants.

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

`kind` is a C4 element type (`system`, `container`, `component`, `->`),
with positional value and attributes carrying name/description/technology, and `->` nodes
pointing at other elements via ref.

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

## Packages

| Package | Description |
| --- | --- |
| [`indent-lang`](./indent-lang/README.md) | Parser, XPath-like selector, and schema validator for the Indent Markup Language. |
| [`treesitter-indent`](./treesitter-indent/README.md) | Tree-sitter grammar for the Indent Markup Language — single source of truth for lexing/parsing, shared by `indent-lang` (native binding) and `indent-language-server` (WASM binding). |
| [`indent-language-server`](./indent-language-server/README.md) | Language Server Protocol implementation for the Indent Markup Language. |
| [`vscode-indent-lang`](./vscode-indent-lang/README.md) | VS Code syntax highlighting extension for the Indent Markup Language. |

## Architecture

`treesitter-indent`'s `grammar.js` is the single source of truth for lexing
and parsing `.inml` source. Both consumers walk the same tree-sitter CST via
the shared walker in `indent-lang/src/cstParser.ts` (published as the
`indent-lang/cst` subpath export):

- `indent-lang` uses the **native** `tree-sitter` Node binding
  (`treesitter-indent`'s `bindings/node`) for synchronous, dependency-light
  parsing from the CLI/library API. `tokenizer.ts` flattens the CST into the
  legacy `LineToken[]` shape so the existing `parser.ts` (indentation-stack
  tree builder) and `resolver.ts` (`!include`/`!schema` resolution) keep
  working unchanged.
- `indent-language-server` uses the **WASM** `web-tree-sitter` binding
  (`treesitter-indent`'s compiled `.wasm`) so it can run portably across
  editor hosts/browsers and keep the parsed `Tree` object around for future
  incremental re-parsing. It calls the shared `walkCstTree()` directly and
  layers only its own LSP-specific fields (`id`, `uri`, `parent`) on top via
  a thin adapter.

There is no longer a hand-written lexer/parser duplicated between packages —
`treesitter-indent/grammar.js` is written once and consumed twice.

## Development

This is an npm workspaces monorepo. From the repo root:

```sh
npm install
npm run build   # build --workspaces --if-present
npm run test    # test --workspaces --if-present
```
