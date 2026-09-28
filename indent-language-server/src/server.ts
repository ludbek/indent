import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  TextDocuments,
  _Connection,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { WorkspaceIndex } from "./indexer.js";
import { computeDiagnostics } from "./diagnostics.js";
import { computeCompletions } from "./completions.js";
import {
  getDefinition,
  getDocumentSymbols,
  getHover,
  getReferences,
} from "./navigation.js";
import { formatDocument, formatOnType } from "./formatting.js";
import { prepareRename, renameSymbol } from "./rename.js";
import { getSearchableNodes } from "./nodeSearch.js";
import { uriToFsPath } from "./indexer.js";
import { PROJECT_FILENAME } from "indent-parser";
import { basename } from "node:path";

export function createIndentLanguageServer(customConnection?: _Connection) {
  const connection =
    customConnection || createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
  const index = new WorkspaceIndex();

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    const roots: string[] = [];
    if (params.workspaceFolders) {
      for (const folder of params.workspaceFolders) {
        roots.push(uriToFsPath(folder.uri));
      }
    } else if (params.rootUri) {
      roots.push(uriToFsPath(params.rootUri));
    } else if (params.rootPath) {
      roots.push(params.rootPath);
    }

    index.refreshProjects(roots);
    index.preloadProjectFiles();

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: ["=", '"', "'", "/", ".", ">", " ", "[", ","],
        },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        referencesProvider: true,
        renameProvider: {
          prepareProvider: true,
        },
        documentFormattingProvider: true,
        documentOnTypeFormattingProvider: {
          firstTriggerCharacter: "\n",
        },
      },
    };
  });

  const updateDiagnostics = (uri: string) => {
    const diagnostics = computeDiagnostics(uri, index);
    connection.sendDiagnostics({ uri, diagnostics });
  };

  const updateDiagnosticsForAllOpenDocuments = () => {
    for (const uri of index.documents.keys()) {
      updateDiagnostics(uri);
    }
  };

  documents.onDidChangeContent((change) => {
    index.setDocument(
      change.document.uri,
      change.document.getText(),
      change.document.version
    );

    const isProjectManifest = basename(uriToFsPath(change.document.uri)) === PROJECT_FILENAME;
    if (isProjectManifest) {
      // A project.inml's entry/include graph affects reachability for
      // every other file, so recompute projects and re-publish
      // diagnostics for everything currently open.
      index.refreshProjects();
      index.preloadProjectFiles();
      updateDiagnosticsForAllOpenDocuments();
    } else {
      updateDiagnostics(change.document.uri);
    }
  });

  documents.onDidClose((e) => {
    // If this file is still reachable from a project's entry, keep it
    // indexed (just stop treating it as an open editor buffer) so refs
    // from other open documents into it keep resolving after the tab
    // closes -- only fully drop it from the index when it's genuinely
    // outside every project's include graph.
    if (index.reachableFiles.has(uriToFsPath(e.document.uri))) {
      index.preloadedUris.add(e.document.uri);
    } else {
      index.removeDocument(e.document.uri);
    }
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  });

  // The client (vscode-indent-lang) watches **/*.inml and forwards changes here
  // even for files that are never opened in an editor (e.g. created/edited
  // externally, or via git checkout/branch switch). Any such change can add,
  // remove, or rewire `!include` edges anywhere in a project's graph, so the
  // reachability set must be recomputed and every open document's
  // diagnostics re-published -- otherwise stale "not reachable" warnings
  // (or missed ones) can linger until project.inml itself happens to change.
  connection.onDidChangeWatchedFiles(() => {
    index.refreshProjects();
    index.preloadProjectFiles();
    updateDiagnosticsForAllOpenDocuments();
  });

  connection.onCompletion((params) => {
    return computeCompletions(params.textDocument.uri, params.position, index);
  });

  connection.onHover((params) => {
    return getHover(params.textDocument.uri, params.position, index);
  });

  connection.onDefinition((params) => {
    return getDefinition(params.textDocument.uri, params.position, index);
  });

  connection.onDocumentSymbol((params) => {
    return getDocumentSymbols(params.textDocument.uri, index);
  });

  connection.onReferences((params) => {
    return getReferences(params.textDocument.uri, params.position, index);
  });

  connection.onPrepareRename((params) => {
    return prepareRename(params.textDocument.uri, params.position, index);
  });

  connection.onRenameRequest((params) => {
    const result = renameSymbol(
      params.textDocument.uri,
      params.position,
      params.newName,
      index
    );
    return result;
  });

  connection.onDocumentFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return formatDocument(doc.getText(), params.options);
  });

  connection.onDocumentOnTypeFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return formatOnType(doc.getText(), params.position, params.ch);
  });

  // Custom (non-standard-LSP) request: returns every indexed node across
  // the whole workspace as a flat list for the client's "insert node
  // reference" fuzzy-search command (`indent.insertNodeRef` in
  // vscode-indent-lang). Not a standard LSP method, so it's a plain
  // `connection.onRequest` rather than `onExecuteCommand` -- the client
  // calls it via `client.sendRequest("indent/listNodes")`.
  connection.onRequest("indent/listNodes", () => {
    return getSearchableNodes(index);
  });

  documents.listen(connection);
  return { connection, index, documents };
}

export function startServer() {
  const { connection } = createIndentLanguageServer();
  connection.listen();
}
