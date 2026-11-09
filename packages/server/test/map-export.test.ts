// Composing an exported component map page from the web export bundle.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPage, loadExportAssets } from "../src/map/export.js";

const assets = { script: "const a = '</script>';", style: "a::after{content:'</style>'}", notices: "elkjs -- EPL" };

describe("exportPage", () => {
  it("embeds the map so no element closes early", () => {
    const html = exportPage({ map: { title: "A <b>&</b>" }, note: "</script><script>alert(1)" } as never, assets);
    expect(html).toContain("<title>A &lt;b&gt;&amp;&lt;/b&gt; · component map</title>");
    expect(html).toContain(`"note":"\\u003c/script>\\u003cscript>alert(1)"`);
    expect(html).toContain("const a = '<\\/script>';");
    expect(html).toContain("content:'<\\/style>'");
    expect(html).toContain("<!--\nelkjs - - EPL\n-->");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it("names an untitled map and leaves out empty notices", () => {
    const html = exportPage({ map: { title: "" } }, { ...assets, notices: "" });
    expect(html).toContain("<title>Component map · component map</title>");
    expect(html).not.toContain("<!--");
  });
});

describe("loadExportAssets", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("reads the bundle and notices, and reports a build without a bundle", () => {
    dir = mkdtempSync(join(tmpdir(), "srev-export-"));
    expect(loadExportAssets(dir)).toBeUndefined();
    mkdirSync(join(dir, "export"));
    writeFileSync(join(dir, "export", "map.js"), "js");
    expect(loadExportAssets(dir)).toBeUndefined();
    writeFileSync(join(dir, "export", "map.css"), "css");
    expect(loadExportAssets(dir)).toEqual({ script: "js", style: "css", notices: "" });
    writeFileSync(join(dir, "THIRD-PARTY-NOTICES.txt"), "n");
    expect(loadExportAssets(dir)!.notices).toBe("n");
  });
});
