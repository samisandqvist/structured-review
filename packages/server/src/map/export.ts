// A stored component map as one self-contained HTML page: the web build's
// export bundle (dist/export/map.js and map.css) inlined with the map JSON,
// so the page draws the map without a hub and can be shared as a file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ExportAssets {
  script: string;
  style: string;
  notices: string;
}

/** The export bundle of a built web UI, or undefined when it was built without one. */
export function loadExportAssets(webDistPath: string): ExportAssets | undefined {
  const dir = join(webDistPath, "export");
  const script = join(dir, "map.js");
  const style = join(dir, "map.css");
  if (!existsSync(script) || !existsSync(style)) return undefined;
  const noticesFile = join(webDistPath, "THIRD-PARTY-NOTICES.txt");
  return {
    script: readFileSync(script, "utf8"),
    style: readFileSync(style, "utf8"),
    notices: existsSync(noticesFile) ? readFileSync(noticesFile, "utf8") : "",
  };
}

/** The hub's web fonts; without network access the page falls back to system fonts. */
const FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;700&display=swap";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Keeps embedded text from closing its element early. */
const inScript = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1");
const inStyle = (s: string) => s.replace(/<\/(style)/gi, "<\\/$1");
const inComment = (s: string) => s.replace(/--/g, "- -");

/** The page for `stored` (the body of GET /api/sessions/:id/map). */
export function exportPage(stored: { map: { title: string } }, assets: ExportAssets): string {
  const data = JSON.stringify(stored).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    `<title>${escapeHtml(stored.map.title || "Component map")} · component map</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${escapeHtml(FONTS)}">`,
    ...(assets.notices ? [`<!--\n${inComment(assets.notices.trim())}\n-->`] : []),
    `<style>${inStyle(assets.style)}</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `<script type="application/json" id="srev-map">${data}</script>`,
    `<script type="module">${inScript(assets.script)}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
