# indent-lang

TypeScript toolkit for the **Indent Markup Language**: a parser, an
XPath-like node selector, and a schema validator — in one package.

```sh
npm install indent-lang
```

Three subpath exports:

| Import | Contents |
| --- | --- |
| `indent-lang` | Parser, include resolver, wire format. |
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

Schemas declare which **elements** may appear where, which **attributes**
they carry, and **how many times** each child element may repeat. Schemas
are themselves written in Indent.

### Schema syntax

A schema file (`*.schema.inml`) is a list of `element` definitions. Each
definition may contain `attr` lines and `element` children, which are
either **inline nested definitions** or **references** to other
definitions.

```
element "workspace"
    attr "name" type="string" required=true
    element //element[.="person"]
    element //element[.="softwareSystem"] minCount=1

element "person"
    attr "name" type="string" required=true

element "softwareSystem"
    attr "name" type="string" required=true
    element "container"
        attr "name" type="string" required=true
        attr "port" type="number"
        element //element[.="container"]
```

- Top-level `element "name"` lines are **canonical definitions**. The name
  is a quoted string. Duplicates are an error.
- A nested `element "name"` line with a plain quoted string is an **inline
  definition**: it declares a brand-new element -- registered globally,
  exactly as if written at the top level -- *and* wires it up as an allowed
  child of the enclosing element at the cardinality declared on that line.
  Inline definitions may nest further inline definitions, to any depth.
- A nested `element //element[.="name"]` line is a **reference**, not a
  redefinition: the value is an xpath ref resolved against the schema's own
  root nodes, pointing at an element defined elsewhere (top-level or
  inline-nested).

  Why references in addition to inline definitions? Because an element can
  appear under many parents with different cardinality, and can be
  self-referential (`container` inside `container` -- which can't be
  expressed inline, since the name wouldn't exist yet at that point).
  References point at one canonical definition and carry only the local
  cardinality, so there is exactly one place that defines an element's
  shape; every other mention of that name must use the ref form.
- Edge-style elements work the same way:
  `element "->"` is referenced elsewhere as `element //element[.="->"]`.

#### Attributes

```
attr "<name>" type="string|number|boolean|ref" [required=true|false]
```

`type=` is mandatory; `required=` defaults to `false`.

`type=` can also be an xpath self-axis ref instead of a plain literal,
constraining a `ref`-typed attribute to point at a node of one specific
declared element:

```
attr "team" type=//element[.="team"]
```

This resolves `type=` against the schema's own elements (same self-axis
resolution as a child `element //element[.="name"]` reference) to record
that the attribute's value isn't just *any* ref -- when validating a
document, its target must resolve to a `team` element. Combine with
`required=` as usual.

#### Positional value

An element's own positional value (e.g. `"Acme"` in `workspace "Acme"`) can
be schema'd with a `value` line, following the same `type=` rules as `attr`
(including the ref-target-kind constraint above):

```
element "team"
    value type="string" required=true

element "assignment"
    value type=//element[.="team"]
```

At most one `value` line per element definition. `required=` defaults to
`false`. If an element's schema does not declare a `value` line, that
element's document nodes must not carry a positional value either (it's an
error, like an undeclared attribute).

#### Cardinality

```
element //element[.="x"] minCount=1 maxCount=3
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

Every top-level `element` definition is implicitly allowed at the document
root with the default cardinality. Inline-nested definitions are not.

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
// SchemaDiagnostic = { severity: "error" | "warning"; message: string; element?: string }
```

`parseSchema`/`parseSchemaFile` throw `SchemaDefinitionError` when the schema
itself is malformed. `validateAgainstSchema` never throws; it returns a list
of diagnostics (empty when the document is valid).

Checks performed: unknown element for the current scope, unknown attribute,
missing required attribute, attribute type mismatch, positional value
presence/type (per a declared `value` line), cardinality violations (under
`minCount`, over `maxCount`), and ref-target-kind mismatches for
ref-constrained `attr`/`value` declarations (resolved against the full
document tree being validated, including `!include`-spliced content).

> **Limitation:** diagnostics are not line-anchored. `IndentNode` carries no
> position information (the parser drops line numbers when building the
> tree), so diagnostics identify the offending element structurally rather
> than by source range. Editor squiggles are a follow-up in
> `indent-language-server`, whose CST does retain positions.

### Binding a document to a schema

A document finds its schema via an in-document `!schema "<path>"` directive:

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

If no `!schema` directive is present, the document is not validated.

`.schema.inml` is a **reserved suffix**: such a file is always a schema
definition, never a document.

```ts
import { resolveSchemaFor } from "indent-lang/schema";

const schemaPath = resolveSchemaFor(parseResult);
// string | undefined
```

---

## CLI

```
indent-lang <path> [options]

  -o, --output <p>   write JSON output to a file instead of stdout
  --schema <path>    validate against this schema, overriding discovery
```

Without `--schema`, the schema is auto-discovered from the document's
`!schema` directive. Schema diagnostics go to stderr; JSON output is still
written. The process exits non-zero if any diagnostic has `error` severity.

---

## Deferred / future work

**Remote schemas.** Schemas are local files only. `parse()` is synchronous
and must never perform network I/O, so fetching a schema over HTTP cannot be
folded into parsing. Any future remote-schema support would need an explicit
fetch step with a local cache, kept entirely separate from parsing.

**Language server integration.** `indent-language-server` does not yet
consume schemas for diagnostics or completions.

**Line-anchored diagnostics.** Requires either threading source positions
through the tree builder or validating against the language server's CST.

---

## Development

```
npm install
npm run build
npm test
```
