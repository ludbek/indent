import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile, parseFileWithSources } from "../../src/resolver.js";
import { IndentParseError } from "../../src/types.js";
import {
  extractSchemaSegment,
  isSchemaDefinitionFile,
  resolveSchemaFor,
} from "../../src/schema/resolve.js";
import type { ProjectManifest } from "../../src/project.js";

function withTmpDir(fn: (dir: string) => void): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "indent-schema-resolve-"));
  try {
    fn(tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function manifestWith(schemas: Record<string, string>): ProjectManifest {
  return {
    entryPath: "/unused",
    schemas: new Map(Object.entries(schemas)),
  };
}

describe("extractSchemaSegment", () => {
  it("extracts the <name> segment from doc.<name>.inml", () => {
    expect(extractSchemaSegment("/a/b/diagram.architecture.inml")).toBe("architecture");
    expect(extractSchemaSegment("config.settings.inml")).toBe("settings");
  });

  it("returns undefined for filenames without a schema segment", () => {
    expect(extractSchemaSegment("root.inml")).toBeUndefined();
  });

  it("returns undefined for .schema.inml files themselves", () => {
    expect(extractSchemaSegment("architecture.schema.inml")).toBeUndefined();
  });
});

describe("isSchemaDefinitionFile", () => {
  it("recognizes the reserved .schema.inml suffix", () => {
    expect(isSchemaDefinitionFile("./schemas/c4.schema.inml")).toBe(true);
    expect(isSchemaDefinitionFile("./doc.architecture.inml")).toBe(false);
  });
});

describe("resolveSchemaFor", () => {
  it("prefers an in-document !schema directive over the filename/registry", () => {
    const result = { roots: [], schemaRef: "/abs/from-directive.schema.inml" };
    const manifest = manifestWith({ architecture: "/abs/from-registry.schema.inml" });
    expect(
      resolveSchemaFor("/proj/diagram.architecture.inml", result, manifest),
    ).toBe("/abs/from-directive.schema.inml");
  });

  it("falls back to the filename segment + registry lookup", () => {
    const result = { roots: [] };
    const manifest = manifestWith({ architecture: "/abs/c4.schema.inml" });
    expect(resolveSchemaFor("/proj/diagram.architecture.inml", result, manifest)).toBe(
      "/abs/c4.schema.inml",
    );
  });

  it("returns undefined when the registry has no entry for the segment", () => {
    const result = { roots: [] };
    const manifest = manifestWith({ config: "/abs/config.schema.inml" });
    expect(resolveSchemaFor("/proj/diagram.architecture.inml", result, manifest)).toBeUndefined();
  });

  it("returns undefined when the filename has no schema segment", () => {
    const result = { roots: [] };
    const manifest = manifestWith({ architecture: "/abs/c4.schema.inml" });
    expect(resolveSchemaFor("/proj/root.inml", result, manifest)).toBeUndefined();
  });

  it("returns undefined when no manifest is given and no directive is present", () => {
    const result = { roots: [] };
    expect(resolveSchemaFor("/proj/diagram.architecture.inml", result)).toBeUndefined();
  });
});

describe("!schema directive parsing (via resolver)", () => {
  it("resolves !schema to an absolute path and strips it from the parsed tree", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "schema.inml"), "kind \"org\"\n", "utf8");
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
      writeFileSync(join(dir, "schema.inml"), "kind \"org\"\n", "utf8");
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
