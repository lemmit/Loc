import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverBackendsFs } from "../../src/platform/fs-discovery.js";
import { coreRangeSatisfies, PLATFORM_SURFACE_CONTRACT } from "../../src/platform/manifest.js";

// C10 — fs-discovery enforces the `loom.core` semver gate and warns (never
// silently drops) on malformed manifests, unknown families, and core-version
// mismatches.

describe("coreRangeSatisfies", () => {
  it("accepts wildcards and empty", () => {
    expect(coreRangeSatisfies("*", "1.2.3")).toBe(true);
    expect(coreRangeSatisfies("", "1.2.3")).toBe(true);
    expect(coreRangeSatisfies("x", "9.9.9")).toBe(true);
  });

  it("caret keeps the left-most non-zero component", () => {
    expect(coreRangeSatisfies("^1.0.0", "1.4.2")).toBe(true);
    expect(coreRangeSatisfies("^1.0.0", "1.0.0")).toBe(true);
    expect(coreRangeSatisfies("^1.0.0", "2.0.0")).toBe(false);
    expect(coreRangeSatisfies("^1.0.0", "0.9.0")).toBe(false);
    expect(coreRangeSatisfies("^0.2.3", "0.2.9")).toBe(true);
    expect(coreRangeSatisfies("^0.2.3", "0.3.0")).toBe(false);
  });

  it("tilde pins major.minor", () => {
    expect(coreRangeSatisfies("~1.2.0", "1.2.9")).toBe(true);
    expect(coreRangeSatisfies("~1.2.0", "1.3.0")).toBe(false);
  });

  it("exact and comparators", () => {
    expect(coreRangeSatisfies("1.0.0", "1.0.0")).toBe(true);
    expect(coreRangeSatisfies("=1.0.0", "1.0.1")).toBe(false);
    expect(coreRangeSatisfies(">=1.0.0", "1.5.0")).toBe(true);
    expect(coreRangeSatisfies("<2.0.0", "1.9.9")).toBe(true);
    expect(coreRangeSatisfies(">1.0.0", "1.0.0")).toBe(false);
  });

  it("fails closed on an unparseable range", () => {
    expect(coreRangeSatisfies("not-a-range", "1.0.0")).toBe(false);
  });

  it("the shipped backend manifests satisfy the running contract", () => {
    expect(coreRangeSatisfies("^1.0.0", PLATFORM_SURFACE_CONTRACT)).toBe(true);
  });
});

describe("discoverBackendsFs — warning diagnostics", () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-fsdisc-"));
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function addPkg(name: string, loom: unknown): Promise<void> {
    const pkgDir = path.join(dir, "node_modules", name);
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name, loom }));
  }

  it("warns and skips a malformed backend manifest (missing fields)", async () => {
    await addPkg("bad-backend", { kind: "backend", family: "node" }); // no loomVersion/core
    const out = await discoverBackendsFs(dir);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing/invalid field"));
  });

  it("warns and skips an unknown family/version", async () => {
    await addPkg("mystery-backend", {
      kind: "backend",
      family: "cobol",
      loomVersion: "v1",
      core: "^1.0.0",
    });
    const out = await discoverBackendsFs(dir);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown backend family/version"));
  });

  it("warns and skips a core-contract mismatch", async () => {
    await addPkg("future-backend", {
      kind: "backend",
      family: "node",
      loomVersion: "v5",
      core: "^2.0.0", // running contract is 1.0.0
    });
    const out = await discoverBackendsFs(dir);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not satisfy the running core"));
  });

  it("stays quiet for a non-backend loom block", async () => {
    await addPkg("some-core", { kind: "core" });
    const out = await discoverBackendsFs(dir);
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
