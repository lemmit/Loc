// M-T3.9 — the .NET audit trail recorded whatever the WRITER was allowed to see.
//
// `mask unless` redacts a field on the read path by testing the REQUEST's
// principal.  The audited-operation handler built its `__before` / `__after`
// snapshots with the very same projection, so the audit row's content depended
// on who performed the write: the same `bump()` run by an HR user recorded the
// salary and run by anyone else recorded `null` — for the exact field the audit
// exists to evidence, and with no signal that anything was withheld.
//
// An audit record is not an API read (it is never returned to the actor who
// produced it — reading it back goes through the history query, which masks
// there), so it projects UNMASKED.  Four sites: create, destroy, the audited
// operation's before/after pair, and the workflow's inline audited op-call.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system MaskAudit {
  user { id: guid  role: string }

  subdomain S {
    context Ord {
      aggregate Order audited {
        code: string
        salary: int mask unless currentUser.role == "hr"
        create(code: string) { }
        destroy { }
        operation bump() {
          salary := salary + 1
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdApi from S
  storage primary { type: postgres }
  resource ordState { for: Ord, kind: state, use: primary }
  deployable d {
    platform: dotnet
    contexts: [Ord]
    dataSources: [ordState]
    serves: OrdApi
    port: 4000
    auth: required
  }
}
`;

function bySuffix(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

/** The mask wrap's signature in emitted C#. */
const MASK = "CurrentUser is { } __maskUser";

describe(".NET audit snapshots project unmasked", () => {
  it("the operation's before/after pair records the real value", async () => {
    const h = bySuffix(await generateSystemFiles(SRC), "Commands/BumpHandler.cs");
    expect(h).toContain("var __before = ");
    expect(h).toContain("var __after = ");
    expect(h).toContain("new OrderResponse(aggregate.Id.Value, aggregate.Code, aggregate.Salary,");
    expect(h, "the audit snapshot still redacts by the writer's principal").not.toContain(MASK);
  });

  it("the create handler's After snapshot is unmasked too", async () => {
    const h = bySuffix(await generateSystemFiles(SRC), "Commands/CreateOrderHandler.cs");
    expect(h).toContain("_audit.Stage(new AuditRecord");
    expect(h).not.toContain(MASK);
  });

  it("the destroy handler's Before snapshot is unmasked too", async () => {
    const h = bySuffix(await generateSystemFiles(SRC), "Commands/DestroyOrderHandler.cs");
    expect(h).toContain("_audit.Stage(new AuditRecord");
    expect(h).not.toContain(MASK);
  });

  it("the READ path still masks — this is an audit-only exemption", async () => {
    const q = bySuffix(await generateSystemFiles(SRC), "Queries/GetOrderByIdHandler.cs");
    expect(q).toContain(MASK);
    expect(q).toContain('__maskUser0.Role == "hr"');
  });

  it("reading the audit trail back still masks — the redaction moved, it did not vanish", async () => {
    const h = bySuffix(await generateSystemFiles(SRC), "Queries/GetOrderHistoryHandler.cs");
    expect(h).toContain(MASK);
  });
});
