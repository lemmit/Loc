// Render fidelity: the FastAPI router renders EXACTLY the derived surface.
//
// The python sibling of `test/generator/dotnet/api-surface-render.test.ts` —
// see its header for the framing.  Python renders from
// `deriveAggregateOperations` since the unification's python slice, so the
// independence gate (`test/ir/api-surface-parity.test.ts`) dropped it; this
// suite holds the RENDERING to the derivation instead: an arm dropping a
// derived operation, mangling its decorator path, or declaring a different
// `responses=` set than the `op.errorStatuses` it was handed fails here.
//
// The scrapers read BOTH mount prefixes from the emitted source (`main.py`'s
// include_router + the APIRouter prefix) — hardcoding `/api` would make the
// scrape agree with the derivation by construction rather than observation.

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../../src/ir/types/loom-ir.js";
import {
  type ApiOperationIR,
  collectionSuccess,
  deriveContextOperations,
} from "../../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

/** Same surface as the dotnet fidelity fixture, plus an ERROR-PAYLOAD absence
 *  union find (`byRef`) — python's union arm is a SEPARATE emitter path from
 *  the plain optional find (the two-arms landmine), so both must be held. */
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
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: python
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

/** The routes module + its full mount prefix, read from the emitted source. */
function routerSource(files: Map<string, string>): { src: string; prefix: string } {
  const src = [...files].find(([p]) => p.endsWith("order_routes.py"))?.[1] ?? "";
  const main = [...files].find(([p]) => p.endsWith("app/main.py"))?.[1] ?? "";
  const mount = main.match(/include_router\(\s*order_router[^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? "";
  return {
    src,
    prefix: `${mount}${src.match(/APIRouter\([^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? ""}`,
  };
}

function scrapeRoutes(files: Map<string, string>): Route[] {
  const { src, prefix } = routerSource(files);
  const out: Route[] = [];
  for (const m of src.matchAll(/@router\.(get|post|put|patch|delete)\("([^"]*)"/g)) {
    out.push({ method: m[1]!, path: normalisePath(`${prefix}${m[2]}`) });
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

/** `response_model=X` resolved to its pydantic field list; no model +
 *  `status_code=204` is a bodiless answer. */
function scrapeShapes(files: Map<string, string>): Map<string, MaybeShape> {
  const { src, prefix } = routerSource(files);

  const model = (name: string): MaybeShape => {
    const root = src.match(new RegExp(`class ${name}\\(RootModel\\[list\\[`));
    if (root) return "array";
    const body = src.match(new RegExp(`class ${name}\\(BaseModel\\):\\n((?: +.*\\n|\\n)*)`))?.[1];
    if (body === undefined) return undefined;
    return shapeOfFields([...body.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]!));
  };

  const out = new Map<string, MaybeShape>();
  for (const m of src.matchAll(/@router\.(get|post|put|patch|delete)\("([^"]*)"([^\n]*)\)/g)) {
    const k = key({ method: m[1]!, path: normalisePath(`${prefix}${m[2]}`) });
    const named = m[3]!.match(/response_model=(\w+)/)?.[1];
    out.set(k, named ? model(named) : "none");
  }
  return out;
}

/** `responses={400: {"model": ProblemDetails, …}, …}` per decorator. */
function scrapeErrors(files: Map<string, string>): Map<string, number[]> {
  const { src, prefix } = routerSource(files);
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(/@router\.(get|post|put|patch|delete)\("([^"]*)"([^\n]*)\)/g)) {
    const codes = [...m[3]!.matchAll(/(\d{3}): \{"model"/g)].map((c) => Number(c[1]));
    out.set(
      key({ method: m[1]!, path: normalisePath(`${prefix}${m[2]}`) }),
      codes.sort((a, b) => a - b),
    );
  }
  return out;
}

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

describe("python render fidelity — the router renders exactly the derived surface", () => {
  it("mounts exactly the derived method+path set", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model))
      .map((o) => key({ method: o.method, path: o.path }))
      .sort();
    const files = await generateSystemFiles(SOURCE);
    const mounted = scrapeRoutes(files).map(key).sort();
    expect(mounted.length, "scraped no routes — the scraper is stale").toBeGreaterThan(0);
    // EXACT both ways — this fixture's router emits only lifted route classes
    // (no audited history), so an extra mounted route fails like a missing one.
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
