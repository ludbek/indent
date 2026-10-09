import { describe, it, expect, beforeAll } from "vitest";
import { WorkspaceIndex } from "../src/indexer.js";
import { computeDiagnostics } from "../src/diagnostics.js";
import { computeCompletions as computeCompletionsRaw } from "../src/completions.js";
import type { CompletionItem, CompletionList } from "vscode-languageserver";
import {
  getDefinition,
  getHover,
  getDocumentSymbols,
  getReferences,
} from "../src/navigation.js";
import { formatDocument, formatOnType } from "../src/formatting.js";
import { prepareRename, renameSymbol } from "../src/rename.js";
import { Location, MarkupContent } from "vscode-languageserver";
import { fsPathToUri } from "../src/indexer.js";
import { resolve as resolvePath } from "path";

describe("LSP Features Suite", () => {
  // Ref-value completion stages return a CompletionList ({isIncomplete, items})
  // to force the client to re-query on every keystroke rather than caching and
  // fuzzy-filtering stale results; other stages still return a plain array.
  // Tests only care about the items, so unwrap both shapes uniformly.
  const computeCompletions = (
    ...args: Parameters<typeof computeCompletionsRaw>
  ): CompletionItem[] => {
    const result = computeCompletionsRaw(...args);
    return Array.isArray(result) ? result : (result as CompletionList).items;
  };

  const uri = "file:///workspace/sample.inml";
  // Two `service` siblings under `org` → disambiguated by first unique attr.
  // `API`, `table`, `=>` are unique under their parents → bare kind suffices.
  const source = `org name="Acme" color="green"
    service name="auth"
        API name="Login" method="POST"
            => entity=/org/service[name="db"]/table
    service name="db"
        table name="users" pk="id"
`;

  let index: WorkspaceIndex;

  beforeAll(async () => {
    index = await WorkspaceIndex.create();
    index.setDocument(uri, source);
  });

  it("Diagnostics: returns clean diagnostics on valid document", () => {
    const diags = computeDiagnostics(uri, index);
    expect(diags).toEqual([]);
  });

  it("Diagnostics: detects unresolved entity reference", () => {
    const badUri = "file:///workspace/bad.inml";
    index.setDocument(
      badUri,
      `org name="BadOrg"
    service name="api"
        -> entity=/NonExistent/Target
`
    );
    const diags = computeDiagnostics(badUri, index);
    expect(diags.some((d) => d.message.includes("Unresolved reference"))).toBe(true);
    index.removeDocument(badUri);
  });

  it("Diagnostics: does NOT flag quoted path-shaped string attributes as references", () => {
    const quotedUri = "file:///workspace/quoted.inml";
    index.setDocument(
      quotedUri,
      `org name="QuotedOrg"
    service name="api"
        API name="Health" basepath="/harmony/rest/au/address" method="GET"
            -> entity="/Org/Some Target"
`
    );
    const diags = computeDiagnostics(quotedUri, index);
    expect(diags.some((d) => d.message.includes("Unresolved reference"))).toBe(false);
    expect(index.refReferences.some((r) => r.uri === quotedUri)).toBe(false);
    index.removeDocument(quotedUri);
  });

  it("Completions: suggests root nodes when `/` is typed", () => {
    // Line 3: `            => entity=/org/service[name="db"]/table`
    // Character 22 is `=`, 23 is `/` → ref trigger starts at `/`
    const items = computeCompletions(uri, { line: 3, character: 23 }, index);
    // At `/` position, should suggest root-level nodes (org)
    expect(items.some((i) => i.label === "org")).toBe(true);
  });

  it("Completions: `/node/` (nested parent context) collapses to distinct kinds, same as `/` and `//`", () => {
    // Simulate typing `entity=/org/` — cursor after the trailing `/`.
    // Two `service` siblings exist under `org`, but the suggestion list must
    // collapse them to a single bare `service` entry -- never per-instance
    // `service[.="auth"]` / `service[.="db"]` segments. Uniform with root
    // `/` and `//` behavior; the user narrows further with `[...]` if needed.
    const deepUri = "file:///workspace/deep.inml";
    const deepSource = `org name="Acme"
    service name="auth"
    service name="db"
        table name="users"
        => entity=/org/
`;
    index.setDocument(deepUri, deepSource);
    // line 4: `        => entity=/org/`, cursor at end (char 24)
    const items = computeCompletions(deepUri, { line: 4, character: 24 }, index);
    const serviceItems = items.filter((i) => i.label === "service");
    expect(serviceItems).toHaveLength(1);
    expect(items.some((i) => /\[/.test(i.label))).toBe(false);
    index.removeDocument(deepUri);
  });

  it("Completions: does NOT trigger path suggestions on bare `attr=` with no ref character typed", () => {
    const items = computeCompletions(uri, { line: 3, character: 22 }, index);
    expect(items.some((i) => i.label.startsWith("/"))).toBe(false);
  });

  it("Completions: suggests repeated positional (node) values, filtered by quoted prefix", () => {
    const posValUri = "file:///workspace/posval.inml";
    const posValSource = `status "active"\nstatus "inactive"\nstatus "active"\nstatus "ac`;
    index.setDocument(posValUri, posValSource);
    // Last line: `status "ac` -- quoted value in progress.
    const items = computeCompletions(
      posValUri,
      { line: 3, character: "status \"ac".length },
      index
    );
    expect(items.some((i) => i.label === '"active"')).toBe(true);
    expect(items.some((i) => i.label === '"inactive"')).toBe(false);
    index.removeDocument(posValUri);
  });

  it("Completions: merges positional-value and attribute-name suggestions on a bare first token", () => {
    const mergeUri = "file:///workspace/merge.inml";
    // "Alpha" repeats (count 2, clears the MIN_VALUE_OCCURRENCES floor);
    // "Beta" appears once (count 1, filtered out as noise).
    const mergeSource = `widget "Alpha" color="red"\nwidget "Alpha" color="red"\nwidget "Beta" color="blue"\nwidget `;
    index.setDocument(mergeUri, mergeSource);
    // Last line: `widget ` -- nothing typed yet after the kind.
    const items = computeCompletions(mergeUri, { line: 3, character: "widget ".length }, index);
    expect(items.some((i) => i.label === '"Alpha"')).toBe(true);
    expect(items.some((i) => i.label === '"Beta"')).toBe(false);
    expect(items.some((i) => i.label === "color")).toBe(true);
    index.removeDocument(mergeUri);
  });

  it("Completions: suggests attribute values sorted by frequency, filtered by quoted prefix", () => {
    const attrValUri = "file:///workspace/attrval.inml";
    // POST occurs 3x, GET occurs 2x -- both clear the MIN_VALUE_OCCURRENCES
    // floor, with POST ranked first by frequency.
    const line0 = `API "A" method="GET"`;
    const line1 = `API "B" method="POST"`;
    const line2 = `API "C" method="POST"`;
    const line3 = `API "F" method="POST"`;
    const line4 = `API "G" method="GET"`;
    const line5 = `API "D" method=`;
    const line6 = `API "E" method="P`;
    const attrValSource = `${line0}\n${line1}\n${line2}\n${line3}\n${line4}\n${line5}\n${line6}`;
    index.setDocument(attrValUri, attrValSource);

    // Bare `method=`, nothing typed -- both values shown, most frequent first.
    const bareItems = computeCompletions(attrValUri, { line: 5, character: line5.length }, index);
    expect(bareItems[0]?.label).toBe('"POST"');
    expect(bareItems.some((i) => i.label === '"GET"')).toBe(true);

    // Quoted `method="P` -- only POST matches the typed prefix.
    const quotedItems = computeCompletions(
      attrValUri,
      { line: 6, character: line6.length },
      index
    );
    expect(quotedItems).toHaveLength(1);
    expect(quotedItems[0]?.label).toBe('"POST"');

    index.removeDocument(attrValUri);
  });

  it("Completions: suggests boolean attribute values, filtered by bare (unquoted) prefix", () => {
    const boolUri = "file:///workspace/boolval.inml";
    // Both true and false occur 2x -- both clear the MIN_VALUE_OCCURRENCES
    // floor; true is ranked first (first inserted, tied count).
    const line0 = `database "d1" active=true`;
    const line1 = `database "d2" active=false`;
    const line2 = `database "d3" active=true`;
    const line3 = `database "d4" active=false`;
    const line4 = `database "d5" active=`;
    const line5 = `database "d6" active=tr`;
    const boolSource = `${line0}\n${line1}\n${line2}\n${line3}\n${line4}\n${line5}`;
    index.setDocument(boolUri, boolSource);

    const bareItems = computeCompletions(boolUri, { line: 4, character: line4.length }, index);
    expect(bareItems.some((i) => i.label === "true")).toBe(true);
    expect(bareItems.some((i) => i.label === "false")).toBe(true);
    expect(bareItems[0]?.label).toBe("true"); // first-inserted, tied frequency (2 vs 2)

    const partialItems = computeCompletions(boolUri, { line: 5, character: line5.length }, index);
    expect(partialItems).toHaveLength(1);
    expect(partialItems[0]?.label).toBe("true");

    index.removeDocument(boolUri);
  });

  it("Completions: excludes single-use values (MIN_VALUE_OCCURRENCES floor)", () => {
    const floorUri = "file:///workspace/floor.inml";
    // `env="staging"` occurs only once -- must be filtered out as noise.
    // `env="prod"` occurs twice -- must survive the floor.
    const line0 = `API "A" env="staging"`;
    const line1 = `API "B" env="prod"`;
    const line2 = `API "C" env="prod"`;
    const line3 = `API "D" env=`;
    const floorSource = `${line0}\n${line1}\n${line2}\n${line3}`;
    index.setDocument(floorUri, floorSource);
    const items = computeCompletions(floorUri, { line: 3, character: line3.length }, index);
    expect(items.some((i) => i.label === '"prod"')).toBe(true);
    expect(items.some((i) => i.label === '"staging"')).toBe(false);
    index.removeDocument(floorUri);
  });

  it("Completions: does NOT leak attribute values across kinds (no cross-kind fallback)", () => {
    const crossKindUri = "file:///workspace/crosskind.inml";
    // `name="Widget"` used twice under `widget`, never under `gadget`.
    // Completing `gadget name=` must NOT suggest "Widget" from the other kind.
    const line0 = `widget "w1" name="Widget"`;
    const line1 = `widget "w2" name="Widget"`;
    const line2 = `gadget "g1" name=`;
    const crossKindSource = `${line0}\n${line1}\n${line2}`;
    index.setDocument(crossKindUri, crossKindSource);
    const items = computeCompletions(
      crossKindUri,
      { line: 2, character: line2.length },
      index
    );
    expect(items.some((i) => i.label === '"Widget"')).toBe(false);
    index.removeDocument(crossKindUri);
  });

  it("Completions: suggests ref paths for a positional (node-value) ref, same as attribute ref values", () => {
    const posRefCompUri = "file:///workspace/posrefcomp.inml";
    const posRefCompSource = `org name="Acme"
    service name="auth"
        database name="primary"
alias /`;
    index.setDocument(posRefCompUri, posRefCompSource);
    // Last line: `alias /` -- positional ref value, root-level trigger.
    const items = computeCompletions(
      posRefCompUri,
      { line: 3, character: "alias /".length },
      index
    );
    // Use startsWith (not exact "org") since the shared suite fixture also
    // has a root `org name="Acme"`, so disambiguation may qualify the label.
    expect(items.some((i) => i.label.startsWith("org"))).toBe(true);
    index.removeDocument(posRefCompUri);
  });

  it("Completions: suggests ref paths for an edge-kind (`->`/`=>`) positional ref", () => {
    const edgeRefUri = "file:///workspace/edgeref.inml";
    const edgeRefSource = `org name="Acme"
    service name="auth"
        database name="primary"
-> /`;
    index.setDocument(edgeRefUri, edgeRefSource);
    // Last line: `-> /` -- edge kind `->` carrying a positional ref value.
    // Regression: edge kinds start with `-`/`=`, which the old kind regex
    // (`[A-Za-z_]...`) rejected, so completion never fired for `-> /`.
    const items = computeCompletions(
      edgeRefUri,
      { line: 3, character: "-> /".length },
      index
    );
    expect(items.some((i) => i.label.startsWith("org"))).toBe(true);
    index.removeDocument(edgeRefUri);
  });

  it("Completions: `//` shows unique kinds across workspace", () => {
    const dsUri = "file:///workspace/ds.inml";
    const dsSource = `org name="X"
    service name="a"
        API name="foo"
    => entity=//
`;
    index.setDocument(dsUri, dsSource);
    // line 3: `    => entity=//`, cursor at end (char 16)
    const items = computeCompletions(dsUri, { line: 3, character: 16 }, index);
    // Should show unique kinds: org, service, API, =>, table (from main fixture)
    expect(items.some((i) => i.label.startsWith("org"))).toBe(true);
    expect(items.some((i) => i.label.startsWith("service"))).toBe(true);
    expect(items.some((i) => i.label.startsWith("API"))).toBe(true);
    index.removeDocument(dsUri);
  });

  it("Completions: `//` lists distinct kind names with no positional index (`API`, not `API[0]`)", () => {
    // Multiple API nodes that share a kind and have no disambiguating
    // attribute (they differ only by positional value). The `//` descendant
    // list must collapse them to a single bare `API` entry -- never `API[0]`.
    const noIdxUri = "file:///workspace/noidx.inml";
    const noIdxSource = `org name="Acme"
    service name="svc"
        API "Save Tfn" type="REST"
        API "Save Address" type="REST"
        => entity=//AP`;
    index.setDocument(noIdxUri, noIdxSource);
    const items = computeCompletions(
      noIdxUri,
      { line: 4, character: "        => entity=//AP".length },
      index
    );
    const apiItems = items.filter((i) => i.label.startsWith("API"));
    expect(apiItems.length).toBe(1);
    expect(apiItems[0].label).toBe("API");
    expect(items.some((i) => /\[\d+\]/.test(i.label))).toBe(false);
    index.removeDocument(noIdxUri);
  });

  it("Completions: `/partial` (child axis) collapses to distinct kinds, no attribute qualifier", () => {
    // Multiple root `org` nodes that differ only by an attribute. Typing a
    // partial node name after a single `/` must collapse to one bare `org`
    // entry -- never per-instance `org[background-color="..."]` segments.
    const childPartialUri = "file:///workspace/childpartial.inml";
    const childPartialSource = `org name="A" background-color="blue"
org name="B" background-color="gray"
org name="C" background-color="green"
=> entity=/or`;
    index.setDocument(childPartialUri, childPartialSource);
    const items = computeCompletions(
      childPartialUri,
      { line: 3, character: "=> entity=/or".length },
      index
    );
    const orgItems = items.filter((i) => i.label.startsWith("org"));
    expect(orgItems.length).toBe(1);
    expect(orgItems[0].label).toBe("org");
    expect(items.some((i) => /\[/.test(i.label))).toBe(false);
    index.removeDocument(childPartialUri);
  });

  it("Completions: bare `/` (root, no partial) collapses to distinct kinds, no attribute qualifier", () => {
    // Regression: multiple root `org` nodes differing only by an attribute
    // must collapse to a single bare `org` entry when just `/` is typed --
    // never per-instance `org[background-color="..."]` segments.
    const bareRootUri = "file:///workspace/bareroot.inml";
    const bareRootSource = `org name="A" background-color="blue"
org name="B" background-color="gray"
org name="C" background-color="green"
=> entity=/`;
    index.setDocument(bareRootUri, bareRootSource);
    const items = computeCompletions(
      bareRootUri,
      { line: 3, character: "=> entity=/".length },
      index
    );
    const orgItems = items.filter((i) => i.label.startsWith("org"));
    expect(orgItems.length).toBe(1);
    expect(orgItems[0].label).toBe("org");
    expect(items.some((i) => /\[/.test(i.label))).toBe(false);
    index.removeDocument(bareRootUri);
  });

  it("Completions: `/node/subnode/` (two levels deep) collapses to distinct kinds, same as `/node/`", () => {
    // Regression: the collapse-to-kinds rule must hold at any depth, not
    // just root (`/`, `//`) or one level in (`/org/`). Multiple `API`
    // siblings differing only by attributes, two levels under root, must
    // still collapse to a single bare `API` entry.
    const twoDeepUri = "file:///workspace/twodeep.inml";
    const twoDeepSource = `org name="Acme"
    service name="auth"
        API name="Login" method="POST"
        API name="Logout" method="POST"
=> entity=/org/service/`;
    index.setDocument(twoDeepUri, twoDeepSource);
    const items = computeCompletions(
      twoDeepUri,
      { line: 4, character: "=> entity=/org/service/".length },
      index
    );
    const apiItems = items.filter((i) => i.label === "API");
    expect(apiItems).toHaveLength(1);
    expect(items.some((i) => /\[/.test(i.label))).toBe(false);
    index.removeDocument(twoDeepUri);
  });

  it("Completions: `//partial` preserves descendant axis (regression: was searching root only)", () => {
    // `table` exists only as a nested descendant, never at root -- a plain
    // child-axis (root-only) search would never find it. Confirms the
    // partial-kind-after-`//` axis bug is fixed.
    const axisBugUri = "file:///workspace/axisbug.inml";
    const line0 = `org name="Acme"`;
    const line1 = `    service name="auth"`;
    const line2 = `        table name="users"`;
    const line3 = `    => entity=//tab`;
    const axisBugSource = `${line0}\n${line1}\n${line2}\n${line3}`;
    index.setDocument(axisBugUri, axisBugSource);
    const items = computeCompletions(axisBugUri, { line: 3, character: line3.length }, index);
    expect(items.some((i) => i.label.startsWith("table"))).toBe(true);
    index.removeDocument(axisBugUri);
  });

  it("Completions: ref-value responses are marked isIncomplete with matching filterText (regression: stale client-side fuzzy filtering)", () => {
    // Ref completions must force the client to re-query on every keystroke
    // instead of caching+fuzzy-filtering the prior list, and each item's
    // filterText must include the leading path so any filtering that the
    // client does still perform matches correctly against `/`-delimited text.
    const rawUri = "file:///workspace/rawref.inml";
    const line0 = `org name="Acme"`;
    const line1 = `    service name="auth"`;
    const line2 = `    yo=//`;
    const rawSource = `${line0}\n${line1}\n${line2}`;
    index.setDocument(rawUri, rawSource);
    const raw = computeCompletionsRaw(rawUri, { line: 2, character: line2.length }, index);
    expect(Array.isArray(raw)).toBe(false);
    const list = raw as CompletionList;
    expect(list.isIncomplete).toBe(true);
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items) {
      expect(item.filterText).toBe(item.textEdit && "newText" in item.textEdit ? item.textEdit.newText : undefined);
    }
    index.removeDocument(rawUri);
  });

  it("Completions: ref predicate `[` lists `.` and attribute names for the kind", () => {
    const predUri = "file:///workspace/pred.inml";
    const line0 = `widget "Alpha" color="red"`;
    const line1 = `widget "Alpha" color="blue"`;
    const line2 = `widget "Beta" color="blue"`;
    const line3 = `=> entity=//widget[`;
    const line4 = `=> entity=//widget[.=`;
    const line5 = `=> entity=//widget[color=`;
    const predSource = `${line0}\n${line1}\n${line2}\n${line3}\n${line4}\n${line5}`;
    index.setDocument(predUri, predSource);

    // `//widget[` -- lists "." (self-value) plus attribute names used on `widget`.
    const listItems = computeCompletions(predUri, { line: 3, character: line3.length }, index);
    expect(listItems.some((i) => i.label === ".")).toBe(true);
    expect(listItems.some((i) => i.label === "color")).toBe(true);

    // `//widget[.=` -- lists ALL distinct positional values, including
    // single-occurrence ones. Self-value predicates enumerate actual
    // reference targets by identity, so the MIN_VALUE_OCCURRENCES noise
    // floor does not apply here (unlike the attr-value case below).
    const selfItems = computeCompletions(predUri, { line: 4, character: line4.length }, index);
    expect(selfItems.some((i) => i.label === '"Alpha"')).toBe(true);
    expect(selfItems.some((i) => i.label === '"Beta"')).toBe(true);

    // `//widget[color=` -- lists repeated attribute values for that prop
    // ("blue" repeats, "red" doesn't).
    const attrItems = computeCompletions(predUri, { line: 5, character: line5.length }, index);
    expect(attrItems.some((i) => i.label === '"blue"')).toBe(true);
    expect(attrItems.some((i) => i.label === '"red"')).toBe(false);

    index.removeDocument(predUri);
  });

  it("Completions: self-value predicate `[.=` lists every distinct value regardless of occurrence count", () => {
    // Three distinct `part` names, each occurring exactly once -- none clear
    // the MIN_VALUE_OCCURRENCES floor (2). Self-value predicates enumerate
    // actual reference targets by identity, so ALL of them must still appear;
    // this is the case the shared MIN_VALUE_OCCURRENCES floor must NOT apply to.
    const selfAllUri = "file:///workspace/selfall.inml";
    const line0 = `part "Widget"`;
    const line1 = `part "Gadget"`;
    const line2 = `part "Sprocket"`;
    const line3 = `=> entity=//part[.=`;
    const selfAllSource = `${line0}\n${line1}\n${line2}\n${line3}`;
    index.setDocument(selfAllUri, selfAllSource);
    try {
      const items = computeCompletions(selfAllUri, { line: 3, character: line3.length }, index);
      expect(items.some((i) => i.label === '"Widget"')).toBe(true);
      expect(items.some((i) => i.label === '"Gadget"')).toBe(true);
      expect(items.some((i) => i.label === '"Sprocket"')).toBe(true);
    } finally {
      index.removeDocument(selfAllUri);
    }
  });

  it("Completions: self-value predicate keeps suggesting after a space is typed inside the quoted partial", () => {
    // Multi-word positional values (e.g. `"UpstreamOrg Update Member"`) are common.
    // Typing a space mid-value (`.="UpstreamOrg `) must NOT drop out of ref-value
    // completion -- the ref-value extraction regex must allow spaces while
    // inside the open quote, only treating unquoted spaces as a terminator.
    const spaceUri = "file:///workspace/spaceval.inml";
    const line0 = `part "UpstreamOrg Update Member"`;
    const line1 = `part "UpstreamOrg Search Address"`;
    const line2 = `=> entity=//part[.="UpstreamOrg `;
    const spaceSource = `${line0}\n${line1}\n${line2}`;
    index.setDocument(spaceUri, spaceSource);
    try {
      const items = computeCompletions(spaceUri, { line: 2, character: line2.length }, index);
      expect(items.some((i) => i.label === '"UpstreamOrg Update Member"')).toBe(true);
      expect(items.some((i) => i.label === '"UpstreamOrg Search Address"')).toBe(true);
    } finally {
      index.removeDocument(spaceUri);
    }
  });

  it("Completions: self-value predicate range consumes an already-present auto-closed trailing quote", () => {
    // Editors commonly auto-insert a matching closing `"` the instant the
    // user types the opening quote, so by the time a partial value is typed
    // the line already has a real trailing `"` sitting after the cursor.
    // `formatValueLiteral` returns a fully self-quoted literal (its own
    // leading + trailing quote), so without extending the replacement range
    // to also consume that pre-existing auto-closed quote, accepting a
    // suggestion leaves a duplicated trailing `"` behind instead of
    // replacing it.
    const trailUri = "file:///workspace/trailquote.inml";
    const line0 = `part "Widget"`;
    const line1 = `=> entity=//part[.="Wid"`; // cursor sits right before the pre-existing closing `"`
    const trailSource = `${line0}\n${line1}`;
    index.setDocument(trailUri, trailSource);
    try {
      const cursorChar = line1.length - 1; // right after "Wid", before the closing quote
      const items = computeCompletions(trailUri, { line: 1, character: cursorChar }, index);
      const widget = items.find((i) => i.label === '"Widget"');
      expect(widget).toBeDefined();
      const edit = widget!.textEdit as {
        range: { start: { character: number }; end: { character: number } };
        newText: string;
      };
      // The range must extend through the pre-existing trailing quote so it
      // gets replaced, not left dangling after the newly-inserted literal.
      expect(edit.range.end.character).toBe(line1.length);
      const applied =
        line1.slice(0, edit.range.start.character) + edit.newText + line1.slice(edit.range.end.character);
      expect(applied).toBe(`=> entity=//part[.="Widget"`);
    } finally {
      index.removeDocument(trailUri);
    }
  });

  it("Completions: ref predicate `[` scopes attribute names to the first resolved node, not every same-kind node in the workspace", () => {
    // `gizmo` is a kind name unused elsewhere in this suite -- picked
    // deliberately so this test isn't contaminated by the shared top-level
    // fixture's own nodes (this file reuses one `WorkspaceIndex` across all
    // tests). It appears twice with disjoint attribute sets: "Alpha"
    // (size, color) under org/auth, and unrelated "Beta" (region) under a
    // separate root service. `//gizmo[` resolves depth-first/document order
    // -- "Alpha" is first -- so only its attrs should be suggested; `region`
    // (only on "Beta") must not leak in from a workspace-wide aggregate.
    const scopedUri = "file:///workspace/scoped.inml";
    const scopedSource = `org name="ScopeOrg"
    service name="auth"
        gizmo "Alpha" size="10" color="red"
service name="scopeother"
    gizmo "Beta" region="us"
=> //gizmo[`;
    index.setDocument(scopedUri, scopedSource);
    try {
      const line5 = "=> //gizmo[";
      const items = computeCompletions(scopedUri, { line: 5, character: line5.length }, index);
      expect(items.some((i) => i.label === "size")).toBe(true);
      expect(items.some((i) => i.label === "color")).toBe(true);
      expect(items.some((i) => i.label === "region")).toBe(false);
    } finally {
      index.removeDocument(scopedUri);
    }
  });

  it("Completions: suggests keyword snippets at line start", () => {
    const items = computeCompletions(uri, { line: 0, character: 0 }, index);
    expect(items.some((i) => i.label === "org")).toBe(true);
    expect(items.some((i) => i.label === "service")).toBe(true);
    expect(items.some((i) => i.label === "API")).toBe(true);
  });

  it("Go to Definition: jumps from entity reference to target node", () => {
    const def = getDefinition(uri, { line: 3, character: 24 }, index);
    expect(def).not.toBeNull();
    const loc = def as Location;
    expect(loc.uri).toBe(uri);
    expect(loc.range.start.line).toBe(5); // line of table name="users"
  });

  it("Go to Definition: jumps from a positional (node-value) ref to target node", () => {
    const posRefUri = "file:///workspace/posref.inml";
    const posRefSource = `org name="Acme"
    service name="auth"
        database name="primary"
alias /org[name="Acme"]/service[name="auth"]/database
`;
    index.setDocument(posRefUri, posRefSource);
    // line 3: `alias /org[name="Acme"]/service[name="auth"]/database`
    // character 8 lands inside the ref text (after `alias `).
    const def = getDefinition(posRefUri, { line: 3, character: 8 }, index);
    expect(def).not.toBeNull();
    const loc = def as Location;
    expect(loc.uri).toBe(posRefUri);
    expect(loc.range.start.line).toBe(2); // line of `database name="primary"`
    index.removeDocument(posRefUri);
  });

  it("Go to Definition: jumps via a ref that targets a node by its own positional value ([.=value])", () => {
    const selfValUri = "file:///workspace/selfval.inml";
    const selfValSource = `org name="Acme"
    service name="auth"
        database "primary"
    => entity=/org/service[name="auth"]/database[.="primary"]
`;
    index.setDocument(selfValUri, selfValSource);
    // line 3: `    => entity=/org/service[name="auth"]/database[.="primary"]`
    // character 15 lands inside the ref text (right after `entity=`).
    const def = getDefinition(selfValUri, { line: 3, character: 15 }, index);
    expect(def).not.toBeNull();
    const loc = def as Location;
    expect(loc.uri).toBe(selfValUri);
    expect(loc.range.start.line).toBe(2); // line of `database "primary"`
    index.removeDocument(selfValUri);
  });

  it("Diagnostics: detects unresolved positional (node-value) ref", () => {
    const badPosRefUri = "file:///workspace/badposref.inml";
    index.setDocument(
      badPosRefUri,
      `org name="Acme"
alias /NonExistent/Target
`
    );
    const diags = computeDiagnostics(badPosRefUri, index);
    expect(diags.some((d) => d.message.includes("Unresolved reference"))).toBe(true);
    index.removeDocument(badPosRefUri);
  });

  it("Go to Definition: jumps from a bare positional descendant self-value ref (`=> //kind[.=\"value\"]`)", () => {
    const arrowUri = "file:///workspace/arrowposref.inml";
    const arrowSource = `service "svc"
    secret "SHC KMS Key" description="x"
    API "Health"
        => //secret[.="SHC KMS Key"]
`;
    index.setDocument(arrowUri, arrowSource);
    // line 3: `        => //secret[.="SHC KMS Key"]`
    // character 12 lands inside the ref text (right after `=> `).
    const def = getDefinition(arrowUri, { line: 3, character: 12 }, index);
    expect(def).not.toBeNull();
    const loc = def as Location;
    expect(loc.uri).toBe(arrowUri);
    expect(loc.range.start.line).toBe(1); // line of `secret "SHC KMS Key" ...`
    index.removeDocument(arrowUri);
  });

  it("Hover: provides markdown documentation for nodes and references", () => {
    const hoverRef = getHover(uri, { line: 3, character: 24 }, index);
    expect(hoverRef).not.toBeNull();
    const contents = hoverRef?.contents as MarkupContent;
    expect(contents.value).toContain("table");

    const hoverNode = getHover(uri, { line: 1, character: 12 }, index);
    expect(hoverNode).not.toBeNull();
    const nodeContents = hoverNode?.contents as MarkupContent;
    expect(nodeContents.value).toContain("service");
  });

  it("Document Symbols: produces hierarchical outline", () => {
    const symbols = getDocumentSymbols(uri, index);
    expect(symbols).toHaveLength(1);
    // Symbol names are now the kind (tag name), not the `name` attribute
    expect(symbols[0].name).toBe("org");
    expect(symbols[0].children).toHaveLength(2);
    expect(symbols[0].children![0].name).toBe("service");
    expect(symbols[0].children![0].children![0].name).toBe("API");
  });

  it("Find References: locates all references to a node", () => {
    const refs = getReferences(uri, { line: 5, character: 10 }, index); // on table
    expect(refs).toHaveLength(1);
    expect(refs[0].range.start.line).toBe(3); // => entity=/org/service[name="db"]/table
  });

  it("Rename Symbol: renames kind and updates inbound references", () => {
    // Cursor on `table` kind token at line 5
    const prep = prepareRename(uri, { line: 5, character: 9 }, index);
    expect(prep).not.toBeNull();
    expect(prep?.placeholder).toBe("table");

    const edit = renameSymbol(uri, { line: 5, character: 9 }, "collection", index);
    expect(edit).not.toBeNull();
    expect(edit?.changes?.[uri]).toBeDefined();
    expect(edit?.changes?.[uri]).toHaveLength(2); // kind declaration + ref reference
    expect(edit?.changes?.[uri].some((e) => e.newText.includes("collection"))).toBe(true);
  });

  it("Formatting: aligns continuation lines correctly", () => {
    const unformatted = `org name="Acme" \\
desc="Test"
`;
    const edits = formatDocument(unformatted);
    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toBe(`org name="Acme" \\\n    desc="Test"\n`);
  });

  it("On-Type Formatting: computes indent after continuation backslash", () => {
    const docText = `API name="Search" method="GET" \\\n`;
    const edits = formatOnType(docText, { line: 1, character: 0 }, "\n");
    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toBe("    ");
  });

  it("Positional Value Features: hover and symbols display positional values", () => {
    const posUri = "file:///workspace/pos.inml";
    const posSource = `org "Acme Corp"
    service "Auth Service" owner="Platform"
        database 123 active=true
`;
    index.setDocument(posUri, posSource);
    const symbols = getDocumentSymbols(posUri, index);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("org");
    expect(symbols[0].detail).toContain('"Acme Corp"');
    expect(symbols[0].children![0].name).toBe("service");
    expect(symbols[0].children![0].detail).toContain('"Auth Service"');

    const hover = getHover(posUri, { line: 1, character: 12 }, index);
    expect(hover).not.toBeNull();
    const contents = hover?.contents as MarkupContent;
    expect(contents.value).toContain("Auth Service");
    expect(contents.value).toContain("**Value:** `\"Auth Service\"`");

    const diags = computeDiagnostics(posUri, index);
    expect(diags).toEqual([]);
    index.removeDocument(posUri);
  });

  describe("Include Path Completion", () => {
    // Include paths point at real files on disk, not at parsed workspace
    // nodes, so this points the doc uri at the real indent-lang include
    // fixtures directory and reads the actual filesystem -- unlike every
    // other completion stage, which is driven purely off in-memory index
    // state under the fake `file:///workspace/...` uris used elsewhere.
    const fixturesDir = resolvePath(
      __dirname,
      "../../indent-lang/test/fixtures/includes"
    );
    const includeUri = fsPathToUri(resolvePath(fixturesDir, "completion-test.inml"));

    it("suggests sibling .inml files and subdirectories for an empty path", () => {
      const source = `!include "`;
      index.setDocument(includeUri, source);
      const items = computeCompletions(includeUri, { line: 0, character: source.length }, index);
      const labels = items.map((i) => i.label);

      expect(labels).toContain("team.inml");
      expect(labels).toContain("root.inml");
      expect(labels).toContain("nested/");
      // Non-.inml files must never be suggested as include targets.
      expect(labels.every((l) => l === "nested/" || l.endsWith(".inml"))).toBe(true);
      index.removeDocument(includeUri);
    });

    it("filters entries by the already-typed prefix", () => {
      const source = `!include "cy`;
      index.setDocument(includeUri, source);
      const items = computeCompletions(includeUri, { line: 0, character: source.length }, index);
      const labels = items.map((i) => i.label);

      expect(labels).toContain("cycle-a.inml");
      expect(labels).toContain("cycle-b.inml");
      expect(labels).not.toContain("team.inml");
      index.removeDocument(includeUri);
    });

    it("descends into a typed subdirectory and lists its contents", () => {
      const source = `!include "./nested/`;
      index.setDocument(includeUri, source);
      const items = computeCompletions(includeUri, { line: 0, character: source.length }, index);
      const labels = items.map((i) => i.label);

      expect(labels).toContain("child.inml");
      const child = items.find((i) => i.label === "child.inml")!;
      expect((child.textEdit as { newText: string }).newText).toBe("./nested/child.inml");
      index.removeDocument(includeUri);
    });

    it("returns no items once the path is already closed by a quote", () => {
      const source = `!include "./team.inml"`;
      index.setDocument(includeUri, source);
      const items = computeCompletions(includeUri, { line: 0, character: source.length }, index);
      expect(items).toEqual([]);
      index.removeDocument(includeUri);
    });
  });
});
