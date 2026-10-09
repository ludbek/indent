import { dirname, resolve, isAbsolute, basename } from "path";
import { existsSync, readFileSync } from "fs";
import { URI } from "vscode-uri";
import type { Range } from "vscode-languageserver";
import { CstParser } from "./cst.js";
import { parseXPath, selectNodes } from "indent-lang/xpath";
import { buildXPathForest } from "./xpathTree.js";
import {
  discoverProjects,
  findProjectForFile as findProjectForFileImpl,
  type DiscoveredProject,
} from "./project.js";
import type {
  AstDocument,
  AstStatement,
  IndexedNode,
  RefReference,
} from "./types.js";

export function uriToFsPath(uri: string): string {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return uri.startsWith("file://") ? uri.slice(7) : uri;
  }
}

export function fsPathToUri(fsPath: string): string {
  return URI.file(resolve(fsPath)).toString();
}

export interface IncludeLink {
  sourceUri: string;
  rawPath: string;
  resolvedFsPath: string;
  resolvedUri?: string;
  range: Range;
  exists: boolean;
  isCircular?: boolean;
}

export class WorkspaceIndex {
  public parser!: CstParser;
  public documents = new Map<string, AstDocument>();
  public nodesByPath = new Map<string, IndexedNode>();
  public nodesById = new Map<string, IndexedNode>();
  public rootNodes: IndexedNode[] = [];
  public refReferences: RefReference[] = [];
  public inboundReferences = new Map<string, RefReference[]>();
  public includeLinks: IncludeLink[] = [];
  public workspaceRoots: string[] = [];
  public projects: DiscoveredProject[] = [];
  /** Absolute fs paths reachable (via `!include`) from any discovered project.inml's entry. */
  public reachableFiles: Set<string> = new Set();
  /**
   * URIs of documents loaded from disk by `preloadProjectFiles` rather than
   * opened/edited in the editor. Tracked separately so a later
   * `preloadProjectFiles` call can safely evict them if the file falls out
   * of `reachableFiles` (e.g. its `!include` was removed), without ever
   * evicting a document the user genuinely has open.
   */
  public preloadedUris: Set<string> = new Set();

  private constructor() {}

  static async create(): Promise<WorkspaceIndex> {
    const index = new WorkspaceIndex();
    index.parser = await CstParser.create();
    return index;
  }

  /**
   * Scans `roots` for `project.inml` manifests and resolves each one's
   * include graph, populating `projects`/`reachableFiles`. Call once at
   * server init (with the LSP workspace folders) and again whenever a
   * `project.inml` file changes, since reachability affects every other
   * document's orphan-file diagnostic.
   */
  public refreshProjects(roots: string[] = this.workspaceRoots) {
    this.workspaceRoots = roots;
    const { projects, reachableFiles } = discoverProjects(roots);
    this.projects = projects;
    this.reachableFiles = reachableFiles;
  }

  /**
   * Resolves which discovered project (if any) governs `fsPath`, via
   * nearest-ancestor `project.inml` lookup (not the global `reachableFiles`
   * union) -- see `findProjectForFile` in `project.ts` for the rationale.
   * Returns `undefined` if no project.inml governs this file.
   */
  public findProjectForFile(fsPath: string): DiscoveredProject | undefined {
    return findProjectForFileImpl(fsPath, this.projects, this.workspaceRoots);
  }

  /**
   * Reads and indexes every file in `reachableFiles` that isn't already in
   * `documents`, so xpath/ref resolution (`rebuildIndex`'s ref-forest) sees
   * a project's *entire* include graph, not just whichever files happen to
   * be open in the editor. Without this, a ref in an open file pointing at
   * a node defined in a never-opened (but genuinely included) file would
   * falsely resolve to zero targets, since that file's nodes never made it
   * into `rootNodes`/the xpath forest.
   *
   * Files already open (or previously edited) are left untouched -- only
   * gaps in `documents` get filled from disk. Previously preloaded files
   * that have since fallen out of `reachableFiles` (e.g. an `!include` was
   * removed) are evicted, since stale nodes there could cause a since-
   * removed reference to spuriously keep resolving. Call after
   * `refreshProjects` whenever the project graph may have changed.
   */
  public preloadProjectFiles() {
    let changed = false;

    for (const fsPath of this.reachableFiles) {
      const uri = fsPathToUri(fsPath);
      if (this.documents.has(uri)) continue;
      try {
        const text = readFileSync(fsPath, "utf8");
        const { doc } = this.parser.parse(uri, text, 0);
        this.documents.set(uri, doc);
        this.preloadedUris.add(uri);
        changed = true;
      } catch {
        // File may have been deleted/unreadable between discovery and
        // read -- skip it; it simply won't be indexed this pass.
      }
    }

    for (const uri of [...this.preloadedUris]) {
      if (!this.reachableFiles.has(uriToFsPath(uri))) {
        this.documents.delete(uri);
        this.preloadedUris.delete(uri);
        changed = true;
      }
    }

    if (changed) this.rebuildIndex();
  }

  public setDocument(uri: string, text: string, version: number = 1): AstDocument {
    const { doc } = this.parser.parse(uri, text, version);
    this.documents.set(uri, doc);
    // The editor now genuinely has this document open/edited -- it's no
    // longer merely a disk-preloaded stand-in, so `preloadProjectFiles`
    // must never evict it just because it fell out of `reachableFiles`.
    this.preloadedUris.delete(uri);
    this.rebuildIndex();
    return doc;
  }

  public removeDocument(uri: string) {
    this.documents.delete(uri);
    this.rebuildIndex();
  }

  public getDocument(uri: string): AstDocument | undefined {
    return this.documents.get(uri);
  }

  public getStatementAtPosition(
    uri: string,
    position: { line: number; character: number }
  ): AstStatement | undefined {
    const doc = this.documents.get(uri);
    if (!doc) return undefined;

    const contains = (stmt: AstStatement): boolean => {
      if (
        position.line < stmt.range.start.line ||
        position.line > stmt.range.end.line
      ) {
        return false;
      }
      if (
        position.line === stmt.range.start.line &&
        position.character < stmt.range.start.character
      ) {
        return false;
      }
      if (
        position.line === stmt.range.end.line &&
        position.character > stmt.range.end.character
      ) {
        return false;
      }
      return true;
    };

    // Find deepest statement matching position
    let candidate: AstStatement | undefined;
    for (const stmt of doc.allStatements) {
      if (contains(stmt)) {
        if (!candidate || stmt.depth >= candidate.depth) {
          candidate = stmt;
        }
      }
    }
    return candidate;
  }

  public getNodeByPath(path: string): IndexedNode | undefined {
    const norm = path.startsWith("/") ? path : "/" + path;
    const direct = this.nodesByPath.get(norm);
    if (direct) return direct;

    // Case-insensitive lookup
    for (const [p, node] of this.nodesByPath.entries()) {
      if (p.toLowerCase() === norm.toLowerCase()) {
        return node;
      }
    }
    return undefined;
  }

  private _registerNode(
    stmt: AstStatement,
    uri: string,
    canonicalPath: string,
    kind: string,
    parentPath?: string,
  ): IndexedNode {
    // Sibling disambiguation (`_disambiguateSiblings` / the bare-kind case in
    // `buildChildren`) only ever looks at siblings within the SAME document,
    // since `rebuildIndex` builds each doc's tree independently. Two separate
    // files that happen to share the same shape at some scope (e.g. each has
    // exactly one top-level `service` and one `layout-row`, so both compute
    // the bare path `/service/layout-row`) would otherwise collide in the
    // single workspace-wide `nodesByPath` map: the later document silently
    // overwrites the earlier one's entry, so any `childPaths` lookup that
    // resolves through `nodesByPath` (see `xpathTree.ts`) can end up walking
    // into the wrong file's subtree, breaking `//kind[.="value"]` lookups for
    // perfectly valid same-file references. Detect that cross-document
    // collision here and disambiguate by source file, keeping canonical
    // paths unique workspace-wide without touching the common,
    // non-colliding case.
    let finalPath = canonicalPath;
    const existing = this.nodesByPath.get(finalPath);
    if (existing && existing.uri !== uri) {
      const fileTag = basename(uriToFsPath(uri));
      finalPath = `${canonicalPath}{file="${fileTag}"}`;
      const stillColliding = this.nodesByPath.get(finalPath);
      if (stillColliding && stillColliding.uri !== uri) {
        // Extremely rare: even the file-tagged path collides (e.g. two
        // documents sharing the same basename). Fall back to the statement
        // id, which is always unique, to guarantee no silent overwrite.
        finalPath = `${canonicalPath}{file="${fileTag}",id="${stmt.id}"}`;
      }
    }

    const label =
      stmt.value !== undefined
        ? String(stmt.value.value)
        : stmt.attrs.name?.value !== undefined
          ? String(stmt.attrs.name.value)
          : kind;
    const indexed: IndexedNode = {
      id: stmt.id,
      uri,
      canonicalPath: finalPath,
      label,
      kind,
      value: stmt.value,
      attrs: stmt.attrs,
      parentPath,
      childPaths: [],
      statement: stmt,
    };
    this.nodesByPath.set(finalPath, indexed);
    this.nodesById.set(stmt.id, indexed);
    // Wire up parent's childPaths
    if (parentPath) {
      const parent = this.nodesByPath.get(parentPath);
      if (parent) parent.childPaths.push(finalPath);
    }
    return indexed;
  }

  /** Find the shortest attribute predicate that uniquely identifies each sibling */
  private _disambiguateSiblings(
    siblings: AstStatement[],
    kind: string,
    parentPath?: string,
  ): string[] {
    // Collect all attribute names used across these siblings
    const allAttrNames = new Set<string>();
    for (const s of siblings) {
      for (const an of Object.keys(s.attrs)) allAttrNames.add(an);
    }

    // Try each attribute — first one that makes all values unique wins
    for (const attrName of allAttrNames) {
      const values = siblings.map((s) => s.attrs[attrName]?.value);
      const defined = values.filter((v) => v !== undefined);
      const unique = new Set(defined.map((v) => String(v)));
      if (defined.length === siblings.length && unique.size === siblings.length) {
        // This attribute disambiguates all siblings
        return siblings.map((s) => {
          const val = String(s.attrs[attrName]!.value);
          const segment = `${kind}[${attrName}="${val}"]`;
          return parentPath ? `${parentPath}/${segment}` : `/${segment}`;
        });
      }
    }

    // Fallback: positional index
    return siblings.map((s, i) => {
      const segment = `${kind}[${i}]`;
      return parentPath ? `${parentPath}/${segment}` : `/${segment}`;
    });
  }

  public rebuildIndex() {
    this.nodesByPath.clear();
    this.nodesById.clear();
    this.rootNodes = [];
    this.refReferences = [];
    this.inboundReferences.clear();
    this.includeLinks = [];

    // 1. Build include links and check for existence / cycles
    for (const doc of this.documents.values()) {
      const docFsPath = uriToFsPath(doc.uri);
      const docDir = dirname(docFsPath);

      for (const stmt of doc.allStatements) {
        if (stmt.isInclude && stmt.includePath) {
          const raw = stmt.includePath;
          const targetFsPath = resolve(docDir, raw);
          const exists = existsSync(targetFsPath);
          const resolvedUri = fsPathToUri(targetFsPath);

          this.includeLinks.push({
            sourceUri: doc.uri,
            rawPath: raw,
            resolvedFsPath: targetFsPath,
            resolvedUri,
            range: stmt.kindRange,
            exists,
          });
        }
      }
    }

    // 2. Build indexed nodes across all documents.
    // Canonical paths use the statement's `kind` (tag name), not any attribute.
    // When multiple siblings share the same kind under one parent, disambiguate
    // with the first attribute that yields uniqueness, e.g. /org[name="Acme"],
    // falling back to positional index e.g. /org[0] when no attribute suffices.
    for (const doc of this.documents.values()) {
      const buildChildren = (stmts: AstStatement[], parentPath?: string) => {
        // Group siblings by kind to detect collisions
        const kindGroups = new Map<string, AstStatement[]>();
        for (const s of stmts) {
          if (s.isInclude) continue;
          const arr = kindGroups.get(s.kind) ?? [];
          arr.push(s);
          kindGroups.set(s.kind, arr);
        }

        for (const [kind, siblings] of kindGroups.entries()) {
          if (siblings.length === 1) {
            // Unique kind under this parent — bare kind is sufficient
            const stmt = siblings[0];
            const segment = kind;
            const currentPath = parentPath ? `${parentPath}/${segment}` : `/${segment}`;
            const node = this._registerNode(stmt, doc.uri, currentPath, kind, parentPath);
            buildChildren(stmt.children, node.canonicalPath);
          } else {
            // Multiple siblings share the same kind — find a disambiguating attribute
            const disambiguatedPaths = this._disambiguateSiblings(siblings, kind, parentPath);
            for (let i = 0; i < siblings.length; i++) {
              const stmt = siblings[i];
              const currentPath = disambiguatedPaths[i];
              const node = this._registerNode(stmt, doc.uri, currentPath, kind, parentPath);
              buildChildren(stmt.children, node.canonicalPath);
            }
          }
        }
      };

      buildChildren(doc.roots, undefined);
      // Also track root nodes
      for (const rootStmt of doc.roots) {
        if (!rootStmt.isInclude) {
          const rootNode = this.nodesById.get(rootStmt.id);
          if (rootNode) this.rootNodes.push(rootNode);
        }
      }
    }

    // 3. Resolve refs (both attribute values and a node's own positional value)
    const refForest = buildXPathForest(this.rootNodes, this.nodesByPath);

    // The CST classifies any non-number/boolean unquoted value as "ref"
    // type, including incomplete text a user is still typing (e.g. "/org/"
    // or "//"). indent-lang's xpath module's parseXPath is strict and throws on such
    // incomplete/invalid input -- treat that as simply "unresolved" (empty
    // target list) rather than crashing the whole index rebuild, so live
    // editing stays resilient.
    const resolveRefTargets = (raw: string): string[] => {
      try {
        const parsed = parseXPath(raw);
        const targets = selectNodes(refForest, parsed);
        return targets.map((t) => t.indexedNode.canonicalPath);
      } catch {
        return [];
      }
    };

    for (const doc of this.documents.values()) {
      for (const stmt of doc.allStatements) {
        const sourceNode = this.nodesById.get(stmt.id);
        const sourcePath = sourceNode?.canonicalPath ?? "";

        // 3a. A node's own positional value, when it's a ref (e.g. `alias /org/service`).
        if (stmt.value && stmt.value.valueType === "ref") {
          const raw = String(stmt.value.value);
          const targetPaths = resolveRefTargets(raw);

          const ref: RefReference = {
            uri: doc.uri,
            sourceNodeId: stmt.id,
            sourceNodePath: sourcePath,
            rawRef: raw,
            range: stmt.value.range,
            resolvedTargetPaths: targetPaths,
          };

          this.refReferences.push(ref);

          for (const targetPath of targetPaths) {
            const list = this.inboundReferences.get(targetPath) || [];
            list.push(ref);
            this.inboundReferences.set(targetPath, list);
          }
        }

        // 3b. Attribute values, when explicitly typed as a ref.
        for (const [attrName, attr] of Object.entries(stmt.attrs)) {
          // Only unquoted values are typed as ref by the parser/grammar.
          // Quoted string attributes are always plain strings, regardless
          // of their contents (e.g. a quoted "/foo/bar" is not a reference).
          const isExplicitRef = attr.valueType === "ref";

          if (isExplicitRef) {
            const raw = String(attr.value);
            const targetPaths = resolveRefTargets(raw);

            const ref: RefReference = {
              uri: doc.uri,
              sourceNodeId: stmt.id,
              sourceNodePath: sourcePath,
              attrName,
              rawRef: raw,
              range: attr.valueRange,
              resolvedTargetPaths: targetPaths,
            };

            this.refReferences.push(ref);

            for (const targetPath of targetPaths) {
              const list = this.inboundReferences.get(targetPath) || [];
              list.push(ref);
              this.inboundReferences.set(targetPath, list);
            }
          }
        }
      }
    }
  }
}
