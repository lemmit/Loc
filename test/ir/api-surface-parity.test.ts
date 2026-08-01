// ---------------------------------------------------------------------------
// The derived api surface, checked against FOUR INDEPENDENT backends.
//
// `api-surface.test.ts` pins `deriveContextOperations` against the routes Hono
// emits.  That is the reference implementation the derivation was modelled on,
// so it is the friendliest possible check — and three shape drifts still got
// past it (trailing slash on create/findAll, the `201 {id}` create response, a
// void operation typed as the entity).  The other four backends are held to
// Hono only by `conformance-parity`, which diffs the emitted OPENAPI SPECS.
//
// A spec-vs-spec comparison is structurally blind to a backend that does not
// implement its own published contract, and that is not hypothetical: the
// vanilla Phoenix backend advertised `POST /orders/{id}/update` in its own spec
// while its router served `PATCH /orders/:id`, so every client built from that
// contract 404'd.  Nothing caught it until this file's survey.
// (`experience_gathered.md` §57 RS-13 is the same class; §59 is the wider
// lesson about assurances nothing enforces.)
//
// So this compares the derivation against what each backend's ROUTER/controller
// actually declares — the bytes a request is matched against, not a document
// describing them.
//
// WHY THIS EXISTS BEFORE THE UNIFICATION.  The eventual fix is for the per-
// backend route builders to RENDER from `deriveContextOperations` instead of
// re-deriving it five times.  Doing that to Hono first would make
// `api-surface.test.ts` compare the derivation to itself — tautological, and
// exactly the "blind by construction" failure that let the trailing slash ship.
// Checking four independent implementations first is what makes unifying them
// one at a time safe: each backend that gets unified drops out of this file,
// and the ones still independent keep the gate meaningful.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import { deriveContextOperations } from "../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { buildLoomModel } from "../_helpers/ir.js";

/** One aggregate with the full lifted surface: create, getById, destroy, a
 *  declared find, a canonical `update`, and a non-canonical operation. */
const SOURCE = (platform: string): string => `
system P {
  subdomain D {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() { status := "Cancelled" }
      }
      repository Orders for Order {
        find byCode(code: string): Order option
      }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [st]
    port: 3000
  }
}
`;

/** `{method, absolute path}`, normalised so every backend's dialect compares. */
interface Route {
  readonly method: string;
  readonly path: string;
}

const key = (r: Route): string => `${r.method.toLowerCase()} ${r.path}`;

/** Phoenix spells a path param `:id`; everyone else `{id}`. */
function normalisePath(p: string): string {
  const withBraces = p.replace(/:(\w+)/g, "{$1}");
  const trimmed = withBraces.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** FastAPI — `@router.<m>("<p>")` under a router prefix, itself mounted under
 *  `app.include_router(..., prefix="/api")` in `main.py`.  BOTH prefixes are
 *  read from the emitted source; hardcoding `/api` here would make the scraper
 *  agree with the derivation by construction rather than by observation. */
function scrapePython(files: Map<string, string>): Route[] {
  const src = [...files].find(([p]) => p.endsWith("order_routes.py"))?.[1] ?? "";
  const main = [...files].find(([p]) => p.endsWith("app/main.py"))?.[1] ?? "";
  const mount = main.match(/include_router\(\s*order_router[^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? "";
  const prefix = `${mount}${src.match(/APIRouter\([^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? ""}`;
  const out: Route[] = [];
  for (const m of src.matchAll(/@router\.(get|post|put|patch|delete)\("([^"]*)"/g)) {
    out.push({ method: m[1]!, path: normalisePath(`${prefix}${m[2]}`) });
  }
  return out;
}

/** Spring — class `@RequestMapping("<base>")` + method `@<M>Mapping[("<p>")]`.
 *  A BARE annotation (no parens) mounts at the class path itself, which is how
 *  create / findAll are declared. */
function scrapeJava(files: Map<string, string>): Route[] {
  const src =
    [...files].find(
      ([p, c]) => p.endsWith(".java") && /@RequestMapping\("\/api\/orders"\)/.test(c),
    )?.[1] ?? "";
  const base = src.match(/@RequestMapping\("([^"]*)"\)/)?.[1] ?? "";
  const out: Route[] = [];
  for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping(?:\("([^"]*)"\))?/g)) {
    out.push({ method: m[1]!, path: normalisePath(`${base}${m[2] ?? ""}`) });
  }
  return out;
}

/** ASP.NET — class `[Route("<base>")]` + `[Http<M>]` / `[Http<M>("<p>")]`.
 *  Attribute paths carry no leading slash. */
function scrapeDotnet(files: Map<string, string>): Route[] {
  const src =
    [...files].find(([p, c]) => p.endsWith(".cs") && /\[Route\("api\/orders"\)\]/.test(c))?.[1] ??
    "";
  const base = src.match(/\[Route\("([^"]*)"\)\]/)?.[1] ?? "";
  const out: Route[] = [];
  for (const m of src.matchAll(/\[Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?\]/g)) {
    const seg = m[2] ? `/${m[2]}` : "";
    out.push({ method: m[1]!, path: normalisePath(`/${base}${seg}`) });
  }
  return out;
}

/** Phoenix — `<m> "<path>", Controller, :action` inside `scope "/api"`. */
function scrapeElixir(files: Map<string, string>): Route[] {
  const src = [...files].find(([p]) => p.endsWith("router.ex"))?.[1] ?? "";
  const scope = src.match(/scope "\/api",[\s\S]*?\n {2}end/)?.[0] ?? "";
  const out: Route[] = [];
  for (const m of scope.matchAll(/^\s*(get|post|put|patch|delete) "([^"]*)"/gm)) {
    out.push({ method: m[1]!, path: normalisePath(`/api${m[2]}`) });
  }
  return out;
}

const BACKENDS: Record<string, { platform: string; scrape(f: Map<string, string>): Route[] }> = {
  "Python/FastAPI": { platform: "python", scrape: scrapePython },
  "Java/Spring": { platform: "java", scrape: scrapeJava },
  ".NET": { platform: "dotnet", scrape: scrapeDotnet },
  "Elixir/Phoenix": { platform: "elixir", scrape: scrapeElixir },
};

function ordersContext(model: LoomModel): BoundedContextIR | undefined {
  return model.systems
    .flatMap((s) => s.subdomains)
    .flatMap((sd) => sd.contexts)
    .find((c) => c.name === "Orders");
}

describe("api-surface parity — the derivation vs four independent backends", () => {
  for (const [label, backend] of Object.entries(BACKENDS)) {
    it(`${label} mounts exactly the derived method+path set`, async () => {
      const source = SOURCE(backend.platform);
      const model = await buildLoomModel(source);
      const ctx = ordersContext(model);
      expect(ctx, "Orders context lowered").toBeDefined();

      const derived = new Set(
        deriveContextOperations(ctx!).map((o) => key({ method: o.method, path: o.path })),
      );

      const files = await generateSystemFiles(source);
      const emitted = backend.scrape(files);
      expect(emitted.length, `${label}: scraped no routes — the scraper is stale`).toBeGreaterThan(
        0,
      );

      // Only compare routes the lift CLAIMS to cover.  `apiSurfaceCoverage`
      // names what is not lifted yet (prepare / workflow / projection …), and a
      // backend emitting one of those is not a drift — it is out of scope.  So
      // the assertion is one-directional: every DERIVED operation must be
      // mounted.  An extra route the derivation doesn't know about is caught by
      // `conformance-parity`, not here.
      const mounted = new Set(emitted.map(key));
      const missing = [...derived].filter((d) => !mounted.has(d));
      expect(
        missing,
        `${label} does not mount:\n  ${missing.join("\n  ")}\nmounted:\n  ${[...mounted].sort().join("\n  ")}`,
      ).toEqual([]);
    });
  }
});
