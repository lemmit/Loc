// A page's EMIT IDENTITY — `src/generator/_frontend/page-identity.ts`.
//
// This module is the single answer to "where did that page land, and what does
// a router import it as".  The failure it exists to prevent is a consumer
// rebuilding the answer BY CONVENTION from `page.name` (`./pages/${snake(name)}`,
// `${snake(name)}_page.dart`, `e2e/pages/${snake(name)}.ts`): `page.name` is
// unique only within ONE `area` scope, so the moment an `area { … }` exists
// every such site either names a module the page emitter never wrote (TS2307)
// or collides with a sibling area's page (TS2300).
//
// So the three properties pinned here are the three the consumers rely on:
//
//   * `pageEmitPath` returns the path LOWERING chose (`page.emitPath`), never a
//     reconstruction — and re-points only the extension for the other
//     frontends' file types;
//   * `pageModuleSpecifier` is EXACTLY that path minus `src/` minus the
//     extension, so an import can never name a different module than the one
//     written (round-tripped below for `.tsx` / `.vue` / `.dart`);
//   * `pageFileBase` keeps the area qualification the identifier has, so the
//     flat-directory frontends (Flutter `lib/pages/`, the Playwright page
//     objects) get one file per page rather than one per page NAME.
//
// Plus `buildPageModuleIndex`'s documented no-throw contract on a duplicated
// slot (first page wins, deterministically) — the ambiguity the IR check
// `loom.ui-page-slot-collision` reports, which the emitter must survive.

import { describe, expect, it } from "vitest";
import {
  buildPageModuleIndex,
  pageEmitPath,
  pageFileBase,
  pageModuleSpecifier,
} from "../../../src/generator/_frontend/page-identity.js";
import type { PageIR, UiIR } from "../../../src/ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx, pageSlotKey } from "../../../src/ir/util/page-kind.js";
import { buildLoomModel } from "../../_helpers/ir.js";

// A ui that scaffolds ONE aggregate (so the conventional area/role pages exist)
// and adds two hand-written pages: one inside an `area Ops`, one top-level.
// That is the whole matrix this module cares about — role-named pages under an
// area, a custom page under an area, and an area-less custom page.
const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { code: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable api { platform: node contexts: [Orders] serves: SalesApi dataSources: [st] port: 8080 }
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    area Ops {
      page Dashboard { route: "/ops/dashboard" body: Heading { "Ops" } }
    }
    page Secret { route: "/secret" body: Heading { "Secret" } }
  }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 }
}
`;

const CTX: PageNameCtx = { aggregateNames: ["Order"], workflowNames: [] };

async function loadUi(): Promise<UiIR> {
  const model = await buildLoomModel(SRC);
  const ui = model.systems[0]?.uis[0];
  if (!ui) throw new Error("fixture emitted no ui");
  return ui;
}

const pageNamed = (ui: UiIR, name: string, area?: string): PageIR => {
  const hit = ui.pages.find(
    (p) => p.name === name && (area === undefined || (p.area ?? []).includes(area)),
  );
  if (!hit) throw new Error(`fixture has no page ${area ? `${area}.` : ""}${name}`);
  return hit;
};

describe("pageEmitPath — lowering's path is authoritative", () => {
  it("returns `page.emitPath` verbatim for the .tsx default", async () => {
    const ui = await loadUi();
    // The area path, not `src/pages/dashboard.tsx` — the convention-rebuild bug.
    expect(pageEmitPath(pageNamed(ui, "Dashboard"))).toBe("src/pages/ops/dashboard.tsx");
    // A role-named scaffold page lands under its aggregate's area, not under
    // its (non-unique) role name.
    expect(pageEmitPath(pageNamed(ui, "List"))).toBe("src/pages/orders/list.tsx");
  });

  it("re-points only the EXTENSION for another frontend's file type", async () => {
    const ui = await loadUi();
    const dash = pageNamed(ui, "Dashboard");
    expect(pageEmitPath(dash, ".vue")).toBe("src/pages/ops/dashboard.vue");
    expect(pageEmitPath(dash, ".dart")).toBe("src/pages/ops/dashboard.dart");
  });

  it("falls back to `src/pages/<snake>.tsx` only for a page lowering left unplaced", () => {
    // No `emitPath`: the fallback is the ONLY place a path is reconstructed,
    // and it applies to a top-level page (where `name` IS unique).
    const orphan = { name: "AuditLog", params: [], state: [], derived: [], actions: [] } as PageIR;
    expect(pageEmitPath(orphan)).toBe("src/pages/audit_log.tsx");
    expect(pageEmitPath(orphan, ".vue")).toBe("src/pages/audit_log.vue");
  });
});

describe("pageModuleSpecifier — the emit path minus `src/` minus the extension", () => {
  it("round-trips against pageEmitPath for .tsx / .vue / .dart", async () => {
    const ui = await loadUi();
    for (const ext of [".tsx", ".vue", ".dart"]) {
      for (const page of ui.pages) {
        const spec = pageModuleSpecifier(page, ext);
        // The property, not a golden string: the specifier is exactly the
        // written path with `src/` and the extension removed — so re-adding
        // both must reproduce the file the page emitter actually wrote.
        expect(`src/${spec.slice("./".length)}${ext}`).toBe(pageEmitPath(page, ext));
      }
    }
  });

  it("keeps the area path in the specifier (the TS2307 regression)", async () => {
    const ui = await loadUi();
    expect(pageModuleSpecifier(pageNamed(ui, "Dashboard"))).toBe("./pages/ops/dashboard");
    expect(pageModuleSpecifier(pageNamed(ui, "Secret"))).toBe("./pages/secret");
    expect(pageModuleSpecifier(pageNamed(ui, "Detail"), ".vue")).toBe("./pages/orders/detail");
  });
});

describe("pageFileBase — a unique single segment for the flat-directory frontends", () => {
  it("carries the area qualification (`area Ops { page Dashboard }` → ops_dashboard)", async () => {
    const ui = await loadUi();
    expect(pageFileBase(pageNamed(ui, "Dashboard"), CTX)).toBe("ops_dashboard");
  });

  it("leaves an area-less page equal to snake(name) — the corpus stays byte-identical", async () => {
    const ui = await loadUi();
    for (const page of ui.pages) {
      if ((page.area ?? []).length > 0) continue;
      if (classifyPage(page, CTX).kind !== "custom" && page.name !== "Home") continue;
      expect(pageFileBase(page, CTX)).toBe(page.name.toLowerCase());
    }
    expect(pageFileBase(pageNamed(ui, "Secret"), CTX)).toBe("secret");
    expect(pageFileBase(pageNamed(ui, "Home"), CTX)).toBe("home");
  });

  it("qualifies a role-named scaffold page by its AGGREGATE, not its role", async () => {
    const ui = await loadUi();
    // `list`/`new`/`detail` are the same three names for every aggregate — the
    // one-`list_page.dart`-per-app collision.
    expect(pageFileBase(pageNamed(ui, "List"), CTX)).toBe("order_list");
    expect(pageFileBase(pageNamed(ui, "New"), CTX)).toBe("order_new");
    expect(pageFileBase(pageNamed(ui, "Detail"), CTX)).toBe("order_detail");
  });
});

describe("buildPageModuleIndex — slot → the module that slot's page actually emitted", () => {
  it("indexes exactly the SLOTTED pages, at their own specifiers", async () => {
    const ui = await loadUi();
    const index = buildPageModuleIndex(ui, CTX);
    expect([...index]).toEqual([
      ["agg:Order:list", "./pages/orders/list"],
      ["agg:Order:new", "./pages/orders/new"],
      ["agg:Order:detail", "./pages/orders/detail"],
      ["home", "./pages/home"],
    ]);
    // Every value is the page's OWN specifier — the whole point of the index
    // is that the shell imports where the page landed, not where convention
    // would have put it.
    for (const page of ui.pages) {
      const slot = pageSlotKey(classifyPage(page, CTX));
      if (slot === undefined) continue;
      expect(index.get(slot)).toBe(pageModuleSpecifier(page));
    }
  });

  it("omits `custom` pages — they have no slot, they are mounted by their route", async () => {
    const ui = await loadUi();
    const index = buildPageModuleIndex(ui, CTX);
    expect([...index.values()]).not.toContain("./pages/ops/dashboard");
    expect([...index.values()]).not.toContain("./pages/secret");
  });

  it("honours the extension (a Vue shell indexes .vue modules)", async () => {
    const ui = await loadUi();
    expect(buildPageModuleIndex(ui, CTX, ".vue").get("agg:Order:list")).toBe("./pages/orders/list");
    // Same specifier text, derived from the .vue path — pinned via the path so
    // the equality is not a coincidence of the extension being stripped twice.
    const list = pageNamed(ui, "List");
    expect(pageEmitPath(list, ".vue")).toBe("src/pages/orders/list.vue");
  });

  it("is FIRST-WINS and deterministic on a duplicated slot (no throw)", () => {
    // Two pages classifying to `agg:Order:list` — the authoring error the IR
    // check `loom.ui-page-slot-collision` reports.  The emitter must still
    // produce one deterministic answer rather than throwing mid-generation.
    const dup = (emitPath: string): PageIR =>
      ({
        name: "List",
        area: ["orders"],
        params: [],
        state: [],
        derived: [],
        actions: [],
        emitPath,
      }) as PageIR;
    const ui = {
      name: "WebApp",
      pages: [dup("src/pages/orders/list.tsx"), dup("src/pages/orders/list_alt.tsx")],
      components: [],
      stores: [],
      apiParams: [],
    } as UiIR;
    const first = buildPageModuleIndex(ui, CTX);
    expect(first.get("agg:Order:list")).toBe("./pages/orders/list");
    expect(first.size).toBe(1);
    // Deterministic: the same input yields the same answer, and the LATER page
    // never overwrites the earlier one.
    expect([...buildPageModuleIndex(ui, CTX)]).toEqual([...first]);
  });
});
