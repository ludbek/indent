#!/usr/bin/env node
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseFile } from "./resolver.js";
import { PROJECT_FILENAME, parseProject } from "./project.js";
import { IndentParseError } from "./types.js";

interface CliOptions {
  path?: string;
  mode: "auto" | "project" | "file";
  output?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "auto" };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--project":
        options.mode = "project";
        break;
      case "--file":
        options.mode = "file";
        break;
      case "-o":
      case "--output":
        options.output = argv[++i];
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        positionals.push(arg);
    }
  }

  options.path = positionals[0];
  return options;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: indent-parser <path> [options]\n\n` +
      `Parses an Indent project or a single .inml file and prints the result as JSON.\n\n` +
      `<path> may be:\n` +
      `  - a directory containing a '${PROJECT_FILENAME}' manifest\n` +
      `  - a direct path to a '${PROJECT_FILENAME}' manifest\n` +
      `  - a direct path to any other '.inml' file, parsed standalone (its own\n` +
      `    '!include's are still spliced in, but there is no project manifest)\n\n` +
      `By default the mode is auto-detected from <path>. Use --project or --file\n` +
      `to force a specific mode instead of auto-detecting.\n\n` +
      `Options:\n` +
      `  --project        Force project-manifest mode (error if not found)\n` +
      `  --file           Force standalone-file mode (error if it's a project.inml)\n` +
      `  -o, --output <p> Write JSON output to file <p> instead of stdout\n` +
      `  -h, --help       Show this help message\n`,
  );
}

function isProjectManifestPath(resolvedPath: string): boolean {
  if (!existsSync(resolvedPath)) return false;
  const stat = statSync(resolvedPath);
  if (stat.isDirectory()) return existsSync(resolve(resolvedPath, PROJECT_FILENAME));
  return basename(resolvedPath) === PROJECT_FILENAME;
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));

  if (!options.path) {
    process.stderr.write("Error: missing required <path> argument.\n\n");
    printHelp();
    process.exit(1);
  }

  const resolvedPath = resolve(options.path);
  let useProjectMode: boolean;

  if (options.mode === "project") {
    useProjectMode = true;
  } else if (options.mode === "file") {
    useProjectMode = false;
  } else {
    useProjectMode = isProjectManifestPath(resolvedPath);
  }

  try {
    let output: unknown;
    if (useProjectMode) {
      const { manifest, result, includedFiles } = parseProject(resolvedPath);
      output = { manifest, result, includedFiles };
    } else {
      if (basename(resolvedPath) === PROJECT_FILENAME) {
        throw new IndentParseError(
          `'${resolvedPath}' is a '${PROJECT_FILENAME}' manifest; use --project (or omit --file) to parse it as a project`,
          0,
          resolvedPath,
        );
      }
      const result = parseFile(resolvedPath);
      output = { result };
    }

    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (options.output) {
      const outPath = resolve(options.output);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, json);
    } else {
      process.stdout.write(json);
    }
  } catch (err) {
    if (err instanceof IndentParseError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
    }
    process.exit(1);
  }
}

run();
