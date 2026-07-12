// Tier-0 honest-gate guard.  Per-operation audit-record emission (`operation …
// audited`) AND audited LIFECYCLE actions (audited create / destroy) are
// implemented on the Hono (node), .NET (dotnet), Java (java) and Python (python)
// backends; on phoenix the modifier is inert, so an `audited` operation or
// lifecycle action hosted there silently records nothing.  The validator rejects
// that mismatch with loom.audited-backend-unsupported.
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
      aggregate Order {
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

  it("accepts an audited operation on an elixir (vanilla) deployable (audit runtime ported)", async () => {
    const src = sys("elixir");
    expect(await auditErrors(src)).toEqual([]);
  });

  it("does not fire for a non-audited operation on .NET", async () => {
    const src = sys("dotnet").replace("audited ", "");
    expect(await auditErrors(src)).toEqual([]);
  });
});

// Audited LIFECYCLE actions (`create(...) audited` / `destroy audited`) ship on
// node / dotnet / java / python — each backend's create/destroy handler stages
// the lifecycle audit row (before:null/after=wire on create; before=wire/
// after:null on destroy) in the lifecycle transaction.  Phoenix (elixir) stays
// uninstrumented, so AUDIT_LIFECYCLE_BACKENDS = {node,dotnet,java,python} rejects
// exactly an audited lifecycle action hosted on elixir.
function lifecycleSys(platform: string): string {
  return `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order {
        status: string
        create(status: string) audited { status := status }
        destroy audited { }
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

describe("audited-lifecycle capability validation", () => {
  it("accepts audited create/destroy on a Hono (node) deployable", async () => {
    expect(await auditErrors(lifecycleSys("node"))).toEqual([]);
  });

  it("accepts audited lifecycle actions on a .NET deployable (ported)", async () => {
    expect(await auditErrors(lifecycleSys("dotnet"))).toEqual([]);
  });

  it("accepts audited lifecycle actions on a Java deployable (ported)", async () => {
    expect(await auditErrors(lifecycleSys("java"))).toEqual([]);
  });

  it("accepts audited lifecycle actions on a Python deployable (ported)", async () => {
    expect(await auditErrors(lifecycleSys("python"))).toEqual([]);
  });

  it("accepts audited lifecycle actions on an elixir (vanilla) deployable (ported)", async () => {
    const src = lifecycleSys("elixir");
    expect(await auditErrors(src)).toEqual([]);
  });

  it("does not fire for non-audited lifecycle actions on Java", async () => {
    const src = lifecycleSys("java").replaceAll("audited ", "");
    expect(await auditErrors(src)).toEqual([]);
  });
});
