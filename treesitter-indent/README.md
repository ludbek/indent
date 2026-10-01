# treesitter-indent

Tree-sitter grammar for Indent Markup Language.

## Grammar shape

The grammar is intentionally generic -- there is no special-cased
"edge"/"reference"/"include" concept at this layer, matching the hand-written
parser in `indent-parser`:

```
document  := NEWLINE? statement*
statement := type attribute* NEWLINE block?
block     := INDENT statement+ DEDENT
attribute := attribute_name "=" value
value     := string | number | boolean
```

- `type` is any bareword up to the first space (e.g. `org`, `service`,
  `->`, `=>`, `include` -- all just ordinary keywords; meaning is assigned
  entirely by downstream consumers).
- Indentation is 4 spaces per level, tracked via external `NEWLINE` /
  `INDENT` / `DEDENT` tokens (see `src/scanner.c`), since indentation
  sensitivity isn't context-free.
- A trailing `\` joins the current line with the next physical line; this
  is modeled as an invisible `extras` token in `grammar.js` rather than
  scanner logic (see the comment at the top of `src/scanner.c` for why).

## Building

```sh
npm install         # also runs `node-gyp-build` to compile the native binding
tree-sitter generate
```

## Testing

The corpus test suite in `test/corpus/statements.txt` is the primary
correctness check:

```sh
tree-sitter test
```

It covers: attributes (quoted strings, unquoted numbers/booleans), single-
and multi-level nesting, multi-level dedent back to a shallower depth,
full-line comments and blank lines, backslash line-continuation, bareword
kinds like `->`, and EOF without a trailing newline.

You can also sanity-check against real fixtures directly:

```sh
tree-sitter parse ../indent-parser/test/fixtures/sample.inml
tree-sitter parse ../test.inml
```

Both should produce zero `ERROR` nodes.

## Highlighting

`queries/highlights.scm` provides syntax-highlighting captures for editors
that support Tree-sitter directly (Neovim, Helix, Zed, etc.). VS Code does
not consume Tree-sitter grammars natively -- see the sibling
`vscode-indent-lang` package for a plain TextMate grammar instead.
