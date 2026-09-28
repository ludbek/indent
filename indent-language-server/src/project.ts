import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseProject, PROJECT_FILENAME } from "indent-parser";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vscode"]);

/**
 * Recursively finds every file literally named `project.inml` under `root`,
 * skipping common noise directories. This is the discovery mechanism for
 * "projects" in the workspace: any directory with a `project.inml` is a
 * project root, and its `entry` node's include graph defines the set of
 * `.inml` files that belong to it.
 */
export function findProjectFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === PROJECT_FILENAME) {
        found.push(full);
      }
    }
  };

  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    // root doesn't exist / not accessible -- no projects found.
  }

  return found;
}

export interface DiscoveredProject {
  projectFsPath: string;
  entryFsPath: string;
  /** Absolute paths of every file reachable from this project's entry. */
  includedFiles: Set<string>;
}

/**
 * Discovers every `project.inml` under `roots` and resolves each one's
 * include graph via `indent-parser`'s `parseProject`. A project.inml that
 * fails to parse (missing/invalid `entry`, broken include, etc.) is skipped
 * rather than thrown -- a broken manifest must not crash the language
 * server or block diagnostics for unrelated files.
 */
export function discoverProjects(roots: string[]): {
  projects: DiscoveredProject[];
  reachableFiles: Set<string>;
} {
  const projects: DiscoveredProject[] = [];
  const reachableFiles = new Set<string>();

  const seenProjectFiles = new Set<string>();
  for (const root of roots) {
    for (const projectFsPath of findProjectFiles(root)) {
      if (seenProjectFiles.has(projectFsPath)) continue;
      seenProjectFiles.add(projectFsPath);

      try {
        const { manifest, includedFiles } = parseProject(projectFsPath);
        const includedSet = new Set(includedFiles);
        projects.push({
          projectFsPath,
          entryFsPath: manifest.entryPath,
          includedFiles: includedSet,
        });
        for (const f of includedFiles) reachableFiles.add(f);
      } catch {
        // Broken project.inml -- skip; its own diagnostics (if opened) will
        // still surface via the normal CST/parse-error path.
      }
    }
  }

  return { projects, reachableFiles };
}

/**
 * Walks upward from `fsPath`'s directory looking for the nearest ancestor
 * directory containing a `project.inml`, stopping once we go above every
 * workspace root (or hit the filesystem root). This mirrors the "nearest
 * ancestor wins" convention used by tools like tsconfig.json resolution --
 * important in a monorepo where multiple independent `project.inml`
 * manifests may exist at different subtree depths, so a file must be
 * matched against the closest one, not just any project found anywhere in
 * the workspace.
 *
 * Returns the resolved absolute path to the nearest `project.inml`, or
 * `undefined` if none is found before running out of ancestors to check.
 */
export function findNearestProjectFile(
  fsPath: string,
  workspaceRoots: string[] = [],
): string | undefined {
  const resolvedRoots = workspaceRoots.map((r) => resolve(r));
  let dir = dirname(resolve(fsPath));

  // Only search within (at or below) a workspace root, if any were given.
  const isWithinARoot = (d: string) =>
    resolvedRoots.length === 0 ||
    resolvedRoots.some((root) => d === root || d.startsWith(root + "/"));

  while (true) {
    const candidate = join(dir, PROJECT_FILENAME);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // No project.inml here -- keep walking up.
    }

    const parent = dirname(dir);
    const reachedRootBoundary =
      resolvedRoots.length > 0 &&
      resolvedRoots.includes(dir) &&
      !isWithinARoot(parent);
    if (parent === dir || reachedRootBoundary) return undefined;
    dir = parent;
  }
}

/**
 * Resolves which discovered project (if any) governs a given file, using
 * nearest-ancestor `project.inml` lookup. Returns `undefined` if no
 * `project.inml` is found up the directory chain, or if the nearest one
 * found failed to parse (broken manifests are treated as "no project" --
 * consistent with `discoverProjects` skipping them). Callers should treat
 * an `undefined` result as "parse this file standalone" (i.e. fall back to
 * `parseFile` semantics / no project-membership diagnostics), only using
 * `parseProject`-derived membership info when a project is actually found.
 */
export function findProjectForFile(
  fsPath: string,
  projects: DiscoveredProject[],
  workspaceRoots: string[] = [],
): DiscoveredProject | undefined {
  const nearestProjectFsPath = findNearestProjectFile(fsPath, workspaceRoots);
  if (!nearestProjectFsPath) return undefined;
  return projects.find((p) => p.projectFsPath === nearestProjectFsPath);
}
