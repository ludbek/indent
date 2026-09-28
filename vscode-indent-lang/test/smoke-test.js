// Standalone smoke test for the TextMate grammar (not shipped with the
// extension). Verifies real tokenization via vscode-textmate +
// vscode-oniguruma against a small representative snippet.
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

  const lines = [
    'org name="Acme" color="green"',
    '    ; a comment',
    '    team name="Phoenix" pk=true count=42',
    '    service "Auth Service" owner="ateam"',
    '        database 123 is_active=true',
    '        flag false',
    '        -> "/UpstreamOrg/Member"',
    '    -> entity="Globex/super/rollover"',
  ];

  let ruleStack = INITIAL;
  for (const line of lines) {
    const result = grammar.tokenizeLine(line, ruleStack);
    console.log(`\nLine: ${JSON.stringify(line)}`);
    for (const token of result.tokens) {
      const text = line.substring(token.startIndex, token.endIndex);
      console.log(`  ${JSON.stringify(text)} -> ${token.scopes.join(" ")}`);
    }
    ruleStack = result.ruleStack;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
