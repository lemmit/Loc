import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";

// Lifecycle-stamp rejections.  Every backend applies `contextStamps` (java /
// dotnet entity hooks + interceptor, node Hono write hooks, python persist-time
// stamping, elixir vanilla Ecto changeset `put_change`s) — the MECHANISMS
// differ, but the two rejections do not.
//
// M-T6.33 re-verified them and found neither arm is backend-specific: the check
// reads only `dep.auth`, `sys.user` and `agg.persistedAs`.  So the five
// per-backend `validateXStampSupport` functions (and their five
// `loom.<backend>-stamp-unsupported` codes) collapsed to ONE
// `validateStampSupport` and two codes named for what they mean:
//
//   loom.stamp-principal-without-auth   — a principal stamp on a deployable
//     with no auth.  There is no principal to read: a misuse, not a gap.
//   loom.stamp-on-event-sourced-invalid — a stamp on an event-sourced
//     aggregate.  Stamps mutate state fields; an event-sourced aggregate's
//     state is folded from its event stream.  Impossible, not a gap.
//
// Because the arms are now backend-independent, THIS file is where they are
// covered per-arm; the per-backend generator suites keep only the cases that
// exercise their own emitter.

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
    const stampErrors = validateLoomModel(loom).filter((d) => /^loom\.stamp-/.test(d.code ?? ""));
    expect(stampErrors).toEqual([]);
  });

  // `with auditable` references `currentUser` (createdBy/updatedBy := currentUser),
  // so a deployable WITHOUT auth has no request actor to stamp from — still a
  // fail-fast on the elixir vanilla foundation (and on Ash), the principal-
  // without-auth case that survives the gate removal.
  it("gates a principal stamp WITHOUT auth on the elixir vanilla foundation", async () => {
    const loom = await buildLoomModel(src("elixir", ""));
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.stamp-principal-without-auth",
    );
    expect(
      errors.length,
      "expected a loom.stamp-principal-without-auth diagnostic",
    ).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("currentUser");
  });

  // The event-sourced arm, per-backend.  It was covered only in three of the
  // five generator suites before M-T6.33 (dotnet and java tested the principal
  // arm only) — with one shared body now, the arm belongs here and applies to
  // every family alike.
  it.each([
    "dotnet",
    "java",
    "node",
    "python",
    "elixir",
  ])("gates a lifecycle stamp on an event-sourced aggregate (%s)", async (platform) => {
    const loom = await buildLoomModel(
      src(platform).replace(
        "aggregate Order with auditable { code: string }",
        "aggregate Order persistedAs: eventLog with auditable { code: string }",
      ),
    );
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.stamp-on-event-sourced-invalid",
    );
    expect(
      errors.length,
      `expected a loom.stamp-on-event-sourced-invalid diagnostic on ${platform}`,
    ).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("folded from its event stream");
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
    const stampErrors = validateLoomModel(loom).filter((d) => /^loom\.stamp-/.test(d.code ?? ""));
    expect(stampErrors).toEqual([]);
  });
});
