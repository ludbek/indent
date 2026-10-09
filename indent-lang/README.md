# indent-lang

TypeScript toolkit for the **Indent Markup Language**: a parser, an
XPath-like node selector, and a schema validator — in one package.

```sh
npm install indent-lang
```

Three subpath exports:

| Import | Contents |
| --- | --- |
| `indent-lang` | Parser, include resolver, project manifest, wire format. |
| `indent-lang/xpath` | XPath-like selector over tree-shaped data. |
| `indent-lang/schema` | Schema definition parsing, validation, discovery. |

> **Note:** this package supersedes the separate `indent-parser` and
> `indent-xpath` packages, which have been merged here and are no longer
> published.

---

## Parsing

```ts
import { parse, parseFile } from "indent-lang";

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

### Wire format

`encodeWireFormat`/`decodeWireFormat` convert between normal
4-space-indented Indent source and a compact single-line "wire format"
that replaces newline + indentation-change with escape sequences. This
is a pure text transform (no tokenizing/parsing) meant for transmitting
`.inml` structure without embedded raw newlines.

```ts
import { encodeWireFormat, decodeWireFormat } from "indent-lang";

const wire = encodeWireFormat(source);
const roundTripped = decodeWireFormat(wire);
// roundTripped === source (modulo normalizing line endings to `\n`)
```

Escape sequences, one character per depth level crossed:
- `\+` — indent one level deeper than the previous line.
- `\-` — dedent one level shallower than the previous line.
- `\=` — same depth as the previous line (a sibling); no indentation
  change needs to be communicated, but the marker is still required so
  the wire format never contains a raw embedded newline.

Runs of `\+`/`\-` are used for multi-level jumps, e.g. going from depth 0
to depth 2 encodes as `\+\+`, and back down to depth 0 as `\-\-`. Blank
lines and comment-only (`;...`) lines carry no indentation of their own,
so they are encoded as a same-depth (`\=`) transition.

`decodeWireFormat` throws `IndentParseError` if a `\-` run would dedent
past depth 0.

---

## XPath (`indent-lang/xpath`)

XPath-like node selector for tree-shaped data (`kind` / `value` / `attrs` /
`children`). Works on any tree with that shape — `IndentNode` is
structurally assignable to `XPathNode`, so parsed trees can be passed
straight in.

This implements a **subset** of XPath, not the full grammar. See
"Not supported" below for what is intentionally left out.

### Supported syntax

```
//api                       // descendant: match anywhere in the tree, any depth
//service//endpoint         // mid-path descendant: any depth under a matched service
/org/team/service           // absolute path: from the tree root, one level per step
//service[owner]                       // predicate: attribute exists
//service[owner="ateam"]               // predicate: attribute equals a quoted string
//service[port=8080]                   // predicate: attribute equals an unquoted number
//service[active=true]                 // predicate: attribute equals an unquoted boolean
//service[owner="ateam",port=8080]     // multi-predicate: comma-separated, ANDed together
//service[.="Auth Service"]            // self-axis: match the node's own positional `value`
```

- **Steps** (`/name` or `//name`) match a node's `kind`, case-insensitively.
- **`/`** (child axis) descends exactly one level.
- **`//`** (descendant axis) matches at any depth, including zero — so a
  leading `//api` also matches an `api` node at the root, and mid-path
  `//service//endpoint` matches an `endpoint` at any depth under any
  previously-matched `service`.
- **`[prop]`** checks the node's `attrs` for key existence.
- **`[prop=value]`** checks `attrs[prop]` for equality against a typed value.
- **`[prop1=v1,prop2=v2]`** ANDs multiple attribute equality checks together
  in one bracket, comma-separated. Bare existence checks (`[prop]`) are only
  allowed on their own — mixing one into a comma list (e.g.
  `[owner,port=8080]`) is a parse error.
- **`[.=value]`** checks the node's own positional `value` field (the thing
  an Indent line like `service "Auth Service"` carries before any attributes).
- Predicate values follow the same literal typing rules as Indent itself:
  quoted is `string`, unquoted `true`/`false` is `boolean`, unquoted numeric
  text is `number`, anything else unquoted is a parse error. `\"` escapes a
  quote; a `,` or `/` inside a quoted value does not split the predicate list
  or the path (the scanner is quote-aware).
- Equality is **strict-typed**: `[port="8080"]` does **not** match an
  attribute stored as the number `8080`.

### Not supported

Using any of these throws `XPathParseError`:

- Relative paths without a leading `/` (e.g. bare `service/api`).
- `..` (parent axis).
- `@name` as a standalone path step.
- Wildcard `*` names.
- Multiple *separate* bracket groups on one step, e.g. `[a][b]` — use a
  single comma-separated bracket instead: `[a,b]`.
- A `name=value` shorthand for the self-value match — use `[.=value]`.
- Field projection. `selectNodes` always returns full nodes; read whatever
  field you need off the result (`node.attrs?.owner`, `node.value`).

### API

```ts
import { parseXPath, selectNodes, XPathParseError } from "indent-lang/xpath";
import type { XPathNode, ParsedXPath } from "indent-lang/xpath";

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

`selectNodes` **always returns an array**, whether zero, one, or many nodes
match. That is deliberate: it removes the classic XML→JSON "is this a single
object or a one-element array?" ambiguity. The caller declares intent by
asking for a path; the shape of the answer never depends on the data.

`parseXPath` and `selectNodes` throw `XPathParseError` (with a `raw`
property holding the original expression) on malformed or unsupported input.

---

## Schema (`indent-lang/schema`)

Schemas declare which **kinds** may appear where, which **attributes** they
carry, and **how many times** each child kind may repeat. Schemas are
themselves written in Indent.

### Schema syntax

A schema file (`*.schema.inml`) is a flat list of top-level `kind`
definitions. Each definition may contain `attr` lines and `kind`
*references* to other definitions.

```
kind "workspace"
    attr "name" type="string" required=true
    kind //kind[.="person"]
    kind //kind[.="softwareSystem"] minCount=1

kind "person"
    attr "name" type="string" required=true

kind "softwareSystem"
    attr "name" type="string" required=true
    kind //kind[.="container"]

kind "container"
    attr "name" type="string" required=true
    attr "port" type="number"
    kind //kind[.="container"]
```

- Top-level `kind "name"` lines are **canonical definitions**. The name is a
  quoted string. Duplicates are an error.
- Nested `kind` lines are **references**, not redefinitions. The value is an
  xpath ref (`//kind[.="name"]`) resolved against the schema's own root
  nodes. Writing a plain quoted string there is an error.

  Why references instead of bare names? Because a kind can appear under many
  parents with different cardinality, and can be self-referential
  (`container` inside `container`). References point at one canonical
  definition and carry only the local cardinality, so there is exactly one
  place that defines a kind's shape.
- Edge-style kinds work the same way:
  `kind "->"` is referenced as `kind //kind[.="->"]`.

#### Attributes

```
attr "<name>" type="string|number|boolean|ref" [required=true|false]
```

`type=` is mandatory; `required=` defaults to `false`.

#### Cardinality

```
kind //kind[.="x"] minCount=1 maxCount=3
```

| Field | Default | Meaning |
| --- | --- | --- |
| `minCount` | `0` | Minimum occurrences among siblings. |
| `maxCount` | unbounded | Maximum occurrences among siblings. |

Omitting both means **zero-to-unbounded**. That default suits the domains
Indent targets — C4 and sequence diagrams, HTML-like documents — which are
collection-heavy, so requiring an explicit `maxCount` everywhere would be
noise. Constraints: both must be integers, `minCount >= 0`,
`maxCount >= 1`, `minCount <= maxCount`.

Every top-level `kind` definition is implicitly allowed at the document
root with the default cardinality.

### Validating

```ts
import {
  parseSchema,
  parseSchemaFile,
  validateAgainstSchema,
} from "indent-lang/schema";
import { parse } from "indent-lang";

const schema = parseSchemaFile("./schemas/c4.schema.inml");
const { roots } = parse(source);

const diagnostics = validateAgainstSchema(roots, schema);
// SchemaDiagnostic = { severity: "error" | "warning"; message: string; kind?: string }
```

`parseSchema`/`parseSchemaFile` throw `SchemaDefinitionError` when the schema
itself is malformed. `validateAgainstSchema` never throws; it returns a list
of diagnostics (empty when the document is valid).

Checks performed: unknown kind for the current scope, unknown attribute,
missing required attribute, attribute type mismatch, and cardinality
violations (under `minCount`, over `maxCount`).

> **Limitation:** diagnostics are not line-anchored. `IndentNode` carries no
> position information (the parser drops line numbers when building the
> tree), so diagnostics identify the offending kind structurally rather than
> by source range. Editor squiggles are a follow-up in
> `indent-language-server`, whose CST does retain positions.

### Binding a document to a schema

A document finds its schema by this precedence:

| # | Mechanism | Wins over |
| --- | --- | --- |
| 1 | `!schema "<path>"` directive in the document | everything |
| 2 | Filename segment `doc.<name>.inml` looked up in the project registry | — |
| 3 | No schema — the document is not validated | — |

#### 1. The `!schema` directive

```
!schema "./schemas/c4.schema.inml"

workspace "Acme"
    ...
```

Constraints:

- Must be the **first statement** in the file, at **depth 0**.
- At most **one** per file.
- Does **not** propagate through `!include`. An included fragment is
  validated as part of its includer, never independently — an `!schema`
  line inside an included file is an error.
- The directive is stripped from the token stream, so it never appears as a
  node in the resulting tree. The resolved absolute path is surfaced as
  `ParseResult.schemaRef` (set by `parseFile`/`parseFileWithSources`; plain
  `parse()` does not read from disk and so never sets it).

This exists for standalone files with no surrounding project — a CI config
file, a one-off diagram — and lets tooling know a single opened file's schema
without indexing a workspace.

#### 2. The `project.inml` schema registry

```
entry "./src/main.inml"

schemas
    schema "architecture" src="./schemas/c4.schema.inml"
    schema "config" src="./schemas/config.schema.inml"
```

`src` paths resolve relative to the manifest directory. Names must be unique.
The registry is exposed as `ProjectManifest.schemas: Map<string, string>`
(name → absolute path).

A document named `diagram.architecture.inml` has schema segment
`architecture`, which is looked up in this registry. There is no
sibling-directory or walk-up lookup — registration is explicit and reviewable
in one place.

`.schema.inml` is a **reserved suffix**: such a file is always a schema
definition, never a document, and never has a schema segment of its own.

```ts
import { resolveSchemaFor } from "indent-lang/schema";

const schemaPath = resolveSchemaFor(filePath, parseResult, manifest);
// string | undefined
```

---

## CLI

```
indent-lang <path> [options]

  --project          treat <path> as a project.inml manifest
  --file             treat <path> as a single .inml entry file
  -o, --output <p>   write JSON output to a file instead of stdout
  --schema <path>    validate against this schema, overriding discovery
```

Without `--schema`, the schema is auto-discovered using the precedence above.
Schema diagnostics go to stderr; JSON output is still written. The process
exits non-zero if any diagnostic has `error` severity.

---

## Deferred / future work

**Remote schemas.** Schemas are local files only. `parse()` is synchronous
and must never perform network I/O, so fetching a schema over HTTP cannot be
folded into parsing. The intended future shape:

- The `project.inml` registry gains remote `src` URLs, keeping the
  indirection in one reviewable place.
- An explicit `indent-lang schema fetch` CLI subcommand downloads them.
- Downloads are cached in a `.indent/schemas/` directory.
- A lockfile records integrity hashes so builds are reproducible and
  schema drift is detectable.

Parsing and validation stay offline against the cache; the network step is
always explicit and separate.

**Language server integration.** `indent-language-server` does not yet
consume schemas for diagnostics or completions. The `!schema` directive and
the project registry exist to enable it.

**Line-anchored diagnostics.** Requires either threading source positions
through the tree builder or validating against the language server's CST.

---

## Development

```
npm install
npm run build
npm test
```
