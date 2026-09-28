// src/types.ts
var XPathParseError = class extends Error {
  constructor(message, raw) {
    super(`Invalid XPath "${raw}": ${message}`);
    this.raw = raw;
    this.name = "XPathParseError";
  }
};

// src/parser.ts
var NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_-]*$/;
var KIND_NAME_REGEX = /^[-_=<>A-Za-z][-_=<>A-Za-z0-9]*$/;
var NUMBER_REGEX = /^-?\d+(\.\d+)?$/;
var Scanner = class {
  constructor(text, raw) {
    this.text = text;
    this.raw = raw;
    this.pos = 0;
  }
  get eof() {
    return this.pos >= this.text.length;
  }
  peek(offset = 0) {
    return this.text[this.pos + offset] ?? "";
  }
  startsWith(s) {
    return this.text.startsWith(s, this.pos);
  }
  advance(n = 1) {
    this.pos += n;
  }
  error(message) {
    throw new XPathParseError(message, this.raw);
  }
  /** Reads a bare node-kind/step name matching {@link KIND_NAME_REGEX}. */
  readName(context) {
    const start = this.pos;
    while (!this.eof && /[-_=<>A-Za-z0-9]/.test(this.peek())) {
      this.advance();
    }
    const name = this.text.slice(start, this.pos);
    if (!name) this.error(`expected ${context} at position ${start}`);
    if (!KIND_NAME_REGEX.test(name)) {
      this.error(
        `invalid ${context} "${name}": must start with a letter, underscore, or one of - = < >, followed by letters, digits, underscores, hyphens, or < = >`
      );
    }
    return name;
  }
  /**
   * Reads (and consumes) the contents between a `[` and its matching `]`,
   * respecting `"..."` quoted spans so a `]`/`/` inside a quoted predicate
   * literal doesn't terminate the predicate or step early.
   */
  readBracketedPredicate() {
    if (this.peek() !== "[") this.error("expected '['");
    this.advance();
    const start = this.pos;
    let inString = false;
    while (!this.eof) {
      const ch = this.peek();
      if (inString) {
        if (ch === "\\") {
          this.advance(2);
          continue;
        }
        if (ch === '"') inString = false;
        this.advance();
        continue;
      }
      if (ch === '"') {
        inString = true;
        this.advance();
        continue;
      }
      if (ch === "]") {
        const body = this.text.slice(start, this.pos);
        this.advance();
        return body;
      }
      this.advance();
    }
    this.error("unterminated '[' predicate");
  }
};
function parseLiteral(text, raw) {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (NUMBER_REGEX.test(trimmed)) return Number(trimmed);
  throw new XPathParseError(
    `invalid predicate literal "${trimmed}" -- must be a quoted string, number, or true/false`,
    raw
  );
}
function splitTopLevelCommas(text) {
  const parts = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
function parseAttrClause(clause, raw) {
  const trimmed = clause.trim();
  if (trimmed.length === 0) {
    throw new XPathParseError("empty predicate clause", raw);
  }
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) {
    if (!NAME_REGEX.test(trimmed)) {
      throw new XPathParseError(`invalid attribute name "${trimmed}" in predicate`, raw);
    }
    return { name: trimmed };
  }
  const name = trimmed.slice(0, eqIndex).trim();
  if (!NAME_REGEX.test(name)) {
    throw new XPathParseError(`invalid attribute name "${name}" in predicate`, raw);
  }
  const value = parseLiteral(trimmed.slice(eqIndex + 1), raw);
  return { name, value };
}
var INDEX_REGEX = /^\d+$/;
function parsePredicate(body, raw) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new XPathParseError("empty predicate '[]'", raw);
  }
  if (INDEX_REGEX.test(trimmed)) {
    return { type: "index", index: Number(trimmed) };
  }
  if (trimmed.startsWith(".")) {
    const rest = trimmed.slice(1).trim();
    if (!rest.startsWith("=")) {
      throw new XPathParseError(
        `self predicate must be in the form [.=value], got "[${trimmed}]"`,
        raw
      );
    }
    const value = parseLiteral(rest.slice(1), raw);
    return { type: "self", value };
  }
  const clauses = splitTopLevelCommas(trimmed);
  const predicates = clauses.map((clause) => parseAttrClause(clause, raw));
  if (predicates.length > 1) {
    for (const p of predicates) {
      if (p.value === void 0) {
        throw new XPathParseError(
          `bare attribute existence check "${p.name}" is not allowed inside a multi-predicate list -- combine only "name=value" pairs, e.g. [${p.name}=value,other=value]`,
          raw
        );
      }
    }
  }
  return { type: "attr", predicates };
}
function parseXPath(raw) {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }
  if (text.length === 0) {
    throw new XPathParseError("xpath expression is empty", raw);
  }
  let isAbsolute = false;
  let isDescendant = false;
  let nextAxis;
  if (text.startsWith("//")) {
    isDescendant = true;
    nextAxis = "descendant";
    text = text.slice(2);
  } else if (text.startsWith("/")) {
    isAbsolute = true;
    nextAxis = "child";
    text = text.slice(1);
  } else {
    throw new XPathParseError(
      "only absolute paths ('/a/b') or descendant paths ('//a') are supported in this subset",
      raw
    );
  }
  const scanner = new Scanner(text, raw);
  const steps = [];
  for (; ; ) {
    const name = scanner.readName("a node kind");
    let predicate;
    if (scanner.peek() === "[") {
      const body = scanner.readBracketedPredicate();
      predicate = parsePredicate(body, raw);
    }
    steps.push({ axis: nextAxis, name, predicate });
    if (scanner.eof) break;
    if (scanner.startsWith("//")) {
      scanner.advance(2);
      nextAxis = "descendant";
    } else if (scanner.startsWith("/")) {
      scanner.advance(1);
      nextAxis = "child";
    } else {
      scanner.error(`unexpected character "${scanner.peek()}" after step "${name}"`);
    }
  }
  return { isAbsolute, isDescendant, steps, raw };
}

// src/evaluate.ts
function matchesLiteral(nodeValue, literal) {
  return typeof nodeValue === typeof literal && nodeValue === literal;
}
function matchesPredicate(node, predicate) {
  if (predicate.type === "self") {
    return node.value !== void 0 && matchesLiteral(node.value, predicate.value);
  }
  if (predicate.type === "index") {
    throw new Error("index predicates must be resolved positionally, not via matchesPredicate");
  }
  const attrs = node.attrs ?? {};
  return predicate.predicates.every((p) => {
    if (!(p.name in attrs)) return false;
    if (p.value === void 0) return true;
    return matchesLiteral(attrs[p.name], p.value);
  });
}
function matchesStep(node, step) {
  if (node.kind.toLowerCase() !== step.name.toLowerCase()) return false;
  if (step.predicate && !matchesPredicate(node, step.predicate)) return false;
  return true;
}
function collectDescendants(nodes) {
  const result = [];
  const visit = (n) => {
    for (const child of n.children ?? []) {
      result.push(child);
      visit(child);
    }
  };
  for (const n of nodes) visit(n);
  return result;
}
function selectNodes(roots, xpath) {
  const parsed = typeof xpath === "string" ? parseXPath(xpath) : xpath;
  let currentSet = parsed.isDescendant ? [...roots, ...collectDescendants(roots)] : [...roots];
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const candidates = i === 0 ? currentSet : step.axis === "descendant" ? collectDescendants(currentSet) : currentSet.flatMap((n) => n.children ?? []);
    if (step.predicate?.type === "index") {
      const kindMatches = candidates.filter(
        (n) => n.kind.toLowerCase() === step.name.toLowerCase()
      );
      const target = kindMatches[step.predicate.index];
      currentSet = target ? [target] : [];
      if (currentSet.length === 0) break;
      continue;
    }
    const matched = [];
    for (const node of candidates) {
      if (matchesStep(node, step) && !matched.includes(node)) {
        matched.push(node);
      }
    }
    currentSet = matched;
    if (currentSet.length === 0) break;
  }
  return currentSet;
}
export {
  XPathParseError,
  parseXPath,
  selectNodes
};
//# sourceMappingURL=index.js.map