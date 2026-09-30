import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/cli.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  target: "node18",
  // Only web-tree-sitter stays external (it ships its own wasm asset that must
  // be located on disk at runtime). Everything else -- vscode-languageserver,
  // vscode-uri, indent-parser, indent-xpath, etc. -- must be bundled so the
  // built dist/*.cjs is fully self-contained once copied into a packaged
  // VS Code extension's dist/ (no reliance on a workspace-hoisted node_modules).
  external: ["web-tree-sitter"],
  noExternal: [
    "vscode-languageserver",
    "vscode-languageserver-textdocument",
    "vscode-uri",
    "indent-parser",
    "indent-xpath",
  ],
});
