import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// User (non-`extern`) components — Angular flavour
// (`src/generator/angular/components-emit.ts`).
//
// Until this shipped, a walked `component TierBadge(…) { body: … }` produced NO
// output on Angular and every use site rendered
// `<!-- unknown layout component: TierBadge -->` — the declaration and its uses
// vanished together (the last two rows of the `KNOWN_DEGRADATIONS` ratchet in
// `test/generator/_walker/render-degradation.test.ts`).
//
// Each walked component now becomes a standalone `@Component` class at
// `src/app/components/<Name>.ts`, assembled by the SAME shell that assembles a
// page (`renderAngularPage` in component mode) — so state signals, `derived`
// computeds, action methods and the member lifts an Angular template needs come
// from one assembler rather than a second half-featured one.  Call sites keep
// the extern path's `NgComponentOutlet` form (Angular has no PascalCase tag, and
// the outlet is selector-free), so only the IMPORT PATH distinguishes the two
// flavours: a walked class is a sibling under `src/app/`, an extern shim sits at
// `src/components/`.
//
// The Angular mirror of react's `walker-user-components.test.ts` and vue's
// `vue-user-components.test.ts`.
// ---------------------------------------------------------------------------

async function angularFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

const sys = (uiBody: string) => `
  system S {
    subdomain M { context Sales {
      aggregate Order with crudish {
        customerId: string
        operation confirm() { }
      }
      repository Orders for Order { }
    } }
    api SalesApi from M
    ui WebApp {
      api Sales: SalesApi
${uiBody}
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, dataSources: [salesState], port: 3000 }
    deployable web { platform: angular, targets: api, port: 3001, ui: WebApp { Sales: api } }
  }
`;

describe("user components — Angular", () => {
  it("emits a standalone component class with typed @Input()s and a walked template", async () => {
    const files = await angularFiles(
      sys(`
      component TierBadge(label: string, level: int) {
        body: Stack { Text { label }, Text { level > 2 ? "high" : "low" } }
      }
      page Home { route: "/" body: Stack { Heading { "home" } } }`),
    );
    const comp = files.get("src/app/components/TierBadge.ts")!;
    expect(comp).toBeDefined();
    // The class is named EXACTLY the component — a call site imports `{ Name }`
    // and hands the class to `[ngComponentOutlet]`.
    expect(comp).toContain("export class TierBadge {");
    expect(comp).toContain('selector: "app-tier-badge"');
    // Params are decorated fields, not signal inputs: the walked template reads
    // them as bare identifiers, exactly as a page reads a bound route param.
    // Not `required: true`: a call site may omit an arg (no validator gates
    // component-call arity) and every other frontend renders that as
    // `undefined` — a required input would make the same `.ddd` throw NG0950 on
    // Angular alone.
    expect(comp).toContain("@Input() label!: string;");
    expect(comp).toContain("@Input() level!: number;");
    expect(comp).toContain('import { Component, Input } from "@angular/core";');
    // Body walked (the interpolation + the ternary), no give-up comment.
    expect(comp).toContain("{{ label }}");
    expect(comp).toMatch(/\{\{ \(\(level > 2\) \? "high" : "low"\) \}\}/);
    expect(comp).not.toContain("unknown layout component");
  });

  it("a page invoking it imports the sibling class and binds inputs through the outlet", async () => {
    const files = await angularFiles(
      sys(`
      component TierBadge(label: string, level: int) { body: Text { label } }
      page Home {
        route: "/"
        state { tier: string = "gold" }
        body: Stack { TierBadge(label: tier, level: 3) }
      }`),
    );
    const home = files.get("src/app/pages/home.component.ts")!;
    // ONE hop: pages and components are siblings under `src/app/`.
    expect(home).toContain('import { TierBadge } from "../components/TierBadge";');
    expect(home).toContain('import { NgComponentOutlet } from "@angular/common";');
    expect(home).toContain("protected readonly TierBadge = TierBadge;");
    expect(home).toContain(
      `<ng-container [ngComponentOutlet]="TierBadge" [ngComponentOutletInputs]='{ label: tier(), level: 3 }'></ng-container>`,
    );
    expect(home).not.toContain("unknown layout component");
  });

  it("a component invoking another component imports it as a sibling in the same dir", async () => {
    const files = await angularFiles(
      sys(`
      component Ribbon() { body: Text { "sale" } }
      component TierBadge(label: string) { body: Stack { Text { label }, Ribbon() } }
      page Home { route: "/" body: Stack { TierBadge(label: "gold") } }`),
    );
    const comp = files.get("src/app/components/TierBadge.ts")!;
    // From `src/app/components/TierBadge.ts` the sibling is `./Ribbon`, not
    // `../components/Ribbon` (which the page uses).
    expect(comp).toContain('import { Ribbon } from "./Ribbon";');
    expect(comp).toContain("protected readonly Ribbon = Ribbon;");
    expect(files.has("src/app/components/Ribbon.ts")).toBe(true);
  });

  it("component state / derived / actions ride the page shell's own machinery", async () => {
    const files = await angularFiles(
      sys(`
      component Counter(caption: string) {
        state { n: int = 0 }
        derived doubled: int = n * 2
        action bump() { n := n + 1 }
        body: Stack {
          Text { caption },
          Text { string(doubled) },
          Button { "more", onClick: bump }
        }
      }
      page Home { route: "/" body: Stack { Counter(caption: "hits") } }`),
    );
    const comp = files.get("src/app/components/Counter.ts")!;
    expect(comp).toContain("readonly n = signal(0);");
    expect(comp).toContain("readonly doubled = computed(() => (this.n() * 2));");
    expect(comp).toContain("bump() { this.n.set((this.n() + 1)); }");
    // The `@Input()` is declared FIRST so a `computed`/read hoist may reference
    // it without tripping TS2729 ("used before its initialization").
    expect(comp.indexOf("@Input() caption")).toBeLessThan(comp.indexOf("readonly doubled ="));
  });

  it("an aggregate-typed param types as the wire DTO with the component-depth import", async () => {
    const files = await angularFiles(
      sys(`
      component OrderLine(order: Order) { body: Text { order.customerId } }
      page Home { route: "/" body: Stack { Heading { "home" } } }`),
    );
    const comp = files.get("src/app/components/OrderLine.ts")!;
    expect(comp).toContain("@Input() order!: OrderResponse;");
    // TWO hops from `src/app/components/` to `src/api/` — the props file (at
    // `src/components/`) spells the same import with one.
    expect(comp).toContain('import type { OrderResponse } from "../../api/order";');
  });

  it("a slot param defers the component instead of emitting a half-bound class", async () => {
    // `ngComponentOutletInputs` sets INPUTS; it has no content-projection
    // channel, so a `slot` param has nowhere to land.  The component stays out of
    // the emitted set and the call site keeps the honest comment — never a
    // reference to a class that was not written.
    const files = await angularFiles(
      sys(`
      component Panel(head: slot) { body: Card { head } }
      page Home { route: "/" body: Stack { Panel(head: Text { "hi" }) } }`),
    );
    expect(files.has("src/app/components/Panel.ts")).toBe(false);
    const home = files.get("src/app/pages/home.component.ts")!;
    expect(home).toContain("unknown layout component: Panel");
    expect(home).not.toContain("import { Panel }");
  });

  it("an arg-less api read inside a component hoists like a page's", async () => {
    const files = await angularFiles(
      sys(`
      component OrderCount() {
        body: QueryView { of: Sales.Order.all, data: rows => Text { string(rows.length) } }
      }
      page Home { route: "/" body: Stack { OrderCount() } }`),
    );
    const comp = files.get("src/app/components/OrderCount.ts")!;
    expect(comp).toContain("readonly orderAll = useAllOrders();");
    expect(comp).toContain('import { useAllOrders } from "../../api/order";');
  });

  it("a read whose ARG reads an @Input() defers (the field initializer beats the input)", async () => {
    // The shell hoists a read as a class-FIELD initializer, which runs in the
    // constructor — before Angular sets any input — so `useOrderById(this.oid)`
    // would throw on `undefined` at construction.  Compiles, breaks at runtime:
    // exactly the class this deferral exists to keep out.
    const files = await angularFiles(
      sys(`
      component OrderCard(oid: string) {
        body: QueryView { of: Sales.Order.byId(oid), single: true, data: o => Text { o.customerId } }
      }
      page Home { route: "/" body: Stack { OrderCard(oid: "x") } }`),
    );
    expect(files.has("src/app/components/OrderCard.ts")).toBe(false);
    expect(files.get("src/app/pages/home.component.ts")).toContain(
      "unknown layout component: OrderCard",
    );
  });

  it("an `Action(<input>.<op>)` component hoists the mutation and reads the id at CLICK time", async () => {
    // The canonical component shape (`component OrderActions(order: Order)`):
    // the mutation is a class field (an injection context), and the id is read
    // inside the click method — i.e. after Angular has set the input, which is
    // why THIS shape is supported while an input-fed READ is not.
    const files = await angularFiles(
      sys(`
      component OrderActions(order: Order) { body: Stack { Action { order.confirm } } }
      page Home {
        route: "/"
        body: QueryView { of: Sales.Order.all, data: rows => Stack {
          For { each: rows, o => OrderActions(order: o) }
        } }
      }`),
    );
    const comp = files.get("src/app/components/OrderActions.ts")!;
    expect(comp).toContain("@Input() order!: OrderResponse;");
    expect(comp).toContain("readonly confirmOrder = useConfirmOrder();");
    expect(comp).toContain("const id = this.order?.id;");
    expect(comp).toContain("await this.confirmOrder.mutateAsync({ id, input: {} });");
  });

  it("an extern component still resolves through its own shim path", async () => {
    const files = await angularFiles(
      sys(`
      component Banner(caption: string) extern from "widgets/banner"
      component TierBadge(label: string) { body: Text { label } }
      page Home {
        route: "/"
        body: Stack { Banner(caption: "Q3"), TierBadge(label: "gold") }
      }`),
    );
    const home = files.get("src/app/pages/home.component.ts")!;
    // Extern: the re-export shim at `src/components/` (two hops).  Walked: the
    // emitted class at `src/app/components/` (one hop).  Same call form.
    expect(home).toContain('import { Banner } from "../../components/Banner";');
    expect(home).toContain('import { TierBadge } from "../components/TierBadge";');
    expect(home).toContain(`[ngComponentOutlet]="Banner"`);
    expect(home).toContain(`[ngComponentOutlet]="TierBadge"`);
    expect(files.has("src/components/Banner.props.ts")).toBe(true);
    expect(files.has("src/app/components/Banner.ts")).toBe(false);
  });

  it("a top-level (workspace-wide) component emits the same way", async () => {
    const files = await angularFiles(`
      component Ribbon(label: string) { body: Text { label } }
      system S {
        subdomain M { context Sales { aggregate Order { customerId: string } } }
        ui WebApp {
          page Home { route: "/" body: Stack { Ribbon(label: "sale") } }
        }
        deployable api { platform: node, contexts: [Sales], port: 3000 }
        deployable web { platform: angular, targets: api, port: 3001, ui: WebApp }
      }
    `);
    expect(files.get("src/app/components/Ribbon.ts")).toContain("export class Ribbon {");
    expect(files.get("src/app/pages/home.component.ts")).toContain(
      'import { Ribbon } from "../components/Ribbon";',
    );
  });
});
