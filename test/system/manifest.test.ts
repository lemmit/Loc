// Unit tests for the pure prune core (`src/system/manifest.ts`).  The CLI-level
// gate lives in `test/cli/regen-prune.test.ts`; these pin the decisions that do
// not need a disk — most importantly the ones whose failure mode is DELETING
// something, which is the only irreversible thing this feature does.

import { describe, expect, it } from "vitest";
import {
  buildManifest,
  carriedOverEntries,
  isProtectedFromPrune,
  MANIFEST_REL_PATH,
  parseManifest,
  planPrune,
  serializeManifest,
} from "../../src/system/manifest.js";

const nothingIgnored = { isIgnored: () => false, exists: () => true };

describe("manifest round-trip", () => {
  it("sorts, dedupes and survives serialise → parse", () => {
    const m = buildManifest([
      { path: "b/two.ts" },
      { path: "a/one.ts", scaffoldOnce: true },
      { path: "b/two.ts" },
    ]);
    expect(m.entries.map((e) => e.path)).toEqual(["a/one.ts", "b/two.ts"]);
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it("keeps scaffold-once when a duplicate entry drops it", () => {
    const m = buildManifest([{ path: "x.ex", scaffoldOnce: true }, { path: "x.ex" }]);
    expect(m.entries).toEqual([{ path: "x.ex", scaffoldOnce: true }]);
  });

  it("normalises backslash keys to the forward-slash form `.loomignore` speaks", () => {
    expect(buildManifest([{ path: "api\\src\\Foo.cs" }]).entries[0].path).toBe("api/src/Foo.cs");
  });

  it("reads an unreadable manifest as absent — never as a partial delete list", () => {
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest("[]")).toBeNull();
    expect(parseManifest('{"version":99,"entries":[]}')).toBeNull();
    expect(parseManifest('{"version":1}')).toBeNull();
    expect(parseManifest('{"version":1,"entries":[{"path":42}]}')).toBeNull();
    expect(parseManifest('{"version":1,"entries":[{"path":""}]}')).toBeNull();
  });
});

describe("isProtectedFromPrune", () => {
  it("protects migration files under every backend's layout", () => {
    for (const p of [
      "api/Migrations/20260101000000_M_Initial.cs",
      "api/drizzle/migrations/0000_init.sql",
      "api/priv/repo/migrations/20260101000000_init.exs",
      "api/src/main/resources/db/migration/V1.0__init.sql",
      "api/alembic/migration/0001_init.py",
    ]) {
      expect(isProtectedFromPrune(p), p).toBe(true);
    }
  });

  it("protects the snapshot baselines and the manifest itself", () => {
    expect(isProtectedFromPrune(".loom/snapshots/M.snapshot.json")).toBe(true);
    expect(isProtectedFromPrune(MANIFEST_REL_PATH)).toBe(true);
  });

  it("does not protect ordinary output — including the rest of `.loom/`", () => {
    expect(isProtectedFromPrune("web_app/src/pages/board.tsx")).toBe(false);
    expect(isProtectedFromPrune("api/Application/Issues/Commands/CommentHandler.cs")).toBe(false);
    expect(isProtectedFromPrune(".loom/wire-spec.json")).toBe(false);
    // A FILE named `migrations` is not a migration DIRECTORY.
    expect(isProtectedFromPrune("api/migrations")).toBe(false);
  });
});

describe("carriedOverEntries", () => {
  // Why this exists: backends emit only the NEWEST migration each run, so a
  // manifest built from run 2's file map alone would drop the migration entry
  // that run 1 recorded — and run 3 would add nothing back.  The manifest then
  // flips between two contents forever, is rewritten on every regen, and the
  // "a no-op regen touches no file" invariant (`test/cli/regeneration.test.ts`)
  // dies.  Carrying protected entries forward is what makes it a fixed point.
  const previous = buildManifest([
    { path: "api/Migrations/0001_init.cs" },
    { path: "api/Migrations/0002_add_col.cs" },
    { path: ".loom/snapshots/M.snapshot.json" },
    { path: "api/Program.cs" },
    { path: "api/Migrations/0000_deleted_by_hand.cs" },
  ]);

  it("carries the protected paths this run did not re-emit", () => {
    const carried = carriedOverEntries(
      previous,
      [".loom/snapshots/M.snapshot.json"],
      (p) => !p.endsWith("0000_deleted_by_hand.cs"),
    );
    expect(carried.map((e) => e.path)).toEqual([
      "api/Migrations/0001_init.cs",
      "api/Migrations/0002_add_col.cs",
    ]);
  });

  it("never carries an ordinary path — that one is a prune candidate", () => {
    const carried = carriedOverEntries(previous, [], () => true);
    expect(carried.map((e) => e.path)).not.toContain("api/Program.cs");
  });

  it("is a fixed point: entries + carry-over reproduces the same manifest", () => {
    // Run 2 emits everything run 1 did EXCEPT the migrations.
    const emitted = ["api/Program.cs", ".loom/snapshots/M.snapshot.json"];
    const next = buildManifest([
      ...emitted.map((p) => ({ path: p })),
      ...carriedOverEntries(previous, emitted, () => true),
    ]);
    expect(serializeManifest(next)).toBe(serializeManifest(previous));
  });

  it("carries nothing when there is no previous manifest", () => {
    expect(carriedOverEntries(null, [], () => true)).toEqual([]);
  });
});

describe("planPrune", () => {
  const previous = buildManifest([
    { path: "keep.ts" },
    { path: "stale.ts" },
    { path: "pinned.ts" },
    { path: "impl.ex", scaffoldOnce: true },
    { path: "api/Migrations/0001_init.cs" },
    { path: "gone-already.ts" },
  ]);

  it("removes only what the previous run owned and this one no longer emits", () => {
    const plan = planPrune(previous, ["keep.ts", "new.ts"], {
      isIgnored: (p) => p === "pinned.ts",
      exists: (p) => p !== "gone-already.ts",
    });
    expect(plan.remove).toEqual(["stale.ts"]);
    expect(plan.keptIgnored).toEqual(["pinned.ts"]);
    expect(plan.keptScaffoldOnce).toEqual(["impl.ex"]);
    expect(plan.keptProtected).toEqual(["api/Migrations/0001_init.cs"]);
  });

  it("prunes nothing at all when there is no readable previous manifest", () => {
    expect(planPrune(null, [], nothingIgnored).remove).toEqual([]);
  });

  it("cannot reach a path the previous manifest never listed", () => {
    const plan = planPrune(buildManifest([]), [], nothingIgnored);
    expect(plan.remove).toEqual([]);
  });
});
