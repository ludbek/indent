# indent-xpath

Generic-purpose, XPath-like node selector for tree-shaped data (`kind` /
`value` / `attrs` / `children`). Usable standalone on any tree with this
shape, and consumed by `indent-language-server` (via an adapter) for resolving
`ref`-typed attribute values. Zero runtime dependencies, and no dependency
(runtime or dev) on `indent-parser` -- it operates on a structurally
compatible `XPathNode` shape declared independently.

This package implements a **subset** of XPath, not the full grammar. See
"Not supported" below for what's intentionally left out.

## Supported syntax

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

- **Steps** (`/name` or `//name`) match a node's `kind`, case-insensitively.
- **`/`** (child axis) descends exactly one level.
- **`//`** (descendant axis) matches at any depth, including zero -- so a
  leading `//api` also matches an `api` node at the root, and mid-path
  `//service//endpoint` matches an `endpoint` at any depth under any
  previously-matched `service`.
- **`[prop]`** checks the node's `attrs` for key existence.
- **`[prop=value]`** checks the node's `attrs[prop]` for equality against a
  typed value.
- **`[prop1=v1,prop2=v2]`** ANDs multiple attribute equality checks together
  in one bracket, comma-separated. Bare existence checks (`[prop]`) are only
  allowed on their own -- mixing one into a comma list (e.g.
  `[owner,port=8080]`) is a parse error; every clause in a multi-clause list
  must be `name=value`.
- **`[.=value]`** checks the node's own positional `value` field (the thing
  an Indent line like `service "Auth Service"` carries before any attributes) --
  reuses XPath's self-axis (`.`) convention.
- Predicate values follow the same literal typing rules as Indent itself:
  - `"..."` (quoted) is always a `string`, e.g. `[owner="ateam"]`.
  - Unquoted `true` / `false` is a `boolean`.
  - Unquoted numeric text matching `/^-?\d+(\.\d+)?$/` is a `number`.
  - Anything else unquoted is a parse error.
  - `\"` inside a quoted value is an escaped quote.
  - A `,` or `/` inside a quoted value doesn't split a predicate list or the
    path -- the scanner is quote-aware.
- Equality is **strict-typed**, not stringified: `[port="8080"]` (quoted
  string) does **not** match an attribute stored as the number `8080`.

## Not supported

This subset deliberately omits parts of the existing `indent-language-server`
xpath grammar (which is coupled to its own indexed-node model). Using any of
these throws `XPathParseError`:

- Relative paths without a leading `/` (e.g. bare `service/api`).
- `..` (parent axis).
- `@name` as a standalone path step (attribute axis outside of a predicate).
- Wildcard `*` names.
- Positional index predicates, e.g. `[0]`.
- Multiple *separate* bracket groups on one step, e.g. `[a][b]` -- use a
  single comma-separated bracket instead: `[a,b]`.
- A `name=value` shorthand for the self-value match is not supported --
  use the bracketed `[.=value]` form instead.
- A field-projection/selection syntax (e.g. returning just one attribute's
  value instead of the whole node) is not implemented. `selectNodes` always
  returns full `XPathNode`s; read whatever field you need off the result
  yourself (`node.attrs?.owner`, `node.value`, etc).

## API

```ts
import { parseXPath, selectNodes, XPathParseError } from "indent-xpath";
import type { XPathNode, ParsedXPath } from "indent-xpath";

const tree: XPathNode[] = [
  {
    kind: "service",
    value: "Auth Service",
    attrs: { owner: "ateam", port: 8080 },
    children: [{ kind: "api", value: "Login", attrs: { method: "POST" } }],
  },
];

selectNodes(tree, "//api"); // -> [ { kind: "api", value: "Login", ... } ]
selectNodes(tree, '/service[owner="ateam"]'); // -> [ the service node ]

// Parse once, evaluate many times against different trees:
const parsed: ParsedXPath = parseXPath("//service//api");
selectNodes(tree, parsed);
```

`XPathNode` is a minimal shape (`kind`, optional `value`, optional `attrs`,
optional `children`) -- `indent-parser`'s `IndentNode` is structurally
assignable to it, so it can be passed directly to `selectNodes` without any
adapter, despite there being no dependency between the two packages.

`parseXPath` and `selectNodes` throw `XPathParseError` (with a `raw`
property holding the original expression) on malformed or unsupported
input.

## Development

```
npm install
npm run build
npm test
```
