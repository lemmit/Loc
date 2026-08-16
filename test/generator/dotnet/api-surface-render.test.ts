// Render fidelity: the .NET controller renders EXACTLY the derived surface.
//
// Until the unification (#2453 → this slice), .NET re-derived its route
// surface independently and `test/ir/api-surface-parity.test.ts` held that
// independent copy against the derivation.  Now the controller RENDERS from
// `deriveAggregateOperations`, so an independence gate is meaningless for this
// backend — what can still break is the RENDERING: an arm dropping a derived
// operation, mounting it at a mangled template, or declaring a different
// status set than the `op.errorStatuses` it was handed.  This suite scrapes
// the emitted controller (the same way the parity gate did — real bytes, not
// emitter internals) and holds it to the derivation on all three axes:
//
//   1. mounted method+path set — EXACT (bidirectional: the aggregate
//      controller emits only lifted route classes for this fixture, so an
//      extra mounted route is as much a failure as a missing one);
//   2. success-body shape per route (create's `201 {id}` envelope, the paged
//      carrier, the bodiless 204);
//   3. declared error statuses per route — EXACT against `op.errorStatuses`.

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../../src/ir/types/loom-ir.js";
import {
  type ApiOperationIR,
  collectionSuccess,
  deriveContextOperations,
} from "../../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

/** The same aggregate surface the cross-backend parity fixture uses: create,
 *  getById, destroy, a `when`-gated op (+ gate probe), a canonical update, and
 *  a `requires`-gated ABSENCE-union find. */
const SOURCE = `
system P {
  subdomain D {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order {
        find byCode(code: string): Order option requires currentUser.role == "admin"
      }
    }
  }
  user { id: string  role: string }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: dotnet
    contexts: [Orders]
    dataSources: [st]
    port: 3000
    auth: required
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

/** The controller source + its `[Route("...")]` base. */
function controller(files: Map<string, string>): { src: string; base: string } {
  const src =
    [...files].find(([p, c]) => p.endsWith(".cs") && /\[Route\("api\/orders"\)\]/.test(c))?.[1] ??
    "";
  return { src, base: src.match(/\[Route\("([^"]*)"\)\]/)?.[1] ?? "" };
}

/** `[Http<M>]` / `[Http<M>("<p>")]` → absolute method+path (attribute paths
 *  carry no leading slash). */
function scrapeRoutes(files: Map<string, string>): Route[] {
  const { src, base } = controller(files);
  const out: Route[] = [];
  for (const m of src.matchAll(/\[Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?\]/g)) {
    const seg = m[2] ? `/${m[2]}` : "";
    out.push({ method: m[1]!, path: normalisePath(`/${base}${seg}`) });
  }
  return out;
}

type Shape = "none" | "paged" | "array" | "idEnvelope" | "canEnvelope" | "entity";
type MaybeShape = Shape | undefined;

function shapeOfFields(fields: readonly string[]): Shape {
  const set = new Set(fields.map((f) => f.toLowerCase()));
  if (set.has("items") && set.has("totalpages")) return "paged";
  if (set.size === 1 && set.has("id")) return "idEnvelope";
  if (set.size === 1 && set.has("allowed")) return "canEnvelope";
  return "entity";
}

/** The 2xx `[ProducesResponseType]`, resolved through the emitted `record`.
 *  A bare `[ProducesResponseType(204)]` names no type: bodiless. */
function scrapeShapes(files: Map<string, string>): Map<string, MaybeShape> {
  const { src, base } = controller(files);
  const all = [...files.values()].join("\n");

  const record = (name: string): MaybeShape => {
    if (/^Paged</.test(name)) return "paged";
    const params = all.match(new RegExp(`record ${name}\\(([^)]*)\\)`))?.[1];
    if (params === undefined) return undefined;
    const fields = params
      .split(",")
      .map((s) => s.replace(/\[[^\]]*\]/g, "").trim())
      .map((s) => s.split(/\s+/).pop() ?? "")
      .filter(Boolean);
    return shapeOfFields(fields);
  };

  const out = new Map<string, MaybeShape>();
  const re = /\[Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?\]([\s\S]*?)public\s/g;
  for (const m of src.matchAll(re)) {
    const seg = m[2] ? `/${m[2]}` : "";
    const k = key({ method: m[1]!, path: normalisePath(`/${base}${seg}`) });
    const success = [
      ...m[3]!.matchAll(/\[ProducesResponseType\((?:typeof\((.+?)\), )?(2\d\d)\)\]/g),
    ];
    out.set(k, success.length === 0 ? undefined : success[0]![1] ? record(success[0]![1]) : "none");
  }
  return out;
}

/** The 4xx/5xx `[ProducesResponseType(typeof(ProblemDetails), NNN)]` per route. */
function scrapeErrors(files: Map<string, string>): Map<string, number[]> {
  const { src, base } = controller(files);
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(
    /\[Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?\]([\s\S]*?)public\s/g,
  )) {
    const seg = m[2] ? `/${m[2]}` : "";
    const codes = [...m[3]!.matchAll(/\[ProducesResponseType\((?:typeof\(.+?\), )?([45]\d\d)\)\]/g)]
      .map((c) => Number(c[1]))
      .sort((a, b) => a - b);
    out.set(key({ method: m[1]!, path: normalisePath(`/${base}${seg}`) }), codes);
  }
  return out;
}

/** What the derivation says the caller receives — the same ladder the client
 *  emitters share (create → id envelope, probe → {allowed}, collection →
 *  carrier, absent responseType → bodiless). */
function expectedShape(op: ApiOperationIR): Shape {
  if (op.kind === "create") return "idEnvelope";
  if (op.kind === "gateProbe") return "canEnvelope";
  if (!op.responseType) return "none";
  const coll = collectionSuccess(op.responseType);
  if (coll) return coll.carrier === "paged" ? "paged" : "array";
  return "entity";
}

function ordersContext(model: LoomModel): BoundedContextIR {
  const ctx = model.systems
    .flatMap((s) => s.subdomains)
    .flatMap((sd) => sd.contexts)
    .find((c) => c.name === "Orders");
  expect(ctx, "Orders context lowered").toBeDefined();
  return ctx!;
}

describe(".NET render fidelity — the controller renders exactly the derived surface", () => {
  it("mounts exactly the derived method+path set", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model))
      .map((o) => key({ method: o.method, path: o.path }))
      .sort();
    const files = await generateSystemFiles(SOURCE);
    const mounted = scrapeRoutes(files).map(key).sort();
    expect(mounted.length, "scraped no routes — the scraper is stale").toBeGreaterThan(0);
    // EXACT both ways: this fixture's aggregate controller emits only lifted
    // route classes (no audited history), so an unexpected extra mounted route
    // fails here just like a dropped one.
    expect(mounted).toEqual(derived);
  });

  it("answers each derived operation with the derived body shape", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model));
    const shapes = scrapeShapes(await generateSystemFiles(SOURCE));
    expect(shapes.size, "scraped no bodies — the scraper is stale").toBeGreaterThan(0);
    for (const op of derived) {
      const k = key({ method: op.method, path: op.path });
      expect(shapes.get(k), k).toBe(expectedShape(op));
    }
  });

  it("declares exactly op.errorStatuses on every route", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model));
    const declared = scrapeErrors(await generateSystemFiles(SOURCE));
    expect(declared.size, "scraped no error sets — the scraper is stale").toBeGreaterThan(0);
    for (const op of derived) {
      const k = key({ method: op.method, path: op.path });
      expect(declared.get(k), k).toEqual([...op.errorStatuses]);
    }
  });
});
