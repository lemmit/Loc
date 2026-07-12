// IR-level validation + lowering for named-action references (named-actions-
// and-stores.md, Proposal A Stage 1, Fixes 1/3/4/5).
//
//  - Fix 1  action→action calls lower to `target: "action"` (not
//           `private-operation`); a 3-action chain stays resolved.
//  - Fix 3  `loom.unresolved-action-ref`: a handler-slot ref (`onRowClick:
//           ghost`) or a bare body call matching no sibling action / function.
//  - Fix 4  action bodies get the same IR checks (params in scope).
//  - Fix 5  `loom.missing-effect-marker` (async-actions-and-effects.md Stage 2b,
//           was `loom.action-requires-await`): a BARE remote mutating command
//           inline in an action body is an ERROR (mark it `await`); an
//           `await`-marked op (a `match await` subject) is accepted.
//
// IR diagnostics come from `validateLoomModel` over the lowered+enriched model
// (the `buildLoomModel` helper asserts the AST is clean first).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { StmtIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Parse → assert no AST errors → lower → enrich → validate; return only the
 *  named-action IR diagnostic codes (filtering ambient diags like storage
 *  warnings from a deliberately minimal system). */
async function actionDiags(source: string): Promise<string[]> {
  const { model, errors } = await parseString(source);
  expect(errors, `unexpected AST errors:\n${errors.join("\n")}`).toEqual([]);
  const loom = enrichLoomModel(lowerModel(model));
  return validateLoomModel(loom)
    .map((d) => d.code)
    .filter((c) => c === "loom.unresolved-action-ref" || c === "loom.missing-effect-marker");
}

async function buildPage(source: string) {
  const { model, errors } = await parseString(source);
  expect(errors, `unexpected AST errors:\n${errors.join("\n")}`).toEqual([]);
  const loom = enrichLoomModel(lowerModel(model));
  return loom.systems[0]!.uis[0]!.pages.find((p) => p.name === "P")!;
}

// A system with an aggregate carrying a PUBLIC mutating `confirm()` operation,
// a repository finder, and an api-handle binding (`C.Order.*`) so the await
// check's Pattern E (`Order.confirm`) and Pattern B (`C.Order.confirm`) both
// have a resolvable target.
const withApi = (
  action: string,
  extra = "",
  body = `body: Stack { Button { "Go", onClick: go } }`,
) => `
  system Demo {
    subdomain S {
      context C {
        aggregate Order {
          code: string
          status: string
          operation confirm() { status := "confirmed" }
        }
        repository Orders for Order {
          find active(): Order[] where this.status == "confirmed"
        }
      }
    }
    api CApi from S
    ui Web {
      api C: CApi
      ${extra}
      page P {
        route: "/p"
        ${action}
        ${body}
      }
    }
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: CApi, port: 3000 }
    deployable web {
      platform: react
      targets: api
      ui: Web { C: api }
      port: 3001
    }
  }
`;

describe("action→action lowering (Fix 1)", () => {
  it('lowers a bare sibling-action call to `target: "action"` (not private-operation)', async () => {
    const page = await buildPage(`
      system Demo {
        subdomain S { context C { aggregate Order { code: string } repository Orders for Order {} } }
        ui Web {
          page P {
            route: "/p"
            state { n: int = 0 }
            action go() { bump() }
            action bump() { n := n + 1 }
            body: Stack { Button { "Go", onClick: go } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Web, port: 3001 }
      }
    `);
    const go = page.actions.find((a) => a.name === "go")!;
    const call = go.body[0] as Extract<StmtIR, { kind: "call" }>;
    expect(call.kind).toBe("call");
    expect(call.target).toBe("action");
    expect(call.name).toBe("bump");
  });

  it("keeps a non-matching bare call as a function / private-operation (no over-capture)", async () => {
    const page = await buildPage(`
      system Demo {
        subdomain S { context C { aggregate Order { code: string } repository Orders for Order {} } }
        ui Web {
          page P {
            route: "/p"
            state { n: int = 0 }
            action go() { helper() }
            body: Stack { Button { "Go", onClick: go } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Web, port: 3001 }
      }
    `);
    const go = page.actions.find((a) => a.name === "go")!;
    const call = go.body[0] as Extract<StmtIR, { kind: "call" }>;
    // `helper` is no sibling action — it stays a backend-shaped call.
    expect(call.target).not.toBe("action");
    expect(call.target).toBe("private-operation");
  });

  it('resolves a 3-action transitive chain A→B→C, each arm a `target: "action"` call', async () => {
    const page = await buildPage(`
      system Demo {
        subdomain S { context C { aggregate Order { code: string } repository Orders for Order {} } }
        ui Web {
          page P {
            route: "/p"
            state { n: int = 0 }
            action a() { b() }
            action b() { c() }
            action c() { n := n + 1 }
            body: Stack { Button { "A", onClick: a } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Web, port: 3001 }
      }
    `);
    const a = page.actions.find((x) => x.name === "a")!;
    const b = page.actions.find((x) => x.name === "b")!;
    expect((a.body[0] as Extract<StmtIR, { kind: "call" }>).target).toBe("action");
    expect((a.body[0] as Extract<StmtIR, { kind: "call" }>).name).toBe("b");
    expect((b.body[0] as Extract<StmtIR, { kind: "call" }>).target).toBe("action");
    expect((b.body[0] as Extract<StmtIR, { kind: "call" }>).name).toBe("c");
  });
});

describe("loom.unresolved-action-ref (Fix 3)", () => {
  it("fires on a handler-slot ref naming no sibling action (`onRowClick: ghost`)", async () => {
    const diags = await actionDiags(
      withApi(`action go() { toast("x") }`, ``, `body: Stack { Table { onRowClick: ghost } }`),
    );
    expect(diags).toContain("loom.unresolved-action-ref");
  });

  it("fires on a bare body call matching no sibling action (`ghost()`)", async () => {
    const diags = await actionDiags(withApi(`action go() { ghost() }`));
    expect(diags).toContain("loom.unresolved-action-ref");
  });

  it("does NOT fire on a valid handler-slot ref to a real sibling action", async () => {
    const diags = await actionDiags(
      withApi(
        `state { n: int = 0 }  action go() { n := n + 1 }`,
        ``,
        `body: Stack { Table { onRowClick: go } }`,
      ),
    );
    expect(diags).not.toContain("loom.unresolved-action-ref");
  });

  it("does NOT fire on a sibling-action body call (that's Fix 1, not an unresolved ref)", async () => {
    const diags = await actionDiags(
      withApi(`state { n: int = 0 }  action go() { other() }  action other() { n := n + 1 }`),
    );
    expect(diags).not.toContain("loom.unresolved-action-ref");
  });

  it("does NOT fire on a UI extern-function call in an action body (`ui.functions` exclusion)", async () => {
    const diags = await actionDiags(
      withApi(
        `action go() { initials("x") }`,
        `function initials(name: string): string extern from "./helpers/initials"`,
      ),
    );
    expect(diags).not.toContain("loom.unresolved-action-ref");
  });

  // View-effect builtins (`toast(…)` / `navigate(…)`) resolve against the page's
  // own imports and lower to a `target: "private-operation"` bare call; the
  // body-call check excludes them (`VIEW_EFFECT_BUILTINS`) so an action that
  // shows a toast or navigates never falsely fires `loom.unresolved-action-ref`.
  it("does NOT fire on view-effect builtins (`toast` / `navigate`) in an action body", async () => {
    const diags = await actionDiags(withApi(`action go() { toast("hi") navigate("/x") }`));
    expect(diags).not.toContain("loom.unresolved-action-ref");
  });
});

describe("loom.missing-effect-marker (async-actions-and-effects.md Stage 2b)", () => {
  it("ERRORS on a bare remote mutating command inline in an action body (Pattern E `Order.confirm(o)`)", async () => {
    const { model } = await parseString(withApi(`action go(o: Order id) { Order.confirm(o) }`));
    const loom = enrichLoomModel(lowerModel(model));
    const d = validateLoomModel(loom).find((x) => x.code === "loom.missing-effect-marker");
    expect(d).toBeDefined();
    // Stage 2b: `await` is required — a bare remote call is now an ERROR.
    expect(d!.severity).toBe("error");
  });

  it("ERRORS on the api-handle-rooted form (Pattern B `C.Order.confirm(o)`)", async () => {
    const diags = await actionDiags(withApi(`action go(o: Order id) { C.Order.confirm(o) }`));
    expect(diags).toContain("loom.missing-effect-marker");
  });

  it("does NOT flag a repository finder call (`Order.active()` — a read)", async () => {
    const diags = await actionDiags(withApi(`action go() { Order.active() }`));
    expect(diags).not.toContain("loom.missing-effect-marker");
  });

  it("does NOT flag a view-effect call (`navigate` / `toast`)", async () => {
    const diags = await actionDiags(withApi(`action go() { navigate("/x") toast("hi") }`));
    expect(diags).not.toContain("loom.missing-effect-marker");
  });

  it("does NOT flag a sibling-action call (Fix 1, not a remote effect)", async () => {
    const diags = await actionDiags(
      withApi(`action go() { other() }  action other() { navigate("/y") }`),
    );
    expect(diags).not.toContain("loom.missing-effect-marker");
  });

  it("does NOT flag an `await`-marked op (the explicit, handled form)", async () => {
    // `match await C.Order.place() { … }` is the Stage-2 effect form — the
    // awaited subject is ACCEPTED (no missing-effect-marker), unlike the bare
    // `Order.place()` call above.
    const diags = await actionDiags(`
      error Failed { reason: string }
      system Demo {
        subdomain S {
          context C {
            aggregate Order ids guid {
              code: string
              operation place(): Order or Failed { return Failed { reason: code } }
            }
            repository Orders for Order {}
          }
        }
        api CApi from S { httpStatus Failed 422 }
        ui Web {
          api C: CApi
          page P {
            route: "/orders/:id"
            state { msg: string = "" }
            action go() {
              match await C.Order.place() {
                Order o => { msg := o.code }
                Failed f => { msg := f.reason }
              }
            }
            body: Stack { Button { "Go", onClick: go } }
          }
        }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }
        deployable api { platform: node, contexts: [C], dataSources: [cState], serves: CApi, port: 3000 }
        deployable web {
          platform: react
          targets: api
          ui: Web { C: api }
          port: 3001
        }
      }
    `);
    expect(diags).not.toContain("loom.missing-effect-marker");
  });

  it("does NOT flag a PRIVATE operation (only public mutating ops require a marker)", async () => {
    const diags = await actionDiags(`
      system Demo {
        subdomain S {
          context C {
            aggregate Order {
              code: string
              status: string
              private operation touch() { status := "x" }
            }
            repository Orders for Order {}
          }
        }
        api CApi from S
        ui Web {
          api C: CApi
          page P {
            route: "/p"
            action go(o: Order id) { Order.touch(o) }
            body: Stack { Button { "Go", onClick: go } }
          }
        }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }
        deployable api { platform: node, contexts: [C], dataSources: [cState], serves: CApi, port: 3000 }
        deployable web {
          platform: react
          targets: api
          ui: Web { C: api }
          port: 3001
        }
      }
    `);
    expect(diags).not.toContain("loom.missing-effect-marker");
  });

  it("does not DOUBLE-fire with unresolved-action-ref on the same remote call site", async () => {
    // `Order.confirm(o)` is a method-call, so Fix 3's bare-call branch never
    // applies — only the effect-marker error fires (the developer's no-overlap claim).
    const diags = await actionDiags(withApi(`action go(o: Order id) { Order.confirm(o) }`));
    expect(diags.filter((c) => c === "loom.missing-effect-marker")).toHaveLength(1);
    expect(diags).not.toContain("loom.unresolved-action-ref");
  });
});

// -------------------------------------------------------------------------
// loom.effect-in-lambda (fable-elmish-frontend.md §8) — an inline effect
// handler in a page/component body is rejected; effects live only in a named
// `action`.  Keeps the render tree pure (one effect-handler form, and the
// MVU `Model → Html` view stays a projection).
// -------------------------------------------------------------------------

/** Parse → assert clean AST → lower → enrich → validate; return only the
 *  `loom.effect-in-lambda` codes. */
async function lambdaDiags(source: string): Promise<string[]> {
  const { model, errors } = await parseString(source);
  expect(errors, `unexpected AST errors:\n${errors.join("\n")}`).toEqual([]);
  const loom = enrichLoomModel(lowerModel(model));
  return validateLoomModel(loom)
    .map((d) => d.code)
    .filter((c) => c === "loom.effect-in-lambda");
}

describe("loom.effect-in-lambda (fable-elmish-frontend.md §8)", () => {
  it("fires on an inline state-write handler (`onClick: e => { n := n + 1 }`)", async () => {
    const diags = await lambdaDiags(
      withApi(
        `state { n: int = 0 }`,
        ``,
        `body: Stack { Button { "Go", onClick: e => { n := n + 1 } } }`,
      ),
    );
    expect(diags).toContain("loom.effect-in-lambda");
  });

  it('fires on an inline navigate handler (`onClick: e => { navigate("/x") }`)', async () => {
    const diags = await lambdaDiags(
      withApi(``, ``, `body: Stack { Button { "Go", onClick: e => { navigate("/x") } } }`),
    );
    expect(diags).toContain("loom.effect-in-lambda");
  });

  it('fires on a SINGLE-EXPRESSION view-effect body (`onClick: e => navigate("/x")`)', async () => {
    // No block — the effect rides the expression body; the check must still
    // catch it (a value lambda's expression is a render, never a `navigate`).
    const diags = await lambdaDiags(
      withApi(``, ``, `body: Stack { Button { "Go", onClick: e => navigate("/x") } }`),
    );
    expect(diags).toContain("loom.effect-in-lambda");
  });

  it("does NOT fire on the named-action equivalent (`action go() {…}` + `onClick: go`)", async () => {
    const diags = await lambdaDiags(
      withApi(
        `state { n: int = 0 }  action go() { n := n + 1 }`,
        ``,
        `body: Stack { Button { "Go", onClick: go } }`,
      ),
    );
    expect(diags).not.toContain("loom.effect-in-lambda");
  });

  it("does NOT fire on effects inside a named action body (effects live there)", async () => {
    const diags = await lambdaDiags(
      withApi(`state { n: int = 0 }  action go() { n := n + 1  navigate("/x") }`),
    );
    expect(diags).not.toContain("loom.effect-in-lambda");
  });

  it("does NOT fire on a PURE value lambda (a Table column accessor `o => Text { o.code }`)", async () => {
    // A value lambda whose body is a render expression (no effect statement) is
    // legitimate — the ubiquitous column-accessor / row-renderer shape.
    const diags = await lambdaDiags(
      withApi(
        `action go() { toast("x") }`,
        ``,
        `body: Stack { Table { rows: Order.active(), Column { "Code", o => Text { o.code } } } }`,
      ),
    );
    expect(diags).not.toContain("loom.effect-in-lambda");
  });

  it("does NOT fire on an effect lambda in an extern-component `action`-typed param slot", async () => {
    // Extern-component Tier 2 behaviour callback (extern-component-escape-hatch.md
    // §3): the lambda legitimately carries effects that walk in the caller's
    // scope, so it is exempt — the gate must not break this feature.
    const diags = await lambdaDiags(`
      system S {
        subdomain M { context C { aggregate Order { status: string } repository Orders for Order { } } }
        api CApi from M
        ui WebApp {
          api C: CApi
          component OrderGrid(orders: Order[], onPick: action(Order)) extern from "widgets/order-grid"
          page Board {
            route: "/board"
            state { note: string = "" }
            body: OrderGrid { orders: C.Order.all, onPick: o => { note := o.status } }
          }
        }
        storage p { type: postgres }
        resource cs { for: C, kind: state, use: p }
        deployable api { platform: node, contexts: [C], dataSources: [cs], serves: CApi, port: 3000 }
        deployable web { platform: static  targets: api  ui: WebApp { C: api }  port: 3001 }
      }
    `);
    expect(diags).not.toContain("loom.effect-in-lambda");
  });

  it("STILL fires on a stdlib handler slot in the same page (exemption is slot-scoped)", async () => {
    // The exemption is specific to the component's action-typed param — a normal
    // Button.onClick in the same page is still gated.
    const diags = await lambdaDiags(`
      system S {
        subdomain M { context C { aggregate Order { status: string } repository Orders for Order { } } }
        api CApi from M
        ui WebApp {
          api C: CApi
          component OrderGrid(orders: Order[], onPick: action(Order)) extern from "widgets/order-grid"
          page Board {
            route: "/board"
            state { note: string = "" }
            body: Stack {
              OrderGrid { orders: C.Order.all, onPick: o => { note := o.status } },
              Button { "x", onClick: e => { note := "y" } }
            }
          }
        }
        storage p { type: postgres }
        resource cs { for: C, kind: state, use: p }
        deployable api { platform: node, contexts: [C], dataSources: [cs], serves: CApi, port: 3000 }
        deployable web { platform: static  targets: api  ui: WebApp { C: api }  port: 3001 }
      }
    `);
    expect(diags).toContain("loom.effect-in-lambda");
  });
});
