import {
  Diagnostic,
  DiagnosticSeverity,
  type Range,
} from "vscode-languageserver";
import type { WorkspaceIndex } from "./indexer.js";
import { validateDocumentAgainstSchema } from "./schemaValidator.js";

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

  // 5. Double-usage hard error: a schema-classified file cannot also be
  // pulled in via !include as ordinary content.
  for (const link of index.includeLinks) {
    if (link.sourceUri === uri && link.invalidIncludeOfSchemaFile) {
      diagnostics.push({
        range: link.range,
        message: `Cannot !include '${link.rawPath}' -- it is a schema definition file and must be bound with !schema instead`,
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    }
  }

  // 6. Schema-directive misuse: placement rules the LSP enforces itself
  // since it never runs indent-lang's resolver.ts. Every `!schema`
  // occurrence is checked, not just the one that ends up bound.
  const schemaStatements = doc.allStatements.filter((s) => s.isSchema);
  for (let i = 0; i < schemaStatements.length; i++) {
    const stmt = schemaStatements[i];
    const isFirstRootStatement = doc.roots.length > 0 && doc.roots[0].id === stmt.id;

    if (i > 0) {
      diagnostics.push({
        range: stmt.kindRange,
        message: "!schema may only appear once per file",
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
      continue;
    }
    if (stmt.depth !== 0 || !isFirstRootStatement) {
      diagnostics.push({
        range: stmt.kindRange,
        message: "!schema must be the first statement in the file",
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    }
    if (Object.keys(stmt.attrs).length > 0) {
      diagnostics.push({
        range: stmt.kindRange,
        message: "!schema does not accept attributes",
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    }
    if (!stmt.value || stmt.value.valueType !== "string") {
      diagnostics.push({
        range: stmt.kindRange,
        message: "!schema requires a quoted string path",
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    }
  }

  // 7. The resolved schema binding (if any) must point at a valid schema file.
  const binding = index.schemaBindingByUri.get(uri);
  if (binding) {
    if (!binding.exists) {
      diagnostics.push({
        range: binding.range,
        message: `Linked schema file does not exist: '${binding.rawPath}'`,
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    } else if (!binding.isValidSchemaFile) {
      diagnostics.push({
        range: binding.range,
        message: `'${binding.rawPath}' is not a valid schema file`,
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    } else {
      // 8. Schema validation: the binding resolved to a parsed schema --
      // validate this document's own tree against it.
      const schemaEntry = binding.resolvedUri ? index.schemaFiles.get(binding.resolvedUri) : undefined;
      if (schemaEntry?.schema) {
        diagnostics.push(...validateDocumentAgainstSchema(doc, schemaEntry.schema, index));
      }
    }
  }

  // 9. Schema file's own grammar diagnostics: when this document is itself
  // schema-classified and failed to parse as schema grammar.
  if (index.schemaClassifiedUris.has(uri)) {
    const entry = index.schemaFiles.get(uri);
    if (entry?.parseError) {
      const range: Range =
        entry.parseErrorRange ??
        doc.roots[0]?.kindRange ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        };
      diagnostics.push({
        range,
        message: entry.parseError,
        severity: DiagnosticSeverity.Error,
        source: "indent-schema",
      });
    }
  }

  return diagnostics;
}
