/** The four attribute value types a schema can declare for an `attr`. */
export type AttrType = "string" | "number" | "boolean" | "ref";

/** A single declared attribute on a `kind`. */
export interface AttrSchema {
  /** The attribute's key, e.g. `"name"` in `attr "name" type="string"`. */
  name: string;
  /** The expected value type. */
  type: AttrType;
  /** Whether the attribute must be present on every matching node. */
  required: boolean;
}

/**
 * A reference to a child `kind` allowed under some parent (or at the
 * document root), carrying the cardinality constraint declared at this
 * particular nesting point.
 *
 * `kind` is the resolved name of the canonical top-level `KindSchema` this
 * reference points at (e.g. `"container"`), not the raw ref text used to
 * declare it (`//kind[.="container"]`).
 */
export interface ChildRef {
  /** The canonical kind name this reference resolves to. */
  kind: string;
  /** Minimum number of occurrences required among siblings of this kind. Default `0`. */
  minCount: number;
  /** Maximum number of occurrences allowed among siblings of this kind. Default `Infinity` (unbounded). */
  maxCount: number;
}

/** A canonical, top-level kind definition: its allowed attrs and child kinds. */
export interface KindSchema {
  /** The kind name, e.g. `"container"`. */
  name: string;
  /** Allowed attributes, keyed by name. */
  attrs: Map<string, AttrSchema>;
  /** Allowed child kinds and their cardinality, keyed by child kind name. */
  children: Map<string, ChildRef>;
}

/** A fully-parsed schema document. */
export interface Schema {
  /** Every top-level kind definition, keyed by kind name. */
  kinds: Map<string, KindSchema>;
  /** Allowed kinds (and cardinality) at the document root. */
  roots: Map<string, ChildRef>;
}

/** A single diagnostic produced by `validateAgainstSchema`. */
export interface SchemaDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** The kind name the diagnostic pertains to, when applicable. */
  kind?: string;
}

/** Thrown when a schema definition file itself is malformed. */
export class SchemaDefinitionError extends Error {
  constructor(message: string, public readonly line?: number, public readonly file?: string) {
    super(
      file && line !== undefined
        ? `${file}:${line}: ${message}`
        : line !== undefined
          ? `Line ${line}: ${message}`
          : message,
    );
    this.name = "SchemaDefinitionError";
  }
}
