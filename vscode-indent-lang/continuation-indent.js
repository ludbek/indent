// Pure, VS Code-API-free logic for the continuation-alignment on-type
// formatter, so it can be unit tested with plain Node without needing a
// running VS Code Extension Host. See extension.js for the thin wrapper
// that wires this up to `vscode.languages.registerOnTypeFormattingEditProvider`.

const CONTINUATION_RE = /\\\s*$/;
const FIRST_TOKEN_RE = /^(\s*\S+\s+)/;

/**
 * Finds the column (character offset) where the first attribute starts on
 * a statement's opening line, e.g. for `API name="..."` this is the index
 * right after `API `. Returns null if the line has no second token to
 * align to (e.g. a bare `org` with no attributes at all).
 */
function firstAttributeColumn(lineText) {
  const match = lineText.match(FIRST_TOKEN_RE);
  return match ? match[1].length : null;
}

/**
 * Walks upward from `lineIndex` through the contiguous chain of
 * backslash-continued lines to find the index of the statement's true
 * opening line (the one that does NOT follow another continuation line).
 * `getLineText(i)` returns the text of line `i`.
 */
function findStatementStartLine(getLineText, lineIndex) {
  let idx = lineIndex;
  while (idx > 0 && CONTINUATION_RE.test(getLineText(idx - 1))) {
    idx--;
  }
  return idx;
}

/**
 * Computes the replacement indentation (a string of spaces) for the new
 * line created by pressing Enter at the end of `previousLineText`, given
 * `getLineText(i)` to look up earlier lines. Returns null if no
 * realignment should happen (previous line wasn't a continuation, or the
 * statement's opening line has nothing to align to).
 */
function computeContinuationIndent(getLineText, newLineIndex) {
  if (newLineIndex === 0) return null;

  const previousLineText = getLineText(newLineIndex - 1);
  if (!CONTINUATION_RE.test(previousLineText)) return null;

  const statementStartLine = findStatementStartLine(getLineText, newLineIndex - 1);
  const targetColumn = firstAttributeColumn(getLineText(statementStartLine));
  if (targetColumn === null) return null;

  return " ".repeat(targetColumn);
}

module.exports = {
  CONTINUATION_RE,
  FIRST_TOKEN_RE,
  firstAttributeColumn,
  findStatementStartLine,
  computeContinuationIndent,
};
