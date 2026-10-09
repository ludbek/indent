#!/usr/bin/env node
// Builds the language server + extension, packages a fresh .vsix, installs it
// into an isolated VS Code profile (so your real settings/extensions are
// untouched), and launches VS Code against that profile with a sample
// .inml file open so you can manually smoke-test the extension end-to-end.
//
// Usage: node scripts/test-local.js [path/to/file.inml]
//   (defaults to indent-lang/test/fixtures/sample.inml if no path given)

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..", "..");
const vscodeExtDir = path.join(repoRoot, "vscode-indent-lang");
const vsixPath = path.join(vscodeExtDir, "vscode-indent-lang.vsix");

const sampleFile =
  process.argv[2] ||
  path.join(repoRoot, "indent-lang", "test", "fixtures", "sample.inml");

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

console.log("== 1/4: build indent-language-server ==");
run("npm", ["run", "build", "--workspace", "indent-language-server"], repoRoot);

console.log("\n== 2/4: build vscode-indent-lang extension ==");
run("node", ["scripts/build.js"], vscodeExtDir);

console.log("\n== 3/4: package vsix ==");
run("node", ["scripts/package.js"], vscodeExtDir);

if (!fs.existsSync(vsixPath)) {
  console.error(`Expected vsix at ${vsixPath} but it was not found.`);
  process.exit(1);
}

console.log("\n== 4/4: install into isolated VS Code profile ==");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-indent-lang-test-"));
const userDataDir = path.join(testRoot, "user-data");
const extensionsDir = path.join(testRoot, "extensions");
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(extensionsDir, { recursive: true });

run(
  "code",
  [
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
    "--install-extension",
    vsixPath,
  ],
  repoRoot
);

console.log(`\nInstalled into isolated profile at ${testRoot}`);

if (!fs.existsSync(sampleFile)) {
  console.warn(`Sample file not found at ${sampleFile}, skipping launch.`);
} else {
  console.log(`\nLaunching VS Code against isolated profile with ${sampleFile} ...`);
  run(
    "code",
    [
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      sampleFile,
    ],
    repoRoot
  );
}

console.log(`
Done. VS Code launched with the freshly packaged extension in an isolated profile.
- Check syntax highlighting on the opened file.
- Check the "Indent Language Server" output channel for errors.
- Verify hover/completions/go-to-definition work.

Isolated profile left at: ${testRoot}
Delete it manually when done: rm -rf ${testRoot}
`);
