import { dirname, resolve, isAbsolute, basename, sep } from "path";
import { existsSync, readFileSync } from "fs";
import { URI } from "vscode-uri";
import type { Range } from "vscode-languageserver";
import { CstParser } from "./cst.js";
import { parseXPath, selectNodes } from "indent-lang/xpath";
import { buildXPathForest } from "./xpathTree.js";
import { findAllInmlFiles, findProjectRoot } from "./project.js";
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
  /**
   * Discovered project roots (see `findProjectRoot`) mapped to the set of
   * `.inml` fsPaths found under each, as of the last scan. Scoped-per-root
   * so a watched-file change can resync each known project independently
   * instead of re-walking the whole workspace.
   */
  public projectRoots: Map<string, Set<string>> = new Map();
  /**
   * URIs of documents loaded from disk by `ensureProjectIndexed`/
   * `rescanKnownProjects` rather than opened/edited in the editor. Tracked
   * separately so a later rescan can safely evict them if the file falls
   * out of the discovered set (e.g. it was deleted), without ever evicting
   * a document the user genuinely has open.
   */
  public preloadedUris: Set<string> = new Set();

  private constructor() {}

  static async create(): Promise<WorkspaceIndex> {
    const index = new WorkspaceIndex();
    index.parser = await CstParser.create();
    return index;
  }

  /**
   * Remembers `roots` for later use as the upper bound `findProjectRoot`'s
   * upward walk won't cross. Call once at server init with the LSP
   * workspace folders.
   */
  public setWorkspaceRoots(roots: string[] = this.workspaceRoots) {
    this.workspaceRoots = roots;
  }

  /**
   * Reads and indexes every `.inml` file discovered under `root` that isn't
   * already in `documents`, and evicts any previously-preloaded file under
   * `root` that's no longer discovered (e.g. deleted). Returns whether
   * `documents` changed, so callers can decide whether to rebuild the index.
   */
  private _syncRoot(root: string): boolean {
    let changed = false;

    const discovered = new Set(findAllInmlFiles(root));
    this.projectRoots.set(root, discovered);

    for (const fsPath of discovered) {
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

    const rootPrefix = root.endsWith(sep) ? root : root + sep;
    for (const uri of [...this.preloadedUris]) {
      const fsPath = uriToFsPath(uri);
      if (fsPath !== root && !fsPath.startsWith(rootPrefix)) continue;
      if (!discovered.has(fsPath)) {
        this.documents.delete(uri);
        this.preloadedUris.delete(uri);
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Determines the project a newly-opened file belongs to (see
   * `findProjectRoot`) and indexes every `.inml` file under that root, so
   * xpath/ref resolution sees the full set of documents in that project,
   * not just whichever ones happen to be open in the editor. Without this,
   * a ref in an open file pointing at a node defined in a never-opened
   * sibling file would falsely resolve to zero targets.
   *
   * Idempotent / cheap to call repeatedly for files already belonging to a
   * known root -- it re-syncs that root each time, so it also serves as a
   * manual refresh if called again for the same root.
   */
  public ensureProjectIndexed(fsPath: string) {
    const root = findProjectRoot(fsPath, this.workspaceRoots);
    // Never walk the filesystem root itself -- it's never a legitimate
    // project root in practice (`findProjectRoot`'s no-marker/no-boundary
    // fallback only lands here for a file that is itself directly inside
    // the fs root), and recursing from "/" would walk the entire disk.
    if (resolve(root) === resolve("/")) return;
    if (this._syncRoot(root)) this.rebuildIndex();
  }

  /**
   * Re-syncs every previously-discovered project root. Used when the
   * client's file watcher reports a change -- cheaper than re-walking the
   * whole workspace, since it's bounded by the number of distinct projects
   * opened so far rather than the workspace's total size.
   */
  public rescanKnownProjects() {
    let changed = false;
    for (const root of this.projectRoots.keys()) {
      if (this._syncRoot(root)) changed = true;
    }
    if (changed) this.rebuildIndex();
  }

  public setDocument(uri: string, text: string, version: number = 1): AstDocument {
    const isNewDocument = !this.documents.has(uri);
    const { doc } = this.parser.parse(uri, text, version);
    this.documents.set(uri, doc);
    // The editor now genuinely has this document open/edited -- it's no
    // longer merely a disk-preloaded stand-in, so a project rescan must
    // never evict it just because it's no longer (re)discovered.
    this.preloadedUris.delete(uri);
    if (isNewDocument) {
      // First time we've seen this uri -- discover and index its project
      // so refs into never-opened sibling files resolve immediately.
      this.ensureProjectIndexed(uriToFsPath(uri));
    }
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
