import { describe, expect, it } from "vitest";
import type { SchemaSnapshot } from "../../src/ir/types/migrations-ir.js";
import { buildMigrations } from "../../src/system/migrations-builder.js";
import { memorySnapshotStore } from "../../src/system/snapshot.js";
import { buildLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T9.24 I1 — the per-module VERSION BLOCK.
//
// Every backend that serves >1 module writes all their migrations into ONE
// directory, and Ecto refuses a directory with a duplicated integer version
// prefix.  The Elixir emitter used to derive each module's slice of the
// version space from its POSITION in the migrations array — computed only on
// the generation that emits the INITIAL migration.  Consequences:
//
//   - every module's first delta came out at the SAME version
//     (`BASE_TIMESTAMP + 1`) — `ecto.migrate` aborts on the duplicate;
//   - module 1's delta sorted BEFORE its own create-table, so applying it hit
//     `relation does not exist`.
//
// The block now lives in the module's SNAPSHOT, so it is stable for the life
// of the project and a NEW module is allocated a block above every existing
// one — which is what makes inserting a module anywhere in the source safe.
// ---------------------------------------------------------------------------

const SOURCE = `
system Multi {
  subdomain Catalog {
    context Catalog {
      aggregate Project with crudish { title: string }
      repository Projects for Project { }
    }
  }
  subdomain Builds {
    context Builds {
      aggregate Build with crudish { sha: string }
      repository BuildsRepo for Build { }
    }
  }
  subdomain People {
    context People {
      aggregate Engineer with crudish { nick: string }
      repository Engineers for Engineer { }
    }
  }
  api CatalogApi from Catalog
  api BuildsApi from Builds
  api PeopleApi from People
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  resource buildsState { for: Builds, kind: state, use: primary }
  resource peopleState { for: People, kind: state, use: primary }
  deployable svc {
    platform: elixir
    contexts: [Catalog, Builds, People]
    dataSources: [catalogState, buildsState, peopleState]
    serves: CatalogApi, BuildsApi, PeopleApi
    port: 4000
  }
}
`;

async function sys() {
  const loom = await buildLoomModel(SOURCE);
  return loom.systems[0]!;
}

describe("per-module migration version blocks", () => {
  it("stamps a distinct block on every module and persists it in the snapshot", async () => {
    const migrations = buildMigrations(await sys(), memorySnapshotStore());
    const blocks = migrations.map((m) => m.next.versionBlock);
    expect(blocks).toHaveLength(3);
    expect(new Set(blocks).size).toBe(3);
    // The block shows up in the allocated VERSION, which is what the emitted
    // filenames and the snapshot's migrationHistory both use — deriving it
    // from array position inside an emitter is what broke on the second
    // generation, and made the two disagree.
    expect(migrations.map((m) => m.version)).toEqual([
      "20260101000000",
      "20260102000000",
      "20260103000000",
    ]);
  });

  it("keeps each module's block across regenerations", async () => {
    const s = await sys();
    const first = buildMigrations(s, memorySnapshotStore());
    const store = memorySnapshotStore(
      Object.fromEntries(first.map((m) => [m.module, m.next])) as Record<string, SchemaSnapshot>,
    );
    const second = buildMigrations(s, store);
    for (const m of second) {
      expect(m.next.versionBlock).toBe(first.find((f) => f.module === m.module)!.next.versionBlock);
    }
  });

  it("allocates a NEW module a block above every existing one", async () => {
    const s = await sys();
    // Only two of the three modules have been generated before; the third is
    // new.  Position would have handed it a block already in use.
    const seeded = buildMigrations(s, memorySnapshotStore()).filter((m) => m.module !== "Catalog");
    const store = memorySnapshotStore(
      Object.fromEntries(seeded.map((m) => [m.module, m.next])) as Record<string, SchemaSnapshot>,
    );
    const next = buildMigrations(s, store);
    const fresh = next.find((m) => m.module === "Catalog")!;
    const taken = seeded.map((m) => m.next.versionBlock!);
    expect(taken).not.toContain(fresh.next.versionBlock);
    expect(fresh.next.versionBlock!).toBeGreaterThan(Math.max(...taken));
    // The pre-existing modules keep theirs.
    for (const m of seeded) {
      expect(next.find((n) => n.module === m.module)!.next.versionBlock).toBe(m.next.versionBlock);
    }
  });

  it("adopts the legacy position-derived block for a snapshot written before the field existed", async () => {
    const s = await sys();
    const first = buildMigrations(s, memorySnapshotStore());
    // Strip `versionBlock` — exactly what a project generated before this
    // change carries.  Each module must keep the block its already-emitted
    // initial migrations were written with, i.e. its position.
    const legacy = Object.fromEntries(
      first.map((m) => {
        const { versionBlock: _drop, ...rest } = m.next;
        return [m.module, rest as SchemaSnapshot];
      }),
    );
    const next = buildMigrations(s, memorySnapshotStore(legacy));
    next.forEach((m, i) => {
      expect(m.next.versionBlock).toBe(i);
    });
  });
});
