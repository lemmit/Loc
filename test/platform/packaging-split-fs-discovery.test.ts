import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBackendsFs, installFsBackendSource } from "../../src/platform/fs-discovery.js";
import {
  defaultBuiltInBackends,
  discoverBackends,
  resetBackendSource,
} from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// fs-backed `discoverBackends()` source.
//
// The contract under test: a workspace where
// `@loom/backend-hono-v4` is symlinked under
// `node_modules/@loom/backend-hono-v4` (set up earlier in the test) yields
// a `DiscoveredBackend` whose `surface` is *the same instance* as
// the in-tree `hono@v4` surface.  That `===` identity is the
// byte-identical bridge: the same code is delivered through the
// in-tree path AND the workspace symlink, so swapping the source
// changes which `package.json` the manifest was *read* from but not
// which `PlatformSurface` is *resolved*.  Output stays unchanged.
//
// A later change will replace the in-tree surface lookup in
// `fs-discovery.ts` with a dynamic `import(pkg)`; at that point
// the identity invariant relaxes to "structural equivalence", and
// these tests update to assert behaviour (`emitProject(...)`
// returns the same files) rather than reference equality.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => resetBackendSource());

describe("fs-discovery — workspace symlink discovery", () => {
  it("discovers @loom/backend-hono-v4 by its package.json loom key", async () => {
    const fs = await discoverBackendsFs(repoRoot);
    const hono = fs.find((b) => b.manifest.family === "node");
    expect(hono).toBeDefined();
    expect(hono?.manifest).toMatchObject({
      kind: "backend",
      family: "node",
      loomVersion: "v4",
    });
    expect(hono?.manifest.core).toMatch(/^\^?\d/);
  });

  it("fs-discovered hono surface is the SAME INSTANCE as in-tree", async () => {
    // The byte-identical bridge — both delivery paths yield
    // the identical PlatformSurface, so every downstream resolver
    // is unaffected by the source swap.
    const fs = await discoverBackendsFs(repoRoot);
    const fsHono = fs.find((b) => b.manifest.family === "node")!;
    const inTreeHono = defaultBuiltInBackends().find((b) => b.manifest.family === "node")!;
    expect(fsHono.surface).toBe(inTreeHono.surface);
  });

  it("only emits backend entries — packages without a loom key are silently ignored", async () => {
    const fs = await discoverBackendsFs(repoRoot);
    // The repo's node_modules has hundreds of normal packages; the
    // fs walk picks out exactly the ones with `loom.kind:"backend"`.
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.every((b) => b.manifest.kind === "backend")).toBe(true);
  });

  it("missing node_modules yields an empty set, not a throw", async () => {
    const empty = await discoverBackendsFs("/definitely/not/a/dir");
    expect(empty).toEqual([]);
  });
});

describe("installFsBackendSource — composition with in-tree default", () => {
  it("merges fs + in-tree so backends without a workspace package still resolve", async () => {
    await installFsBackendSource(repoRoot);
    const set = discoverBackends();
    const families = set.map((b) => `${b.manifest.family}@${b.manifest.loomVersion}`);
    // dotnet@v8 and elixir@v1 have no workspace package yet,
    // but they MUST still appear via the in-tree fallback — otherwise
    // resolution silently breaks for `platform: dotnet` etc.
    expect(families).toContain("dotnet@v8");
    expect(families).toContain("elixir@v1");
    // hono@v4 is now sourced through fs (its workspace symlink),
    // but the entry still resolves to the same surface instance.
    expect(families).toContain("node@v4");
  });

  it("does not double-count a backend present in both fs and in-tree", async () => {
    await installFsBackendSource(repoRoot);
    const honoEntries = discoverBackends().filter(
      (b) => b.manifest.family === "node" && b.manifest.loomVersion === "v4",
    );
    expect(honoEntries.length).toBe(1);
  });
});
