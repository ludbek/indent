import {
  type Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver";
import type { WorkspaceIndex } from "./indexer.js";

function isPositionInsideRange(pos: Position, range: Range): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

export function prepareRename(
  uri: string,
  position: Position,
  index: WorkspaceIndex
): { range: Range; placeholder: string } | null {
  const stmt = index.getStatementAtPosition(uri, position);
  if (!stmt) return null;

  // Rename is supported on the kind (tag name) token — since canonical paths
  // are built from kind names, renaming a kind updates the declaration and all
  // ref references that navigate through this node's kind.
  if (isPositionInsideRange(position, stmt.kindRange)) {
    return {
      range: stmt.kindRange,
      placeholder: stmt.kind,
    };
  }

  return null;
}

export function renameSymbol(
  uri: string,
  position: Position,
  newName: string,
  index: WorkspaceIndex
): WorkspaceEdit | null {
  const stmt = index.getStatementAtPosition(uri, position);
  if (!stmt) return null;

  const node = index.nodesById.get(stmt.id);
  if (!node) return null;

  if (!isPositionInsideRange(position, stmt.kindRange)) return null;

  const oldKind = stmt.kind;
  const changes: Record<string, TextEdit[]> = {};

  const addEdit = (docUri: string, edit: TextEdit) => {
    if (!changes[docUri]) changes[docUri] = [];
    changes[docUri].push(edit);
  };

  // 1. Rename the kind token in the declaration
  addEdit(stmt.uri, TextEdit.replace(stmt.kindRange, newName));

  // 2. Find all inbound references and update kind segments in their ref paths
  for (const [targetPath, inbounds] of index.inboundReferences.entries()) {
    if (
      targetPath === node.canonicalPath ||
      targetPath.startsWith(node.canonicalPath + "/")
    ) {
      for (const ref of inbounds) {
        const raw = ref.rawRef;
        // Replace kind name in path segments (e.g. /org/API → /org/Endpoint)
        const segments = raw.replace(/^["']|["']$/g, "").split("/");
        const updatedSegments = segments.map((s) => {
          // Match bare kind or kind with predicate (e.g. "API" or "API[name=\"Health\"]")
          if (s === oldKind) return newName;
          if (s.startsWith(oldKind + "[")) return newName + s.slice(oldKind.length);
          return s;
        });

        const updatedPath = updatedSegments.join("/");
        addEdit(ref.uri, TextEdit.replace(ref.range, updatedPath));
      }
    }
  }

  return { changes };
}
