# Indent

A generic, human-friendly markup language toolchain: parser, path-query
language, tree-sitter grammar, language server, and VS Code extension.

## Packages

| Package | Description |
| --- | --- |
| [`indent-parser`](./indent-parser/README.md) | Parser for the Indent Markup Language. |
| [`indent-xpath`](./indent-xpath/README.md) | XPath-like node selector for tree-shaped data. |
| [`treesitter-indent`](./treesitter-indent/README.md) | Tree-sitter grammar for the Indent Markup Language. |
| [`indent-language-server`](./indent-language-server) | Language Server Protocol implementation for the Indent Markup Language. |
| [`vscode-indent-lang`](./vscode-indent-lang/README.md) | VS Code syntax highlighting extension for the Indent Markup Language. |

## Development

This is an npm workspaces monorepo. From the repo root:

```sh
npm install
npm run build   # build --workspaces --if-present
npm run test    # test --workspaces --if-present
```
