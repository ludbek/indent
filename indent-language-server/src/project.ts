import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vscode"]);

/**
 * Recursively finds every `.inml` file under `root`, skipping common noise
 * directories.
 */
export function findAllInmlFiles(root: string): string[] {
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
      } else if (entry.isFile() && entry.name.endsWith(".inml")) {
        found.push(full);
      }
    }
  };

  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    // root doesn't exist / not accessible -- nothing found.
  }

  return found;
}

/**
 * Marker files/directories conventionally used by other tooling to denote a
 * project root. The first one found walking upward from the opened file
 * wins, so an inner marker (e.g. a nested `package.json`) takes precedence
 * over an outer one (e.g. the repo's top-level `.git`).
 */
const ROOT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
];

/**
 * Determines the "project" a `.inml` file belongs to, replacing the removed
 * `project.inml` manifest concept with a marker-file heuristic: walk upward
 * from the file's directory looking for one of `ROOT_MARKERS`. The walk
 * never goes above `workspaceBoundaries` (the LSP workspace folder roots) --
 * if no marker is found by the time a boundary is reached, that boundary
 * itself becomes the project root (today's whole-workspace behavior, used
 * as a fallback).
 *
 * If `workspaceBoundaries` is empty (no VS Code folder open -- a bare
 * "Open File" single-file session) and no marker is found anywhere up to
 * the filesystem root, indexing stays scoped to the opened file's own
 * directory: siblings and subfolders are indexed, but the walk never
 * reaches upward with no boundary to anchor it.
 */
export function findProjectRoot(
  filePath: string,
  workspaceBoundaries: string[] = [],
): string {
  const startDir = resolve(dirname(filePath));
  const boundaries = new Set(workspaceBoundaries.map((b) => resolve(b)));

  let dir = startDir;
  let prev: string | undefined;

  while (dir !== prev) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
      return dir;
    }
    if (boundaries.has(dir)) {
      return dir;
    }
    prev = dir;
    dir = dirname(dir);
  }

  // No workspace boundary configured and no marker found anywhere up to the
  // filesystem root -- fall back to the opened file's own directory.
  return startDir;
}
