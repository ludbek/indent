import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { decodeWireFormat, encodeWireFormat } from "../src/wireFormat.js";
import { IndentParseError } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wireFormat", () => {
  it("round-trips the sample fixture", () => {
    const source = readFileSync(join(__dirname, "fixtures/sample.inml"), "utf8");
    const encoded = encodeWireFormat(source);
    expect(decodeWireFormat(encoded)).toBe(source);
  });

  it("encodes a single indent level as one \\+", () => {
    const source = 'org name="A"\n    team name="B"';
    expect(encodeWireFormat(source)).toBe('org name="A"\\+team name="B"');
  });

  it("encodes sibling lines (same depth) with a bare \\n", () => {
    const source = 'org name="A"\n    team name="B"\n    team name="C"';
    expect(encodeWireFormat(source)).toBe(
      'org name="A"\\+team name="B"\nteam name="C"',
    );
  });

  it("encodes a multi-level dedent as repeated \\-", () => {
    const source = [
      'org name="A"',
      '    team name="B"',
      '        service name="C"',
      'org name="D"',
    ].join("\n");
    expect(encodeWireFormat(source)).toBe(
      'org name="A"\\+team name="B"\\+service name="C"\\-\\-org name="D"',
    );
  });

  it("round-trips a multi-level indent/dedent sequence", () => {
    const source = [
      'org name="A"',
      '    team name="B"',
      '        service name="C"',
      '            API name="D"',
      '    team name="E"',
      'org name="F"',
    ].join("\n");
    const encoded = encodeWireFormat(source);
    expect(decodeWireFormat(encoded)).toBe(source);
  });

  it("round-trips blank lines verbatim and normalizes comment-only line indentation to current depth", () => {
    const source = [
      'org name="A"',
      '    team name="B"',
      '',
      '        ; a comment', // intentionally mis-indented relative to depth 1
      '    team name="C"',
    ].join("\n");
    const expected = [
      'org name="A"',
      '    team name="B"',
      '',
      '    ; a comment', // normalized to depth 1 (currentDepth at that point), not its own mis-indentation
      '    team name="C"',
    ].join("\n");
    const encoded = encodeWireFormat(source);
    expect(decodeWireFormat(encoded)).toBe(expected);
  });

  it("round-trips a trailing inline comment and \\ continuation lines", () => {
    const source = [
      'org name="A" ; trailing comment',
      '    API "Search" \\',
      '        type="REST" \\',
      '        method="POST"',
    ].join("\n");
    const encoded = encodeWireFormat(source);
    expect(decodeWireFormat(encoded)).toBe(source);
  });

  it("throws the same stray-whitespace error as the tokenizer on bad indentation", () => {
    const source = 'org name="A"\n   team name="B"'; // 3 spaces, not 4
    expect(() => encodeWireFormat(source)).toThrow(IndentParseError);
    expect(() => encodeWireFormat(source)).toThrow(/inconsistent indentation/);
  });

  it("throws when decoding a \\- run that dedents past depth 0", () => {
    expect(() => decodeWireFormat('org name="A"\\-team name="B"')).toThrow(
      /dedents past depth 0/,
    );
  });
});
