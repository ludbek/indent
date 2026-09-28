// Unit test verifying the "Insert Node Reference" feature's package.json
// contributions are wired up correctly: the command itself, a keybinding,
// and an editor right-click context-menu entry, all pointing at the same
// command ID (`indent.insertNodeRef`). Run with plain `node` (no VS Code API
// dependency -- just checks the static manifest).
const assert = require("node:assert");
const pkg = require("../package.json");

const COMMAND_ID = "indent.insertNodeRef";

// 1. Command Palette entry (contributes.commands).
const commands = pkg.contributes && pkg.contributes.commands;
assert.ok(Array.isArray(commands), "contributes.commands should be an array");
const command = commands.find((c) => c.command === COMMAND_ID);
assert.ok(command, `contributes.commands should include a "${COMMAND_ID}" entry`);
assert.ok(command.title && command.title.length > 0, "command should have a non-empty title");

// 2. Keybinding, scoped to indent documents only.
const keybindings = pkg.contributes && pkg.contributes.keybindings;
assert.ok(Array.isArray(keybindings), "contributes.keybindings should be an array");
const keybinding = keybindings.find((k) => k.command === COMMAND_ID);
assert.ok(keybinding, `contributes.keybindings should include a "${COMMAND_ID}" entry`);
assert.ok(keybinding.key, "keybinding should define a 'key'");
assert.ok(keybinding.mac, "keybinding should define a 'mac' variant");
assert.strictEqual(
  keybinding.when,
  "editorLangId == indent",
  "keybinding should only be active when editing a indent document"
);

// 3. Editor right-click context-menu entry, also scoped to indent documents.
const editorContextMenu =
  pkg.contributes && pkg.contributes.menus && pkg.contributes.menus["editor/context"];
assert.ok(Array.isArray(editorContextMenu), "contributes.menus['editor/context'] should be an array");
const menuEntry = editorContextMenu.find((m) => m.command === COMMAND_ID);
assert.ok(menuEntry, `contributes.menus['editor/context'] should include a "${COMMAND_ID}" entry`);
assert.strictEqual(
  menuEntry.when,
  "editorLangId == indent",
  "context-menu entry should only be active when editing a indent document"
);

// 4. The command should also be declared as an activation event so it can
// be invoked (e.g. from the Command Palette) before any .inml file is open.
assert.ok(
  Array.isArray(pkg.activationEvents) &&
    pkg.activationEvents.includes(`onCommand:${COMMAND_ID}`),
  `activationEvents should include "onCommand:${COMMAND_ID}"`
);

// 5. extension.js should actually register the command (sanity check that
// the manifest entries aren't dangling with no implementation).
const fs = require("node:fs");
const path = require("node:path");
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
assert.ok(
  extensionSource.includes(`registerCommand("${COMMAND_ID}"`),
  `extension.js should call vscode.commands.registerCommand("${COMMAND_ID}", ...)`
);
assert.ok(
  extensionSource.includes('sendRequest("indent/listNodes")'),
  "extension.js should call client.sendRequest(\"indent/listNodes\") to fetch searchable nodes"
);

console.log("All insert-node-ref contribution tests passed.");
