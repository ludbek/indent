#!/usr/bin/env node
// Standard esbuild-based VS Code extension bundling:
// - bundle the extension client into a single dist/extension.js (esbuild)
// - copy the already-bundled language server (tsup output) into dist/server.cjs
// - copy the grammar's wasm blob (tree-sitter-indent.wasm) alongside server.cjs
// - copy web-tree-sitter's runtime (its own .wasm + JS glue, can't be bundled
//   by esbuild since it's an Emscripten-glue module) into node_modules/ next
//   to dist/ so plain `require("web-tree-sitter")` resolution still finds it
//   at runtime inside a packaged .vsix.
//
// Everything shipped is a portable wasm blob -- no native/platform-specific
// binaries, no per-OS/arch packaging matrix needed.
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const monorepoRoot = path.join(root, "..");
const distDir = path.join(root, "dist");
const nodeModulesDir = path.join(root, "node_modules");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  rmrf(dest);
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

async function main() {
  rmrf(distDir);
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Bundle the extension client into a single file. `vscode` is provided
  // by the extension host at runtime and must stay external.
  await esbuild.build({
    entryPoints: [path.join(root, "extension.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    outfile: path.join(distDir, "extension.js"),
    sourcemap: true,
  });

  // 2. Copy the pre-bundled language server (tsup already inlined everything
  // except the externalized `web-tree-sitter` package) and its grammar wasm.
  const serverDistDir = path.join(monorepoRoot, "indent-language-server", "dist");
  const serverSrc = path.join(serverDistDir, "cli.cjs");
  const serverSrcMap = `${serverSrc}.map`;
  fs.copyFileSync(serverSrc, path.join(distDir, "server.cjs"));
  if (fs.existsSync(serverSrcMap)) {
    fs.copyFileSync(serverSrcMap, path.join(distDir, "server.cjs.map"));
  }
  copyFile(
    path.join(serverDistDir, "tree-sitter-indent.wasm"),
    path.join(distDir, "tree-sitter-indent.wasm")
  );

  // 3. Copy web-tree-sitter's runtime (its CJS glue + own wasm blob) so
  // `require("web-tree-sitter")` resolves correctly from a packaged
  // extension that ships its own node_modules. web-tree-sitter has zero
  // dependencies and no native/per-platform binaries -- a single copy works
  // on every OS/arch, no packaging matrix needed.
  rmrf(nodeModulesDir);
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  {
    const src = path.join(monorepoRoot, "node_modules", "web-tree-sitter");
    const dest = path.join(nodeModulesDir, "web-tree-sitter");
    for (const file of ["package.json", "web-tree-sitter.cjs", "web-tree-sitter.cjs.map", "web-tree-sitter.wasm"]) {
      copyFile(path.join(src, file), path.join(dest, file));
    }
  }

  console.log("Build complete: dist/{extension.js,server.cjs,tree-sitter-indent.wasm}, node_modules/web-tree-sitter");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
