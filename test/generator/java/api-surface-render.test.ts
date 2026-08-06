// Render fidelity: the Spring controller AND the OpenAPI customizer render
// EXACTLY the derived surface.
//
// The java sibling of `test/generator/dotnet/api-surface-render.test.ts` (see
// its header for the framing) — with a java-specific twist: springdoc infers
// nothing useful, so java's PUBLISHED contract is the emitted
// `OpenApiContractCustomizer`'s Route table.  Both the controller (what a
// request matches) and the customizer (what the served spec claims) now
// render from `deriveAggregateOperations`; this suite scrapes both and holds
// them to the derivation, so a renderer defect on either side — or the two
// drifting apart again — fails here.
//
// The fixture runs under `urlStyle: resource`, which pins the java-only fix
// this slice shipped: java was the only backend ignoring `routeSlug`, so a
// resource-styled op mounted at `/{id}/cancel` while the other four (and
// every generated client) used `/{id}/cancels`.  With the fixture styled,
// a regression to `snake(op.name)` breaks the mount-set equality below.

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../../src/ir/types/loom-ir.js";
import { deriveContextOperations } from "../../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SOURCE = `
system P {
  subdomain D {
    context Orders {
      error Missing { resource: string }
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order {
        find byCode(code: string): Order option requires currentUser.role == "admin"
        find byRef(ref: string): Order or Missing
      }
    }
  }
  api SalesApi from D { urlStyle: resource }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: java
    contexts: [Orders]
    dataSources: [st]
    port: 3000
  }
}
`;

interface Route {
  readonly method: string;
  readonly path: string;
}
const key = (r: Route): string => `${r.method.toLowerCase()} ${r.path}`;

function normalisePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function controllerSource(files: Map<string, string>): { src: string; base: string } {
  const src =
    [...files].find(
      ([p, c]) => p.endsWith(".java") && /@RequestMapping\("\/api\/orders"\)/.test(c),
    )?.[1] ?? "";
  return { src, base: src.match(/@RequestMapping\("([^"]*)"\)/)?.[1] ?? "" };
}

/** Class `@RequestMapping("<base>")` + method `@<M>Mapping[("<p>")]` — a BARE
 *  annotation mounts at the class path itself (create / findAll). */
function scrapeControllerRoutes(files: Map<string, string>): Route[] {
  const { src, base } = controllerSource(files);
  const out: Route[] = [];
  for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping(?:\("([^"]*)"\))?/g)) {
    out.push({ method: m[1]!, path: normalisePath(`${base}${m[2] ?? ""}`) });
  }
  return out;
}

/** The customizer's Route table — java's published contract:
 *  `new Route(method, path, successRef, new int[] {…}, …)`. */
function scrapeCustomizerRoutes(files: Map<string, string>): Map<string, number[]> {
  const src = [...files].find(([p]) => p.endsWith("OpenApiContractCustomizer.java"))?.[1] ?? "";
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(
    /new Route\("(\w+)",\s*"([^"]*)",\s*[^,]*,\s*new int\[\]\s*\{([^}]*)\}/g,
  )) {
    const codes = (m[3]!.match(/\d{3}/g) ?? [])
      .map(Number)
      .filter((c) => c >= 400)
      .sort((a, b) => a - b);
    out.set(key({ method: m[1]!, path: normalisePath(m[2]!) }), codes);
  }
  return out;
}

function ordersContext(model: LoomModel): BoundedContextIR {
  const ctx = model.systems
    .flatMap((s) => s.subdomains)
    .flatMap((sd) => sd.contexts)
    .find((c) => c.name === "Orders");
  expect(ctx, "Orders context lowered").toBeDefined();
  return ctx!;
}

function derivedKeys(model: LoomModel): string[] {
  return deriveContextOperations(ordersContext(model))
    .map((o) => key({ method: o.method, path: o.path }))
    .sort();
}

describe("java render fidelity — controller + customizer render exactly the derived surface", () => {
  it("the controller mounts exactly the derived method+path set (routeSlug honored)", async () => {
    const model = await buildLoomModel(SOURCE);
    const files = await generateSystemFiles(SOURCE);
    const mounted = scrapeControllerRoutes(files).map(key).sort();
    expect(mounted.length, "scraped no routes — the scraper is stale").toBeGreaterThan(0);
    expect(mounted).toEqual(derivedKeys(model));
    // The resource-styled op mounts at its routeSlug — the java-only fix.
    expect(mounted).toContain("post /api/orders/{id}/cancels");
    expect(mounted).toContain("get /api/orders/{id}/can_cancels");
  });

  it("the customizer publishes exactly the derived paths with exactly op.errorStatuses", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model));
    const published = scrapeCustomizerRoutes(await generateSystemFiles(SOURCE));
    expect(published.size, "scraped no routes — the scraper is stale").toBeGreaterThan(0);
    for (const op of derived) {
      const k = key({ method: op.method, path: op.path });
      expect(published.get(k), k).toEqual([...op.errorStatuses]);
    }
    // No published aggregate route outside the derived set (workflow routes
    // would be, but this fixture declares none).
    expect([...published.keys()].sort()).toEqual(derivedKeys(model));
  });

  it("a named-only destroy mounts no generic DELETE and documents none", async () => {
    // NAMED FIX (ii): java gated DELETE on `destroys.length > 0`, so a
    // named-only destroy (`destroy archive()`) mounted a generic DELETE that
    // its own customizer refused to document.  Both sides now gate on the
    // shared `emitsRestDestroy` (canonical destroy only).
    const src = `
system P {
  subdomain D {
    context Orders {
      aggregate Order {
        code: string
        status: string
        create(code: string) { code := code }
        destroy archive() { status := "archived" }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: java contexts: [Orders] dataSources: [st] port: 3000 }
}
`;
    const files = await generateSystemFiles(src);
    const mounted = scrapeControllerRoutes(files).map(key);
    expect(mounted.some((k) => k.startsWith("delete "))).toBe(false);
    const published = [...scrapeCustomizerRoutes(files).keys()];
    expect(published.some((k) => k.startsWith("delete "))).toBe(false);
  });

  it("a genuinely-single find declares no 404 (findSingle, not the optional convention)", async () => {
    // NAMED FIX (iii): the customizer's non-array bucket declared
    // `findOptional`'s 404 for a bare-`T` find; the derivation classifies it
    // `findSingle` → [] (matching what the controller answers on the happy
    // path — the ladder's 404 belongs to ABSENCE-capable returns).
    const src = `
system P {
  subdomain D {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
      }
      repository Orders for Order {
        find newest(): Order
      }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: java contexts: [Orders] dataSources: [st] port: 3000 }
}
`;
    const files = await generateSystemFiles(src);
    const published = scrapeCustomizerRoutes(files);
    expect(published.get("get /api/orders/newest")).toEqual([]);
  });
});
