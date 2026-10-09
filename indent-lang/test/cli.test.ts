import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");
const cliPath = join(__dirname, "..", "dist", "cli.cjs");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], {
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

// These tests exercise the built CLI (dist/cli.cjs), so `npm run build` must
// run before `npm test` for them to pass -- consistent with how this package
// is normally built+tested together.
describe("cli", () => {
  it("parses a standalone .inml file", () => {
    const { stdout, status } = runCli([join(fixturesDir, "sample.inml")]);
    expect(status).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.result.roots[0].kind).toBe("org");
  });

  it("errors on a missing path", () => {
    const missing = join(fixturesDir, "does-not-exist.inml");
    const { status } = runCli([missing]);
    expect(status).not.toBe(0);
  });

  it("writes output to a file when -o is given", () => {
    const outDir = mkdtempSync(join(tmpdir(), "indent-cli-out-"));
    const outFile = join(outDir, "nested", "out.json");
    try {
      const { status } = runCli([join(fixturesDir, "sample.inml"), "-o", outFile]);
      expect(status).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
