// `loom.datagrid-unsupported-target` — DataGrid on a frontend that can't
// render it is a COMPILE ERROR, not a silently missing grid.
//
// This is the honest-gap discipline: DataGrid emits a TanStack row model in a
// child component, so it is not a markup mapping the other frontends pick up
// for free.  Without this gate a Flutter page would render an empty slot (or a
// "not supported" comment on HEEx) and the author would only discover it in the
// running app.
//
// The allowlist tracks one question — can this target host TANSTACK? — not
// "does it emit JSX".  Feliz can (Fable compiles F# to JavaScript, so it binds
// `@tanstack/table-core` directly), so it is accepted.  Flutter cannot: its
// shipping target is a native APK with no JS runtime, and that is a settled
// decision rather than a pending port.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/index.js";

async function validateSource(src: string) {
  return validateLoomModel(enrichLoomModel(lowerModel(await parseValid(src))));
}

/** `platform:` for a ui's host.  The four static-bundle frameworks share the
 *  `static` host; Feliz and Flutter each only host their own (they build through
 *  their own toolchains), so the validator rejects them on `static`; a
 *  phoenixLiveView ui is served by its own `elixir` backend deployable. */
const hostFor = (framework: string): string => {
  if (framework === "feliz" || framework === "flutter") return framework;
  if (framework === "phoenixLiveView") return "elixir";
  return "static";
};

/** The deployable topology a ui's framework implies.  The five JS frontends are
 *  a SEPARATE bundle deployable pointing at a node backend (`targets:`); a
 *  phoenixLiveView ui is served BY its backend, and `targets:` is a
 *  frontend-only clause the validator rejects on `platform: elixir` — so the
 *  Phoenix leg is one self-hosting deployable, not two. */
const topologyFor = (framework: string): { resource: string; deployables: string } =>
  framework === "phoenixLiveView"
    ? {
        resource: "  resource st { for: Orders, kind: state, use: pg }",
        deployables:
          "  deployable app { platform: elixir, contexts: [Orders], dataSources: [st], " +
          "serves: SalesApi, ui: WebApp { Sales: app }, port: 4000 }",
      }
    : {
        resource: "",
        deployables: `  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: ${hostFor(framework)}, targets: api, port: 3001, ui: WebApp { Sales: api } }`,
      };

const sys = (framework: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
${topologyFor(framework).resource}
  ui WebApp {
    framework: ${framework}
    api Sales: SalesApi
    page X { route: "/x"  body: QueryView { of: Sales.Customer.all, data: rows => DataGrid(
      Column("Name", o => o.name, sortable: true),
      rows: rows) } }
  }
${topologyFor(framework).deployables}
}
`;

/** Same system, but the grid lives in a COMPONENT the page renders.  A
 *  page-only scan let this through: flutter then emitted a bare
 *  `SizedBox.shrink()` (with an unknown-layout-component comment) and heex an
 *  unsupported-primitive comment — the grid VANISHED with no diagnostic. */
const sysWithGridInComponent = (framework: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp {
    framework: ${framework}
    api Sales: SalesApi
    component GridBlock() { body: QueryView { of: Sales.Customer.all, data: rows => DataGrid(
      Column("Name", o => o.name, sortable: true),
      rows: rows) } }
    page X { route: "/x"  body: GridBlock() }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: ${hostFor(framework)}, targets: api, port: 3001, ui: WebApp { Sales: api } }
}
`;

/** A `hosts: [A, B]` deployable (D-PHOENIX-SURFACE) where only the SECOND ui
 *  carries the grid.  The gate used to read `d.uiName` + a single
 *  `sys.uis.find`, so ui B was never scanned at all. */
const sysWithTwoHostedUis = `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui UiA {
    framework: flutter
    page A { route: "/a"  body: Text("plain") }
  }
  ui UiB {
    framework: flutter
    page B { route: "/b"  body: QueryView { of: Customer.all, data: rows => DataGrid(
      Column("Name", o => o.name, sortable: true),
      rows: rows) } }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: flutter, targets: api, port: 3001, hosts: [UiA, UiB] }
}
`;

describe("loom.datagrid-unsupported-target", () => {
  // The frameworks with no `renderDataGridChild` seam.  Both are PERMANENT
  // under D-DATAGRID-TARGETS' one rule — a frontend ships `DataGrid` iff it can
  // host TanStack without forking its own contract — not unported legs:
  //
  //   * flutter emits Dart and its native build has no JS runtime, so TanStack
  //     cannot run there at all (`src/util/flutter-deferred-primitives.ts`);
  //   * phoenixLiveView COULD serve a grid — the rows are already in a socket
  //     assign — and that is exactly the objection: a hand-rolled Elixir row
  //     model re-derives TanStack's sort/filter/pagination semantics, and the
  //     other road (a `phx-hook` over `phx-update="ignore"`) hands LiveView a
  //     DOM island it must not patch.
  //
  // phoenixLiveView was NOT exercised here until the pin re-examination, even
  // though `heex-parity.test.ts` and `page-metamodel.md` both promise "a
  // DataGrid on HEEx is a compile error, not a blank space".  That promise was
  // load-bearing (it is what makes the HEEx gap honest rather than silent) and
  // untested — the gate's own coverage stopped at flutter.
  for (const fw of ["flutter", "phoenixLiveView"]) {
    it(`rejects DataGrid on a ${fw} frontend`, async () => {
      const diags = await validateSource(sys(fw));
      const hit = diags.find((d) => d.code === "loom.datagrid-unsupported-target");
      expect(hit, `expected the gate to fire for ${fw}`).toBeDefined();
      expect(hit?.severity).toBe("error");
      // The message must point at the alternative that actually works.
      expect(hit?.message).toContain("Table");
    });
  }

  it("rejects DataGrid inside a COMPONENT on a flutter frontend", async () => {
    const diags = await validateSource(sysWithGridInComponent("flutter"));
    const hit = diags.find((d) => d.code === "loom.datagrid-unsupported-target");
    expect(hit, "a grid moved into a component must not slip the gate").toBeDefined();
    expect(hit?.severity).toBe("error");
    // The message names the actual host, not just some page.
    expect(hit?.message).toContain("component 'GridBlock'");
  });

  it("accepts DataGrid inside a component on a ported frontend", async () => {
    const diags = await validateSource(sysWithGridInComponent("react"));
    expect(diags.find((d) => d.code === "loom.datagrid-unsupported-target")).toBeUndefined();
  });

  it("scans EVERY ui a `hosts: [A, B]` deployable mounts, not just the first", async () => {
    const diags = await validateSource(sysWithTwoHostedUis);
    const hits = diags.filter((d) => d.code === "loom.datagrid-unsupported-target");
    expect(hits.length, "the grid on the second hosted ui must be found").toBe(1);
    expect(hits[0].source).toBe("UiB/page 'B'");
  });

  // Ported frameworks.  Each entry here is a `renderDataGridChild` seam that
  // exists; the gate's whole job is to keep the two sets in step.
  for (const fw of ["react", "vue", "svelte", "angular", "feliz"]) {
    it(`accepts DataGrid on ${fw}`, async () => {
      const diags = await validateSource(sys(fw));
      expect(diags.find((d) => d.code === "loom.datagrid-unsupported-target")).toBeUndefined();
    });
  }
});
