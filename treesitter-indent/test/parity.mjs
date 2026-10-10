// Sanity check: native (node-gyp) binding and WASM (web-tree-sitter) binding
// must produce identical tree shapes for the same source, since both are
// compiled from the same grammar.js + scanner.c. This guards against the two
// binding targets drifting apart.
import assert from "node:assert";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import TreeSitter from "tree-sitter";
import { Parser as WasmParser, Language as WasmLanguage } from "web-tree-sitter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const nativeLanguage = require(path.join(__dirname, ".."));

const SOURCE = `org name="Acme"
    team name="Platform"
        service name="api" port=8080
`;

function printTree(node, depth = 0) {
  const indent = "  ".repeat(depth);
  let out = `${indent}(${node.type}`;
  const count = node.childCount ?? node.namedChildCount;
  const children = node.children ?? [];
  for (const child of children) {
    if (child) out += "\n" + printTree(child, depth + 1);
  }
  out += ")";
  return out;
}

async function main() {
  // Native parse
  const nativeParser = new TreeSitter();
  nativeParser.setLanguage(nativeLanguage);
  const nativeTree = nativeParser.parse(SOURCE);
  const nativeShape = printTree(nativeTree.rootNode);

  // WASM parse
  await WasmParser.init();
  const wasmLanguage = await WasmLanguage.load(
    path.join(__dirname, "..", "tree-sitter-indent.wasm")
  );
  const wasmParser = new WasmParser();
  wasmParser.setLanguage(wasmLanguage);
  const wasmTree = wasmParser.parse(SOURCE);
  const wasmShape = printTree(wasmTree.rootNode);

  assert.strictEqual(
    nativeShape,
    wasmShape,
    `Tree shape mismatch between native and WASM bindings:\nnative:\n${nativeShape}\nwasm:\n${wasmShape}`
  );

  console.log("OK: native and WASM bindings produce identical tree shapes");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
