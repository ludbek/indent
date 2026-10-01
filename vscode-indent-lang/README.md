# vscode-indent-lang

VS Code syntax highlighting for the Indent Markup Language.

This is the pragmatic "baseline" highlighting extension: it uses a plain
TextMate grammar (`syntaxes/indent.tmLanguage.json`), since VS Code's built-in
editor does not support Tree-sitter grammars directly. The canonical,
structurally-correct grammar for Indent lives in the sibling
`treesitter-indent` package (used for other tools -- linting, other editors,
CLI tooling, etc.).

## What gets highlighted

- The leading bareword `type`/tag of each line (`org`, `service`, `->`,
  `include`, ...) as a keyword.
- `key=` attribute names as parameters.
- `"..."` string values, unquoted `true`/`false` booleans, and unquoted
  numeric values, each with their own scope.
- Full-line `;` comments.
- A trailing `\` line-continuation marker gets a visible color.
- Backslash-continued statements (a line ending in `\`, joined with one or
  more following physical lines) are highlighted correctly across every
  continued line via a multi-line `begin`/`end` TextMate rule
  (`#statement-with-continuation`) -- not just the first line.

## Development

Install test-only dependencies and run the smoke tests (these exercise the
real grammar via `vscode-textmate` + `vscode-oniguruma`, not just eyeballing
the regexes):

```sh
npm install
npm test
```

`test/smoke-test.js` tokenizes a small hand-written snippet and prints every
token's scope. `test/smoke-test-file.js <path>` tokenizes an entire `.inml`
file and reports any line whose real content ends up with no specific scope
(i.e. unclassified) -- both should show zero unclassified content, including
across backslash-continued statements.

## Installing locally in VS Code

This extension isn't published to the Marketplace. To try it locally:

1. Open this folder in VS Code.
2. Press F5 (or use "Run Extension" in the Debug panel) to launch an
   Extension Development Host window with the extension loaded.
3. Open any `.inml` file in that window.
