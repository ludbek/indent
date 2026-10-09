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
 * The kind name for the built-in schema directive. A schema line has the
 * shape `!schema "path"`: kind `"!schema"`, a mandatory quoted-string
 * positional value holding the relative path to a schema definition file,
 * and no attributes. It must be the first statement in the entry file, at
 * depth 0, and appear at most once. It is stripped from the parsed tree --
 * callers read the resolved path off `ParseResult.schemaRef` instead. It
 * does not propagate through `!include`: an `!schema` directive found in an
 * included file is a parse error.
 */
const SCHEMA_KIND = "!schema";

/** Mutable context threaded through `resolveIncludeTokens` to capture an `!schema` directive. */
interface SchemaDirectiveContext {
  schemaPath?: string;
  seen: boolean;
}


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
  schemaContext?: SchemaDirectiveContext,
): LineToken[] {
  const isEntryFile = currentFile === chain[0];
  const result: LineToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.kind === SCHEMA_KIND) {
      if (!isEntryFile) {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' directive is not allowed in an included file -- it does not propagate through '${INCLUDE_KIND}'`,
          token.line,
          currentFile,
        );
      }
      if (!schemaContext) {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' directive is not supported in this context`,
          token.line,
          currentFile,
        );
      }
      if (schemaContext.seen) {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' directive may only appear once per file`,
          token.line,
          currentFile,
        );
      }
      if (i !== 0) {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' must be the first statement in the file`,
          token.line,
          currentFile,
        );
      }
      if (token.depth !== 0) {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' must be at the top level (depth 0)`,
          token.line,
          currentFile,
        );
      }
      if (Object.keys(token.attrs).length > 0) {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' directive does not accept attributes`,
          token.line,
          currentFile,
        );
      }
      if (typeof token.value !== "string") {
        throw new IndentParseError(
          `'${SCHEMA_KIND}' requires a quoted string path, e.g. '${SCHEMA_KIND} "./schema.inml"'`,
          token.line,
          currentFile,
        );
      }

      schemaContext.seen = true;
      schemaContext.schemaPath = resolveIncludePath(token.value, currentFile);
      continue;
    }

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
      schemaContext,
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
  const schemaContext: SchemaDirectiveContext = { seen: false };
  const tokens = resolveIncludeTokens(
    tokenizeFile(source, resolvedEntryPath),
    resolvedEntryPath,
    [resolvedEntryPath],
    undefined,
    schemaContext,
  );
  const result = buildTree(tokens);
  if (schemaContext.schemaPath !== undefined) {
    result.schemaRef = schemaContext.schemaPath;
  }
  return result;
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
  const schemaContext: SchemaDirectiveContext = { seen: false };
  const tokens = resolveIncludeTokens(
    tokenizeFile(source, resolvedEntryPath),
    resolvedEntryPath,
    [resolvedEntryPath],
    visited,
    schemaContext,
  );
  const result = buildTree(tokens);
  if (schemaContext.schemaPath !== undefined) {
    result.schemaRef = schemaContext.schemaPath;
  }
  return { result, files: [...visited] };
}
