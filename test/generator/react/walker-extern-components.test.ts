// Extern components — the UI escape hatch (Tier 1).  A
// `component X(...) extern from "<path>"` makes Loom emit:
//   - a re-export shim at `src/components/<Name>.tsx` (so call sites
//     import `components/<Name>` unchanged) forwarding the default
//     export to the hand-written module at the `from` path;
//   - a typed `src/components/<Name>.props.ts` derived from the
//     params' wire shape (aggregate → `<Agg>Response`, slot → ReactNode);
// and NOT a walked body.  The walker dispatches `<Name .../>` at call
// sites exactly as for a normal user component.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("extern components", () => {
  it("emits a re-export shim + typed props file, no walked body", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { aggregate Order { customerId: string } } }
        ui WebApp {
          component OrderChart(order: Order, caption: string, aside: slot?)
            extern from "widgets/order-chart"
          page Home { route: "/" body: Heading { "hi" } }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);

    // Shim re-exports the hand-written module (one `../` hop from
    // src/components/ to the src-relative `from` path) and the props type.
    const shim = files.get("web/src/components/OrderChart.tsx")!;
    expect(shim).toBeDefined();
    expect(shim).toMatch(/export \{ default \} from "\.\.\/widgets\/order-chart";/);
    expect(shim).toMatch(/export type \{ OrderChartProps \} from "\.\/OrderChart.props";/);
    // No body was walked — the shim is pure re-export.
    expect(shim).not.toMatch(/export default function/);

    // Props file: aggregate → wire DTO import, primitive → string,
    // optional slot → optional ReactNode.
    const props = files.get("web/src/components/OrderChart.props.ts")!;
    expect(props).toBeDefined();
    expect(props).toMatch(/import type \{ ReactNode \} from "react";/);
    expect(props).toMatch(/import type \{ OrderResponse \} from "\.\.\/api\/order";/);
    expect(props).toMatch(
      /export interface OrderChartProps \{\n\s+order: OrderResponse;\n\s+caption: string;\n\s+aside\?: ReactNode;\n\}/,
    );
  });

  it("call sites import components/<Name> unchanged and render the JSX element", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          component Banner(text: string) extern from "widgets/banner"
          page Home { route: "/" body: Banner(text: "hello") }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const home = files.get("web/src/pages/home.tsx")!;
    expect(home).toBeDefined();
    // Imports the stable internal name; the shim forwards to the user module.
    expect(home).toMatch(/import Banner from "\.\.\/components\/Banner";/);
    expect(home).toMatch(/<Banner text="hello" \/>/);
  });

  it("a param-less extern component emits an empty-object props type", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          component Spinner() extern from "widgets/spinner"
          page Home { route: "/" body: Heading { "hi" } }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const props = files.get("web/src/components/Spinner.props.ts")!;
    expect(props).toMatch(/export type SpinnerProps = Record<string, never>;/);
  });
});

// ─── Tier 2 — `action` behaviour params ──────────────────────────────────────
// `slot` carries elements, `action` carries behaviours: the caller hands the
// component a (block-body) lambda, the props type gains a void callback, and
// the lambda body walks in the CALLER's scope (state writes hit the caller's
// setters).  See extern-component-escape-hatch.md §3 Tier 2.

describe("extern components — action params (Tier 2)", () => {
  const SRC = `
    system S {
      subdomain M { context C {
        aggregate Order { status: string }
        repository Orders for Order { }
      } }
      ui WebApp {
        component OrderGrid(orders: Order[], onPick: action(Order), onRefresh: action?)
          extern from "widgets/order-grid"
        page Board {
          route: "/board"
          state { note: string = "" }
          body: OrderGrid { orders: C.Order.all, onPick: o => { note := o.status } }
        }
      }
      deployable api { platform: hono, contexts: [C], port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { C: api }, port: 3001 }
    }
  `;

  it("props: action(Order) → (arg: OrderResponse) => void; action? → optional () => void", async () => {
    const files = await buildAndGenerate(SRC);
    const props = files.get("web/src/components/OrderGrid.props.ts")!;
    expect(props).toMatch(/orders: OrderResponse\[\];/);
    expect(props).toMatch(/onPick: \(arg: OrderResponse\) => void;/);
    expect(props).toMatch(/onRefresh\?: \(\) => void;/);
  });

  it("call site: the lambda emits as a typed arrow walked in the caller's scope", async () => {
    const files = await buildAndGenerate(SRC);
    const board = files.get("web/src/pages/board.tsx")!;
    // Param stays bound (not dropped like event-handler lambdas); the
    // state write resolves against the caller's `state {}` setter.
    expect(board).toContain("onPick={(o) => { setNote(o.status); }}");
  });

  it("rejects `action` outside a component parameter list", async () => {
    const { parseString } = await import("../../_helpers/index.js");
    const { errors } = await parseString(`
      system S { subdomain M { context C {
        aggregate Order { pick: action }
      } } }
    `);
    expect(
      errors.some((e) => /'action' is only valid on a component's parameter list/.test(e)),
    ).toBe(true);
  });

  it("rejects a nested UI marker as the callback argument", async () => {
    const { parseString } = await import("../../_helpers/index.js");
    const { errors } = await parseString(`
      system S { subdomain M { context C { } }
        ui W {
          component X(cb: action(slot)) extern from "widgets/x"
          page Home { route: "/" body: Heading { "hi" } }
        }
      }
    `);
    expect(errors.some((e) => /loom\.action-nested-marker|not allowed/.test(e))).toBe(true);
  });

  it("a field named `action` still parses (soft keyword)", async () => {
    const { parseString } = await import("../../_helpers/index.js");
    const { errors } = await parseString(`
      system S { subdomain M { context C {
        aggregate AuditEntry { action: string  at: datetime }
      } } }
    `);
    expect(errors).toEqual([]);
  });
});
