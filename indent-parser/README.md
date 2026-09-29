
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

## Development

```
npm install
npm run build
npm test
```
