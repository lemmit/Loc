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
import {
  type ApiOperationIR,
  collectionSuccess,
  deriveContextOperations,
} from "../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { buildLoomModel } from "../_helpers/ir.js";

/** One aggregate with the full lifted surface: create, getById, destroy, a
 *  declared find, a canonical `update`, and a non-canonical operation.
 *
 *  `cancel` is `when`-GATED on purpose.  A state gate is the `when` rung of the
 *  denial ladder (`when` → 409, `requires` → 403, `precondition` → 422; RS-15),
 *  and it is the rung that was missing from two backends' published contracts.
 *  `examples/showcase.ddd` — the ONE fixture the per-PR `conformance-parity`
 *  job boots — has no `when`-gated operation anywhere (every op there uses
 *  `requires` + `precondition`), which is precisely why that gate compares the
 *  `errorResponses` dimension and still saw nothing. A fixture that does not
 *  exercise a feature cannot gate it. */
const SOURCE = (platform: string): string => `
system P {
  subdomain D {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
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

// ---------------------------------------------------------------------------
// Success-body shape.
//
// Path parity is only half the contract: a client that reaches the right URL
// and parses the wrong body still throws.  #2341 found THREE such drifts in
// Hono alone (create sends `201 {id}` not the entity; findAll sends a paged
// envelope; a void operation sends `204` with no body at all) and gated Hono
// against them.  This is the same gate for the other four.
//
// Shapes are resolved STRUCTURALLY, from the emitted DTO's field names — never
// from the type NAME, which differs per backend on purpose (the callee calls
// it `CreateOrderResponse`, the client calls it `OrderCreated`).  A name
// comparison would be brittle exactly where a shape comparison is exact.
// ---------------------------------------------------------------------------

type Shape = "none" | "paged" | "array" | "idEnvelope" | "canEnvelope" | "entity";

/** `undefined` = the backend's source does not state the type at this route.
 *  Kept distinct from a shape so it can't be mistaken for agreement — the
 *  unresolved set is pinned below and ratchets. */
type MaybeShape = Shape | undefined;

/** A body's field names → its shape.  The three carriers are recognised by the
 *  fields that define them, so any backend spelling them differently is a
 *  drift rather than a rename this test has to learn. */
function shapeOfFields(fields: readonly string[]): Shape {
  const set = new Set(fields.map((f) => f.toLowerCase()));
  if (set.has("items") && set.has("totalpages")) return "paged";
  if (set.size === 1 && set.has("id")) return "idEnvelope";
  // The `can_<op>` gate probe's `{ allowed }` — a bool on the wire, but an
  // ENVELOPE, not a bare boolean.  Every client emitter unwraps it the same way
  // it unwraps ProblemDetails on the error side.
  if (set.size === 1 && set.has("allowed")) return "canEnvelope";
  return "entity";
}

/** What the derivation says the caller receives — the same reading every
 *  client emitter does, so a mismatch here IS a broken generated client. */
function expectedShape(op: ApiOperationIR): Shape {
  if (op.kind === "create") return "idEnvelope";
  // The probe's `responseType` is the VALUE the caller cares about (`bool`);
  // the body it rides in is the fixed `{ allowed }` envelope.
  if (op.kind === "gateProbe") return "canEnvelope";
  if (!op.responseType) return "none";
  const coll = collectionSuccess(op.responseType);
  if (coll) return coll.carrier === "paged" ? "paged" : "array";
  return "entity";
}

/** FastAPI — `response_model=X` on the decorator, X resolved to its pydantic
 *  field list.  No `response_model` + `status_code=204` is a bodiless answer. */
function shapesPython(files: Map<string, string>): Map<string, MaybeShape> {
  const src = [...files].find(([p]) => p.endsWith("order_routes.py"))?.[1] ?? "";
  const main = [...files].find(([p]) => p.endsWith("app/main.py"))?.[1] ?? "";
  const mount = main.match(/include_router\(\s*order_router[^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? "";
  const prefix = `${mount}${src.match(/APIRouter\([^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? ""}`;

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
    const decorator = m[3]!;
    const named = decorator.match(/response_model=(\w+)/)?.[1];
    out.set(k, named ? model(named) : "none");
  }
  return out;
}

/** Spring — the handler's declared return type, resolved through the emitted
 *  `record` for that type.  `void` (with `@ResponseStatus(NO_CONTENT)`) is a
 *  bodiless answer; `ResponseEntity<?>` states nothing and stays unresolved. */
function shapesJava(files: Map<string, string>): Map<string, MaybeShape> {
  const src =
    [...files].find(
      ([p, c]) => p.endsWith(".java") && /@RequestMapping\("\/api\/orders"\)/.test(c),
    )?.[1] ?? "";
  const base = src.match(/@RequestMapping\("([^"]*)"\)/)?.[1] ?? "";

  const record = (name: string): MaybeShape => {
    for (const [p, c] of files) {
      if (!p.endsWith(`${name}.java`)) continue;
      const params = c.match(new RegExp(`record ${name}\\(([^)]*)\\)`))?.[1] ?? "";
      // `List<OrderResponse> items, int page, …` → the trailing identifier of
      // each parameter, generics and annotations discarded.
      const fields = params
        .split(/,(?![^<]*>)/)
        .map((s) => s.trim().split(/\s+/).pop() ?? "")
        .filter(Boolean);
      return shapeOfFields(fields);
    }
    return undefined;
  };

  const out = new Map<string, MaybeShape>();
  const re =
    /@(Get|Post|Put|Patch|Delete)Mapping(?:\("([^"]*)"\))?([\s\S]*?)public\s+([\w.<>?, ]+?)\s+\w+\(/g;
  for (const m of src.matchAll(re)) {
    const k = key({ method: m[1]!, path: normalisePath(`${base}${m[2] ?? ""}`) });
    const ret = m[4]!.trim();
    if (ret === "void") out.set(k, "none");
    else {
      const inner = ret.match(/^ResponseEntity<(.+)>$/)?.[1] ?? ret;
      out.set(k, inner === "?" ? undefined : record(inner.replace(/<.*/, "")));
    }
  }
  return out;
}

/** ASP.NET — the 2xx `[ProducesResponseType]`, resolved through the emitted
 *  `record`.  A bare `[ProducesResponseType(204)]` names no type: bodiless. */
function shapesDotnet(files: Map<string, string>): Map<string, MaybeShape> {
  const src =
    [...files].find(([p, c]) => p.endsWith(".cs") && /\[Route\("api\/orders"\)\]/.test(c))?.[1] ??
    "";
  const base = src.match(/\[Route\("([^"]*)"\)\]/)?.[1] ?? "";
  const all = [...files.values()].join("\n");

  const record = (name: string): MaybeShape => {
    if (/^Paged</.test(name)) return "paged"; // the shared generic carrier
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

/** Phoenix — no DTOs to resolve, so the shape is read off the action's own
 *  success return: `send_resp(conn, 204, "")`, a literal `%{"id" => …}`, the
 *  shared `serialize/1`, or the paged struct update. */
function shapesElixir(files: Map<string, string>): Map<string, MaybeShape> {
  const router = [...files].find(([p]) => p.endsWith("router.ex"))?.[1] ?? "";
  const ctl = [...files].find(([p]) => p.endsWith("order_controller.ex"))?.[1] ?? "";
  const scope = router.match(/scope "\/api",[\s\S]*?\n {2}end/)?.[0] ?? "";

  const action = (name: string): MaybeShape => {
    const body = ctl.match(new RegExp(`\\n  def ${name}\\(conn[\\s\\S]*?\\n  end\\n`))?.[0];
    if (body === undefined) return undefined;
    if (/send_resp\(conn, 204, ""\)/.test(body)) return "none";
    // `json(conn, …)` and the piped `conn |> put_status(201) |> json(…)` are
    // both live forms — create uses the second.
    if (/json\((?:conn, )?%\{"id" =>/.test(body)) return "idEnvelope";
    if (/json\(conn, %\{result \| items:/.test(body)) return "paged";
    if (/json\(conn, %\{"allowed" =>/.test(body)) return "canEnvelope";
    if (/json\(conn, serialize\(/.test(body)) return "entity";
    return undefined;
  };

  const out = new Map<string, MaybeShape>();
  for (const m of scope.matchAll(/^\s*(get|post|put|patch|delete) "([^"]*)", \w+, :(\w+)/gm)) {
    out.set(key({ method: m[1]!, path: normalisePath(`/api${m[2]}`) }), action(m[3]!));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declared error statuses.
//
// The third leg of the contract: a client can only type its failure union from
// statuses somebody states.  `ApiOperationIR.errorStatuses` is what the M-T4.8
// in-system clients read, and it used to be a SECOND hardcoded copy of a table
// that already existed (`src/ir/util/openapi-errors.ts`, which all five
// backends consume) — so the two drifted, in both directions at once: the
// derivation declared 409 on create where the ladder says 422, carried 403 on
// every find whether gated or not, and omitted 422 entirely.
//
// `conformance-parity` DOES compare this dimension (`errorResponses` in
// `openapi-normalize.ts`), and its own comment asserts "Every backend declares
// the SAME set (driven by openapi-errors.ts)".  That assertion was false for a
// `when`-gated operation — python and java omitted the `Disallowed` 409 their
// runtimes answer — and the gate could not see it because its single fixture
// has no `when` gate.  Hence this check, on a fixture that does.
// ---------------------------------------------------------------------------

/** FastAPI — `responses={400: {"model": ProblemDetails, …}, …}` on the decorator. */
function errorsPython(files: Map<string, string>): Map<string, number[]> {
  const src = [...files].find(([p]) => p.endsWith("order_routes.py"))?.[1] ?? "";
  const main = [...files].find(([p]) => p.endsWith("app/main.py"))?.[1] ?? "";
  const mount = main.match(/include_router\(\s*order_router[^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? "";
  const prefix = `${mount}${src.match(/APIRouter\([^)]*prefix\s*=\s*"([^"]*)"/)?.[1] ?? ""}`;
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(/@router\.(get|post|put|patch|delete)\("([^"]*)"([^\n]*)\)/g)) {
    const codes = [...m[3]!.matchAll(/(\d{3}): \{"model"/g)].map((c) => Number(c[1]));
    out.set(key({ method: m[1]!, path: normalisePath(`${prefix}${m[2]}`) }), codes.sort());
  }
  return out;
}

/** ASP.NET — the 4xx/5xx `[ProducesResponseType(typeof(ProblemDetails), NNN)]`. */
function errorsDotnet(files: Map<string, string>): Map<string, number[]> {
  const src =
    [...files].find(([p, c]) => p.endsWith(".cs") && /\[Route\("api\/orders"\)\]/.test(c))?.[1] ??
    "";
  const base = src.match(/\[Route\("([^"]*)"\)\]/)?.[1] ?? "";
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(
    /\[Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?\]([\s\S]*?)public\s/g,
  )) {
    const seg = m[2] ? `/${m[2]}` : "";
    const codes = [...m[3]!.matchAll(/\[ProducesResponseType\((?:typeof\(.+?\), )?([45]\d\d)\)\]/g)]
      .map((c) => Number(c[1]))
      .sort();
    out.set(key({ method: m[1]!, path: normalisePath(`/${base}${seg}`) }), codes);
  }
  return out;
}

/** Spring — springdoc infers nothing useful here, so the contract lives in the
 *  emitted `OpenApiContractCustomizer`'s `Route` table: `new Route(method, path,
 *  successRef, new int[] {…}, …)`. Reading the customizer IS reading what java
 *  publishes — the customizer is what edits the served document. */
function errorsJava(files: Map<string, string>): Map<string, number[]> {
  const src = [...files].find(([p]) => p.endsWith("OpenApiContractCustomizer.java"))?.[1] ?? "";
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(
    /new Route\("(\w+)",\s*"([^"]*)",\s*[^,]*,\s*new int\[\]\s*\{([^}]*)\}/g,
  )) {
    const codes = (m[3]!.match(/\d{3}/g) ?? []).map(Number).filter((c) => c >= 400);
    out.set(key({ method: m[1]!, path: normalisePath(m[2]!) }), codes.sort());
  }
  return out;
}

/** Routes whose body type the backend's own source does not state, so this
 *  gate cannot read it.  Each needs a reason and an exit — the set is asserted
 *  exactly, so a backend that goes quiet on one MORE route fails here. */
const UNRESOLVED: Record<string, readonly string[]> = {
  // `byCodeOrder` returns `ResponseEntity<?>` because the 404 arm builds a
  // `ResponseEntity<Void>` that cannot unify with the success type.  Widening
  // it to a declared type is a Java-emitter change, not a test change.
  "Java/Spring": ["get /api/orders/by_code"],
  "Python/FastAPI": [],
  ".NET": [],
  "Elixir/Phoenix": [],
};

const BACKENDS: Record<
  string,
  {
    platform: string;
    scrape(f: Map<string, string>): Route[];
    shapes(f: Map<string, string>): Map<string, MaybeShape>;
    /** Absent when this backend states no error set in a form this gate can
     *  read from the emitted project. */
    errors?(f: Map<string, string>): Map<string, number[]>;
  }
> = {
  "Python/FastAPI": {
    platform: "python",
    scrape: scrapePython,
    shapes: shapesPython,
    errors: errorsPython,
  },
  "Java/Spring": { platform: "java", scrape: scrapeJava, shapes: shapesJava, errors: errorsJava },
  ".NET": { platform: "dotnet", scrape: scrapeDotnet, shapes: shapesDotnet, errors: errorsDotnet },
  // Phoenix declares its error set in the OpenApiSpex module, which is emitted
  // only for a system carrying an `api` declaration — this fixture has none, so
  // there is nothing to read.  Its ROUTES and BODIES are still gated above; the
  // omission is the scraper's reach, not a gap in the backend.
  "Elixir/Phoenix": { platform: "elixir", scrape: scrapeElixir, shapes: shapesElixir },
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

    it(`${label} answers each derived operation with the derived body shape`, async () => {
      const source = SOURCE(backend.platform);
      const model = await buildLoomModel(source);
      const derived = deriveContextOperations(ordersContext(model)!);
      const shapes = backend.shapes(await generateSystemFiles(source));

      expect(shapes.size, `${label}: scraped no bodies — the scraper is stale`).toBeGreaterThan(0);

      const unresolved: string[] = [];
      const wrong: string[] = [];
      for (const op of derived) {
        const k = key({ method: op.method, path: op.path });
        if (!shapes.has(k)) continue; // path drift — the sibling test owns it
        const actual = shapes.get(k);
        if (actual === undefined) unresolved.push(k);
        else if (actual !== expectedShape(op)) {
          wrong.push(`${k}: derived ${expectedShape(op)}, ${label} sends ${actual}`);
        }
      }

      expect(wrong, `${label} answers the wrong body:\n  ${wrong.join("\n  ")}`).toEqual([]);
      // Not `toContain` — an exact match, so a route quietly becoming
      // unreadable is a failure rather than a silently widened blind spot.
      expect(unresolved.sort()).toEqual([...UNRESOLVED[label]!].sort());
    });

    if (backend.errors) {
      it(`${label} declares exactly the derived error statuses`, async () => {
        const source = SOURCE(backend.platform);
        const model = await buildLoomModel(source);
        const derived = deriveContextOperations(ordersContext(model)!);
        const declared = backend.errors!(await generateSystemFiles(source));

        expect(
          declared.size,
          `${label}: scraped no error sets — the scraper is stale`,
        ).toBeGreaterThan(0);

        const wrong: string[] = [];
        for (const op of derived) {
          const k = key({ method: op.method, path: op.path });
          const actual = declared.get(k);
          if (actual === undefined) continue; // path drift — the sibling test owns it
          const want = [...op.errorStatuses].sort((a, b) => a - b);
          if (JSON.stringify(actual) !== JSON.stringify(want)) {
            wrong.push(`${k}: derived [${want}], ${label} declares [${actual}]`);
          }
        }
        expect(
          wrong,
          `${label} declares a different failure set:\n  ${wrong.join("\n  ")}`,
        ).toEqual([]);
      });
    }
  }
});
