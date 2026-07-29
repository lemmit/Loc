import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyPatches, diff, generate, snapshot, validate } from "../../src/api/index.js";

// ---------------------------------------------------------------------------
// The transport-neutral toolkit API (src/api/) — the one core every surface
// (CLI, MCP, LSP, web) shares.  Exercised directly here (no subprocess); the
// CLI tests cover the thin argv/stdout wrapper.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const CLEAN = `context Sales {
  aggregate Order {
    total: int
  }
}
`;

const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

describe("toolkit: validate", () => {
  it("a clean source is ok with a populated outline", async () => {
    const r = await validate(CLEAN);
    expect(r.ok).toBe(true);
    expect(r.summary.errors).toBe(0);
    expect(r.outline.contexts.find((c) => c.name === "Sales")).toBeDefined();
  });

  it("a bad source is not ok and carries a coded diagnostic with a fixHint", async () => {
    const r = await validate(BARE, { path: "m.ddd" });
    expect(r.ok).toBe(false);
    expect(r.model).toBe("m.ddd");
    const bare = r.diagnostics.find((d) => d.code === "loom.bare-aggregate-in-type");
    expect(bare?.fixHint?.patch?.op).toBe("replace");
  });
});

describe("toolkit: generate", () => {
  it("reports the deployable manifest for a system source", async () => {
    const acme = fs.readFileSync(path.join(repoRoot, "examples", "acme.ddd"), "utf8");
    const r = await generate(acme);
    expect(r.ok).toBe(true);
    expect(r.deployables.length).toBeGreaterThan(0);
    for (const d of r.deployables) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.platform).toBe("string");
      expect(typeof d.port).toBe("number");
    }
  });

  it("a bad source is not ok and lists no deployables", async () => {
    const r = await generate(BARE);
    expect(r.ok).toBe(false);
    expect(r.deployables).toEqual([]);
  });
});

// A minimal two-deployable system with a SQL backend, in two versions: `SYS_V2`
// adds an optional `note` column to `SYS_V1` — an additive, non-destructive
// change (the reverse direction drops it, which is destructive).
const SYS_V1 = `system Shop {
  storage primary { type: postgres }
  deployable api { platform: node, contexts: [Sales] }

  subdomain Selling {
    context Sales {
      aggregate Order with crudish {
        reference: string
        total: int
      }
      repository Orders for Order { }
    }
  }
}
`;

const SYS_V2 = SYS_V1.replace(
  "        total: int\n",
  "        total: int\n        note: string?\n",
);

describe("toolkit: diff (evolution)", () => {
  it("an added optional field is an additive, non-breaking migration + wire change", async () => {
    const r = await diff(SYS_V2, SYS_V1);
    expect(r.ok).toBe(true);
    expect(r.hasBaseline).toBe(true);
    expect(r.breaking).toBe(false);
    const mig = r.migrations.find((m) => m.steps.some((s) => s.op === "addColumn"));
    expect(mig).toBeDefined();
    expect(mig?.destructive).toBe(false);
    expect(mig?.steps.some((s) => /note/i.test(s.sql))).toBe(true);
    const wc = r.wireChanges.find((c) => c.field === "note");
    expect(wc?.breaking).toBe(false);
  });

  it("dropping a field is a destructive, breaking migration", async () => {
    const r = await diff(SYS_V1, SYS_V2);
    expect(r.ok).toBe(true);
    expect(r.breaking).toBe(true);
    const mig = r.migrations.find((m) => m.steps.some((s) => s.op === "dropColumn"));
    expect(mig?.destructive).toBe(true);
    expect(typeof mig?.destructiveMessage).toBe("string");
  });

  it("with no baseline every system reads Initial and the wire diff is skipped", async () => {
    const r = await diff(SYS_V2);
    expect(r.ok).toBe(true);
    expect(r.hasBaseline).toBe(false);
    expect(r.migrations.every((m) => m.name === "Initial")).toBe(true);
    expect(r.wireChanges).toEqual([]);
  });

  it("a source with no system block is ok but has nothing to evolve", async () => {
    const r = await diff(CLEAN);
    expect(r.ok).toBe(true);
    expect(r.migrations).toEqual([]);
    expect(r.diagnostics.some((d) => d.code === "loom.no-system")).toBe(true);
  });

  it("a broken current source is not ok and carries its diagnostics", async () => {
    const r = await diff(BARE);
    expect(r.ok).toBe(false);
    expect(r.migrations).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("toolkit: snapshot (provenance capture)", () => {
  it("captures a rule snapshot for a model with a provenanced field", async () => {
    const prov = fs.readFileSync(
      path.join(repoRoot, "web", "src", "examples", "provenance-system.ddd"),
      "utf8",
    );
    const r = await snapshot(prov);
    expect(r.ok).toBe(true);
    expect(r.files.length).toBeGreaterThan(0);
    for (const f of r.files) {
      expect(f.path).toMatch(/\.loom\/snapshots\/.*\.loomsnap\.json$/);
      expect(() => JSON.parse(f.content)).not.toThrow();
    }
  });

  it("a model with no provenanced field captures nothing (still ok)", async () => {
    const r = await snapshot(SYS_V2);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
  });
});

describe("toolkit: validate → fixHint → applyPatches → validate (closed loop)", () => {
  it("applying the fix yields a clean model", async () => {
    const before = await validate(BARE);
    const patches = before.diagnostics
      .map((d) => d.fixHint?.patch)
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    const applied = await applyPatches(BARE, patches);
    expect(applied.ok).toBe(true);
    const after = await validate(applied.text);
    expect(after.ok).toBe(true);
  });
});
