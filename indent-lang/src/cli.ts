#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseFile } from "./resolver.js";
import { IndentParseError, type ParseResult } from "./types.js";
import { parseSchemaFile, validateAgainstSchema, type Schema } from "./schema/index.js";
import { resolveSchemaFor } from "./schema/resolve.js";

interface CliOptions {
  path?: string;
  output?: string;
  schemaPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-o":
      case "--output":
        options.output = argv[++i];
        break;
      case "--schema":
        options.schemaPath = argv[++i];
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
    `Usage: indent-lang <path> [options]\n\n` +
      `Parses a single .inml file (its own '!include's are still spliced in) and\n` +
      `prints the result as JSON.\n\n` +
      `Schema validation is auto-discovered from an in-document '!schema \"<path>\"'\n` +
      `directive. Pass --schema to override auto-discovery with an explicit\n` +
      `schema file.\n\n` +
      `Options:\n` +
      `  --schema <path>  Validate against this schema file, overriding auto-discovery\n` +
      `  -o, --output <p> Write JSON output to file <p> instead of stdout\n` +
      `  -h, --help       Show this help message\n`,
  );
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));

  if (!options.path) {
    process.stderr.write("Error: missing required <path> argument.\n\n");
    printHelp();
    process.exit(1);
  }

  const resolvedPath = resolve(options.path);

  try {
    const result: ParseResult = parseFile(resolvedPath);
    const output = { result };

    const schemaPath = options.schemaPath
      ? resolve(options.schemaPath)
      : resolveSchemaFor(result);

    let hasSchemaErrors = false;
    if (schemaPath) {
      const schema: Schema = parseSchemaFile(schemaPath);
      const diagnostics = validateAgainstSchema(result.roots, schema);
      for (const diagnostic of diagnostics) {
        const label = diagnostic.severity === "error" ? "Error" : "Warning";
        process.stderr.write(`${label}: ${diagnostic.message}\n`);
        if (diagnostic.severity === "error") hasSchemaErrors = true;
      }
    }

    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (options.output) {
      const outPath = resolve(options.output);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, json);
    } else {
      process.stdout.write(json);
    }

    if (hasSchemaErrors) {
      process.exit(1);
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
