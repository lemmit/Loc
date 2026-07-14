import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnrichedLoomModel } from "../../src/ir/types/loom-ir.js";
import type { MigrationsIR, SchemaSnapshot } from "../../src/ir/types/migrations-ir.js";
import { generateSystemsFromLoom } from "../../src/system/index.js";
import {
  checkMigrationBaseline,
  fsMigrationArtifactIndex,
  MigrationBaselineError,
  memoryMigrationArtifactIndex,
  migrationFileVersion,
} from "../../src/system/migration-artifacts.js";
import { fsSnapshotStore, snapshotRelPath } from "../../src/system/snapshot.js";
import { buildLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T2.2 — migration-baseline safety guards.
//
//   (a) refuse "Initial" when the snapshot is missing but files exist
//   (b) verify migration files ↔ snapshot history
//   (c) reject version-number reuse
// ---------------------------------------------------------------------------

// A minimal MigrationsIR for the pure-guard tests — only the fields the guard
// reads are meaningful; the rest are stubbed.
function migrationsIR(over: Partial<MigrationsIR> & Pick<MigrationsIR, "module">): MigrationsIR {
  const emptyNext: SchemaSnapshot = { schemaVersion: 1, tables: [] };
  return {
    module: over.module,
    storageName: "",
    baseline: over.baseline ?? null,
    next: over.next ?? emptyNext,
    steps: over.steps ?? [],
    version: over.version ?? "20260101000000",
    name: over.name ?? "Initial",
  };
}

function snapshotWithHistory(versions: string[]): SchemaSnapshot {
  return {
    schemaVersion: 1,
    tables: [],
    lastVersion: versions.at(-1),
    migrationHistory:
      versions.length > 0 ? versions.map((v) => ({ version: v, name: "M" })) : undefined,
  };
}

describe("migrationFileVersion — filename → version extraction", () => {
  it("reads the leading token of a `<version>_…` filename (Drizzle/Ecto/EF/Alembic)", () => {
    expect(migrationFileVersion("20260101000000_sales_initial.sql")).toBe("20260101000000");
    expect(migrationFileVersion("20260101000000_create_orders.exs")).toBe("20260101000000");
    expect(migrationFileVersion("20260101000000_Sales_Initial.cs")).toBe("20260101000000");
  });

  it("reads the Flyway `V<version>.<n>__…` shape (Java)", () => {
    expect(migrationFileVersion("V20260101000000.1__Sales_Initial.sql")).toBe("20260101000000");
  });

  it("ignores non-migration files", () => {
    expect(migrationFileVersion("_journal.json")).toBeNull();
    expect(migrationFileVersion(".gitkeep")).toBeNull();
    expect(migrationFileVersion("README.md")).toBeNull();
  });
});

describe("checkMigrationBaseline — guard (a) missing snapshot over existing files", () => {
  it("refuses Initial when files exist but the snapshot is missing", () => {
    const migrations = [migrationsIR({ module: "Sales", baseline: null })];
    const index = memoryMigrationArtifactIndex({ Sales: ["20250101000000"] });
    expect(() => checkMigrationBaseline(migrations, index)).toThrow(MigrationBaselineError);
    expect(() => checkMigrationBaseline(migrations, index)).toThrow(/re-baseline module 'Sales'/);
  });

  it("allows the re-baseline under the override flag", () => {
    const migrations = [migrationsIR({ module: "Sales", baseline: null })];
    const index = memoryMigrationArtifactIndex({ Sales: ["20250101000000"] });
    expect(() =>
      checkMigrationBaseline(migrations, index, { allowRebaseline: true }),
    ).not.toThrow();
  });

  it("is a no-op on a genuine first run (no snapshot, no files)", () => {
    const migrations = [migrationsIR({ module: "Sales", baseline: null })];
    expect(() => checkMigrationBaseline(migrations, memoryMigrationArtifactIndex())).not.toThrow();
  });
});

describe("checkMigrationBaseline — guard (b) files ↔ history drift", () => {
  it("passes when the on-disk files match the recorded history", () => {
    const migrations = [
      migrationsIR({
        module: "Sales",
        baseline: snapshotWithHistory(["20250101000000", "20250201000000"]),
        steps: [],
        version: "20250201000000",
      }),
    ];
    const index = memoryMigrationArtifactIndex({
      Sales: ["20250101000000", "20250201000000"],
    });
    expect(() => checkMigrationBaseline(migrations, index)).not.toThrow();
  });

  it("errors when a history entry has no file on disk", () => {
    const migrations = [
      migrationsIR({
        module: "Sales",
        baseline: snapshotWithHistory(["20250101000000", "20250201000000"]),
        steps: [],
      }),
    ];
    const index = memoryMigrationArtifactIndex({ Sales: ["20250101000000"] });
    expect(() => checkMigrationBaseline(migrations, index)).toThrow(/20250201000000.*absent/s);
  });

  it("tolerates untracked extra files (feature-local audit/provenance migrations)", () => {
    // Backends emit audit/provenance late migrations under fixed far-future
    // `2999…` versions that are deliberately NOT part of the version chain and
    // never appear in migrationHistory.  The history⊆files check must not flag
    // them, or every audited/provenanced system would false-positive.
    const migrations = [
      migrationsIR({
        module: "Sales",
        baseline: snapshotWithHistory(["20250101000000"]),
        steps: [],
      }),
    ];
    const index = memoryMigrationArtifactIndex({
      Sales: ["20250101000000", "29991231235959"],
    });
    expect(() => checkMigrationBaseline(migrations, index)).not.toThrow();
  });
});

describe("checkMigrationBaseline — guard (c) version reuse", () => {
  it("rejects a new migration whose version already exists on disk", () => {
    // A stale baseline: its lastVersion lags the files, so the builder
    // recomputed ...02 as the "next" version — but ...02 is already on disk
    // (a real chain migration a newer run wrote, that this stale snapshot
    // forgot).  Emitting under the same version would clobber it.
    const migrations = [
      migrationsIR({
        module: "Sales",
        // History only knows ...01 (stale); the builder computed ...02 as next.
        baseline: snapshotWithHistory(["20250101000000"]),
        steps: [{ op: "sqlComment", comment: "x" }],
        version: "20250201000000",
      }),
    ];
    const index = memoryMigrationArtifactIndex({
      // ...02 is already on disk (written by a newer run this snapshot forgot).
      Sales: ["20250101000000", "20250201000000"],
    });
    expect(() => checkMigrationBaseline(migrations, index)).toThrow(
      /version '20250201000000'.*already present/s,
    );
  });

  it("does not flag a no-op regen (no steps ⇒ no new file emitted)", () => {
    const migrations = [
      migrationsIR({
        module: "Sales",
        baseline: snapshotWithHistory(["20250101000000"]),
        steps: [],
        version: "20250101000000",
      }),
    ];
    const index = memoryMigrationArtifactIndex({ Sales: ["20250101000000"] });
    expect(() => checkMigrationBaseline(migrations, index)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fs-backed index + end-to-end wiring through `generate system`.
// ---------------------------------------------------------------------------

const SHOP_SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        total: int
      }
      repository Orders for Order { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
`;

describe("fsMigrationArtifactIndex + generate-system wiring", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  const mkTmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "loom-m-t2-2-"));
    tmpDirs.push(d);
    return d;
  };
  const writeFiles = (outDir: string, files: Map<string, string>): void => {
    for (const [rel, content] of files) {
      const full = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  };

  it("scans the owner deployable's migration files and reports their versions", async () => {
    const loom = (await buildLoomModel(SHOP_SOURCE)) as EnrichedLoomModel;
    const outDir = mkTmp();
    const first = generateSystemsFromLoom(loom, { snapshots: fsSnapshotStore(outDir) }).files;
    writeFiles(outDir, first);

    const index = fsMigrationArtifactIndex(outDir, loom);
    // The Hono/Drizzle initial migration lands under api/db/migrations/.
    expect(index.versions("Sales").length).toBeGreaterThan(0);
    expect(index.versions("Nonexistent")).toEqual([]);
  });

  it("refuses to re-baseline after the snapshot is deleted but files remain", async () => {
    const loom = (await buildLoomModel(SHOP_SOURCE)) as EnrichedLoomModel;
    const outDir = mkTmp();

    // First generate → writes migration files + the snapshot.
    const first = generateSystemsFromLoom(loom, {
      snapshots: fsSnapshotStore(outDir),
      existingMigrations: fsMigrationArtifactIndex(outDir, loom),
    }).files;
    writeFiles(outDir, first);
    expect(fs.existsSync(path.join(outDir, snapshotRelPath("Sales")))).toBe(true);

    // Snapshot lost (e.g. an unresolved merge deleted it), files remain.
    fs.rmSync(path.join(outDir, snapshotRelPath("Sales")));

    // Regenerate: the snapshot reads null → Initial, but files exist ⇒ refuse.
    expect(() =>
      generateSystemsFromLoom(loom, {
        snapshots: fsSnapshotStore(outDir),
        existingMigrations: fsMigrationArtifactIndex(outDir, loom),
      }),
    ).toThrow(MigrationBaselineError);

    // The override lets it through.
    expect(() =>
      generateSystemsFromLoom(loom, {
        snapshots: fsSnapshotStore(outDir),
        existingMigrations: fsMigrationArtifactIndex(outDir, loom),
        allowRebaseline: true,
      }),
    ).not.toThrow();
  });

  it("stays a no-op when no on-disk inventory is supplied (web playground path)", async () => {
    const loom = (await buildLoomModel(SHOP_SOURCE)) as EnrichedLoomModel;
    const outDir = mkTmp();
    const first = generateSystemsFromLoom(loom, { snapshots: fsSnapshotStore(outDir) }).files;
    writeFiles(outDir, first);
    fs.rmSync(path.join(outDir, snapshotRelPath("Sales")));
    // No `existingMigrations` ⇒ guards skipped ⇒ silent re-baseline (the old
    // behaviour, preserved for callers with no real output tree).
    expect(() =>
      generateSystemsFromLoom(loom, { snapshots: fsSnapshotStore(outDir) }),
    ).not.toThrow();
  });
});
