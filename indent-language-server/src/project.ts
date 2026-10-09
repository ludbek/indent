import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vscode"]);

/**
 * Recursively finds every `.inml` file under `root`, skipping common noise
 * directories. The whole workspace is treated as one implicit project: every
 * `.inml` file found is eagerly indexed so xpath/ref resolution sees the
 * full set of documents, not just whichever ones happen to be open in the
 * editor.
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
