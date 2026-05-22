import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBackendsFs } from "../src/platform/fs-discovery.js";
import { PLATFORM_SURFACE_CONTRACT } from "../src/platform/manifest.js";
import { resetBackendSource } from "../src/platform/registry.js";

// ---------------------------------------------------------------------------
// packaging-split P3 slice 4 — the `@loom/core` workspace package.
//
// Slice 4 introduces `packages/core/` as the published-shape home of
// the toolchain's public API (a thin re-export of `src/` today).  It
// carries the `PlatformSurface` contract version so backend packages
// can declare which contract they speak (their `loom.core` range).
// This pins: (1) the core package advertises the same contract
// version the code constant holds, and (2) fs-backed backend
// discovery does NOT mistake the non-backend `core` package for a
// backend.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => resetBackendSource());

describe("@loom/core package", () => {
  const corePkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages", "core", "package.json"), "utf8"),
  );

  it("is named @loom/core with a core-kind loom marker", () => {
    expect(corePkg.name).toBe("@loom/core");
    expect(corePkg.loom?.kind).toBe("core");
  });

  it("advertises the same contract version as PLATFORM_SURFACE_CONTRACT", () => {
    // A backend's `loom.core` range is checked against this; the
    // package marker and the code constant must not drift.
    expect(corePkg.loom?.contract).toBe(PLATFORM_SURFACE_CONTRACT);
  });

  it("backend hono@v4's `loom.core` range is satisfied by the contract major", () => {
    const honoPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "packages", "backend-hono-v4", "package.json"), "utf8"),
    );
    // `^1.0.0` ⊇ `1.0.0` — assert majors match (a full semver-satisfies
    // check is deferred to publish tooling; majors are the contract
    // boundary).
    const wantMajor = PLATFORM_SURFACE_CONTRACT.split(".")[0];
    const haveMajor = String(honoPkg.loom.core)
      .replace(/^[^\d]*/, "")
      .split(".")[0];
    expect(haveMajor).toBe(wantMajor);
  });
});

describe("fs discovery ignores the @loom/core package", () => {
  it("does not surface `core` as a backend", async () => {
    const backends = await discoverBackendsFs(repoRoot);
    // `@loom/core`'s loom.kind is "core", not "backend" → must be
    // skipped by the backend walk.
    expect(backends.some((b) => (b.manifest.family as string) === "core")).toBe(false);
    // sanity: the real backend is still found.
    expect(backends.some((b) => b.manifest.family === "hono")).toBe(true);
  });
});
