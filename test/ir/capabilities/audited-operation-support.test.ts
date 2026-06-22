// Tier-0 honest-gate guard.  Per-operation audit-record emission (`operation …
// audited`) is implemented on the Hono (node), .NET (dotnet), Java (java) and
// Python (python) backends; on phoenix the modifier is inert, so an `audited`
// operation hosted there silently records nothing.  The validator rejects that
// mismatch with loom.audited-backend-unsupported.  Audited LIFECYCLE actions
// (audited create / destroy) stay node-only (the other backends' create/destroy
// handlers aren't instrumented).
//
// Note: this gates the per-operation `audited` flag only — the `with audit`
// capability macro (context stamps) is a separate concern and is NOT gated here.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { parseString } from "../../_helpers/parse.js";

async function auditErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.audited-backend-unsupported")
    .map((d) => d.message);
}

function sys(platform: string): string {
  return `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order ids guid {
        status: string
        operation cancel() audited { status := "cancelled" }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Ordering], dataSources: [ordersState], port: 4000 }
}
`;
}

describe("audited-operation capability validation", () => {
  it("accepts an audited operation on a Hono (node) deployable", async () => {
    expect(await auditErrors(sys("node"))).toEqual([]);
  });

  it("accepts an audited operation on a .NET deployable (audit runtime ported)", async () => {
    expect(await auditErrors(sys("dotnet"))).toEqual([]);
  });

  it("accepts an audited operation on a Java deployable (audit runtime ported)", async () => {
    expect(await auditErrors(sys("java"))).toEqual([]);
  });

  it("accepts an audited operation on a Python deployable (audit runtime ported)", async () => {
    expect(await auditErrors(sys("python"))).toEqual([]);
  });

  it("rejects an audited operation on a Phoenix deployable (no audit emission)", async () => {
    const errs = await auditErrors(sys("elixir"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("audit-record emission");
  });

  it("does not fire for a non-audited operation on .NET", async () => {
    const src = sys("dotnet").replace("audited ", "");
    expect(await auditErrors(src)).toEqual([]);
  });
});
