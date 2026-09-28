import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildTree } from "./parser.js";
import { LineToken, tokenize } from "./tokenizer.js";
import { IndentParseError, ParseResult } from "./types.js";

/**
 * The kind name for the built-in include directive. An include line has
 * the shape `!include "path"`: kind `"!include"`, a mandatory quoted-string
 * positional value holding the relative path, and no attributes.
 */
const INCLUDE_KIND = "!include";

/**
 * Resolves an include path relative to the file that references it.
 * All include paths are relative (`./...`, `../...`) and are resolved
 * relative to the directory of `fromFile`.
 */
function resolveIncludePath(includePath: string, fromFile: string): string {
  return resolve(dirname(fromFile), includePath);
}

/**
 * Recursively resolves `!include` tokens within a token stream, splicing in
 * the tokens of each referenced file in place of the include line.
 *
 * Splice semantics: the include line is *replaced* (not nested) -- the
 * referenced file's top-level (depth-0) lines land at the same depth as the
 * include line itself, and every descendant is shifted by that same offset.
 * This mirrors plain textual stitching, just indentation-aware.
 *
 * `chain` tracks the resolved absolute paths of files currently being
 * included, to detect and reject circular includes.
 */
function resolveIncludeTokens(
  tokens: LineToken[],
  currentFile: string,
  chain: readonly string[],
  visited?: Set<string>,
): LineToken[] {
  const result: LineToken[] = [];

  for (const token of tokens) {
    if (token.kind !== INCLUDE_KIND) {
      result.push(token);
      continue;
    }

    if (Object.keys(token.attrs).length > 0) {
      throw new IndentParseError(
        `'${INCLUDE_KIND}' directive does not accept attributes`,
        token.line,
        currentFile,
      );
    }

    if (typeof token.value !== "string") {
      throw new IndentParseError(
        `'${INCLUDE_KIND}' requires a quoted string path, e.g. '${INCLUDE_KIND} "./file.inml"'`,
        token.line,
        currentFile,
      );
    }

    const includePath = token.value;
    const resolvedPath = resolveIncludePath(includePath, currentFile);


    if (chain.includes(resolvedPath)) {
      const cyclePath = [...chain, resolvedPath]
        .map((p) => p.split("/").pop())
        .join(" -> ");
      throw new IndentParseError(
        `circular include detected: ${cyclePath}`,
        token.line,
        currentFile,
      );
    }

    let includedSource: string;
    try {
      includedSource = readFileSync(resolvedPath, "utf8");
    } catch (err) {
      throw new IndentParseError(
        `failed to read included file '${resolvedPath}': ${(err as Error).message}`,
        token.line,
        currentFile,
      );
    }

    visited?.add(resolvedPath);

    const includedTokens = resolveIncludeTokens(
      tokenizeFile(includedSource, resolvedPath),
      resolvedPath,
      [...chain, resolvedPath],
      visited,
    );

    for (const includedToken of includedTokens) {
      result.push({ ...includedToken, depth: includedToken.depth + token.depth });
    }
  }

  return result;
}

/** Tokenizes a file's source, re-tagging any `IndentParseError` with its file path. */
function tokenizeFile(source: string, filePath: string): LineToken[] {
  try {
    return tokenize(source);
  } catch (err) {
    if (err instanceof IndentParseError && err.file === undefined) {
      throw new IndentParseError(err.message.replace(/^Line \d+: /, ""), err.line, filePath);
    }
    throw err;
  }
}

/**
 * Parses an Indent entry file from disk, resolving `!include "path"` lines by
 * splicing in the referenced files' content at the include line's own
 * indentation depth.
 *
 * This is a Node-only entry point (uses `fs`/`path`); `parse(source)`
 * remains fs-free for callers that only ever have an in-memory string.
 */
export function parseFile(entryPath: string): ParseResult {
  const resolvedEntryPath = resolve(entryPath);
  const source = readFileSync(resolvedEntryPath, "utf8");
  const tokens = resolveIncludeTokens(
    tokenizeFile(source, resolvedEntryPath),
    resolvedEntryPath,
    [resolvedEntryPath],
  );
  return buildTree(tokens);
}

/**
 * Same as `parseFile`, but also returns the absolute paths of every file
 * that contributed to the result -- the entry file itself plus every file
 * transitively pulled in via `!include`, in the order first encountered.
 *
 * Used by callers that need to know the full set of source files backing a
 * parse (e.g. project-scoped tooling that must distinguish files reachable
 * from an entry point from unrelated/orphaned `.inml` files on disk).
 */
export function parseFileWithSources(entryPath: string): {
  result: ParseResult;
  files: string[];
} {
  const resolvedEntryPath = resolve(entryPath);
  const source = readFileSync(resolvedEntryPath, "utf8");
  const visited = new Set<string>([resolvedEntryPath]);
  const tokens = resolveIncludeTokens(
    tokenizeFile(source, resolvedEntryPath),
    resolvedEntryPath,
    [resolvedEntryPath],
    visited,
  );
  return { result: buildTree(tokens), files: [...visited] };
}
