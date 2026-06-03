import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyPatches, generate, validate } from "../../src/api/index.js";

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
