import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFileWithSources } from "./resolver.js";
import { parse } from "./parser.js";
import { IndentParseError, ParseResult } from "./types.js";

/**
 * The fixed filename a "project" manifest must use. A project is any
 * directory containing a `project.inml` file that declares an `entry` node
 * pointing at the Indent file to parse. `.inml` files not reachable (via
 * `!include`) from that entry are not part of the project.
 */
export const PROJECT_FILENAME = "project.inml";

/** Parsed contents of a `project.inml` manifest. */
export interface ProjectManifest {
  /** Optional human-readable project name, from a top-level `name "..."` node. */
  name?: string;
  /** Absolute path of the entry `.inml` file, resolved relative to the manifest's directory. */
  entryPath: string;
}

/**
 * Resolves a user-supplied path to an actual `project.inml` file path. Accepts
 * either the direct path to a `project.inml` file, or a directory containing
 * one (in which case `PROJECT_FILENAME` is appended).
 */
function resolveProjectFilePath(projectPath: string): string {
  const resolvedPath = resolve(projectPath);
  let isDirectory = false;
  try {
    isDirectory = statSync(resolvedPath).isDirectory();
  } catch {
    // Doesn't exist (yet) -- fall through and let the caller's readFileSync
    // produce a clear "failed to read" error against the literal path given.
  }
  return isDirectory ? join(resolvedPath, PROJECT_FILENAME) : resolvedPath;
}

/**
 * Parses a `project.inml` manifest file. Requires exactly one top-level
 * `entry` node with a quoted-string positional value (a relative path,
 * e.g. `entry "./root.inml"`), resolved relative to the manifest's own
 * directory. An optional top-level `name` node (quoted string) is also read.
 *
 * `projectPath` may be the direct path to a `project.inml` file, or a
 * directory containing one.
 */
export function parseProjectFile(projectPath: string): ProjectManifest {
  const resolvedProjectPath = resolveProjectFilePath(projectPath);
  const parsed: ParseResult = parse(readSource(resolvedProjectPath));

  const entryNodes = parsed.roots.filter((n) => n.kind === "entry");
  if (entryNodes.length === 0) {
    throw new IndentParseError(
      `'${PROJECT_FILENAME}' is missing a required 'entry' node, e.g. 'entry \"./root.inml\"'`,
      0,
      resolvedProjectPath,
    );
  }
  if (entryNodes.length > 1) {
    throw new IndentParseError(
      `'${PROJECT_FILENAME}' must declare exactly one 'entry' node, found ${entryNodes.length}`,
      0,
      resolvedProjectPath,
    );
  }

  const entryNode = entryNodes[0];
  if (typeof entryNode.value !== "string") {
    throw new IndentParseError(
      `'entry' requires a quoted string path, e.g. 'entry \"./root.inml\"'`,
      0,
      resolvedProjectPath,
    );
  }

  const nameNode = parsed.roots.find((n) => n.kind === "name");
  const name = typeof nameNode?.value === "string" ? nameNode.value : undefined;

  const entryPath = resolve(dirname(resolvedProjectPath), entryNode.value);

  return { name, entryPath };
}

function readSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new IndentParseError(
      `failed to read '${PROJECT_FILENAME}': ${(err as Error).message}`,
      0,
      path,
    );
  }
}

/**
 * Parses a project end-to-end: reads `project.inml`, resolves its `entry`
 * file, and parses that entry (splicing any `!include`s). `includedFiles`
 * lists the absolute paths of every file reachable from the entry (the
 * entry itself plus every transitively included file) -- notably it does
 * NOT include the `project.inml` path itself, since it's a manifest, not a
 * DaC (Diagram-as-Code) source file.
 *
 * `projectPath` may be the direct path to a `project.inml` file, or a
 * directory containing one.
 */
export function parseProject(projectPath: string): {
  manifest: ProjectManifest;
  result: ParseResult;
  includedFiles: string[];
} {
  const manifest = parseProjectFile(projectPath);
  const { result, files } = parseFileWithSources(manifest.entryPath);
  return { manifest, result, includedFiles: files };
}
