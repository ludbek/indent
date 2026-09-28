import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createIndentLanguageServer } from "../src/server.js";
import { fsPathToUri } from "../src/indexer.js";
import { computeDiagnostics } from "../src/diagnostics.js";

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

  it("refreshes the project graph and re-publishes diagnostics for open documents on any watched .inml change", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-server-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    writeFileSync(join(tmpDir, "root.inml"), `org name="Acme"\n`);

    const { stub, handlers, sentDiagnostics } = createStubConnection();
    const { index } = createIndentLanguageServer(stub);

    // Simulate server init against the temp workspace root.
    handlers.onInitialize({ workspaceFolders: [{ uri: fsPathToUri(tmpDir), name: "root" }] });

    // A new file, not yet on disk at init time, gets included by root.inml
    // and opened in the editor -- exactly the reported bug scenario.
    writeFileSync(join(tmpDir, "extra.inml"), `team name="Extra"\n`);
    writeFileSync(join(tmpDir, "root.inml"), `!include "./extra.inml"\norg name="Acme"\n`);

    const extraUri = fsPathToUri(join(tmpDir, "extra.inml"));
    index.setDocument(extraUri, `team name="Extra"\n`);

    // Before any refresh, the LS's cached project graph is stale (still
    // pre-dates extra.inml's include), so it wrongly reports "not reachable".
    let diags = computeDiagnostics(extraUri, index);
    expect(diags.some((d: any) => d.message.includes("not reachable"))).toBe(true);

    sentDiagnostics.length = 0;

    // The client's file watcher (configured in vscode-indent-lang's extension.js
    // against **/*.inml) notifies the server of the on-disk root.inml edit.
    handlers.onDidChangeWatchedFiles({ changes: [] });

    diags = computeDiagnostics(extraUri, index);
    expect(diags.some((d: any) => d.message.includes("not reachable"))).toBe(false);

    // Diagnostics for every open document must be re-published, not just
    // the file that triggered the watcher event.
    expect(sentDiagnostics.some((d) => d.uri === extraUri)).toBe(true);
  });
});
