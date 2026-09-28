import {
  FormattingOptions,
  type Position,
  Range,
  TextEdit,
} from "vscode-languageserver";

const CONTINUATION_RE = /\\\s*$/;
const FIRST_TOKEN_RE = /^(\s*\S+\s+)/;

export function firstAttributeColumn(lineText: string): number | null {
  const match = lineText.match(FIRST_TOKEN_RE);
  return match ? match[1].length : null;
}

export function findStatementStartLine(
  getLineText: (i: number) => string,
  lineIndex: number
): number {
  let idx = lineIndex;
  while (idx > 0 && CONTINUATION_RE.test(getLineText(idx - 1))) {
    idx--;
  }
  return idx;
}

export function computeContinuationIndent(
  getLineText: (i: number) => string,
  newLineIndex: number
): string | null {
  if (newLineIndex === 0) return null;

  const previousLineText = getLineText(newLineIndex - 1);
  if (!CONTINUATION_RE.test(previousLineText)) return null;

  const statementStartLine = findStatementStartLine(
    getLineText,
    newLineIndex - 1
  );
  const targetColumn = firstAttributeColumn(getLineText(statementStartLine));
  if (targetColumn === null) return null;

  return " ".repeat(targetColumn);
}

export function formatOnType(
  documentText: string,
  position: Position,
  ch: string
): TextEdit[] {
  if (ch !== "\n") return [];

  const lines = documentText.split(/\r\n|\r|\n/);
  const getLineText = (i: number) => lines[i] ?? "";

  const targetIndent = computeContinuationIndent(getLineText, position.line);
  if (targetIndent === null) return [];

  const currentLineText = getLineText(position.line);
  const currentIndentLength = (currentLineText.match(/^\s*/) || [""])[0].length;

  const range = Range.create(
    position.line,
    0,
    position.line,
    currentIndentLength
  );
  return [TextEdit.replace(range, targetIndent)];
}

export function formatDocument(
  documentText: string,
  options?: FormattingOptions
): TextEdit[] {
  const lines = documentText.split(/\r\n|\r|\n/);
  const formattedLines: string[] = [];

  const tabSize = options?.tabSize ?? 4;
  const indentUnit = " ".repeat(tabSize);

  let inContinuation = false;
  let continuationIndent = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      formattedLines.push("");
      continue;
    }

    if (trimmed.startsWith(";")) {
      // Preserve leading depth
      const leadingSpaces = (rawLine.match(/^\s*/) || [""])[0].length;
      const depth = Math.floor(leadingSpaces / 4);
      formattedLines.push(indentUnit.repeat(depth) + trimmed);
      continue;
    }

    if (inContinuation) {
      formattedLines.push(continuationIndent + trimmed);
      if (!CONTINUATION_RE.test(trimmed)) {
        inContinuation = false;
      }
      continue;
    }

    // Normal line: calculate indentation depth
    const leadingSpaces = (rawLine.match(/^\s*/) || [""])[0].length;
    const depth = Math.floor(leadingSpaces / 4);
    const indent = indentUnit.repeat(depth);

    // Format single line statement
    const formattedStatement = indent + trimmed;
    formattedLines.push(formattedStatement);

    if (CONTINUATION_RE.test(trimmed)) {
      inContinuation = true;
      const col = firstAttributeColumn(formattedStatement);
      continuationIndent = " ".repeat(col ?? (depth + 1) * tabSize);
    }
  }

  const newFullText = formattedLines.join("\n");
  if (newFullText === documentText) return [];

  const lastLine = lines.length > 0 ? lines.length - 1 : 0;
  const lastChar = lines.length > 0 ? lines[lastLine].length : 0;

  return [
    TextEdit.replace(
      Range.create(0, 0, lastLine, lastChar),
      newFullText
    ),
  ];
}
