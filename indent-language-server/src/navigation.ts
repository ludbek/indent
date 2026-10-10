import {
  Definition,
  DocumentSymbol,
  Hover,
  Location,
  MarkupKind,
  type Position,
  type Range,
  SymbolKind,
} from "vscode-languageserver";
import type { WorkspaceIndex } from "./indexer.js";
import type { AstStatement, IndexedNode } from "./types.js";
import type { Schema } from "indent-lang/schema";

function getSchemaForDocument(index: WorkspaceIndex, uri: string): Schema | undefined {
  const binding = index.schemaBindingByUri.get(uri);
  if (!binding || !binding.isValidSchemaFile || !binding.resolvedUri) return undefined;
  return index.schemaFiles.get(binding.resolvedUri)?.schema;
}

function isPositionInsideRange(pos: Position, range: Range): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

// Indent has no reserved/special kind names -- every statement's `kind` is
// an ordinary author-chosen identifier, so there is no fixed kind-to-icon
// mapping. All nodes are surfaced uniformly in outlines/symbols.
function getSymbolKind(_kind: string): SymbolKind {
  return SymbolKind.Object;
}

export function getDefinition(
  uri: string,
  position: Position,
  index: WorkspaceIndex
): Definition | null {
  // 1. Check include links
  for (const link of index.includeLinks) {
    if (link.sourceUri === uri && isPositionInsideRange(position, link.range)) {
      if (link.resolvedUri && link.exists) {
        return Location.create(link.resolvedUri, {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        });
      }
    }
  }

  // 2. Check ref references
  for (const ref of index.refReferences) {
    if (ref.uri === uri && isPositionInsideRange(position, ref.range)) {
      const locations: Location[] = [];
      for (const targetPath of ref.resolvedTargetPaths) {
        const targetNode = index.getNodeByPath(targetPath);
        if (targetNode) {
          locations.push(
            Location.create(targetNode.uri, targetNode.statement.kindRange)
          );
        }
      }
      if (locations.length === 1) return locations[0];
      if (locations.length > 1) return locations;
    }
  }

  return null;
}

export function getHover(
  uri: string,
  position: Position,
  index: WorkspaceIndex
): Hover | null {
  // 1. Hover on include link
  for (const link of index.includeLinks) {
    if (link.sourceUri === uri && isPositionInsideRange(position, link.range)) {
      const md = [
        `### Include File`,
        `**Path:** \`${link.rawPath}\``,
        `**Resolved:** \`${link.resolvedFsPath}\``,
        link.exists ? `Status: Valid` : `Status: **File Not Found**`,
      ].join("\n\n");
      return {
        contents: { kind: MarkupKind.Markdown, value: md },
        range: link.range,
      };
    }
  }

  // 2. Hover on schema link
  for (const link of index.schemaLinks) {
    if (link.sourceUri === uri && isPositionInsideRange(position, link.range)) {
      const md = [
        `### Schema File`,
        `**Path:** \`${link.rawPath}\``,
        `**Resolved:** \`${link.resolvedFsPath}\``,
        link.isValidSchemaFile
          ? `Status: Valid`
          : link.exists
            ? `Status: **Not a valid schema file**`
            : `Status: **File Not Found**`,
      ].join("\n\n");
      return {
        contents: { kind: MarkupKind.Markdown, value: md },
        range: link.range,
      };
    }
  }

  // 3. Hover on ref reference
  for (const ref of index.refReferences) {
    if (ref.uri === uri && isPositionInsideRange(position, ref.range)) {
      const targets = ref.resolvedTargetPaths
        .map((p) => index.getNodeByPath(p))
        .filter((n): n is IndexedNode => n !== undefined);

      if (targets.length > 0) {
        const mdParts = targets.map((target) => {
          const lines = [
            `### [${target.kind}] ${target.label}`,
            `**Canonical Path:** \`${target.canonicalPath}\``,
          ];
          if (target.value) {
            lines.push(`**Value:** \`${target.value.valueRaw}\``);
          }
          const attrList = Object.entries(target.attrs)
            .map(([k, v]) => `- \`${k}\`: \`${v.value}\``)
            .join("\n");
          if (attrList) {
            lines.push(`**Attributes:**\n${attrList}`);
          }
          return lines.join("\n\n");
        });

        return {
          contents: { kind: MarkupKind.Markdown, value: mdParts.join("\n\n---\n\n") },
          range: ref.range,
        };
      } else {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**Unresolved reference:** \`${ref.rawRef}\``,
          },
          range: ref.range,
        };
      }
    }
  }

  // 4. Hover on statement node / keyword / attribute
  const stmt = index.getStatementAtPosition(uri, position);
  if (stmt) {
    const schema = getSchemaForDocument(index, uri);
    const kindSchema = schema?.kinds.get(stmt.kind);
    const node = index.nodesById.get(stmt.id);
    if (node) {
      const lines = [
        `### [${node.kind}] ${node.label}`,
        `**Canonical Path:** \`${node.canonicalPath}\``,
      ];
      if (node.value) {
        lines.push(`**Value:** \`${node.value.valueRaw}\``);
      }

      const attrList = Object.entries(node.attrs)
        .map(([k, v]) => {
          const attrSchema = kindSchema?.attrs.get(k);
          const schemaNote = attrSchema
            ? ` _(${attrSchema.required ? "required" : "optional"} ${attrSchema.type}, schema)_`
            : "";
          return `- \`${k}\`: \`${v.value}\`${schemaNote}`;
        })
        .join("\n");
      if (attrList) {
        lines.push(`**Attributes:**\n${attrList}`);
      }

      if (kindSchema) {
        const schemaAttrLines = Array.from(kindSchema.attrs.entries())
          .filter(([name]) => !(name in node.attrs))
          .map(([name, a]) => `- \`${name}\`: ${a.required ? "required" : "optional"} ${a.type}`);
        if (schemaAttrLines.length > 0) {
          lines.push(`**Other schema attrs for '${stmt.kind}':**\n${schemaAttrLines.join("\n")}`);
        }
        const childKinds = Array.from(kindSchema.children.keys());
        if (childKinds.length > 0) {
          lines.push(`**Allowed children (schema):** ${childKinds.map((k) => `\`${k}\``).join(", ")}`);
        }
      } else if (schema && !schema.kinds.has(stmt.kind) && !schema.roots.has(stmt.kind)) {
        lines.push(`_Kind \`${stmt.kind}\` is not declared in the bound schema._`);
      }

      // Show inbound references pointing to this node
      const inbounds = index.inboundReferences.get(node.canonicalPath) || [];
      if (inbounds.length > 0) {
        lines.push(`**Referenced by (${inbounds.length}):**\n` + inbounds.map((r) => `- \`${r.sourceNodePath}\`${r.attrName ? ` (${r.attrName})` : ""}`).slice(0, 10).join("\n"));
      }

      return {
        contents: { kind: MarkupKind.Markdown, value: lines.join("\n\n") },
        range: stmt.lineRange,
      };
    }
  }

  return null;
}

export function getDocumentSymbols(
  uri: string,
  index: WorkspaceIndex
): DocumentSymbol[] {
  const doc = index.getDocument(uri);
  if (!doc) return [];

  const mapStatementToSymbol = (stmt: AstStatement): DocumentSymbol | null => {
    if (stmt.isInclude) {
      return {
        name: stmt.includePath || stmt.kind,
        detail: "include",
        kind: SymbolKind.File,
        range: stmt.range,
        selectionRange: stmt.kindRange,
      };
    }

    const label = stmt.kind;
    // Show positional value and key attributes as detail for context in the outline
    const attrSummary = Object.entries(stmt.attrs)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v.value === "string" ? `"${v.value}"` : v.value}`)
      .join(" ");

    const detailParts: string[] = [];
    if (stmt.value) detailParts.push(stmt.value.valueRaw);
    if (attrSummary) detailParts.push(attrSummary);
    const detail = detailParts.join(" ");

    const symbol: DocumentSymbol = {
      name: label,
      detail,
      kind: getSymbolKind(stmt.kind),
      range: stmt.range,
      selectionRange: stmt.kindRange,
      children: [],
    };

    for (const child of stmt.children) {
      const childSym = mapStatementToSymbol(child);
      if (childSym) {
        symbol.children!.push(childSym);
      }
    }

    return symbol;
  };

  const symbols: DocumentSymbol[] = [];
  for (const root of doc.roots) {
    const sym = mapStatementToSymbol(root);
    if (sym) {
      symbols.push(sym);
    }
  }

  return symbols;
}

export function getReferences(
  uri: string,
  position: Position,
  index: WorkspaceIndex
): Location[] {
  const stmt = index.getStatementAtPosition(uri, position);
  if (!stmt) return [];

  const node = index.nodesById.get(stmt.id);
  if (!node) return [];

  const inbounds = index.inboundReferences.get(node.canonicalPath) || [];
  return inbounds.map((ref) => Location.create(ref.uri, ref.range));
}
