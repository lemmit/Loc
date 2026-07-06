import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";

// Lifecycle-stamp backend support.  Every backend now applies `contextStamps`
// (java / dotnet entity hooks + interceptor, node Hono write hooks, python
// persist-time stamping, elixir Ash `change` blocks AND vanilla Ecto changeset
// `put_change`s), each guarded by its own `validateXStampSupport` for the
// fail-fast cases (a principal stamp without auth → no actor to read; a stamp on
// an event-sourced aggregate → state is folded from events).  The elixir vanilla
// foundation now applies stamps just like Ash, so it is no longer fully gated —
// only the two fail-fast cases remain (and they apply to vanilla too).

const src = (platformDecl: string, authLine = ", auth: required") => `
  system PS {
    user { id: guid  name: string }
    subdomain D { context Shop {
      aggregate Order with auditable { code: string }
      repository Orders for Order { }
    }}
    api A from D
    storage primary { type: postgres }
    resource st { for: Shop, kind: state, use: primary }
    deployable api { platform: ${platformDecl}, contexts: [Shop], dataSources: [st], serves: A, port: 8081${authLine} }
  }
`;

describe("lifecycle-stamp backend support gate", () => {
  it.each([
    "dotnet",
    "java",
    "node",
    "python",
    "elixir",
    "elixir",
  ])("does NOT gate `with auditable` (authed) on the %s backend", async (platform) => {
    const loom = await buildLoomModel(src(platform));
    const stampErrors = validateLoomModel(loom).filter((d) =>
      /stamp-unsupported$/.test(d.code ?? ""),
    );
    expect(stampErrors).toEqual([]);
  });

  // `with auditable` references `currentUser` (createdBy/updatedBy := currentUser),
  // so a deployable WITHOUT auth has no request actor to stamp from — still a
  // fail-fast on the elixir vanilla foundation (and on Ash), the principal-
  // without-auth case that survives the gate removal.
  it("gates a principal stamp WITHOUT auth on the elixir vanilla foundation", async () => {
    const loom = await buildLoomModel(src("elixir", ""));
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.elixir-stamp-unsupported",
    );
    expect(errors.length, "expected a loom.elixir-stamp-unsupported diagnostic").toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("currentUser");
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
