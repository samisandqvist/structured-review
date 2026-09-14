/** Structural subset of the SCIP occurrence/document shapes decoded in scip.ts (no import: avoids a module cycle). */
interface SpanOccurrence {
  range?: number[];
  enclosingRange?: number[];
  symbol?: string;
  symbolRoles?: number;
}
interface SpanDocument {
  relativePath?: string;
  occurrences?: SpanOccurrence[];
}

/**
 * scip-dotnet (through 0.2.14) emits no `enclosing_range` on definitions, so
 * the graph builder would create no C# nodes at all. Derive each method-like
 * member's body span from source: from the definition line to the `}` that
 * closes its first `{`, or to the first top-level `;` seen before any `{`
 * (expression-bodied, abstract, interface, partial and extern members).
 *
 * Only `...().` symbols (methods, constructors, overloads) receive spans;
 * properties, fields, events and indexers stay node-less, so no per-language
 * node filter is needed. Definitions that already carry a span are untouched,
 * which makes this a no-op if upstream ships enclosing ranges.
 *
 * Known limits: nested interpolation holes share one brace counter, and
 * verbatim-interpolated strings (`$@"..."`) skip their holes entirely.
 */
export function synthesizeCsharpSpans<D extends SpanDocument>(
  docs: D[],
  readFile: (relativePath: string) => string,
): D[] {
  return docs.map((doc) => {
    const path = doc.relativePath ?? "";
    if (!path.endsWith(".cs") || !(doc.occurrences ?? []).some(needsSpan)) return doc;
    let lines: string[];
    try {
      lines = readFile(path).split("\n");
    } catch {
      return doc;
    }
    const occurrences = doc.occurrences!.map((o) => (needsSpan(o) ? withSpan(o, lines) : o));
    return { ...doc, occurrences };
  });
}

const ROLE_DEFINITION = 0x1;

function needsSpan(o: SpanOccurrence): boolean {
  if (!((o.symbolRoles ?? 0) & ROLE_DEFINITION) || o.enclosingRange || o.range?.[0] === undefined) return false;
  return !!o.symbol && !o.symbol.startsWith("local ") && /\)\.$/.test(o.symbol);
}

function withSpan<O extends SpanOccurrence>(o: O, lines: string[]): O {
  const start = o.range![0]!;
  const end = memberEndLine(lines, start);
  return { ...o, enclosingRange: [start, 0, end, lines[end]?.length ?? 0] };
}

type Mode = "code" | "hole" | "line-comment" | "block-comment" | "string" | "char" | "verbatim" | "raw" | "interp";

interface Scan {
  modes: Mode[];
  depth: number;
  sawBrace: boolean;
  rawQuotes: number;
  holeDepth: number;
  done: boolean;
}

const top = (s: Scan): Mode => s.modes[s.modes.length - 1]!; // "code" is never popped

/** 0-based line where the member starting at `startLine` ends; `startLine` if never found. */
export function memberEndLine(lines: string[], startLine: number): number {
  const s: Scan = { modes: ["code"], depth: 0, sawBrace: false, rawQuotes: 0, holeDepth: 0, done: false };
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]!;
    if (top(s) === "line-comment") s.modes.pop();
    if (top(s) === "code" && /^\s*#/.test(line)) continue;
    for (let c = 0; c < line.length; c++) {
      c = step(s, line, c);
      if (s.done) return i;
    }
  }
  return startLine;
}

/** Consume the token at `c`; return the index of its last character. */
function step(s: Scan, line: string, c: number): number {
  switch (top(s)) {
    case "code":
    case "hole":
      return stepCode(s, line, c);
    case "line-comment":
      return line.length;
    case "block-comment":
      if (!line.startsWith("*/", c)) return c;
      s.modes.pop();
      return c + 1;
    case "string":
      return stepQuoted(s, line, c, '"');
    case "char":
      return stepQuoted(s, line, c, "'");
    case "verbatim":
      if (line.startsWith('""', c)) return c + 1;
      if (line[c] === '"') s.modes.pop();
      return c;
    case "raw": {
      const closer = '"'.repeat(s.rawQuotes);
      if (!line.startsWith(closer, c)) return c;
      s.modes.pop();
      return c + s.rawQuotes - 1;
    }
    case "interp":
      return stepInterpolated(s, line, c);
  }
}

function stepQuoted(s: Scan, line: string, c: number, quote: string): number {
  if (line[c] === "\\") return c + 1;
  if (line[c] === quote) s.modes.pop();
  return c;
}

function stepInterpolated(s: Scan, line: string, c: number): number {
  const ch = line[c];
  if (ch === "\\") return c + 1;
  if (ch === "{") {
    if (line[c + 1] === "{") return c + 1;
    s.modes.push("hole");
    s.holeDepth = 0;
    return c;
  }
  if (ch === '"') s.modes.pop();
  return c;
}

function stepCode(s: Scan, line: string, c: number): number {
  const ch = line[c];
  const next = line[c + 1];
  if (ch === "/" && next === "/") {
    s.modes.push("line-comment");
    return line.length;
  }
  if (ch === "/" && next === "*") {
    s.modes.push("block-comment");
    return c + 1;
  }
  if (ch === "'") {
    s.modes.push("char");
    return c;
  }
  if (ch === '"') return openString(s, line, c);
  if (ch === "@" && next === '"') {
    s.modes.push("verbatim");
    return c + 1;
  }
  if (ch === "$" || (ch === "@" && next === "$")) return openInterpolated(s, line, c);
  return top(s) === "hole" ? stepHoleBrace(s, ch, c) : stepMemberBrace(s, ch, c);
}

function openString(s: Scan, line: string, c: number): number {
  let quotes = 0;
  while (line[c + quotes] === '"') quotes++;
  if (quotes >= 3) {
    s.modes.push("raw");
    s.rawQuotes = quotes;
    return c + quotes - 1;
  }
  if (quotes === 2) return c + 1; // empty string literal ""
  s.modes.push("string");
  return c;
}

/** `$"…"` interpolated; `$@"…"`/`@$"…"` verbatim-interpolated (holes skipped); `$"""…"""` raw. */
function openInterpolated(s: Scan, line: string, c: number): number {
  const rest = line.slice(c, c + 3);
  if (rest === '$@"' || rest === '@$"') {
    s.modes.push("verbatim");
    return c + 2;
  }
  if (rest === '$""' && line[c + 3] === '"') return openString(s, line, c + 1);
  if (rest.startsWith('$"')) {
    s.modes.push("interp");
    return c + 1;
  }
  return c;
}

function stepHoleBrace(s: Scan, ch: string | undefined, c: number): number {
  if (ch === "{") s.holeDepth++;
  else if (ch === "}") {
    if (s.holeDepth === 0) s.modes.pop();
    else s.holeDepth--;
  }
  return c;
}

function stepMemberBrace(s: Scan, ch: string | undefined, c: number): number {
  if (ch === "{") {
    s.depth++;
    s.sawBrace = true;
  } else if (ch === "}") {
    s.depth--;
    if (s.sawBrace && s.depth === 0) s.done = true;
  } else if (ch === ";" && !s.sawBrace && s.depth === 0) {
    s.done = true;
  }
  return c;
}
