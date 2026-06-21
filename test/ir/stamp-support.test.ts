import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";

// Lifecycle-stamp backend support.  Every backend now applies `contextStamps`
// (java / dotnet entity hooks + interceptor, node Hono write hooks, python
// persist-time stamping, elixir Ash `change` blocks), each guarded by its own
// `validateXStampSupport` for the fail-fast cases (principal stamp without auth,
// event-sourced aggregate).  The one remaining "not wired" case is the elixir
// **vanilla** (plain Ecto) foundation, which still gates loudly
// (`loom.elixir-stamp-unsupported`) rather than emitting unpopulated columns.

const src = (platformDecl: string) => `
  system PS {
    user { id: guid  name: string }
    subdomain D { context Shop {
      aggregate Order with auditable { code: string }
      repository Orders for Order { }
    }}
    api A from D
    storage primary { type: postgres }
    resource st { for: Shop, kind: state, use: primary }
    deployable api { platform: ${platformDecl}, contexts: [Shop], dataSources: [st], serves: A, port: 8081, auth: required }
  }
`;

describe("lifecycle-stamp backend support gate", () => {
  it.each([
    "dotnet",
    "java",
    "node",
    "python",
    "elixir",
  ])("does NOT gate `with auditable` on the %s backend", async (platform) => {
    const loom = await buildLoomModel(src(platform));
    const stampErrors = validateLoomModel(loom).filter((d) =>
      /stamp-unsupported$/.test(d.code ?? ""),
    );
    expect(stampErrors).toEqual([]);
  });

  it("gates `with auditable` on the elixir vanilla foundation fail-fast", async () => {
    const loom = await buildLoomModel(src("elixir { foundation: vanilla }"));
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.elixir-stamp-unsupported",
    );
    expect(errors.length, "expected a loom.elixir-stamp-unsupported diagnostic").toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("vanilla");
  });

  it("a stamp-free aggregate on node is clean", async () => {
    const loom = await buildLoomModel(`
      system PS {
        subdomain D { context Shop {
          aggregate Order { code: string }
          repository Orders for Order { }
        }}
        api A from D
        storage primary { type: postgres }
        resource st { for: Shop, kind: state, use: primary }
        deployable api { platform: node, contexts: [Shop], dataSources: [st], serves: A, port: 8081 }
      }
    `);
    const stampErrors = validateLoomModel(loom).filter((d) =>
      /stamp-unsupported$/.test(d.code ?? ""),
    );
    expect(stampErrors).toEqual([]);
  });
});
