// Assertion-based regression test for the TextMate grammar's kind-token
// highlighting. Verifies real tokenization via vscode-textmate +
// vscode-oniguruma, asserting scopes rather than just eyeballing smoke-test
// output.
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Registry, INITIAL } = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

async function loadGrammar() {
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

  return registry.loadGrammar("source.indent");
}

// Tokenizes a single line and returns the scope of the token(s) covering
// the given substring (asserts it's a single contiguous token).
function scopeOf(grammar, line, substring) {
  const result = grammar.tokenizeLine(line, INITIAL);
  const startIndex = line.indexOf(substring);
  assert.ok(startIndex >= 0, `substring ${JSON.stringify(substring)} not found in line`);
  const endIndex = startIndex + substring.length;
  const covering = result.tokens.filter(
    (t) => t.startIndex < endIndex && t.endIndex > startIndex,
  );
  assert.strictEqual(
    covering.length,
    1,
    `expected ${JSON.stringify(substring)} to be a single token, got ${covering.length}: ${JSON.stringify(
      covering.map((t) => line.substring(t.startIndex, t.endIndex)),
    )}`,
  );
  const token = covering[0];
  assert.strictEqual(token.startIndex, startIndex, `token should start exactly at ${JSON.stringify(substring)}`);
  assert.strictEqual(token.endIndex, endIndex, `token should end exactly at ${JSON.stringify(substring)}`);
  return token.scopes[token.scopes.length - 1];
}

async function main() {
  const grammar = await loadGrammar();

  // Regression: ">=<" (sync-call edge kind) must be highlighted whole as
  // keyword.control.indent, not split into a partial "attribute" match
  // (">" name + "=" operator) leaving the trailing "<" unstyled.
  assert.strictEqual(
    scopeOf(grammar, '    >=< //API[.="UpstreamOrg Get Member"]', ">=<"),
    "keyword.control.indent",
  );

  // Sibling edge kinds should remain correctly highlighted too.
  assert.strictEqual(scopeOf(grammar, '    >- //event-handler', ">-"), "keyword.control.indent");
  assert.strictEqual(scopeOf(grammar, '    -- //Service', "--"), "keyword.control.indent");

  // Plain kind and a real attribute should still tokenize correctly.
  assert.strictEqual(scopeOf(grammar, 'API "MB Get Member" type="REST"', "API"), "keyword.control.indent");
  assert.strictEqual(scopeOf(grammar, 'API "MB Get Member" type="REST"', "type"), "variable.parameter.indent");

  console.log("tmgrammar.test.js: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
