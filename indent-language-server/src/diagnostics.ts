import {
  Diagnostic,
  DiagnosticSeverity,
  type Range,
} from "vscode-languageserver";
import type { WorkspaceIndex } from "./indexer.js";

export function computeDiagnostics(
  uri: string,
  index: WorkspaceIndex
): Diagnostic[] {
  const doc = index.getDocument(uri);
  if (!doc) return [];

  const diagnostics: Diagnostic[] = [];

  // 1. CST Syntax errors
  for (const err of doc.errors) {
    diagnostics.push({
      range: err.range,
      message: err.message,
      severity:
        err.severity === "error"
          ? DiagnosticSeverity.Error
          : DiagnosticSeverity.Warning,
      source: "indent",
    });
  }

  // 2. Indentation check (4 spaces per level, no tabs)
  const lines = doc.text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trimStart().startsWith(";")) continue;

    let spaceCount = 0;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === "\t") {
        diagnostics.push({
          range: {
            start: { line: i, character: c },
            end: { line: i, character: c + 1 },
          },
          message: "Tabs are not allowed for indentation; use 4 spaces per level",
          severity: DiagnosticSeverity.Error,
          source: "indent",
        });
        break;
      }
      if (line[c] === " ") {
        spaceCount++;
      } else {
        break;
      }
    }

    if (spaceCount % 4 !== 0) {
      diagnostics.push({
        range: {
          start: { line: i, character: 0 },
          end: { line: i, character: spaceCount },
        },
        message: `Inconsistent indentation: found ${spaceCount} leading spaces, expected a multiple of 4`,
        severity: DiagnosticSeverity.Error,
        source: "indent",
      });
    }
  }

  // 3. Include errors (file not found)
  for (const link of index.includeLinks) {
    if (link.sourceUri === uri && !link.exists) {
      diagnostics.push({
        range: link.range,
        message: `Included file does not exist: '${link.rawPath}'`,
        severity: DiagnosticSeverity.Error,
        source: "indent",
      });
    }
  }

  // 4. Unresolved refs
  for (const ref of index.refReferences) {
    if (ref.uri === uri && ref.resolvedTargetPaths.length === 0) {
      const location = ref.attrName ? `attribute '${ref.attrName}'` : "positional value";
      diagnostics.push({
        range: ref.range,
        message: `Unresolved reference '${ref.rawRef}' (${location})`,
        severity: DiagnosticSeverity.Warning,
        source: "indent",
      });
    }
  }

  return diagnostics;
}
