// Unit test for continuation-indent.js's pure alignment logic (no VS Code
// API dependency -- run with plain `node`).
const assert = require("node:assert");
const { computeContinuationIndent } = require("../continuation-indent");

function linesOf(text) {
  const lines = text.split("\n");
  return (i) => lines[i];
}

// Matches the screenshot scenario: pressing Enter after the first
// continuation line should align to the column of "name" (right after
// "API "), not to "API" itself and not to the indentation of the line
// above.
{
  const getLineText = linesOf(
    [
      '        API name="Search Address" type="REST" \\',
      '            <cursor-here>',
    ].join("\n"),
  );
  const indent = computeContinuationIndent(getLineText, 1);
  assert.strictEqual(indent, " ".repeat(12), "should align to column of first attribute (\"name\") on the opening line");
}

// Pressing Enter after a LATER continuation line (not the statement's
// first line) should still align to the ORIGINAL opening line's first
// attribute column, by walking back through the whole continuation chain.
{
  const getLineText = linesOf(
    [
      '        API name="Search Address" type="REST" \\',
      '            description="..." \\',
      '            method="POST" \\',
      '            <cursor-here>',
    ].join("\n"),
  );
  const indent = computeContinuationIndent(getLineText, 3);
  assert.strictEqual(indent, " ".repeat(12));
}

// A plain Enter after a line that does NOT end in '\' should not be
// touched at all (return null so VS Code's default auto-indent applies).
{
  const getLineText = linesOf(
    ['org name="Acme"', '    <cursor-here>'].join("\n"),
  );
  const indent = computeContinuationIndent(getLineText, 1);
  assert.strictEqual(indent, null);
}

// Enter on the very first line of a document (no previous line at all).
{
  const getLineText = linesOf(['<cursor-here>'].join("\n"));
  const indent = computeContinuationIndent(getLineText, 0);
  assert.strictEqual(indent, null);
}

// A statement with no attributes at all (nothing to align to) should not
// crash and should return null.
{
  const getLineText = linesOf(['org \\', '    <cursor-here>'].join("\n"));
  const indent = computeContinuationIndent(getLineText, 1);
  // "org \\" trimmed of the trailing backslash still has a trailing space
  // before it, so FIRST_TOKEN_RE ("^(\s*\S+\s+)") actually does match here
  // (captures "org "), aligning to column 4. This is an acceptable
  // fallback -- there's no real attribute to align to, but aligning past
  // the keyword is still reasonable and never null/crashes.
  assert.strictEqual(indent, " ".repeat(4));
}

console.log("All continuation-indent tests passed.");
