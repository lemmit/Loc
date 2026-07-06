import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `match await` error-variant naming scope (async-actions-and-effects.md
// Stage 2 — error side).  A context-local `error` variant is NOT globally
// exported (context payloads stay context-scoped so they don't leak across
// contexts), but a `match await <api>.<Agg>.<op>() { … }` arm must still be
// able to NAME it.  The scope provider (ddd-scope.ts) widens the arm's type
// scope to the payload/error decls of the bounded contexts the enclosing ui's
// `api X: Y` handles bind to — the page can only match errors from contexts it
// actually talks to.
// ---------------------------------------------------------------------------

const deployable = `
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  deployable phoenixApp {
    platform: elixir
    contexts: [C]
    dataSources: [cState]
    serves: CApi
    ui: Web { C: phoenixApp }
    port: 4000
  }
`;

describe("scope: match-await error-variant naming", () => {
  it("resolves a context-local error variant named in a UI match-await arm", async () => {
    const { errors } = await parseString(`
      system Demo {
        subdomain S { context C {
          error Failed { reason: string }
          aggregate Order { code: string
            operation confirm(): Order or Failed { return Failed { reason: code } }
          }
        } }
        api CApi from S
        ui Web {
          api C: CApi
          page Detail {
            route: "/orders/:id"
            state { message: string = "" }
            action submit() {
              match await C.Order.confirm() {
                Order o  => { message := o.code }
                Failed f => { message := f.reason }
              }
            }
            body: Stack { Button { "Go", onClick: submit } }
          }
        }
        ${deployable}
      }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("does NOT leak an error from a context the ui's api handles do not bind", async () => {
    // `Other` lives in context D, which the page's `api C: CApi` never binds —
    // so naming it in the arm must still fail to resolve (no global leak).
    const { errors } = await parseString(`
      system Demo {
        subdomain S { context C {
          error Failed { reason: string }
          aggregate Order { code: string
            operation confirm(): Order or Failed { return Failed { reason: code } }
          }
        } }
        subdomain T { context D {
          error Other { note: string }
          aggregate Thing { label: string }
        } }
        api CApi from S
        ui Web {
          api C: CApi
          page Detail {
            route: "/orders/:id"
            state { message: string = "" }
            action submit() {
              match await C.Order.confirm() {
                Order o => { message := o.code }
                Other x => { message := x.note }
              }
            }
            body: Stack { Button { "Go", onClick: submit } }
          }
        }
        ${deployable}
      }
    `);
    expect(errors.some((e) => e.includes("Other"))).toBe(true);
  });
});
