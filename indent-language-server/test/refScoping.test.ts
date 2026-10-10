import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkspaceIndex, fsPathToUri } from "../src/indexer.js";
import { computeDiagnostics } from "../src/diagnostics.js";

describe("Ref resolution scoping: document + its forward !include chain", () => {
  let index: WorkspaceIndex;
  let dir: string;

  const write = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    const uri = fsPathToUri(p);
    index.setDocument(uri, content);
    return uri;
  };

  beforeEach(async () => {
    index = await WorkspaceIndex.create();
    dir = mkdtempSync(join(tmpdir(), "indent-ref-scoping-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a ref against an element pulled in via the document's own !include chain", () => {
    write(
      "teams.inml",
      `team "Platform"\n`,
    );
    const docUri = write(
      "service.inml",
      `!include "./teams.inml"\nservice "a service" team=//team\n`,
    );

    const ref = index.refReferences.find((r) => r.uri === docUri && r.attrName === "team");
    expect(ref).toBeDefined();
    expect(ref!.resolvedTargetPaths.length).toBeGreaterThan(0);

    const diags = computeDiagnostics(docUri, index);
    expect(diags.some((d) => d.message.includes("Unresolved reference"))).toBe(false);
  });

  it("does NOT resolve a ref against an element in an unrelated, non-included sibling file", () => {
    // Regression test: an element elsewhere in the workspace that is never
    // opened via !include must not silently satisfy a ref in a sibling
    // document -- refs are scoped to {document} union {its own transitive
    // !include chain}, not the whole workspace-wide node index.
    write("unrelated.inml", `team "Platform"\n`);
    const docUri = write("service.inml", `service "a service" team=//team\n`);

    const ref = index.refReferences.find((r) => r.uri === docUri && r.attrName === "team");
    expect(ref).toBeDefined();
    expect(ref!.resolvedTargetPaths).toEqual([]);

    const diags = computeDiagnostics(docUri, index);
    expect(
      diags.some(
        (d) => d.source === "indent" && d.message.includes("Unresolved reference '//team'"),
      ),
    ).toBe(true);
  });

  it("does not leak visibility backwards from an included file to the includer or its siblings", () => {
    // A includes B. B must not see A's (or A's other includes') elements --
    // forward-only visibility.
    write("other.inml", `team "Platform"\n`);
    write("b.inml", `service "b service" team=//team\n`);
    write("a.inml", `!include "./b.inml"\norg "An org"\n`);

    const bUri = fsPathToUri(join(dir, "b.inml"));
    const ref = index.refReferences.find((r) => r.uri === bUri && r.attrName === "team");
    expect(ref).toBeDefined();
    expect(ref!.resolvedTargetPaths).toEqual([]);
  });

  it("is cycle-safe for mutually-including files", () => {
    const aUri = write("a-cycle.inml", `!include "./b-cycle.inml"\nservice "a" team=//team\n`);
    write("b-cycle.inml", `!include "./a-cycle.inml"\nteam "Platform"\n`);

    const ref = index.refReferences.find((r) => r.uri === aUri && r.attrName === "team");
    expect(ref).toBeDefined();
    expect(ref!.resolvedTargetPaths.length).toBeGreaterThan(0);
  });
});
