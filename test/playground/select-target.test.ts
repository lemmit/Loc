import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { SourceMap } from "../../src/trace/index.js";
import type { VirtualFile } from "../../web/src/build/protocol.js";
import { resolveTestId, selectNodePath } from "../../web/src/build/select-target.js";
import { generateSystemFiles } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Preview select mode (M-T8.20 slice 4) — the pure resolution half.
//
// The click inside the preview iframe yields one thing: a `data-testid`.
// Turning that back into a `.ddd` declaration is what makes "click the running
// app, land on the page that renders it" possible, and it is exactly the part
// that can be proven without a booted preview — so it is proven here, against
// a REAL generate rather than a hand-written tree, with the ids the walker
// actually emits (`products-list`, `products-list-create`, `pager`).
// ---------------------------------------------------------------------------

const SALES = path.resolve(__dirname, "../../web/src/examples/sales-system.ddd");

interface Fixture {
  files: VirtualFile[];
  map: SourceMap;
  source: string;
}

async function fixture(): Promise<Fixture> {
  const source = readFileSync(SALES, "utf-8");
  // Through the shared helper, so the fixture is gated on phases ①/④/⑦.
  const emitted = await generateSystemFiles(source, { sourcemap: true });
  const files: VirtualFile[] = [...emitted].map(([p, content]) => ({
    path: p,
    content,
    size: content.length,
  }));
  const raw = emitted.get(".loom/sourcemap.json");
  expect(raw).toBeDefined();
  return { files, map: JSON.parse(raw!) as SourceMap, source };
}

describe("resolveTestId", () => {
  it("resolves a page's own test id to that page and its `.ddd` declaration", async () => {
    const { files, map, source } = await fixture();
    const target = resolveTestId(files, map, "products-list", source);

    expect(target).not.toBeNull();
    expect(target!.file).toBe("web_app/src/pages/products/list.tsx");
    expect(target!.construct).toBe("WebApp.products.List");
    // The `.ddd` line it landed on has to be inside the ui declaration the
    // scaffold macro expanded — that is what the editor reveals.
    expect(target!.sourceLine).toBeGreaterThan(0);
    const declLine = source.split("\n").findIndex((l) => l.includes("ui WebApp")) + 1;
    expect(target!.sourceLine).toBeLessThanOrEqual(declLine);
    expect(target!.sourceEndLine!).toBeGreaterThanOrEqual(declLine);
    // The node path is what the agent prompt names.
    expect(selectNodePath(target!)).toBe("WebApp.products.List");
  });

  it("matches the emitted attribute, not a substring of a longer id", async () => {
    const { files, map, source } = await fixture();
    // `products-list` is a PREFIX of `products-list-create`; resolving the
    // longer id must not land on whichever line mentions the shorter one.
    const create = resolveTestId(files, map, "products-list-create", source);
    expect(create).not.toBeNull();
    expect(create!.file).toBe("web_app/src/pages/products/list.tsx");
    const line = files.find((f) => f.path === create!.file)!.content.split("\n")[
      create!.generatedLine - 1
    ]!;
    expect(line).toContain('"products-list-create"');
  });

  it("returns null for an id no generated page emits", async () => {
    const { files, map, source } = await fixture();
    // A design pack's own chrome, or an element from a preview showing a
    // build the source has moved past — an honest null, not a wrong page.
    expect(resolveTestId(files, map, "mantine-AppShell-navbar", source)).toBeNull();
    expect(resolveTestId(files, map, "", source)).toBeNull();
  });

  it("never resolves to the emitted Playwright page objects", async () => {
    const { files, map, source } = await fixture();
    // The same ids appear in `web_app/e2e/pages/*.ts`; those describe the
    // page, they do not render it.
    const target = resolveTestId(files, map, "products-list", source);
    expect(target!.file).not.toContain("/e2e/");
  });

  it("still names the page when no sourcemap is available", async () => {
    const { files, source } = await fixture();
    const target = resolveTestId(files, null, "products-list", source);
    expect(target).not.toBeNull();
    expect(target!.file).toBe("web_app/src/pages/products/list.tsx");
    // No map → no construct, and the node path degrades to the file rather
    // than inventing one.
    expect(target!.construct).toBeUndefined();
    expect(selectNodePath(target!)).toBe("web_app/src/pages/products/list.tsx");
  });
});
