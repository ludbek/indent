import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, parseProjectFile } from "../src/project.js";
import { IndentParseError } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures", "project");

describe("parseProjectFile", () => {
  it("reads name and resolves entry relative to the manifest's directory", () => {
    const manifest = parseProjectFile(join(fixturesDir, "project.inml"));
    expect(manifest.name).toBe("Sample Project");
    expect(manifest.entryPath).toBe(join(fixturesDir, "root.inml"));
  });

  it("accepts a directory path and appends 'project.inml'", () => {
    const manifest = parseProjectFile(fixturesDir);
    expect(manifest.name).toBe("Sample Project");
    expect(manifest.entryPath).toBe(join(fixturesDir, "root.inml"));
  });

  it("throws when 'entry' node is missing", () => {
    expect(() =>
      parseProjectFile(join(fixturesDir, "missing-entry", "project.inml")),
    ).toThrow(IndentParseError);
  });

  it("throws when 'entry' value is not a quoted string", () => {
    expect(() =>
      parseProjectFile(join(fixturesDir, "bad-entry-type", "project.inml")),
    ).toThrow(IndentParseError);
  });
});

describe("parseProject", () => {
  it("parses the entry file's include graph and lists included files, excluding project.inml itself", () => {
    const { manifest, result, includedFiles } = parseProject(
      join(fixturesDir, "project.inml"),
    );

    expect(manifest.name).toBe("Sample Project");
    expect(result.roots.map((n) => n.kind)).toEqual(["team", "org"]);

    expect(includedFiles).toContain(join(fixturesDir, "root.inml"));
    expect(includedFiles).toContain(join(fixturesDir, "child.inml"));
    expect(includedFiles).not.toContain(join(fixturesDir, "project.inml"));
    expect(includedFiles).not.toContain(join(fixturesDir, "orphan.inml"));
  });

  it("also accepts a directory path", () => {
    const { manifest } = parseProject(fixturesDir);
    expect(manifest.entryPath).toBe(join(fixturesDir, "root.inml"));
  });
});
