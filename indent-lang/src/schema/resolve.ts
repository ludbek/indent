import { basename } from "node:path";
import type { ParseResult } from "../types.js";

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
 * Resolves which schema definition file (if any) should be used to validate
 * a given document: the in-document `!schema "<path>"` directive
 * (`parseResult.schemaRef`, already resolved to an absolute path by the
 * resolver), or `undefined` if no directive is present -- the document is
 * unvalidated.
 *
 * `!schema` directives never propagate through `!include` (enforced by the
 * resolver), so this function doesn't need to special-case included files.
 */
export function resolveSchemaFor(parseResult: ParseResult): string | undefined {
  return parseResult.schemaRef;
}
