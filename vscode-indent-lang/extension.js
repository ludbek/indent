const path = require("path");
const vscode = require("vscode");
const {
  LanguageClient,
  TransportKind,
} = require("vscode-languageclient/node");

let client;

function activate(context) {
  // Bundled alongside dist/extension.js by scripts/build.js — see that file
  // for why this isn't `require.resolve("indent-language-server/...")`.
  const serverModule = path.join(__dirname, "server.cjs");

  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "indent" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.inml"),
    },
  };

  client = new LanguageClient(
    "indentLanguageServer",
    "Indent Language Server",
    serverOptions,
    clientOptions
  );

  client.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("indent.insertNodeRef", () => insertNodeRef())
  );
}

// "Insert Node Reference": fuzzy-search every node indexed across the whole
// workspace (via the language server's custom `indent/listNodes` request) and
// insert the selected node's ref/xpath string at the cursor in the active
// editor. VS Code's built-in QuickPick provides the fuzzy matching over
// label/description/detail for free -- no client-side search logic needed.
async function insertNodeRef() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Indent: no active editor to insert a reference into.");
    return;
  }

  if (!client) {
    vscode.window.showWarningMessage("Indent: language server is not running.");
    return;
  }

  let nodes;
  try {
    nodes = await client.sendRequest("indent/listNodes");
  } catch (err) {
    vscode.window.showErrorMessage(`Indent: failed to list nodes (${err.message || err}).`);
    return;
  }

  if (!nodes || nodes.length === 0) {
    vscode.window.showInformationMessage("Indent: no nodes found in the workspace.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    nodes.map((n) => ({
      label: n.label,
      description: n.description,
      detail: n.detail,
      ref: n.ref,
    })),
    {
      placeHolder: "Search for a node to insert its reference...",
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );

  if (!picked) {
    return;
  }

  await editor.edit((editBuilder) => {
    for (const selection of editor.selections) {
      editBuilder.insert(selection.active, picked.ref);
    }
  });
}

function deactivate() {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

module.exports = { activate, deactivate };
