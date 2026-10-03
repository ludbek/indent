import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { discoverProjects, findProjectFiles, findNearestProjectFile, findProjectForFile } from "../src/project.js";
import { WorkspaceIndex, fsPathToUri } from "../src/indexer.js";
import { computeDiagnostics } from "../src/diagnostics.js";

describe("findProjectFiles / discoverProjects", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds project.inml files and resolves their reachable file sets", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    mkdirSync(join(tmpDir, "dac"));

    writeFileSync(
      join(tmpDir, "dac", "project.inml"),
      `name "Test Project"\nentry "./root.inml"\n`
    );
    writeFileSync(
      join(tmpDir, "dac", "root.inml"),
      `!include "./child.inml"\norg name="Acme"\n`
    );
    writeFileSync(join(tmpDir, "dac", "child.inml"), `team name="Phoenix"\n`);
    writeFileSync(join(tmpDir, "dac", "orphan.inml"), `team name="Orphan"\n`);

    const projectFiles = findProjectFiles(tmpDir);
    expect(projectFiles).toEqual([join(tmpDir, "dac", "project.inml")]);

    const { projects, reachableFiles } = discoverProjects([tmpDir]);
    expect(projects).toHaveLength(1);
    expect(reachableFiles.has(join(tmpDir, "dac", "root.inml"))).toBe(true);
    expect(reachableFiles.has(join(tmpDir, "dac", "child.inml"))).toBe(true);
    expect(reachableFiles.has(join(tmpDir, "dac", "orphan.inml"))).toBe(false);
    expect(reachableFiles.has(join(tmpDir, "dac", "project.inml"))).toBe(false);
  });

  it("skips a project.inml that fails to parse instead of throwing", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `name "Broken"\n`); // missing entry

    expect(() => discoverProjects([tmpDir])).not.toThrow();
    const { projects, reachableFiles } = discoverProjects([tmpDir]);
    expect(projects).toHaveLength(0);
    expect(reachableFiles.size).toBe(0);
  });
});

describe("findNearestProjectFile / findProjectForFile", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("walks upward to find the nearest ancestor project.inml", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    mkdirSync(join(tmpDir, "nested", "deeper"), { recursive: true });
    writeFileSync(join(tmpDir, "nested", "deeper", "leaf.inml"), `team name="Leaf"\n`);

    const found = findNearestProjectFile(join(tmpDir, "nested", "deeper", "leaf.inml"));
    expect(found).toBe(join(tmpDir, "project.inml"));
  });

  it("returns undefined when no project.inml is found before the workspace root boundary", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    mkdirSync(join(tmpDir, "root-scope", "nested"), { recursive: true });
    writeFileSync(join(tmpDir, "root-scope", "nested", "leaf.inml"), `team name="Leaf"\n`);

    // No project.inml anywhere, and workspaceRoots restricts the walk to
    // stop at root-scope, not climb further up into tmpDir/system tmp.
    const found = findNearestProjectFile(
      join(tmpDir, "root-scope", "nested", "leaf.inml"),
      [join(tmpDir, "root-scope")],
    );
    expect(found).toBeUndefined();
  });

  it("findProjectForFile returns undefined for a broken/unparseable nearest manifest", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `name "Broken"\n`); // missing entry
    writeFileSync(join(tmpDir, "leaf.inml"), `team name="Leaf"\n`);

    const { projects } = discoverProjects([tmpDir]);
    expect(projects).toHaveLength(0);

    const project = findProjectForFile(join(tmpDir, "leaf.inml"), projects, [tmpDir]);
    expect(project).toBeUndefined();
  });
});

describe("orphan-file diagnostic", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("warns on a .inml file not reachable from any discovered project.inml entry", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    writeFileSync(join(tmpDir, "root.inml"), `org name="Acme"\n`);
    writeFileSync(join(tmpDir, "orphan.inml"), `team name="Orphan"\n`);

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);

    const rootUri = fsPathToUri(join(tmpDir, "root.inml"));
    const orphanUri = fsPathToUri(join(tmpDir, "orphan.inml"));
    const projectUri = fsPathToUri(join(tmpDir, "project.inml"));

    index.setDocument(rootUri, `org name="Acme"\n`);
    index.setDocument(orphanUri, `team name="Orphan"\n`);
    index.setDocument(projectUri, `entry "./root.inml"\n`);

    const rootDiags = computeDiagnostics(rootUri, index);
    expect(rootDiags.some((d) => d.message.includes("not reachable"))).toBe(false);

    const orphanDiags = computeDiagnostics(orphanUri, index);
    expect(orphanDiags.some((d) => d.message.includes("not reachable"))).toBe(true);

    const projectDiags = computeDiagnostics(projectUri, index);
    expect(projectDiags.some((d) => d.message.includes("not reachable"))).toBe(false);
  });

  it("does not warn when no project.inml exists anywhere in the workspace", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "loose.inml"), `team name="Loose"\n`);

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);

    const uri = fsPathToUri(join(tmpDir, "loose.inml"));
    index.setDocument(uri, `team name="Loose"\n`);

    const diags = computeDiagnostics(uri, index);
    expect(diags.some((d) => d.message.includes("not reachable"))).toBe(false);
  });

  it("uses nearest-ancestor project.inml, not the global reachableFiles union, in a monorepo with sibling projects", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));

    // Project A: reachable set = {a-root.inml}
    mkdirSync(join(tmpDir, "project-a"));
    writeFileSync(join(tmpDir, "project-a", "project.inml"), `entry "./a-root.inml"\n`);
    writeFileSync(join(tmpDir, "project-a", "a-root.inml"), `org name="A"\n`);

    // Project B: reachable set = {b-root.inml}. b-orphan.inml belongs to
    // project B's directory but is NOT included by B's entry, and must
    // never be considered "reachable" just because project A's set exists
    // elsewhere in the workspace.
    mkdirSync(join(tmpDir, "project-b"));
    writeFileSync(join(tmpDir, "project-b", "project.inml"), `entry "./b-root.inml"\n`);
    writeFileSync(join(tmpDir, "project-b", "b-root.inml"), `org name="B"\n`);
    writeFileSync(join(tmpDir, "project-b", "b-orphan.inml"), `team name="Orphan"\n`);

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);

    // Sanity: the global union (legacy reachableFiles) contains both
    // projects' entries -- this is exactly why a global-set check would be
    // wrong for per-file membership; nearest-ancestor is required instead.
    expect(index.reachableFiles.has(join(tmpDir, "project-a", "a-root.inml"))).toBe(true);
    expect(index.reachableFiles.has(join(tmpDir, "project-b", "b-root.inml"))).toBe(true);

    const bOrphanUri = fsPathToUri(join(tmpDir, "project-b", "b-orphan.inml"));
    index.setDocument(bOrphanUri, `team name="Orphan"\n`);

    const orphanDiags = computeDiagnostics(bOrphanUri, index);
    expect(orphanDiags.some((d) => d.message.includes("not reachable"))).toBe(true);
    expect(
      orphanDiags.some((d) => d.message.includes(join(tmpDir, "project-b", "project.inml"))),
    ).toBe(true);

    const bRootUri = fsPathToUri(join(tmpDir, "project-b", "b-root.inml"));
    index.setDocument(bRootUri, `org name="B"\n`);
    const rootDiags = computeDiagnostics(bRootUri, index);
    expect(rootDiags.some((d) => d.message.includes("not reachable"))).toBe(false);
  });
});

describe("preloadProjectFiles", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a ref in an open file to a node defined in a genuinely-included but never-opened file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    writeFileSync(
      join(tmpDir, "root.inml"),
      `!include "./api.inml"\n!include "./upstream.inml"\n`,
    );
    // Node the ref targets -- lives on disk, never opened in the editor.
    writeFileSync(
      join(tmpDir, "upstream.inml"),
      `service "upstream-token-manager"\n`,
    );
    // api.inml (the file containing the ref) also needs to exist on disk
    // for `!include` resolution during `refreshProjects`/`parseProject` --
    // it's the *editor content* that's out of sync with disk here, not the
    // file's mere existence, matching a real "unsaved edit" scenario.
    writeFileSync(join(tmpDir, "api.inml"), `API "MB Save Tfn"\n`);

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);

    const apiUri = fsPathToUri(join(tmpDir, "api.inml"));
    // Only api.inml (containing the ref) is opened in the editor -- upstream.inml
    // is not; it must still be indexed via preloadProjectFiles for the ref to
    // resolve.
    index.setDocument(
      apiUri,
      `API "MB Save Tfn"\n    >=< //service[.="upstream-token-manager"]\n`,
    );

    // Before preloading: upstream.inml was never opened, so the ref falsely
    // resolves to zero targets -- this is the reported bug.
    const unresolvedBefore = index.refReferences.find((r) => r.uri === apiUri);
    expect(unresolvedBefore?.resolvedTargetPaths).toEqual([]);

    index.preloadProjectFiles();

    const resolvedAfter = index.refReferences.find((r) => r.uri === apiUri);
    expect(resolvedAfter?.resolvedTargetPaths.length).toBe(1);

    const upstreamUri = fsPathToUri(join(tmpDir, "upstream.inml"));
    expect(index.documents.has(upstreamUri)).toBe(true);
    expect(index.preloadedUris.has(upstreamUri)).toBe(true);
  });

  it("does not clobber a genuinely open/edited document's content", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    writeFileSync(join(tmpDir, "root.inml"), `!include "./a.inml"\n`);
    writeFileSync(join(tmpDir, "a.inml"), `team name="OnDisk"\n`);

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);

    const aUri = fsPathToUri(join(tmpDir, "a.inml"));
    // Editor has unsaved edits differing from disk content.
    index.setDocument(aUri, `team name="Edited"\n`);

    index.preloadProjectFiles();

    const doc = index.getDocument(aUri);
    expect(doc?.roots[0]?.attrs.name?.value).toBe("Edited");
    expect(index.preloadedUris.has(aUri)).toBe(false);
  });

  it("evicts a previously preloaded file that falls out of reachableFiles", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    writeFileSync(join(tmpDir, "root.inml"), `!include "./a.inml"\n`);
    writeFileSync(join(tmpDir, "a.inml"), `team name="A"\n`);

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);
    index.preloadProjectFiles();

    const aUri = fsPathToUri(join(tmpDir, "a.inml"));
    expect(index.documents.has(aUri)).toBe(true);
    expect(index.preloadedUris.has(aUri)).toBe(true);

    // Remove the include -- a.inml is no longer reachable.
    writeFileSync(join(tmpDir, "root.inml"), ``);
    index.refreshProjects([tmpDir]);
    index.preloadProjectFiles();

    expect(index.documents.has(aUri)).toBe(false);
    expect(index.preloadedUris.has(aUri)).toBe(false);
  });

  it("does not let two files with the same unqualified node shape clobber each other's canonical paths", async () => {
    // Regression test: two sibling files (`a.inml`, `b.inml`) each define a
    // single top-level `service` with a single `layout-row` child and no
    // disambiguating attribute, so both independently compute the exact
    // same bare-kind canonical path (`/service/layout-row`). Before the
    // fix, the global `nodesByPath` map let the second-processed file's
    // node silently overwrite the first's entry at that path, so `b.inml`'s
    // own same-file `event-handler` self-reference resolved to zero
    // targets -- it is the bug reported against cp-aaspire-feed.inml.
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    writeFileSync(join(tmpDir, "project.inml"), `entry "./root.inml"\n`);
    writeFileSync(
      join(tmpDir, "root.inml"),
      `!include "./a.inml"\n!include "./b.inml"\n`,
    );
    writeFileSync(
      join(tmpDir, "a.inml"),
      [
        `service "svc-a"`,
        `    layout-row`,
        `        event-handler "HandlerA"`,
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(tmpDir, "b.inml"),
      [
        `service "svc-b"`,
        `    layout-row`,
        `        event-handler "HandlerB"`,
        `            >- //event-handler[.="HandlerB"]`,
      ].join("\n") + "\n",
    );

    const index = await WorkspaceIndex.create();
    index.refreshProjects([tmpDir]);
    index.preloadProjectFiles();

    const bUri = fsPathToUri(join(tmpDir, "b.inml"));
    const ref = index.refReferences.find(
      (r) => r.uri === bUri && r.rawRef === '//event-handler[.="HandlerB"]',
    );
    expect(ref?.resolvedTargetPaths.length).toBe(1);

    const diagnostics = computeDiagnostics(bUri, index);
    const unresolved = diagnostics.filter((d) =>
      d.message.startsWith("Unresolved reference"),
    );
    expect(unresolved).toEqual([]);
  });
});
