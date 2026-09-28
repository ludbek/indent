import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFile } from "../src/resolver.js";
import { IndentParseError } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures", "includes");

describe("parseFile", () => {
  it("splices an included file's roots at the include line's own depth", () => {
    const result = parseFile(join(fixturesDir, "root.inml"));
    expect(result.roots).toHaveLength(1);
    const org = result.roots[0];
    expect(org.kind).toBe("org");
    expect(org.children).toHaveLength(3);
    expect(org.children[0]).toEqual({
      kind: "team",
      attrs: { name: "AcmePhoenix" },
      children: [],
    });
    expect(org.children[1]).toEqual({
      kind: "team",
      attrs: { name: "AcmeDataTeam" },
      children: [],
    });
    expect(org.children[2].kind).toBe("service");
    expect(org.children[2].attrs.name).toBe("user-service");
  });

  it("resolves nested includes and offsets depth through multiple levels", () => {
    const result = parseFile(join(fixturesDir, "root-nested.inml"));
    expect(result.roots).toHaveLength(1);
    const org = result.roots[0];
    expect(org.children).toHaveLength(1);
    const service = org.children[0];
    expect(service.kind).toBe("service");
    expect(service.children).toEqual([
      { kind: "team", attrs: { name: "AcmePhoenix" }, children: [] },
      { kind: "team", attrs: { name: "AcmeDataTeam" }, children: [] },
    ]);
  });

  it("rejects a bare relative-path line with no '!include' prefix (treated as an ordinary, invalid kind)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "indent-abs-"));
    try {
      const absTarget = join(fixturesDir, "abs-target.inml");
      const rootPath = join(tmpDir, "abs-root.inml");
      writeFileSync(rootPath, `org name="Acme"\n    ${absTarget}\n`, "utf8");

      expect(() => parseFile(rootPath)).toThrow(IndentParseError);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws IndentParseError on circular includes", () => {
    expect(() => parseFile(join(fixturesDir, "cycle-a.inml"))).toThrow(IndentParseError);
    expect(() => parseFile(join(fixturesDir, "cycle-a.inml"))).toThrow(/circular include/);
  });

  it("throws IndentParseError when a '!include' line has attributes", () => {
    expect(() => parseFile(join(fixturesDir, "include-with-attrs.inml"))).toThrow(
      /does not accept attributes/,
    );
  });

  it("throws IndentParseError when '!include' is missing its quoted string path value", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "indent-include-val-"));
    try {
      const rootPath = join(tmpDir, "root.inml");
      writeFileSync(rootPath, 'org "Acme"\n    !include\n', "utf8");
      expect(() => parseFile(rootPath)).toThrow(/requires a quoted string path/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws IndentParseError when '!include' is given a non-string (e.g. ref) value", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "indent-include-nonstring-"));
    try {
      const rootPath = join(tmpDir, "root.inml");
      writeFileSync(rootPath, 'org "Acme"\n    !include /abs/path\n', "utf8");
      expect(() => parseFile(rootPath)).toThrow(/requires a quoted string path/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws IndentParseError when the included file does not exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "indent-missing-"));
    try {
      const rootPath = join(tmpDir, "root.inml");
      writeFileSync(rootPath, 'org name="Acme"\n    !include "./does-not-exist.inml"\n', "utf8");
      expect(() => parseFile(rootPath)).toThrow(/failed to read included file/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
