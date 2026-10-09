import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { findAllInmlFiles, findProjectRoot } from "../src/project.js";

describe("findAllInmlFiles", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .inml files recursively, skipping noise directories", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-findall-"));
    writeFileSync(join(tmpDir, "a.inml"), "");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "b.inml"), "");
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "node_modules", "c.inml"), "");
    writeFileSync(join(tmpDir, "notes.txt"), "");

    const found = findAllInmlFiles(tmpDir).sort();
    expect(found).toEqual(
      [join(tmpDir, "a.inml"), join(tmpDir, "sub", "b.inml")].sort(),
    );
  });
});

describe("findProjectRoot", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("walks upward and stops at the first marker found", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    const repoRoot = join(tmpDir, "repo");
    const pkgDir = join(repoRoot, "packages", "foo");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), ""); // marker file is fine for existsSync
    const filePath = join(pkgDir, "doc.inml");
    writeFileSync(filePath, "");

    expect(findProjectRoot(filePath)).toBe(resolve(repoRoot));
  });

  it("prefers an inner marker over an outer one", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    const repoRoot = join(tmpDir, "repo");
    const pkgDir = join(repoRoot, "packages", "foo");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "");
    writeFileSync(join(pkgDir, "package.json"), "{}");
    const filePath = join(pkgDir, "doc.inml");
    writeFileSync(filePath, "");

    expect(findProjectRoot(filePath)).toBe(resolve(pkgDir));
  });

  it("falls back to the workspace boundary when no marker is found", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    const workspaceRoot = join(tmpDir, "workspace");
    const subDir = join(workspaceRoot, "docs", "nested");
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, "doc.inml");
    writeFileSync(filePath, "");

    expect(findProjectRoot(filePath, [workspaceRoot])).toBe(resolve(workspaceRoot));
  });

  it("falls back to the opened file's own directory when there is no boundary and no marker", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    const subDir = join(tmpDir, "lonely");
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, "doc.inml");
    writeFileSync(filePath, "");

    expect(findProjectRoot(filePath, [])).toBe(resolve(subDir));
  });

  it("never walks above a workspace boundary even if a marker exists further up", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "indent-project-"));
    const outer = join(tmpDir, "outer");
    const workspaceRoot = join(outer, "workspace");
    const subDir = join(workspaceRoot, "nested");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(outer, ".git"), "");
    const filePath = join(subDir, "doc.inml");
    writeFileSync(filePath, "");

    expect(findProjectRoot(filePath, [workspaceRoot])).toBe(resolve(workspaceRoot));
  });
});
