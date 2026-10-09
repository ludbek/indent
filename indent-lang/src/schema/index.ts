export { parseSchema, parseSchemaFile } from "./parse.js";
export { validateAgainstSchema } from "./validate.js";
export type {
  AttrSchema,
  AttrType,
  ChildRef,
  KindSchema,
  Schema,
  SchemaDiagnostic,
} from "./types.js";
export { SchemaDefinitionError } from "./types.js";
export {
  SCHEMA_FILE_SUFFIX,
  isSchemaDefinitionFile,
  resolveSchemaFor,
} from "./resolve.js";
