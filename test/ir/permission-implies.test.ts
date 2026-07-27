// Permission `implies` — closure stamped on the IR + `contains` gate expanded
// to accept a broader permission (authorization.md §6, M-T3.2 item 7).

import { describe, expect, it } from "vitest";
import type { ExprIR, StmtIR } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/ir.js";

const SRC = `
system P {
  user { id: string  permissions: string[] }
  subdomain M {
    permissions { read, edit implies read, approve implies edit }
    context C {
      aggregate Order with crudish {
        status: string
        operation viewIt() requires currentUser.permissions.contains(permissions.read) { status := "x" }
      }
    }
  }
}`;

/** Collect every string literal appearing anywhere in an ExprIR tree. */
function stringLits(e: ExprIR, out: string[] = []): string[] {
  if (e.kind === "literal" && e.lit === "string") out.push(String(e.value));
  for (const v of Object.values(e as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === "object") stringLits(x as ExprIR, out);
    } else if ("kind" in (v as object)) {
      stringLits(v as ExprIR, out);
    }
  }
  return out;
}

describe("permission implies — IR closure + gate expansion", () => {
  it("stamps impliedBy runtime strings on the catalogue", async () => {
    const ir = await buildLoomModel(SRC);
    const perms = ir.systems[0]!.subdomains[0]!.permissions;
    const read = perms.find((p) => p.name === "read")!;
    // read is implied (transitively) by edit and approve
    expect(read.impliedBy?.sort()).toEqual(["m.approve", "m.edit"]);
    const edit = perms.find((p) => p.name === "edit")!;
    expect(edit.impliedBy).toEqual(["m.approve"]);
    const approve = perms.find((p) => p.name === "approve")!;
    expect(approve.impliedBy).toBeUndefined(); // nothing implies approve
  });

  it("expands a `contains(read)` gate to accept read || edit || approve", async () => {
    const ir = await buildLoomModel(SRC);
    const op = ir.systems[0]!.subdomains[0]!.contexts[0]!.aggregates[0]!.operations.find(
      (o) => o.name === "viewIt",
    )!;
    const gate = op.statements.find((s: StmtIR) => s.kind === "requires");
    expect(gate).toBeDefined();
    const lits = new Set(stringLits((gate as { expr: ExprIR }).expr));
    expect(lits.has("m.read")).toBe(true);
    expect(lits.has("m.edit")).toBe(true);
    expect(lits.has("m.approve")).toBe(true);
  });
});
