// Copies the compiled treesitter-indent grammar wasm into dist/ so cst.ts's
// bundled-path lookup (see resolveGrammarWasmPath in src/cst.ts) finds it
// next to the built server output. Run after `tsup` via the `build` script.
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "..", "treesitter-indent", "tree-sitter-indent.wasm");
const destDir = join(__dirname, "..", "dist");
const dest = join(destDir, "tree-sitter-indent.wasm");

if (!existsSync(src)) {
  console.error(
    `[copy-wasm] Missing ${src}. Run "npm run build:wasm --workspace treesitter-indent" first.`
  );
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`[copy-wasm] Copied ${src} -> ${dest}`);
