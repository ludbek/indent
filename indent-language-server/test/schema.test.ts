import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkspaceIndex, fsPathToUri } from "../src/indexer.js";
import { computeDiagnostics } from "../src/diagnostics.js";
import { computeCompletions as computeCompletionsRaw } from "../src/completions.js";
import type { CompletionItem, CompletionList } from "vscode-languageserver";

const computeCompletions = (
  ...args: Parameters<typeof computeCompletionsRaw>
): CompletionItem[] => {
  const result = computeCompletionsRaw(...args);
  return Array.isArray(result) ? result : (result as CompletionList).items;
};

const SCHEMA_SOURCE = `
kind "org"
    attr "name" type="string" required=true
    kind //kind[.="service"] minCount=1

kind "service"
    attr "name" type="string" required=true
    attr "enabled" type="boolean"
`;

describe("Schema support", () => {
  let index: WorkspaceIndex;
  let dir: string;
  let schemaUri: string;

  const uriFor = (name: string) => fsPathToUri(join(dir, name));
  const write = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    const uri = fsPathToUri(p);
    index.setDocument(uri, content);
    return uri;
  };

  beforeEach(async () => {
    index = await WorkspaceIndex.create();
    dir = mkdtempSync(join(tmpdir(), "indent-schema-test-"));
    schemaUri = write("org.schema.inml", SCHEMA_SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies .schema.inml files by suffix and excludes them from the node tree", () => {
    expect(index.schemaClassifiedUris.has(schemaUri)).toBe(true);
    expect(index.schemaFiles.get(schemaUri)?.schema).toBeDefined();
    expect(index.schemaFiles.get(schemaUri)?.parseError).toBeUndefined();
    expect(index.rootNodes.some((n) => n.uri === schemaUri)).toBe(false);
  });

  it("surfaces a grammar diagnostic when a .schema.inml file has invalid schema semantics", () => {
    const badUri = write("bad.schema.inml", `not_a_valid_schema_kind "oops"\n`);
    expect(index.schemaFiles.get(badUri)?.parseError).toBeDefined();
    const diags = computeDiagnostics(badUri, index);
    expect(diags.some((d) => d.source === "indent-schema")).toBe(true);
  });

  it("binds a document to its linked schema and validates clean content with no diagnostics", () => {
    const docUri = write(
      "good.inml",
      `!schema "org.schema.inml"\norg name="Acme"\n    service name="auth"\n`
    );
    const binding = index.schemaBindingByUri.get(docUri);
    expect(binding).toBeDefined();
    expect(binding?.isValidSchemaFile).toBe(true);
    const diags = computeDiagnostics(docUri, index);
    expect(diags).toEqual([]);
  });

  it("flags unknown kind, missing required attr, and mistyped attr via schema validation", () => {
    const docUri = write(
      "invalid-content.inml",
      [
        `!schema "org.schema.inml"`,
        `org`,
        `    service name="auth" enabled="yes"`,
        `    bogus name="x"`,
        ``,
      ].join("\n")
    );
    const diags = computeDiagnostics(docUri, index);
    const messages = diags.map((d) => d.message).join(" | ");
    expect(messages).toMatch(/unknown.*kind|not declared/i);
    expect(messages).toMatch(/required/i);
    expect(messages).toMatch(/type|boolean/i);
  });

  it("flags cardinality violations (missing required child)", () => {
    const docUri = write("no-service.inml", `!schema "org.schema.inml"\norg name="Acme"\n`);
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /service/i.test(d.message))).toBe(true);
  });

  it("flags !schema placement misuse: not first statement", () => {
    const docUri = write(
      "misuse-order.inml",
      `org name="Acme"\n!schema "org.schema.inml"\n`
    );
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /first statement/i.test(d.message))).toBe(true);
  });

  it("flags !schema placement misuse: appears more than once", () => {
    const docUri = write(
      "misuse-dup.inml",
      `!schema "org.schema.inml"\n!schema "org.schema.inml"\norg name="Acme"\n`
    );
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /only appear once/i.test(d.message))).toBe(true);
  });

  it("flags !schema placement misuse: has attributes", () => {
    const docUri = write("misuse-attrs.inml", `!schema "org.schema.inml" foo="bar"\n`);
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /does not accept attributes/i.test(d.message))).toBe(true);
  });

  it("flags a !schema link whose target does not exist", () => {
    const docUri = write(
      "missing-link.inml",
      `!schema "does-not-exist.schema.inml"\norg name="Acme"\n`
    );
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /does not exist/i.test(d.message))).toBe(true);
  });

  it("flags a !schema link to a file that is not a valid schema file", () => {
    write("plain.inml", `org name="Acme"\n`);
    const docUri = write("wrong-link.inml", `!schema "plain.inml"\norg name="Acme"\n`);
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /not a valid schema file/i.test(d.message))).toBe(true);
  });

  it("hard-errors when a schema file is !include-d as ordinary content", () => {
    const docUri = write("double-usage.inml", `!include "org.schema.inml"\n`);
    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => /schema definition file/i.test(d.message))).toBe(true);
  });

  it("allows an orphaned schema file (unlinked) silently, with no linkage error", () => {
    const diags = computeDiagnostics(schemaUri, index);
    expect(diags.some((d) => /not (referenced|linked)/i.test(d.message))).toBe(false);
  });

  it('completes !schema "path" with workspace .inml files', () => {
    const source = `!schema "`;
    const docUri = write("completing.inml", source);
    const items = computeCompletions(docUri, { line: 0, character: source.length }, index);
    expect(items.some((i) => i.label === "org.schema.inml")).toBe(true);
  });

  it("suggests schema-declared kind names at document root and nested depth", () => {
    const docUri = write(
      "kind-completion.inml",
      `!schema "org.schema.inml"\norg name="Acme"\n    \n`
    );
    const rootItems = computeCompletions(docUri, { line: 1, character: 0 }, index);
    expect(rootItems.some((i) => i.label === "org")).toBe(true);

    const nestedItems = computeCompletions(docUri, { line: 2, character: 4 }, index);
    expect(nestedItems.some((i) => i.label === "service")).toBe(true);
  });

  it("suggests schema-declared attr names for the current kind", () => {
    const docUri = write("attr-completion.inml", `!schema "org.schema.inml"\norg \n`);
    const items = computeCompletions(docUri, { line: 1, character: 4 }, index);
    expect(items.some((i) => i.label === "name")).toBe(true);
  });

  it("suggests boolean literal completions for boolean-typed schema attrs", () => {
    const source = `!schema "org.schema.inml"\norg name="Acme"\n    service name="auth" enabled=`;
    const docUri = write("bool-completion.inml", source);
    const lines = source.split("\n");
    const lastLine = lines.length - 1;
    const items = computeCompletions(
      docUri,
      { line: lastLine, character: lines[lastLine].length },
      index
    );
    expect(items.some((i) => i.label === "true")).toBe(true);
    expect(items.some((i) => i.label === "false")).toBe(true);
  });
});
