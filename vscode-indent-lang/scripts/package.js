#!/usr/bin/env node
// Package the extension into a .vsix.
//
// `vsce` collects files by walking up to the nearest `.git` root, which in
// this npm-workspaces monorepo is the repo root -- so running `vsce package`
// directly from vscode-indent-lang/ pulls in every sibling package and the
// whole `.git` history, ignoring `.vscodeignore` scope. There is no vsce
// flag to disable this. The standard workaround is to stage the extension's
// packaging surface in an isolated directory outside the git working tree,
// then run `vsce package` from there.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-indent-lang-package-"));

// Files that make up the packaged extension (mirrors .vscodeignore's allow-list).
const filesToStage = [
  "package.json",
  "README.md",
  "language-configuration.json",
  "continuation-indent.js",
  "syntaxes",
  "dist",
];

function main() {
  // 1. Rebuild so dist/ and node_modules/web-tree-sitter are current.
  execFileSync("node", [path.join(__dirname, "build.js")], {
    cwd: root,
    stdio: "inherit",
  });

  // 2. Stage the packaging surface in a directory with no parent .git.
  for (const entry of filesToStage) {
    const src = path.join(root, entry);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(stageDir, entry), { recursive: true });
  }
  fs.cpSync(
    path.join(root, "node_modules"),
    path.join(stageDir, "node_modules"),
    { recursive: true }
  );

  // vsce always runs `vscode:prepublish` if present, but the build already
  // ran in step 1 and scripts/ isn't staged -- strip build-only scripts from
  // the staged package.json so vsce's auto-prepublish is a no-op. vsce also
  // shells out to `npm list --production` to validate the dependency tree;
  // since the real deps are `devDependencies` (bundled by esbuild) and only
  // `web-tree-sitter` is physically copied into node_modules (it has zero
  // dependencies of its own, no stub packages needed), declare exactly that
  // as `dependencies` so npm list doesn't flag it as extraneous/missing.
  const pkgJsonPath = path.join(stageDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  delete pkgJson.scripts;
  const webTreeSitterPkg = JSON.parse(
    fs.readFileSync(path.join(stageDir, "node_modules", "web-tree-sitter", "package.json"), "utf8")
  );
  pkgJson.dependencies = { "web-tree-sitter": webTreeSitterPkg.version };
  delete pkgJson.devDependencies;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

  // 3. Run vsce package from the isolated staging directory.
  execFileSync(
    "npx",
    ["--yes", "@vscode/vsce", "package", "-o", path.join(root, "vscode-indent-lang.vsix")],
    { cwd: stageDir, stdio: "inherit" }
  );

  console.log(`Packaged: ${path.join(root, "vscode-indent-lang.vsix")}`);
  console.log(`(staged at ${stageDir}, safe to delete)`);
}

main();
