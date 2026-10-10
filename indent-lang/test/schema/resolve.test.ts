import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile, parseFileWithSources } from "../../src/resolver.js";
import { IndentParseError } from "../../src/types.js";
import {
  isSchemaDefinitionFile,
  resolveSchemaFor,
} from "../../src/schema/resolve.js";

function withTmpDir(fn: (dir: string) => void): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "indent-schema-resolve-"));
  try {
    fn(tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("isSchemaDefinitionFile", () => {
  it("recognizes the reserved .schema.inml suffix", () => {
    expect(isSchemaDefinitionFile("./schemas/c4.schema.inml")).toBe(true);
    expect(isSchemaDefinitionFile("./doc.architecture.inml")).toBe(false);
  });
});

describe("resolveSchemaFor", () => {
  it("returns the in-document !schema directive path when present", () => {
    const result = { roots: [], schemaRef: "/abs/from-directive.schema.inml" };
    expect(resolveSchemaFor(result)).toBe("/abs/from-directive.schema.inml");
  });

  it("returns undefined when no directive is present", () => {
    const result = { roots: [] };
    expect(resolveSchemaFor(result)).toBeUndefined();
  });
});

describe("!schema directive parsing (via resolver)", () => {
  it("resolves !schema to an absolute path and strips it from the parsed tree", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "schema.inml"), "element \"org\"\n", "utf8");
      const rootPath = join(dir, "root.inml");
      writeFileSync(rootPath, '!schema "./schema.inml"\norg name="Acme"\n', "utf8");

      const result = parseFile(rootPath);
      expect(result.schemaRef).toBe(join(dir, "schema.inml"));
      expect(result.roots).toHaveLength(1);
      expect(result.roots[0].kind).toBe("org");
    });
  });

  it("also works through parseFileWithSources", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "schema.inml"), "element \"org\"\n", "utf8");
      const rootPath = join(dir, "root.inml");
      writeFileSync(rootPath, '!schema "./schema.inml"\norg name="Acme"\n', "utf8");

      const { result } = parseFileWithSources(rootPath);
      expect(result.schemaRef).toBe(join(dir, "schema.inml"));
    });
  });

  it("rejects !schema inside an included file (does not propagate)", () => {
    withTmpDir((dir) => {
      const includedPath = join(dir, "included.inml");
      writeFileSync(includedPath, '!schema "./schema.inml"\norg name="Acme"\n', "utf8");
      const rootPath = join(dir, "root.inml");
      writeFileSync(rootPath, '!include "./included.inml"\n', "utf8");

      expect(() => parseFile(rootPath)).toThrow(IndentParseError);
      expect(() => parseFile(rootPath)).toThrow(/does not propagate/);
    });
  });

  it("rejects !schema that isn't the first statement in the file", () => {
    withTmpDir((dir) => {
      const rootPath = join(dir, "root.inml");
      writeFileSync(rootPath, 'org name="Acme"\n!schema "./schema.inml"\n', "utf8");

      expect(() => parseFile(rootPath)).toThrow(/must be the first statement/);
    });
  });

  it("rejects !schema not at depth 0", () => {
    withTmpDir((dir) => {
      const rootPath = join(dir, "root.inml");
      writeFileSync(rootPath, 'org name="Acme"\n    !schema "./schema.inml"\n', "utf8");

      // Not first statement AND not depth 0 -- first-statement check fires first.
      expect(() => parseFile(rootPath)).toThrow(IndentParseError);
    });
  });

  it("rejects more than one !schema directive in a file", () => {
    withTmpDir((dir) => {
      const rootPath = join(dir, "root.inml");
      writeFileSync(
        rootPath,
        '!schema "./a.schema.inml"\n!schema "./b.schema.inml"\n',
        "utf8",
      );

      expect(() => parseFile(rootPath)).toThrow(/may only appear once per file/);
    });
  });
});
