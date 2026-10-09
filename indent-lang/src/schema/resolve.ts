import { basename } from "node:path";
import type { ParseResult } from "../types.js";
import type { ProjectManifest } from "../project.js";

/** Reserved filename suffix for schema definition files. A file ending in
 * this suffix is always a schema definition, never a document to validate. */
export const SCHEMA_FILE_SUFFIX = ".schema.inml";

/**
 * Returns true if `filePath`'s basename ends in `.schema.inml` -- i.e. it is
 * a schema definition file, not a document.
 */
export function isSchemaDefinitionFile(filePath: string): boolean {
  return basename(filePath).endsWith(SCHEMA_FILE_SUFFIX);
}

/**
 * Extracts the `<name>` segment from a `doc.<name>.inml` filename, e.g.
 * `diagram.architecture.inml` -> `"architecture"`. Returns `undefined` if
 * the filename doesn't have the `<base>.<name>.inml` shape (i.e. fewer than
 * two `.`-separated segments before the extension), or if it is itself a
 * `.schema.inml` file.
 */
export function extractSchemaSegment(filePath: string): string | undefined {
  const base = basename(filePath);
  if (base.endsWith(SCHEMA_FILE_SUFFIX)) {
    return undefined;
  }
  if (!base.endsWith(".inml")) {
    return undefined;
  }
  const withoutExt = base.slice(0, -".inml".length);
  const parts = withoutExt.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  return parts[parts.length - 1];
}

/**
 * Resolves which schema definition file (if any) should be used to validate
 * a given document, per the following precedence:
 *
 * 1. An in-document `!schema "<path>"` directive (`parseResult.schemaRef`,
 *    already resolved to an absolute path by the resolver).
 * 2. The `<name>` segment of a `doc.<name>.inml` filename, looked up in the
 *    project manifest's `schemas` registry (`manifest.schemas`).
 * 3. Otherwise, `undefined` -- the document is unvalidated.
 *
 * `!schema` directives never propagate through `!include` (enforced by the
 * resolver), so this function doesn't need to special-case included files.
 */
export function resolveSchemaFor(
  filePath: string,
  parseResult: ParseResult,
  manifest?: ProjectManifest,
): string | undefined {
  if (parseResult.schemaRef !== undefined) {
    return parseResult.schemaRef;
  }

  if (manifest !== undefined) {
    const segment = extractSchemaSegment(filePath);
    if (segment !== undefined) {
      const match = manifest.schemas.get(segment);
      if (match !== undefined) {
        return match;
      }
    }
  }

  return undefined;
}
