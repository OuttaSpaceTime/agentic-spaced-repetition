import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/** The three adapters are transport only: they reach the deck through the SDK and nothing deeper. */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Every relative module specifier in a file: static imports, re-exports, dynamic import() and require(), either quote. */
function relativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])(\.{1,2}\/[^"'`]*)\1/g;
  for (const m of source.matchAll(pattern)) found.push(m[2]);
  return found;
}

describe("SDK boundary", () => {
  it("sees every kind of import it is meant to catch", () => {
    const sample = [
      `import a from '../core/a.js';`,
      `import { b } from "../../db/client.js";`,
      `export { c } from "../core/c.js";`,
      `const d = await import("../core/d.js");`,
      `const e = await import('../core/e.js');`,
      `import "../core/side-effect.js";`,
      `import x from "node:fs";`,
    ].join("\n");
    expect(relativeSpecifiers(sample)).toEqual([
      "../core/a.js",
      "../../db/client.js",
      "../core/c.js",
      "../core/d.js",
      "../core/e.js",
      "../core/side-effect.js",
    ]);
  });

  for (const dir of ["src/mcp", "src/app", "src/cli"]) {
    it(`${dir} reaches the parent tree only through ../sdk/index.js`, () => {
      for (const file of sources(dir)) {
        const parents = relativeSpecifiers(readFileSync(file, "utf-8")).filter((s) => s.startsWith("../"));
        for (const spec of parents) expect(spec, file).toBe("../sdk/index.js");
      }
    });
  }
});
