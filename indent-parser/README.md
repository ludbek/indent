
# indent-parser
A typescript parser for `Indent Markup Langauge`.

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

### Wire format

`encodeWireFormat`/`decodeWireFormat` convert between normal
4-space-indented Indent source and a compact single-line "wire format"
that replaces newline + indentation-change with escape sequences. This
is a pure text transform (no tokenizing/parsing) meant for transmitting
`.inml` structure without embedded raw newlines.

```ts
import { encodeWireFormat, decodeWireFormat } from "indent-parser";

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

## Development

```
npm install
npm run build
npm test
```
