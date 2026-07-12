// `loom.union-find-shape-unsupported` — the producer-side shape gate for
// union-returning finds (payload-transport-layer.md P4 producer side;
// absence semantics per exception-less.md).  A find is declarative, so the
// only derivable producer logic is absence: the supported v1 shape is the
// repository's aggregate + one absent variant (`none`, or an `error` payload
// whose only permitted field is `resource: string`).  Anything else used to
// produce runtime stubs (NotImplementedException on .NET, an untagged body on
// Hono) and is now rejected at validate time — including on elixir (vanilla)
// contexts, which emit the absence producer (`find-controller.ts`) like
// node/dotnet.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.union-find-shape-unsupported";

const loose = (decls: string, ret: string): string => `
  context C {
    aggregate Order { code: string }
    aggregate Cancel { reason: string }
    ${decls}
    repository Orders for Order { find f(): ${ret} }
  }
`;

const sysWith = (platform: string, decls: string, ret: string): string => `
  system S {
    subdomain D {
      context C {
        aggregate Order { code: string }
        aggregate Cancel { reason: string }
        ${decls}
        repository Orders for Order { find f(): ${ret} }
      }
    }
    storage pg { type: postgres }
    resource cState { for: C, kind: state, use: pg }
    deployable api { platform: ${platform}, contexts: [C], dataSources: [cState], port: 4000 }
  }`;

async function codesFor(src: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.code === CODE)
    .map((d) => d.message);
}

describe("union finds — producer shape gate", () => {
  it("accepts `Agg or <fieldless error>`", async () => {
    expect(await codesFor(loose("error Missing { }", "Order or Missing"))).toEqual([]);
  });

  it("accepts `Agg or NotFound` with the conventional resource field", async () => {
    expect(
      await codesFor(loose("error NotFound { resource: string }", "Order or NotFound")),
    ).toEqual([]);
  });

  it("accepts `Agg option` (none → 404)", async () => {
    expect(await codesFor(loose("", "Order option"))).toEqual([]);
  });

  it("rejects aggregate-or-aggregate (no derivable producer)", async () => {
    const msgs = await codesFor(loose("", "Order or Cancel"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("absent variant");
  });

  it("rejects three-plus variants", async () => {
    const msgs = await codesFor(
      loose("error NotFound { resource: string }", "Order or NotFound option"),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("exactly two variants");
  });

  it("rejects an error payload with an under-derivable field", async () => {
    const msgs = await codesFor(loose("error Oops { code: int }", "Order or Oops"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("resource: string");
  });

  it("enforces on an elixir (vanilla) context — vanilla emits the absence producer", async () => {
    const msgs = await codesFor(sysWith("elixir", "", "Order or Cancel"));
    expect(msgs).toHaveLength(1);
  });

  it("enforces on a node-hosted context", async () => {
    const msgs = await codesFor(sysWith("node", "", "Order or Cancel"));
    expect(msgs).toHaveLength(1);
  });
});
