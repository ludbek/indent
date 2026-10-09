import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createIndentLanguageServer } from "../src/server.js";
import { fsPathToUri } from "../src/indexer.js";

/**
 * Minimal stub satisfying only the `_Connection` members `createIndentLanguageServer`
 * touches, capturing each registered handler so tests can invoke them directly
 * without spinning up a real LSP transport.
 */
function createStubConnection() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const sentDiagnostics: { uri: string; diagnostics: unknown[] }[] = [];

  const stub: any = {
    onInitialize: (fn: any) => (handlers.onInitialize = fn),
    onDidChangeWatchedFiles: (fn: any) => (handlers.onDidChangeWatchedFiles = fn),
    onCompletion: (fn: any) => (handlers.onCompletion = fn),
    onHover: (fn: any) => (handlers.onHover = fn),
    onDefinition: (fn: any) => (handlers.onDefinition = fn),
    onDocumentSymbol: (fn: any) => (handlers.onDocumentSymbol = fn),
    onReferences: (fn: any) => (handlers.onReferences = fn),
    onPrepareRename: (fn: any) => (handlers.onPrepareRename = fn),
    onRenameRequest: (fn: any) => (handlers.onRenameRequest = fn),
    onDocumentFormatting: (fn: any) => (handlers.onDocumentFormatting = fn),
    onDocumentOnTypeFormatting: (fn: any) => (handlers.onDocumentOnTypeFormatting = fn),
    onRequest: (_method: string, fn: any) => (handlers.onRequest = fn),
    onDidOpenTextDocument: (fn: any) => (handlers.onDidOpenTextDocument = fn),
    onDidChangeTextDocument: (fn: any) => (handlers.onDidChangeTextDocument = fn),
    onDidCloseTextDocument: (fn: any) => (handlers.onDidCloseTextDocument = fn),
    onWillSaveTextDocument: (fn: any) => (handlers.onWillSaveTextDocument = fn),
    onWillSaveTextDocumentWaitUntil: (fn: any) => (handlers.onWillSaveTextDocumentWaitUntil = fn),
    onDidSaveTextDocument: (fn: any) => (handlers.onDidSaveTextDocument = fn),
    sendDiagnostics: (params: { uri: string; diagnostics: unknown[] }) => {
      sentDiagnostics.push(params);
    },
    listen: vi.fn(),
    onNotification: vi.fn(),
    onProgress: vi.fn(),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  return { stub, handlers, sentDiagnostics };
}

describe("onDidChangeWatchedFiles", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-indexes newly created .inml files on any watched file change, so refs into them resolve", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-server-"));
    writeFileSync(join(tmpDir, "root.inml"), `org name="Acme"\n`);

    const { stub, handlers, sentDiagnostics } = createStubConnection();
    const { index } = await createIndentLanguageServer(stub);

    // Simulate server init against the temp workspace root.
    handlers.onInitialize({ workspaceFolders: [{ uri: fsPathToUri(tmpDir), name: "root" }] });

    // A new file, not yet on disk at init time, gets opened in the editor
    // with a ref pointing at a node defined in another file that's never
    // opened in the editor.
    writeFileSync(join(tmpDir, "extra.inml"), `team name="Extra"\n    alias /org\n`);

    const extraUri = fsPathToUri(join(tmpDir, "extra.inml"));
    index.setDocument(extraUri, `team name="Extra"\n    alias /org\n`);

    // Before any refresh, root.inml (never opened in the editor) was already
    // preloaded at init, so the ref should resolve immediately -- but to
    // exercise the watcher path, create yet another file on disk after init
    // and confirm a watched-file event picks it up.
    writeFileSync(join(tmpDir, "another.inml"), `service name="Svc"\n`);

    sentDiagnostics.length = 0;

    // The client's file watcher (configured in vscode-indent-lang's extension.js
    // against **/*.inml) notifies the server of the on-disk change.
    handlers.onDidChangeWatchedFiles({ changes: [] });

    const anotherUri = fsPathToUri(join(tmpDir, "another.inml"));
    expect(index.documents.has(anotherUri)).toBe(true);

    // Diagnostics for every open document must be re-published, not just
    // the file that triggered the watcher event.
    expect(sentDiagnostics.some((d) => d.uri === extraUri)).toBe(true);
  });
});
