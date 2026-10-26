// Explicit signals for component inference, read from source text: the
// module header comment, HTTP route and tool registrations, and script entry
// points. Heuristic by design; the LLM weighs them against the references.

const MAX_LINE = 160;

const isPython = (file: string) => file.endsWith(".py");

/** Lines after an optional shebang and leading blank lines. */
function leadingLines(source: string): string[] {
  const lines = source.split("\n");
  let start = lines[0]?.startsWith("#!") ? 1 : 0;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  return lines.slice(start);
}

const joinParts = (parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ") || undefined;

function prefixedBlock(lines: string[], prefix: string): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith(prefix)) break;
    out.push(line.trimStart().slice(prefix.length));
  }
  return out;
}

function delimitedBlock(lines: string[], open: string, close: string): string[] {
  const first = lines[0]!.trimStart().slice(open.length);
  if (first.includes(close)) return [first.slice(0, first.indexOf(close))];
  const out = [first];
  for (const line of lines.slice(1)) {
    if (line.includes(close)) {
      out.push(line.slice(0, line.indexOf(close)));
      break;
    }
    out.push(line);
  }
  return out;
}

/** The module's leading comment or docstring as one line, or undefined. */
export function headerComment(source: string, file: string): string | undefined {
  const lines = leadingLines(source);
  const first = lines[0]?.trimStart() ?? "";
  if (isPython(file)) {
    const quote = ['"""', "'''"].find((q) => first.startsWith(q));
    if (quote) return joinParts(delimitedBlock(lines, quote, quote));
    return first.startsWith("#") ? joinParts(prefixedBlock(lines, "#")) : undefined;
  }
  if (first.startsWith("//")) return joinParts(prefixedBlock(lines, "//"));
  if (first.startsWith("/*")) {
    return joinParts(delimitedBlock(lines, "/*", "*/").map((l) => l.replace(/^\s*\*+/, "")));
  }
  return undefined;
}

const TS_REGISTRATIONS = [
  /\b\w+\.(get|post|put|patch|delete|all|route)\(\s*["'`]\//,
  /\.(tool|registerTool|addTool|registerPrompt|registerResource)\(\s*["'`]/,
];
const PY_REGISTRATIONS = [
  /^\s*@[\w.]+\.(get|post|put|patch|delete|route|websocket|tool)\(/,
  /\.(add_url_rule|add_api_route)\(/,
];

/** Route and tool registrations, 1-based lines, trimmed text. */
export function registrations(source: string, file: string): { line: number; text: string }[] {
  const patterns = isPython(file) ? PY_REGISTRATIONS : TS_REGISTRATIONS;
  return source
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim().slice(0, MAX_LINE) }))
    .filter(({ text }) => patterns.some((p) => p.test(text)));
}

export function entryPointReason(source: string, file: string): string | undefined {
  if (!isPython(file)) return undefined;
  if (file === "__main__.py" || file.endsWith("/__main__.py")) return "package entry point (__main__.py)";
  if (/^if __name__ == ["']__main__["']:/m.test(source)) return "runs as a script (__main__ guard)";
  return undefined;
}
