const fs = require("fs");
const path = require("path");
const { Registry, INITIAL } = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

async function main() {
  const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
  const wasmBin = fs.readFileSync(wasmPath).buffer;
  await oniguruma.loadWASM(wasmBin);

  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName) => {
      if (scopeName !== "source.indent") return null;
      const grammarPath = path.join(__dirname, "..", "syntaxes", "indent.tmLanguage.json");
      return JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    },
  });

  const grammar = await registry.loadGrammar("source.indent");
  const filePath = process.argv[2];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r\n|\r|\n/);

  let ruleStack = INITIAL;
  const scopeCounts = {};
  let lineNum = 0;
  for (const line of lines) {
    lineNum++;
    const result = grammar.tokenizeLine(line, ruleStack);
    for (const token of result.tokens) {
      const text = line.substring(token.startIndex, token.endIndex);
      if (text.trim().length === 0) continue;
      const scope = token.scopes[token.scopes.length - 1];
      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      // Flag anything that ended up with NO specific scope beyond the
      // base source.indent (i.e. unclassified real content).
      if (scope === "source.indent" && !/^\s*$/.test(text)) {
        console.log(`UNCLASSIFIED line ${lineNum}: ${JSON.stringify(text)}`);
      }
    }
    ruleStack = result.ruleStack;
  }
  console.log("\nScope counts:", scopeCounts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
