/** The four attribute value types a schema can declare for an `attr`. */
export type AttrType = "string" | "number" | "boolean" | "ref";

/** A single declared attribute on an `element`. */
export interface AttrSchema {
  /** The attribute's key, e.g. `"name"` in `attr "name" type="string"`. */
  name: string;
  /** The expected value type. */
  type: AttrType;
  /** Whether the attribute must be present on every matching node. */
  required: boolean;
  /**
   * When `type` is `"ref"` and the attr's `type=` was declared as an xpath
   * self-axis ref (e.g. `attr "name" type=//element[.="team"]`) rather than
   * the plain `type="ref"` literal, this holds the resolved name of the
   * element the ref's target must match. Validation then checks not just
   * that the attribute's value is *a* ref, but that it resolves (in the
   * document being validated) to a node of this specific element. Absent
   * for a plain, unconstrained `type="ref"`.
   */
  refElement?: string;
}

/**
 * A declared schema for an element's own positional value (the `value
 * type="..."` line inside an element definition). At most one per
 * element definition.
 */
export interface ValueSchema {
  /** The expected value type. */
  type: AttrType;
  /** Whether the element's positional value must be present. */
  required: boolean;
  /**
   * Same ref-target-kind constraint as `AttrSchema.refElement`, but for the
   * element's own positional value, e.g. `value type=//element[.="team"]`.
   */
  refElement?: string;
}

/**
 * A reference to a child `element` allowed under some parent (or at the
 * document root), carrying the cardinality constraint declared at this
 * particular nesting point.
 *
 * `element` is the resolved name of the canonical `ElementSchema` this
 * reference points at (e.g. `"container"`), not the raw ref text used to
 * declare it (`//element[.="container"]`).
 */
export interface ChildRef {
  /** The canonical element name this reference resolves to. */
  element: string;
  /** Minimum number of occurrences required among siblings of this element. Default `0`. */
  minCount: number;
  /** Maximum number of occurrences allowed among siblings of this element. Default `Infinity` (unbounded). */
  maxCount: number;
}

/** A canonical element definition: its allowed attrs and child elements. */
export interface ElementSchema {
  /** The element name, e.g. `"container"`. */
  name: string;
  /** Allowed attributes, keyed by name. */
  attrs: Map<string, AttrSchema>;
  /** Allowed child elements and their cardinality, keyed by child element name. */
  children: Map<string, ChildRef>;
  /** Declared schema for this element's own positional value, if any. */
  value?: ValueSchema;
}

/** A fully-parsed schema document. */
export interface Schema {
  /** Every declared element definition, keyed by element name. */
  elements: Map<string, ElementSchema>;
  /** Allowed elements (and cardinality) at the document root. */
  roots: Map<string, ChildRef>;
}

/** A single diagnostic produced by `validateAgainstSchema`. */
export interface SchemaDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** The element name the diagnostic pertains to, when applicable. */
  element?: string;
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
