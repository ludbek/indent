import { dirname, resolve } from "path";
import { readdirSync } from "fs";
import {
  CompletionItem,
  CompletionItemKind,
  type CompletionList,
  InsertTextFormat,
  type Position,
  type Range,
} from "vscode-languageserver";
import { uriToFsPath, type WorkspaceIndex } from "./indexer.js";
import type { AstDocument, AstValueType, IndexedNode } from "./types.js";
import type { ChildRef, Schema } from "indent-lang/schema";

/**
 * Indent has no reserved/special tag names -- `kind` (the first word of a
 * statement line) and attribute names are ordinary identifiers chosen by the
 * author (see indent-lang/src/types.ts:42). Completions are primarily
 * derived from what already exists in the workspace, not from a hardcoded
 * set of "known" kinds or attributes.
 *
 * When a document has a valid `!schema "path"` binding (see
 * `WorkspaceIndex.schemaBindingByUri`), schema-declared kinds/attrs/types are
 * additionally offered -- unioned with, never replacing, the workspace-stats
 * derived suggestions above. See `getSchemaForDocument`/`findEnclosingKind`.
 */

/** Resolves the valid, parsed `Schema` bound to a document, if any. */
function getSchemaForDocument(index: WorkspaceIndex, uri: string): Schema | undefined {
  const binding = index.schemaBindingByUri.get(uri);
  if (!binding || !binding.isValidSchemaFile || !binding.resolvedUri) return undefined;
  return index.schemaFiles.get(binding.resolvedUri)?.schema;
}

/** Indentation unit used by the indentation diagnostic -- 4 spaces per depth level. */
const INDENT_UNIT = 4;

/**
 * Finds the kind name of the nearest preceding statement at `parentDepth`
 * (i.e. the enclosing parent of whatever is being typed at `currentDepth`),
 * by scanning statements that start before `position`. Returns `undefined`
 * at the document root (`currentDepth === 0`, no parent to resolve).
 */
function findEnclosingKind(doc: AstDocument, position: Position, currentDepth: number): string | undefined {
  if (currentDepth <= 0) return undefined;
  const parentDepth = currentDepth - 1;
  let best: { line: number; kind: string } | undefined;
  for (const stmt of doc.allStatements) {
    if (stmt.depth !== parentDepth) continue;
    if (stmt.range.start.line >= position.line) continue;
    if (!best || stmt.range.start.line > best.line) {
      best = { line: stmt.range.start.line, kind: stmt.kind };
    }
  }
  return best?.kind;
}

/**
 * Matches the in-progress tail of a ref value after the leading `/`/`//`:
 * a repeated run of either (a) any single non-space, non-quote character, or
 * (b) a whole (or still-open, i.e. unterminated at the cursor) `"..."` span.
 * This lets a predicate self-/attr-value like `[.="UpstreamOrg Update Member"]`
 * keep matching once a space is typed inside the quotes, while a bare
 * (unquoted) space still correctly terminates the match outside quotes
 * (path/predicate syntax itself never contains unquoted spaces).
 */
const REF_VALUE_TAIL_SOURCE = String.raw`(?:[^\s"]|"(?:[^"\\]|\\.)*"?)*`;

/** A distinct literal value observed in the workspace, plus how often. */
interface ValueStat {
  value: string | number | boolean;
  valueType: AstValueType;
  count: number;
}

/** Composite key so boolean `true` and string `"true"` never collide. */
function serializeValueKey(valueType: AstValueType, value: string | number | boolean): string {
  return `${valueType}:${String(value)}`;
}

function recordValue(
  map: Map<string, ValueStat>,
  valueType: AstValueType,
  value: string | number | boolean
): void {
  const key = serializeValueKey(valueType, value);
  const existing = map.get(key);
  if (existing) {
    existing.count++;
  } else {
    map.set(key, { value, valueType, count: 1 });
  }
}

function getOrCreateMap<K>(outer: Map<K, Map<string, ValueStat>>, key: K): Map<string, ValueStat> {
  let inner = outer.get(key);
  if (!inner) {
    inner = new Map<string, ValueStat>();
    outer.set(key, inner);
  }
  return inner;
}

/**
 * When a completion is triggered from inside an already-open quoted value
 * (`"partial`), editors commonly auto-insert a matching closing `"` right
 * after the cursor the moment the user types the opening quote. Since
 * `formatValueLiteral` returns a fully self-quoted literal (its own leading
 * + trailing quote) as the replacement text, that pre-existing auto-closed
 * quote is left untouched unless the replacement range is extended to cover
 * it too -- otherwise accepting a suggestion leaves a duplicated trailing
 * `"` behind (e.g. `"UpstreamOrg Get Member""`). Only applies in "quoted" mode, and
 * only when a `"` is actually present right after the range's end.
 */
function extendRangeForAutoClosedQuote(
  range: Range,
  mode: "quoted" | "bare-partial" | "bare-empty",
  lineText: string
): Range {
  if (mode !== "quoted") return range;
  if (lineText.charAt(range.end.character) !== '"') return range;
  return {
    start: range.start,
    end: { line: range.end.line, character: range.end.character + 1 },
  };
}

/** Renders a stat's value back into Indent literal syntax for insertion. */
function formatValueLiteral(valueType: AstValueType, value: string | number | boolean): string {
  if (valueType === "string") {
    const escaped = String(value).replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return String(value);
}

function collectWorkspaceStats(index: WorkspaceIndex): {
  kindCounts: Map<string, number>;
  attrsByKind: Map<string, Map<string, number>>;
  positionalValuesByKind: Map<string, Map<string, ValueStat>>;
  attrValuesByKindAttr: Map<string, Map<string, ValueStat>>;
} {
  const kindCounts = new Map<string, number>();
  const attrsByKind = new Map<string, Map<string, number>>();
  const positionalValuesByKind = new Map<string, Map<string, ValueStat>>();
  const attrValuesByKindAttr = new Map<string, Map<string, ValueStat>>();

  for (const doc of index.documents.values()) {
    for (const stmt of doc.allStatements) {
      if (stmt.isInclude) continue;
      kindCounts.set(stmt.kind, (kindCounts.get(stmt.kind) ?? 0) + 1);

      let attrCounts = attrsByKind.get(stmt.kind);
      if (!attrCounts) {
        attrCounts = new Map<string, number>();
        attrsByKind.set(stmt.kind, attrCounts);
      }

      // Positional (node) value -- refs are handled by the dedicated
      // ref-navigation/completion path, not by literal-value repetition.
      if (stmt.value && stmt.value.valueType !== "ref") {
        const m = getOrCreateMap(positionalValuesByKind, stmt.kind);
        recordValue(m, stmt.value.valueType as AstValueType, stmt.value.value);
      }

      for (const [attrName, attr] of Object.entries(stmt.attrs)) {
        attrCounts.set(attrName, (attrCounts.get(attrName) ?? 0) + 1);

        if (attr.valueType !== "ref") {
          const kindAttrKey = `${stmt.kind}\u0000${attrName}`;
          const scoped = getOrCreateMap(attrValuesByKindAttr, kindAttrKey);
          recordValue(scoped, attr.valueType as AstValueType, attr.value);
        }
      }
    }
  }

  return {
    kindCounts,
    attrsByKind,
    positionalValuesByKind,
    attrValuesByKindAttr,
  };
}

/**
 * Only surface values that have repeated at least this many times. A
 * single-use value is unlikely to be a genuine reusable pattern -- it just
 * adds noise, especially for near-unique attrs like `name`.
 */
const MIN_VALUE_OCCURRENCES = 2;

/**
 * Builds sorted, capped completion items from a value-stat map.
 * - mode "quoted": only string-typed values, filtered by prefix (quote-in-progress).
 * - mode "bare-partial": only non-string values (bool/number), filtered by prefix.
 * - mode "bare-empty": all values shown (string ones rendered pre-quoted).
 *
 * `minOccurrences` overrides the default MIN_VALUE_OCCURRENCES noise floor.
 * Callers enumerating actual reference targets (e.g. self-value `kind[.=`
 * predicates, where each value is a node's own near-unique identifying
 * name) should pass 1 so every distinct value is offered, since the floor's
 * "is this a genuine reusable pattern" heuristic doesn't apply to identifiers.
 */
function buildValueCompletionItems(
  statsMap: Map<string, ValueStat> | undefined,
  opts: {
    mode: "quoted" | "bare-partial" | "bare-empty";
    partial: string;
    range: Range;
    minOccurrences?: number;
  }
): CompletionItem[] {
  if (!statsMap) return [];

  let entries = [...statsMap.values()];
  const lowerPartial = opts.partial.toLowerCase();

  if (opts.mode === "quoted") {
    entries = entries.filter((e) => e.valueType === "string");
    if (opts.partial) {
      entries = entries.filter((e) => String(e.value).toLowerCase().startsWith(lowerPartial));
    }
  } else if (opts.mode === "bare-partial") {
    entries = entries.filter((e) => e.valueType !== "string");
    entries = entries.filter((e) => String(e.value).toLowerCase().startsWith(lowerPartial));
  }
  // "bare-empty": keep every entry, string values included pre-quoted.

  const minOccurrences = opts.minOccurrences ?? MIN_VALUE_OCCURRENCES;
  entries = entries.filter((e) => e.count >= minOccurrences);

  entries.sort((a, b) => b.count - a.count);
  entries = entries.slice(0, 20);

  return entries.map((e) => {
    const literal = formatValueLiteral(e.valueType, e.value);
    return {
      label: literal,
      kind: CompletionItemKind.Value,
      detail: `Used ${e.count} time${e.count === 1 ? "" : "s"} in workspace`,
      textEdit: { range: opts.range, newText: literal },
    };
  });
}

/**
 * Finds an unterminated (still-open) `[` predicate at the end of a typed
 * ref value, quote-aware so a literal `[`/`]` inside a quoted predicate
 * value doesn't confuse bracket tracking. Returns the kind name the
 * predicate is being typed against (the identifier immediately before the
 * `[`), the raw in-progress predicate body (everything after `[`), and the
 * `head` -- everything up to (not including) the `[` -- so the caller can
 * resolve which actual node(s) the predicate is being typed against.
 * Returns `null` when there's no open predicate (i.e. we're still typing a
 * plain step/kind name, not inside `[...]`).
 */
function findOpenPredicate(typedValue: string): { kindName: string; body: string; head: string } | null {
  let inString = false;
  let openIdx = -1;
  for (let i = 0; i < typedValue.length; i++) {
    const ch = typedValue[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") openIdx = i;
    else if (ch === "]") openIdx = -1;
  }
  if (openIdx === -1) return null;
  const head = typedValue.slice(0, openIdx);
  const kindMatch = head.match(/([-_=<>A-Za-z][-_=<>A-Za-z0-9]*)$/);
  if (!kindMatch) return null;
  return { kindName: kindMatch[1], body: typedValue.slice(openIdx + 1), head };
}

/** Splits a predicate body on top-level `,` (not inside a `"..."` span). */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

type ClauseAnalysis =
  | { kind: "attr-list"; partial: string }
  | { kind: "self-value"; mode: "quoted" | "bare"; partial: string }
  | { kind: "attr-value"; attrName: string; mode: "quoted" | "bare"; partial: string };

/** Parses `="..."` / `=partial` after an `=` sign; `null` = already a closed/complete value. */
function analyzeValuePart(valuePart: string): { mode: "quoted" | "bare"; partial: string } | null {
  if (valuePart.startsWith('"')) {
    const rest = valuePart.slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "\\") {
        i++;
        continue;
      }
      if (rest[i] === '"') return null; // already closed -- nothing left to suggest
    }
    return { mode: "quoted", partial: rest };
  }
  return { mode: "bare", partial: valuePart };
}

/** Determines what's being typed inside the active (last, in-progress) predicate clause. */
function analyzeClause(activeClause: string): ClauseAnalysis | null {
  if (activeClause.startsWith(".")) {
    const rest = activeClause.slice(1);
    if (!rest.startsWith("=")) {
      return { kind: "attr-list", partial: activeClause };
    }
    const parsed = analyzeValuePart(rest.slice(1));
    if (!parsed) return null;
    return { kind: "self-value", mode: parsed.mode, partial: parsed.partial };
  }
  const eqIdx = activeClause.indexOf("=");
  if (eqIdx === -1) {
    return { kind: "attr-list", partial: activeClause };
  }
  const attrName = activeClause.slice(0, eqIdx);
  const parsed = analyzeValuePart(activeClause.slice(eqIdx + 1));
  if (!parsed) return null;
  return { kind: "attr-value", attrName, mode: parsed.mode, partial: parsed.partial };
}

/**
 * Completions for inside an in-progress ref predicate: `kind[`, `kind[.=`,
 * `kind[prop=`, and comma-continuations like `kind[a="x",prop=`. The
 * attribute-NAME list (`kind[`) is scoped to `firstMatch` -- the first
 * actual node resolved from the path typed before `[` -- so only props that
 * really exist there are suggested, not every prop ever seen on that kind
 * anywhere in the workspace. Value completion (`kind[.=`, `kind[prop=`)
 * still uses the workspace-wide stats maps so all historically-used values
 * remain discoverable when picking a predicate value.
 */
function buildPredicateCompletionItems(
  kindName: string,
  body: string,
  position: Position,
  firstMatch: IndexedNode | undefined,
  attrsByKind: Map<string, Map<string, number>>,
  positionalValuesByKind: Map<string, Map<string, ValueStat>>,
  attrValuesByKindAttr: Map<string, Map<string, ValueStat>>,
  lineText: string
): CompletionItem[] {
  const clauses = splitTopLevelCommas(body);
  const activeClause = clauses[clauses.length - 1];
  const analysis = analyzeClause(activeClause);
  if (!analysis) return [];

  if (analysis.kind === "attr-list") {
    const { partial } = analysis;
    const lowerPartial = partial.toLowerCase();
    const range = {
      start: { line: position.line, character: position.character - partial.length },
      end: position,
    };
    const items: CompletionItem[] = [];
    if (!partial || ".".startsWith(lowerPartial)) {
      items.push({
        label: ".",
        kind: CompletionItemKind.Property,
        detail: "Self value (node's own positional value)",
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: { range, newText: '.="${1:value}"' },
      });
    }
    // Prefer the first actually-resolved node's own attributes; fall back to
    // the workspace-wide aggregate only when the path didn't resolve to a
    // real node (e.g. an unresolvable/broken ref prefix).
    if (firstMatch) {
      for (const [attrName, attr] of Object.entries(firstMatch.attrs)) {
        if (partial && !attrName.toLowerCase().startsWith(lowerPartial)) continue;
        items.push({
          label: attrName,
          kind: CompletionItemKind.Property,
          detail: `${attrName}="${String(attr.value)}"`,
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit: { range, newText: `${attrName}="\${1:value}"` },
        });
      }
    } else {
      const attrCounts = attrsByKind.get(kindName);
      if (attrCounts) {
        const sorted = [...attrCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [attrName, count] of sorted) {
          if (partial && !attrName.toLowerCase().startsWith(lowerPartial)) continue;
          items.push({
            label: attrName,
            kind: CompletionItemKind.Property,
            detail: `Used ${count} time${count === 1 ? "" : "s"} on '${kindName}' in workspace`,
            insertTextFormat: InsertTextFormat.Snippet,
            textEdit: { range, newText: `${attrName}="\${1:value}"` },
          });
        }
      }
    }
    return items;
  }

  const { mode, partial } = analysis;
  // For "quoted" mode, `partial` is the text after the opening quote --
  // extend the range back by 1 to also cover that already-typed quote char,
  // since `formatValueLiteral` returns a FULLY quoted literal (own leading
  // + trailing quote) as `newText`. Without this the accepted item's quote
  // just gets inserted next to the existing one instead of replacing it,
  // producing a duplicated leading `"`.
  let range = {
    start: {
      line: position.line,
      character: position.character - partial.length - (mode === "quoted" ? 1 : 0),
    },
    end: position,
  };
  const valueMode: "quoted" | "bare-partial" | "bare-empty" =
    mode === "quoted" ? "quoted" : partial ? "bare-partial" : "bare-empty";
  // Also extend forward past an already-present auto-closed trailing quote
  // (see `extendRangeForAutoClosedQuote`), so the same duplicate-quote issue
  // doesn't occur at the end of the replacement instead of the start.
  range = extendRangeForAutoClosedQuote(range, valueMode, lineText);

  if (analysis.kind === "self-value") {
    // Self-value predicates enumerate actual reference targets by their own
    // (usually near-unique) positional name -- bypass the MIN_VALUE_OCCURRENCES
    // floor so every distinct node identifier is offered, not just repeats.
    return buildValueCompletionItems(positionalValuesByKind.get(kindName), {
      mode: valueMode,
      partial,
      range,
      minOccurrences: 1,
    });
  }

  const statsMap = attrValuesByKindAttr.get(`${kindName}\u0000${analysis.attrName}`);
  return buildValueCompletionItems(statsMap, { mode: valueMode, partial, range });
}

/**
 * Resolves a typed ref-value prefix (e.g. `/org/service`, `//Table`) into
 * completion items suggesting the next path segment. Shared by both
 * attribute ref-value completion (`attr=/foo`) and positional ref-value
 * completion (`alias /foo`) -- Indent allows refs in both positions.
 * Returns `null` if the typed prefix isn't resolvable as a ref context at
 * all (caller should fall through to other completion stages in that case).
 */
function buildRefCompletionItems(
  typedValue: string,
  position: Position,
  valueRange: Range,
  index: WorkspaceIndex,
  attrsByKind: Map<string, Map<string, number>>,
  positionalValuesByKind: Map<string, Map<string, ValueStat>>,
  attrValuesByKindAttr: Map<string, Map<string, ValueStat>>,
  lineText: string
): CompletionItem[] | null {
  const openPredicate = findOpenPredicate(typedValue);
  if (openPredicate) {
    // Resolve the actual node(s) the predicate is being typed against (the
    // path before the `[`) so we can scope suggested attribute names to
    // what's really there, instead of a workspace-wide aggregate. Use an
    // exact kind match (not the prefix match `resolveRefContext` normally
    // does for in-progress kind names) since the kind name here is already
    // complete -- it's the identifier immediately before `[`.
    let firstMatch: IndexedNode | undefined;
    const headCtx = resolveRefContext(openPredicate.head, index);
    if (headCtx) {
      const candidates = gatherCandidateNodes(headCtx, index).filter(
        (n) => n.kind === openPredicate.kindName
      );
      firstMatch = candidates[0];
    }
    return buildPredicateCompletionItems(
      openPredicate.kindName,
      openPredicate.body,
      position,
      firstMatch,
      attrsByKind,
      positionalValuesByKind,
      attrValuesByKindAttr,
      lineText
    );
  }

  const items: CompletionItem[] = [];

  const ctx = resolveRefContext(typedValue, index);
  if (!ctx) return null;

  const { axis, partialKind } = ctx;

  let candidateNodes = gatherCandidateNodes(ctx, index);

  // Filter by partial kind typed so far
  if (partialKind) {
    const lowerPartial = partialKind.toLowerCase();
    candidateNodes = candidateNodes.filter((n) => n.kind.toLowerCase().startsWith(lowerPartial));
  }

  // Build the prefix path (everything before what we're completing)
  let pathPrefix: string;
  if (partialKind) {
    pathPrefix = typedValue.slice(0, typedValue.length - partialKind.length);
  } else {
    pathPrefix = typedValue;
  }

  // Always suggest distinct node kinds — show the bare kind name (e.g.
  // `API`), never a per-instance predicate or positional-index segment.
  // This is uniform across every ref position: bare `/`, bare `//`, a
  // partial kind name (`/or`, `//or`), and a resolved parent context
  // (`/org/`, `/org//`) all collapse the same way. The user narrows to a
  // specific node afterwards by typing a `[...]` predicate themselves,
  // which is handled separately above via `findOpenPredicate` /
  // `buildPredicateCompletionItems`.
  const seenKinds = new Set<string>();
  for (const node of candidateNodes) {
    if (seenKinds.has(node.kind)) continue;
    seenKinds.add(node.kind);

    const fullPath = pathPrefix + node.kind;

    items.push({
      label: node.kind,
      kind: CompletionItemKind.Reference,
      // filterText must include the leading path (`/`, `//`) so the
      // client's word-based filtering -- which sees the whole typed value
      // from the first slash to the cursor -- can match it. Without this it
      // filters `//se` against a bare `service` label and the leading
      // slashes cause a mismatch.
      filterText: fullPath,
      textEdit: { range: valueRange, newText: fullPath },
    });
  }

  return items;
}

/**
 * Filesystem-backed path completion for `!include "..."` directive values.
 * Unlike ref-value completion (which resolves against the in-memory
 * workspace index of already-parsed nodes), include paths point at files on
 * disk that may not even be part of the workspace yet -- so this reads the
 * directory directly via `fs.readdirSync` relative to the including
 * document's own location, mirroring how `resolveIncludePath` in
 * indent-lang/src/resolver.ts resolves the same string at parse time.
 *
 * Only directories and `.inml` files are suggested (directories so the user
 * can keep drilling down; non-.inml files are never valid include targets).
 * Dotfiles/dot-directories are hidden unless the user has already typed a
 * leading `.` for that path segment.
 */
function buildIncludePathCompletionItems(
  typedValue: string,
  valueRange: Range,
  docFsPath: string
): CompletionItem[] {
  const lastSlashIdx = typedValue.lastIndexOf("/");
  const dirPart = lastSlashIdx >= 0 ? typedValue.slice(0, lastSlashIdx + 1) : "";
  const segmentPartial = lastSlashIdx >= 0 ? typedValue.slice(lastSlashIdx + 1) : typedValue;

  const baseDir = dirname(docFsPath);
  const resolvedDir = dirPart ? resolve(baseDir, dirPart) : baseDir;

  let entries;
  try {
    entries = readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const lowerPartial = segmentPartial.toLowerCase();
  const showDotfiles = segmentPartial.startsWith(".");

  const filtered = entries
    .filter((e) => e.isDirectory() || e.name.endsWith(".inml"))
    .filter((e) => showDotfiles || !e.name.startsWith("."))
    .filter((e) => !segmentPartial || e.name.toLowerCase().startsWith(lowerPartial))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return filtered.map((entry) => {
    const isDir = entry.isDirectory();
    const name = isDir ? `${entry.name}/` : entry.name;
    const newText = dirPart + name;
    return {
      label: name,
      kind: isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
      // filterText must include the already-typed dir prefix for the same
      // reason as ref-value completion above: the client's word-based
      // filtering sees the whole typed value from the quote to the cursor.
      filterText: newText,
      textEdit: { range: valueRange, newText },
      // Re-trigger suggestions immediately after inserting a directory so
      // the user can keep drilling down without retyping `/`.
      command: isDir
        ? { command: "editor.action.triggerSuggest", title: "Suggest" }
        : undefined,
    };
  });
}

export function computeCompletions(
  uri: string,
  position: Position,
  index: WorkspaceIndex
): CompletionItem[] | CompletionList {
  const doc = index.getDocument(uri);
  if (!doc) return [];

  const lines = doc.text.split(/\r\n|\r|\n/);
  const line = lines[position.line] ?? "";
  const prefix = line.slice(0, position.character);

  const items: CompletionItem[] = [];

  // --- `!include "path"` filesystem path completion ---
  // Must be checked before any other stage: `!include` is a reserved
  // directive kind (leading `!`), not an ordinary user-defined kind, so it
  // never matches the generic kind-charset patterns used below. Its value
  // points at a file on disk, not at another node in the workspace index,
  // so this resolves directly against the filesystem instead of reusing
  // the ref-completion machinery.
  const includePathMatch = prefix.match(/^\s*!include\s+"([^"]*)$/);
  if (includePathMatch) {
    const typedValue = includePathMatch[1];
    const valueStartChar = position.character - typedValue.length;
    const valueRange = {
      start: { line: position.line, character: valueStartChar },
      end: position,
    };
    const docFsPath = uriToFsPath(doc.uri);
    // Incomplete: re-query on every keystroke so the client doesn't apply
    // its own fuzzy filtering to `/`-delimited path segments (same reason
    // as ref-value completion below).
    return {
      isIncomplete: true,
      items: buildIncludePathCompletionItems(typedValue, valueRange, docFsPath),
    };
  }

  // --- `!schema "path"` filesystem path completion ---
  // Same rationale/mechanics as `!include` above -- a schema binding points
  // at a file on disk (classified by the `.schema.inml` suffix), not at a
  // workspace index node. Filtering is identical: directories + any `.inml`
  // file, no suffix restriction (an incorrectly-suffixed/invalid target is
  // surfaced as a diagnostic, not filtered out of completion).
  const schemaPathMatch = prefix.match(/^\s*!schema\s+"([^"]*)$/);
  if (schemaPathMatch) {
    const typedValue = schemaPathMatch[1];
    const valueStartChar = position.character - typedValue.length;
    const valueRange = {
      start: { line: position.line, character: valueStartChar },
      end: position,
    };
    const docFsPath = uriToFsPath(doc.uri);
    return {
      isIncomplete: true,
      items: buildIncludePathCompletionItems(typedValue, valueRange, docFsPath),
    };
  }

  const { kindCounts, attrsByKind, positionalValuesByKind, attrValuesByKindAttr } =
    collectWorkspaceStats(index);

  // Check if inside an unquoted ref-shaped attribute value (e.g. `attr=/foo`,
  // `attr=//foo`). Trigger once ref characters (`/`, `//`) have been typed.
  const refValueMatch = prefix.match(
    new RegExp(`([A-Za-z_][A-Za-z0-9_-]*)=(/{1,2}${REF_VALUE_TAIL_SOURCE})$`)
  );

  if (refValueMatch) {
    const typedValue = refValueMatch[2];
    const valueStartChar = position.character - typedValue.length;
    const valueRange = {
      start: { line: position.line, character: valueStartChar },
      end: position,
    };

    // Ref/path completions must be marked incomplete so the client re-queries
    // the server on every keystroke instead of caching this list and doing its
    // own fuzzy filtering -- the latter mis-matches `/`-delimited path segments
    // (e.g. `//b` fuzzy-matching a `b` deep inside a `/neo/datahub/...` label).
    const refItems = buildRefCompletionItems(
      typedValue,
      position,
      valueRange,
      index,
      attrsByKind,
      positionalValuesByKind,
      attrValuesByKindAttr,
      line
    );
    return { isIncomplete: true, items: refItems ?? items };
  }

  // --- Positional (node) REF value completion ---
  // Triggers on a ref-shaped literal in the first-token position, e.g.
  // `alias /Org/Service` or `alias //Table`. Reuses the exact same
  // resolution logic as attribute ref-value completion above -- refs are
  // valid in either position per the Indent grammar.
  // The kind matcher uses the unified kind charset (letters, digits,
  // underscore, hyphen, and `= < >`) so edge kinds like `->`/`=>` are
  // matched the same as any ordinary kind -- no hardcoded literal special
  // case is needed, since they carry no special meaning to the grammar.
  const posRefMatch = prefix.match(
    new RegExp(`^(\\s*)([-_=<>A-Za-z][-_=<>A-Za-z0-9]*)\\s+(/{1,2}${REF_VALUE_TAIL_SOURCE})$`)
  );

  if (posRefMatch) {
    const typedValue = posRefMatch[3];
    const valueStartChar = position.character - typedValue.length;
    const valueRange = {
      start: { line: position.line, character: valueStartChar },
      end: position,
    };

    const result = buildRefCompletionItems(
      typedValue,
      position,
      valueRange,
      index,
      attrsByKind,
      positionalValuesByKind,
      attrValuesByKindAttr,
      line
    );
    if (result) return { isIncomplete: true, items: result };
  }

  // --- Attribute VALUE completion (non-ref literal values) ---
  // Triggers on `attr="partial` (quote in progress, no closing quote yet)
  // or `attr=partial` (unquoted -- empty, or a partial bool/number). Ref
  // values (`attr=/foo`) are already handled and returned above.
  const attrQuotedValueMatch = prefix.match(/([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)$/);
  const attrBareValueMatch = !attrQuotedValueMatch
    ? prefix.match(/([A-Za-z_][A-Za-z0-9_-]*)=([A-Za-z0-9_.]*)$/)
    : null;

  if (attrQuotedValueMatch || attrBareValueMatch) {
    const m = (attrQuotedValueMatch ?? attrBareValueMatch)!;
    const attrName = m[1];
    const partial = m[2];
    const isQuoted = !!attrQuotedValueMatch;

    const valueStartChar = position.character - (isQuoted ? partial.length + 1 : partial.length);
    const range = extendRangeForAutoClosedQuote(
      {
        start: { line: position.line, character: valueStartChar },
        end: position,
      },
      isQuoted ? "quoted" : partial ? "bare-partial" : "bare-empty",
      line
    );

    // Determine the enclosing kind from the raw line text (not from a CST
    // lookup) since the in-progress value can make the statement unparsable.
    const kindMatch = line.match(/^\s*([-_=<>A-Za-z][-_=<>A-Za-z0-9]*)/);
    const currentKind = kindMatch?.[1];

    // Scoped strictly to this kind+attr combination -- no cross-kind
    // fallback, since values that make sense for one kind's attr often
    // don't for another kind's same-named attr.
    const statsMap = currentKind
      ? attrValuesByKindAttr.get(`${currentKind}\u0000${attrName}`)
      : undefined;

    const mode: "quoted" | "bare-partial" | "bare-empty" = isQuoted
      ? "quoted"
      : partial
        ? "bare-partial"
        : "bare-empty";

    const valueItems = buildValueCompletionItems(statsMap, { mode, partial, range });

    // Schema-driven typed value suggestions (currently: boolean enumeration).
    // String/number/ref types have no enumerable value set to offer beyond
    // what's already observed in the workspace (handled by statsMap above).
    if (!isQuoted && currentKind) {
      const schema = getSchemaForDocument(index, uri);
      const attrSchema = schema?.kinds.get(currentKind)?.attrs.get(attrName);
      if (attrSchema?.type === "boolean") {
        for (const boolLiteral of ["true", "false"]) {
          if (partial && !boolLiteral.startsWith(partial.toLowerCase())) continue;
          if (valueItems.some((it) => it.label === boolLiteral)) continue;
          valueItems.push({
            label: boolLiteral,
            kind: CompletionItemKind.Value,
            detail: "boolean (schema)",
            textEdit: { range, newText: boolLiteral },
          });
        }
      }
    }

    return valueItems;
  }

  // --- Positional (node) VALUE completion ---
  // Triggers only on the very first token after the kind (anchored at line
  // start), e.g. `service "Au` or `database 1`. Because the Indent grammar
  // itself cannot disambiguate a bare partial token (no `=`, no quote) from
  // the start of an attribute name until more is typed, the bare-token case
  // merges both positional-value and attribute-name suggestions.
  const posQuotedMatch = prefix.match(/^(\s*)([-_=<>A-Za-z][-_=<>A-Za-z0-9]*)\s+"([^"]*)$/);
  const posBareMatch = !posQuotedMatch
    ? prefix.match(/^(\s*)([-_=<>A-Za-z][-_=<>A-Za-z0-9]*)\s+([A-Za-z0-9_.]*)$/)
    : null;

  if (posQuotedMatch || posBareMatch) {
    const m = (posQuotedMatch ?? posBareMatch)!;
    const kindName = m[2];
    const partial = m[3];
    const isQuoted = !!posQuotedMatch;

    const valueStartChar = position.character - (isQuoted ? partial.length + 1 : partial.length);
    const mode: "quoted" | "bare-partial" | "bare-empty" = isQuoted
      ? "quoted"
      : partial
        ? "bare-partial"
        : "bare-empty";
    const range = extendRangeForAutoClosedQuote(
      {
        start: { line: position.line, character: valueStartChar },
        end: position,
      },
      mode,
      line
    );

    const valueItems = buildValueCompletionItems(positionalValuesByKind.get(kindName), {
      mode,
      partial,
      range,
    });

    if (!isQuoted) {
      // Ambiguous bare token -- also offer attribute names that could start
      // here (once the user adds `=`), filtered by whatever's typed so far.
      const attrCounts = attrsByKind.get(kindName);
      const suggestedAttrNames = new Set<string>();
      if (attrCounts) {
        const lowerPartial = partial.toLowerCase();
        const sortedAttrs = [...attrCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [attrName, count] of sortedAttrs) {
          if (partial && !attrName.toLowerCase().startsWith(lowerPartial)) continue;
          suggestedAttrNames.add(attrName);
          valueItems.push({
            label: attrName,
            kind: CompletionItemKind.Property,
            detail: `Used ${count} time${count === 1 ? "" : "s"} on '${kindName}' in workspace`,
            textEdit: { range, newText: `${attrName}="\${1:value}"` },
            insertTextFormat: InsertTextFormat.Snippet,
          });
        }
      }

      // Schema-driven attr-name suggestions, unioned with the above.
      const schema = getSchemaForDocument(index, uri);
      const kindSchema = schema?.kinds.get(kindName);
      if (kindSchema) {
        const lowerPartial = partial.toLowerCase();
        for (const [attrName, attrSchema] of kindSchema.attrs) {
          if (suggestedAttrNames.has(attrName)) continue;
          if (partial && !attrName.toLowerCase().startsWith(lowerPartial)) continue;
          valueItems.push({
            label: attrName,
            kind: CompletionItemKind.Property,
            detail: `${attrSchema.required ? "Required" : "Optional"} ${attrSchema.type} attr (schema)`,
            textEdit: { range, newText: `${attrName}="\${1:value}"` },
            insertTextFormat: InsertTextFormat.Snippet,
          });
        }
      }
    }

    return valueItems;
  }

  // Check if typing at line start (kind completion)
  const trimmedPrefix = prefix.trimStart();
  const isLineStart = !trimmedPrefix.includes(" ");

  if (isLineStart) {
    const leadingWhitespaceLen = prefix.length - trimmedPrefix.length;
    const replaceRange = {
      start: { line: position.line, character: leadingWhitespaceLen },
      end: position,
    };
    // Suggest kinds already used elsewhere in the workspace, most frequent first.
    const sortedKinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]);
    const suggestedKinds = new Set<string>();
    for (const [kindName, count] of sortedKinds) {
      suggestedKinds.add(kindName);
      items.push({
        label: kindName,
        kind: CompletionItemKind.Keyword,
        detail: `Used ${count} time${count === 1 ? "" : "s"} in workspace`,
        textEdit: {
          range: replaceRange,
          newText: kindName,
        },
        insertTextFormat: InsertTextFormat.PlainText,
      });
    }

    // Schema-driven kind suggestions -- unioned with the workspace-derived
    // ones above, never replacing them. Scoped to whatever child kinds are
    // actually allowed at this depth per the bound schema (document roots
    // at depth 0, or the enclosing statement's declared children otherwise).
    const schema = getSchemaForDocument(index, uri);
    if (schema) {
      const currentDepth = Math.round(leadingWhitespaceLen / INDENT_UNIT);
      const parentKind = findEnclosingKind(doc, position, currentDepth);
      const allowedChildren: Map<string, ChildRef> | undefined =
        currentDepth === 0 ? schema.roots : schema.kinds.get(parentKind ?? "")?.children;
      if (allowedChildren) {
        for (const kindName of allowedChildren.keys()) {
          if (suggestedKinds.has(kindName)) continue;
          suggestedKinds.add(kindName);
          items.push({
            label: kindName,
            kind: CompletionItemKind.Keyword,
            detail:
              currentDepth === 0
                ? "Allowed at document root (schema)"
                : `Allowed under '${parentKind}' (schema)`,
            textEdit: { range: replaceRange, newText: kindName },
            insertTextFormat: InsertTextFormat.PlainText,
          });
        }
      }
    }

    return items;
  }

  // Check if inside a statement (attribute-name completion, mid-line after
  // at least one prior attr/value already present on the statement).
  const stmt = index.getStatementAtPosition(uri, position);
  if (stmt) {
    const attrCounts = attrsByKind.get(stmt.kind);
    const lastSpaceIdx = prefix.lastIndexOf(" ");
    const partialStart = lastSpaceIdx + 1;
    const partial = prefix.slice(partialStart);
    const lowerPartial = partial.toLowerCase();
    const replaceRange = {
      start: { line: position.line, character: partialStart },
      end: position,
    };
    const suggestedAttrs = new Set<string>();

    if (attrCounts) {
      const sortedAttrs = [...attrCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [attrName, count] of sortedAttrs) {
        if (stmt.attrs[attrName]) continue;
        if (partial && !attrName.toLowerCase().startsWith(lowerPartial)) continue;
        suggestedAttrs.add(attrName);
        items.push({
          label: attrName,
          kind: CompletionItemKind.Property,
          detail: `Used ${count} time${count === 1 ? "" : "s"} on '${stmt.kind}' in workspace`,
          textEdit: {
            range: replaceRange,
            newText: `${attrName}="\${1:value}"`,
          },
          insertTextFormat: InsertTextFormat.Snippet,
        });
      }
    }

    // Schema-driven attr-name suggestions, unioned with the above.
    const schema = getSchemaForDocument(index, uri);
    const kindSchema = schema?.kinds.get(stmt.kind);
    if (kindSchema) {
      for (const [attrName, attrSchema] of kindSchema.attrs) {
        if (stmt.attrs[attrName]) continue;
        if (suggestedAttrs.has(attrName)) continue;
        if (partial && !attrName.toLowerCase().startsWith(lowerPartial)) continue;
        items.push({
          label: attrName,
          kind: CompletionItemKind.Property,
          detail: `${attrSchema.required ? "Required" : "Optional"} ${attrSchema.type} attr (schema)`,
          textEdit: {
            range: replaceRange,
            newText: `${attrName}="\${1:value}"`,
          },
          insertTextFormat: InsertTextFormat.Snippet,
        });
      }
    }
  }

  return items;
}

/** Collect all descendant nodes of a set of parent nodes */
function collectDescendants(parents: IndexedNode[], allNodes: Map<string, IndexedNode>): IndexedNode[] {
  const descendants: IndexedNode[] = [];
  const visit = (node: IndexedNode) => {
    for (const childPath of node.childPaths) {
      const child = allNodes.get(childPath);
      if (child) {
        descendants.push(child);
        visit(child);
      }
    }
  };
  for (const p of parents) visit(p);
  return descendants;
}

/**
 * Given a resolved ref context ({ contextNodes, axis }), gather the actual
 * node set it refers to: root nodes, all workspace nodes, descendants of the
 * context nodes, or direct children -- shared by plain path-step completion
 * and predicate (`[...]`) attribute-name scoping so both resolve node sets
 * identically.
 */
function gatherCandidateNodes(
  ctx: { contextNodes: IndexedNode[]; axis: "child" | "descendant" },
  index: WorkspaceIndex
): IndexedNode[] {
  const { contextNodes, axis } = ctx;
  if (contextNodes.length === 0 && axis === "child") {
    // At root level — suggest root nodes
    return [...index.rootNodes];
  }
  if (contextNodes.length === 0 && axis === "descendant") {
    // `//` from root — all nodes in workspace
    return Array.from(index.nodesByPath.values());
  }
  if (axis === "descendant") {
    // `/parent//` — all descendants of context nodes
    return collectDescendants(contextNodes, index.nodesByPath);
  }
  // `/parent/` — direct children of context nodes
  const result: IndexedNode[] = [];
  for (const parent of contextNodes) {
    for (const childPath of parent.childPaths) {
      const child = index.nodesByPath.get(childPath);
      if (child) result.push(child);
    }
  }
  return result;
}

/**
 * Parse the typed ref prefix to find the "resolved" parent nodes and whether
 * the trailing context is `/` (direct children) or `//` (descendants).
 *
 * Returns the set of context nodes to suggest children/descendants of,
 * the axis type, and the partial kind text typed after the last `/`.
 */
function resolveRefContext(
  typed: string,
  index: WorkspaceIndex
): { contextNodes: IndexedNode[]; axis: "child" | "descendant"; partialKind: string } | null {
  // Determine if trailing with `//` or `/`
  let axis: "child" | "descendant" = "child";
  let pathPart = typed;

  if (pathPart === "/") {
    return { contextNodes: [], axis: "child", partialKind: "" };
  }
  if (pathPart === "//") {
    return { contextNodes: [], axis: "descendant", partialKind: "" };
  }

  // Split into completed steps and a partial trailing segment
  // e.g. "/org/service[name="auth"]/" → steps=["/org", "/service[name=\"auth\"]"], partial=""
  // e.g. "/org/se" → steps=["/org"], partial="se"
  // e.g. "/org//" → steps=["/org"], axis=descendant, partial=""

  // Check for trailing //
  if (pathPart.endsWith("//")) {
    axis = "descendant";
    pathPart = pathPart.slice(0, -2);
  } else if (pathPart.endsWith("/")) {
    axis = "child";
    pathPart = pathPart.slice(0, -1);
  } else {
    // Partial kind name typed (no trailing delimiter yet) -- split off the
    // partial identifier, then check whether it was preceded by `//`
    // (descendant) or a single `/` (child). Must check `//` first: a naive
    // `lastIndexOf("/")` finds the second slash of a `//` pair and would
    // wrongly treat it as a single-slash (child) delimiter, losing the
    // descendant axis entirely -- e.g. "//node" would incorrectly resolve
    // as root-only children instead of a workspace-wide descendant search.
    const partialMatch = pathPart.match(/([-_=<>A-Za-z0-9]*)$/);
    const partial = partialMatch ? partialMatch[1] : "";
    const beforePartial = pathPart.slice(0, pathPart.length - partial.length);

    if (beforePartial.endsWith("//")) {
      const prior = beforePartial.slice(0, -2);
      if (prior === "") {
        return { contextNodes: [], axis: "descendant", partialKind: partial };
      }
      const contextNodes = resolvePathToNodes(prior.startsWith("/") ? prior : "/" + prior, index);
      return { contextNodes, axis: "descendant", partialKind: partial };
    }
    if (beforePartial.endsWith("/")) {
      const prior = beforePartial.slice(0, -1);
      if (prior === "" || prior === "/") {
        return { contextNodes: [], axis: "child", partialKind: partial };
      }
      const contextNodes = resolvePathToNodes(prior.startsWith("/") ? prior : "/" + prior, index);
      return { contextNodes, axis: "child", partialKind: partial };
    }
    return null;
  }

  if (!pathPart || pathPart === "") {
    return { contextNodes: [], axis, partialKind: "" };
  }

  const contextNodes = resolvePathToNodes(pathPart.startsWith("/") ? pathPart : "/" + pathPart, index);
  return { contextNodes, axis, partialKind: "" };
}

/**
 * Resolve a ref path string to matching IndexedNodes by walking the tree
 * step by step. Supports predicates like [attr="val"] and [N].
 */
function resolvePathToNodes(path: string, index: WorkspaceIndex): IndexedNode[] {
  let remaining = path;
  if (remaining.startsWith("/")) remaining = remaining.slice(1);

  // Split into segments respecting brackets
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of remaining) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "/" && depth === 0) {
      if (current) segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) segments.push(current);

  let currentSet: IndexedNode[] = [...index.rootNodes];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const match = seg.match(/^([A-Za-z0-9_><=-]+|\*)(?:\[([A-Za-z0-9_-]+)="([^"]*)"\]|\[(\d+)\])?$/);
    if (!match) return [];

    const kindName = match[1];
    const predAttr = match[2];
    const predVal = match[3];
    const posIdx = match[4] !== undefined ? parseInt(match[4], 10) : undefined;

    let candidates: IndexedNode[];
    if (i === 0) {
      // Filter roots
      candidates = currentSet.filter((n) => kindName === "*" || n.kind === kindName);
    } else {
      // Filter children of current set
      candidates = [];
      for (const parent of currentSet) {
        for (const childPath of parent.childPaths) {
          const child = index.nodesByPath.get(childPath);
          if (child && (kindName === "*" || child.kind === kindName)) {
            candidates.push(child);
          }
        }
      }
    }

    // Apply predicate
    if (predAttr !== undefined) {
      candidates = candidates.filter((n) => {
        const attr = n.attrs[predAttr];
        return attr && String(attr.value) === predVal;
      });
    } else if (posIdx !== undefined) {
      candidates = posIdx < candidates.length ? [candidates[posIdx]] : [];
    }

    currentSet = candidates;
    if (currentSet.length === 0) return [];
  }

  return currentSet;
}

