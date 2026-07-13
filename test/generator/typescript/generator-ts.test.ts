import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe("typescript generator", () => {
  it("emits the expected file set for sales.ddd", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const keys = [...files.keys()].sort();
    expect(keys).toContain("domain/ids.ts");
    expect(keys).toContain("domain/value-objects.ts");
    expect(keys).toContain("domain/events.ts");
    expect(keys).toContain("domain/order.ts");
    expect(keys).toContain("db/schema.ts");
    expect(keys).toContain("db/repositories/order-repository.ts");
    expect(keys).toContain("http/order.routes.ts");
    expect(keys).toContain("http/index.ts");
    expect(keys).toContain("package.json");
    expect(keys).toContain("tsconfig.json");
    expect(keys).toContain("index.ts");
  });

  it("renders the Order aggregate with branded ids and operations", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const order = files.get("domain/order.ts")!;
    expect(order).toMatch(/export class Order/);
    expect(order).toMatch(/Ids\.OrderId/);
    expect(order).toMatch(/public confirm\(\)/);
    expect(order).toMatch(/this\._lines\.length > 0/); // collection .count → .length
    expect(order).toMatch(/OrderStatus\.Confirmed/); // enum value qualified
    expect(order).toMatch(/this\._events\.push\({ type: "OrderConfirmed"/);
  });

  it("renders OrderLine with implicit id and parent injection", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const order = files.get("domain/order.ts")!;
    expect(order).toMatch(
      /OrderLine\._create\(\{ id: Ids\.newOrderLineId\(\), parentId: this\._id/,
    );
  });

  it("emits a vitest test file when `test` blocks are declared", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const tests = files.get("domain/order.test.ts")!;
    expect(tests).toMatch(/import { describe, it, expect } from "vitest"/);
    expect(tests).toMatch(/it\("money literal builds"/);
    expect(tests).toMatch(/expect\(\(\) => \{ new Money\(-1\.0, "USD"\); \}\)\.toThrow\(\)/);
  });

  it("lowers collection `.count` on a let-bound aggregate to `.length`", async () => {
    // Regression: a `let x = Agg.create(...)` binding must type as the
    // aggregate so a subsequent `x.coll.count` resolves to an array and
    // lowers to `.length` (previously the factory call typed as the
    // string fallback, leaving `.count` un-lowered — a TS type error +
    // runtime `undefined`).
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Shop {
        enum OS { Draft, Confirmed }
        aggregate Order {
          status: OS
          contains lines: OrderLine[]
          function isMutable(): bool = status == Draft
          operation addLine(qty: int) {
            precondition isMutable()
            lines += OrderLine { quantity: qty }
          }
          entity OrderLine { quantity: int  invariant quantity > 0 }
          test "count on a local lowers to length" {
            let order = Order.create({ status: Draft })
            order.addLine(2)
            expect(order.lines.count).toBe(1)
          }
        }
        repository Orders for Order { }
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1)).toEqual([]);
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const tests = files.get("domain/order.test.ts")!;
    expect(tests).toMatch(/expect\(order\.lines\.length\)\.toBe\(1\)/);
    expect(tests).not.toMatch(/order\.lines\.count/);
  });

  it("emits a block-body function as a statement method (let → const, return)", async () => {
    // domain-services.md rev. 4 — a `function` may have a pure block body
    // (`{ let … precondition … return … }`) alongside the unchanged
    // expression form (`= Expression`, which stays a single-line method).
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Shop {
        aggregate Cart {
          weight: decimal
          surcharge: decimal
          rate: decimal
          domestic: bool
          function lineTotal(): decimal = weight * rate
          function shippingFor(extra: decimal): decimal {
            let base = weight * rate
            precondition base >= 0
            return (domestic ? base : base + surcharge) + extra
          }
          operation touch() { precondition lineTotal() >= 0 }
        }
        repository Carts for Cart { }
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1)).toEqual([]);
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const cart = files.get("domain/cart.ts")!;
    // Expression form stays the single-line `{ return expr; }` shape.
    expect(cart).toMatch(
      /private lineTotal\(\): number \{ return this\._weight \* this\._rate; \}/,
    );
    // Block form emits its lowered statements.
    expect(cart).toMatch(/private shippingFor\(extra: number\): number \{/);
    expect(cart).toMatch(/const base = this\._weight \* this\._rate;/);
    expect(cart).toMatch(/if \(!\(base >= 0\)\) throw new DomainError/);
    expect(cart).toMatch(/return \(this\._domestic \? base : base \+ this\._surcharge\) \+ extra;/);
  });

  it("emits Dockerfile + .dockerignore", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const dockerfile = files.get("Dockerfile")!;
    expect(dockerfile).toMatch(/FROM node:24-alpine AS build/);
    expect(dockerfile).toMatch(/FROM node:24-alpine AS runtime/);
    expect(dockerfile).toMatch(/CMD \["node", "dist\/index\.js"\]/);
    const dockerignore = files.get(".dockerignore")!;
    expect(dockerignore).toMatch(/node_modules/);
  });

  describe("container basics", () => {
    it("http/index.ts mounts /ready that pings the DB and returns 503 on failure", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const httpIndex = files.get("http/index.ts")!;
      expect(httpIndex).toMatch(/app\.get\("\/ready"/);
      // Drizzle ping via sql`select 1` — cheap, dialect-agnostic.
      expect(httpIndex).toMatch(/db\.execute\(sql`select 1`\)/);
      expect(httpIndex).toMatch(/from "drizzle-orm"/);
      // 503 envelope with one-line cause.
      expect(httpIndex).toMatch(/status: "not_ready"/);
      expect(httpIndex).toMatch(/, 503\)/);
    });

    it("root index.ts captures the server and listens for SIGTERM/SIGINT", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const idx = files.get("index.ts")!;
      expect(idx).toMatch(/const server = serve\(/);
      expect(idx).toMatch(/process\.on\("SIGTERM"/);
      expect(idx).toMatch(/process\.on\("SIGINT"/);
      expect(idx).toMatch(/server\.close/);
      expect(idx).toMatch(/pool\.end\(\)/);
    });

    it("root index.ts fails fast on missing DATABASE_URL", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const idx = files.get("index.ts")!;
      expect(idx).toMatch(/if \(!process\.env\.DATABASE_URL\)/);
      expect(idx).toMatch(/DATABASE_URL is required/);
    });
  });

  describe("request observability", () => {
    it("emits obs/als.ts wiring the ambient RequestContext into AsyncLocalStorage", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const als = files.get("obs/als.ts")!;
      // Non-HTTP code (repository, dispatcher, domain on --trace) resolves
      // the ambient RequestContext (correlation id, principal, locale,
      // scope id, logger) through `requestContext()` / `requestLog()`,
      // which read Node's AsyncLocalStorage — wired by the request-id
      // middleware.
      expect(als).toMatch(/from "node:async_hooks"/);
      expect(als).toMatch(/export interface RequestContext \{/);
      expect(als).toMatch(/correlationId: string;/);
      expect(als).toMatch(/scopeId: string;/);
      expect(als).toMatch(/parentId: string \| null;/);
      expect(als).toMatch(
        /export const requestContextStore = new AsyncLocalStorage<RequestContext>/,
      );
      expect(als).toMatch(/export function requestContext\(\): RequestContext \| undefined/);
      // Outside-request fallback to baseLogger so the helper never throws.
      expect(als).toMatch(/export function requestLog\(\): RequestLogger \{[\s\S]+baseLogger/);
    });

    it("request-id middleware opens the RequestContext and echoes correlation on both headers", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const reqId = files.get("obs/request-id.ts")!;
      expect(reqId).toMatch(/import \{ type RequestContext, requestContextStore \} from "\.\/als"/);
      expect(reqId).toMatch(/await requestContextStore\.run\(ctx, async \(\) => \{/);
      // Reads X-Correlation-Id, falls back to X-Request-Id; echoes both.
      expect(reqId).toMatch(
        /c\.req\.header\(CORRELATION_ID_HEADER\) \?\? c\.req\.header\(REQUEST_ID_HEADER\)/,
      );
      expect(reqId).toMatch(/c\.res\.headers\.set\(CORRELATION_ID_HEADER, correlationId\)/);
      expect(reqId).toMatch(/c\.res\.headers\.set\(REQUEST_ID_HEADER, correlationId\)/);
    });

    it("--trace off: domain file imports no infra and statements stay byte-identical", async () => {
      // The whole point of the compile-time switch: when --trace is OFF
      // (the default) the generated domain file MUST be free of any
      // observability infra import or instrumentation.  Domain purity by
      // construction.
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS); // no emitTrace
      const orderDomain = files.get("domain/order.ts")!;
      expect(orderDomain).not.toMatch(/from "\.\.\/obs\/als"/);
      expect(orderDomain).not.toMatch(/requestLog\(\)/);
      expect(orderDomain).not.toMatch(/event: "value_computed"/);
      expect(orderDomain).not.toMatch(/event: "precondition_evaluated"/);
    });

    it("--trace on: _assertInvariants gains an __op param threaded by every call site", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS, { emitTrace: true });
      const orderDomain = files.get("domain/order.ts")!;
      // The trace-on signature picks up an __op string param so
      // invariant_evaluated lines can carry op context — invariants run
      // from a shared helper that has no direct view of the caller.
      expect(orderDomain).toMatch(/private _assertInvariants\(__op: string\): void \{/);
      // Every call site threads its op label.  Ctor → "<init>" sentinel
      // so the line is distinguishable from in-operation invariants.
      expect(orderDomain).toMatch(/this\._assertInvariants\("<init>"\);/);
      // Each public operation passes its own name.  At least the model's
      // first op should appear (defensive: the example may rename
      // operations, but at minimum one literal label must be threaded).
      expect(orderDomain).toMatch(/this\._assertInvariants\("[a-zA-Z][a-zA-Z0-9]*"\);/);
      // Invariant body: boolean bound, traced, then conditional throw.
      expect(orderDomain).toMatch(/const __inv_\d+_ok = \(/);
      expect(orderDomain).toMatch(
        /requestLog\(\)\.trace\(\{ event: "invariant_evaluated", aggregate: "Order(Line)?", op: __op, expr: "[^"]+", passed: __inv_\d+_ok \}\)/,
      );
      expect(orderDomain).toMatch(/if \(!__inv_\d+_ok\) throw new DomainError\(/);
      // A GUARDED invariant logs ONLY when the guard applies — the
      // `if (this._status === …) {` body wraps the const+trace+throw
      // (so an inapplicable invariant doesn't pollute the stream).
      // sales.ddd's Order has `invariant lines.count > 0 when status == Confirmed`.
      expect(orderDomain).toMatch(
        /if \(this\._status === OrderStatus\.Confirmed\) \{\n\s+const __inv_\d+_ok =/,
      );
    });

    it("--trace on: success responses bind the payload + emit wire_out before c.json", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS, { emitTrace: true });
      const routes = files.get("http/order.routes.ts")!;
      // create: payload bound to `out` so c.json doesn't re-evaluate, +
      // wire_out fires immediately before the return.
      expect(routes).toMatch(
        /const out = \{ id: created\.id as string \};\n\s+.*\.get\("log"\)\.trace\(\{ event: "wire_out", keys: Object\.keys\(out as Record<string, unknown>\) \}\);\n\s+return c\.json\(out, 201\);/,
      );
      // get-by-id success: same pattern, with the existing z.infer cast
      // kept at the c.json site so the response shape still typechecks.
      expect(routes).toMatch(
        /const out = repo\.toWire\(found\);\n\s+.*"wire_out"[^\n]+\n\s+return c\.json\(out as z\.infer<typeof OrderResponse>, 200\);/,
      );
      // Array finds skip wire_out — `Object.keys` over an array returns
      // positional indices, not a useful key set.
      const wireOuts = routes.match(/event: "wire_out"/g) ?? [];
      expect(wireOuts.length).toBeGreaterThanOrEqual(2);
    });

    it("--trace off: success responses keep the original one-line c.json (no binding, no wire_out)", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS); // no emitTrace
      const routes = files.get("http/order.routes.ts")!;
      expect(routes).not.toMatch(/event: "wire_out"/);
      expect(routes).not.toMatch(/const out =/);
      // Original one-line returns unchanged.
      expect(routes).toMatch(/return c\.json\(\{ id: created\.id as string \}, 201\);/);
      expect(routes).toMatch(
        /return c\.json\(repo\.toWire\(found\) as z\.infer<typeof OrderResponse>, 200\);/,
      );
    });

    it("boot script wires pool.on('error') to a db_disconnected warn line", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const index = files.get("index.ts")!;
      // pool 'error' fires on a dropped backend connection (DB restart,
      // network blip) — operators see the cause at boot/diagnostic time
      // instead of waiting for the next request to 503 / 500.  Always
      // emitted (not gated on --trace).
      expect(index).toMatch(/pool\.on\("error", \(err\) => \{/);
      expect(index).toMatch(/event: "db_disconnected"/);
      expect(index).toMatch(/reason: err instanceof Error \? err\.message : String\(err\)/);
    });

    it("--trace on: operation route emits wire_in after body parse, off keeps no wire_in", async () => {
      const model = await buildModel("examples/sales.ddd");
      const filesOn = generateTypeScript(model, HONO_V4_PINS, { emitTrace: true });
      const routesOn = filesOn.get("http/order.routes.ts")!;
      // wire_in fires AFTER `const body = c.req.valid("json");` so the
      // validated shape is what's logged.  `keys: Object.keys(body as
      // Record<string, unknown>)` is the safe runtime read (Zod always
      // returns a plain object).
      expect(routesOn).toMatch(/const body = c\.req\.valid\("json"\);[\s\S]+?wire_in/);
      expect(routesOn).toMatch(
        /\.get\("log"\)\.trace\(\{ event: "wire_in", keys: Object\.keys\(body as Record<string, unknown>\) \}\)/,
      );

      // Off: no wire_in lines, no keys-of-body — operation route stays
      // byte-identical to the pre-Phase-6d shape at the body-parse seam.
      const filesOff = generateTypeScript(model, HONO_V4_PINS); // no emitTrace
      const routesOff = filesOff.get("http/order.routes.ts")!;
      expect(routesOff).not.toMatch(/event: "wire_in"/);
    });

    it("--trace on: repository wraps findById + save in tx_begin/tx_commit/tx_rollback + child_synced per upsert", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS, { emitTrace: true });
      const repo = files.get("db/repositories/order-repository.ts")!;
      // Each of the two transactional methods (findById + save) opens
      // with tx_begin, wraps the inner body in try { … }, emits tx_commit
      // on success, and tx_rollback (with the error message) on the
      // catch path.  Two of each event in the file (one per method).
      expect(repo.match(/event: "tx_begin"/g)?.length).toBe(2);
      expect(repo.match(/event: "tx_commit"/g)?.length).toBe(2);
      expect(repo.match(/event: "tx_rollback"/g)?.length).toBe(2);
      expect(repo).toMatch(/requestLog\(\)\.trace\(\{ event: "tx_begin", aggregate: "Order", id:/);
      expect(repo).toMatch(
        /requestLog\(\)\.trace\(\{ event: "tx_rollback", .*error: txErr instanceof Error \? txErr\.message : String\(txErr\) \}\)/,
      );
      // child_synced per upsert in the save's child loop — action read
      // from `existingIds<Cap>` (set before the upsert) so it tags
      // insert vs update without a second round-trip.
      expect(repo).toMatch(
        /const childAction = existingIdsLines\.has\(child\.id as string\) \? "update" : "insert";/,
      );
      expect(repo).toMatch(
        /requestLog\(\)\.trace\(\{ event: "child_synced", parent: "Order", part: "OrderLine", id: child\.id as string, action: childAction \}\)/,
      );
    });

    it("--trace off: repository stays free of tx_* + child_synced (no try/catch wrap)", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS); // no emitTrace
      const repo = files.get("db/repositories/order-repository.ts")!;
      // No tx_* logs, no try/catch wrapper, no child_synced — body
      // stays at the original 6-space indent and the existing
      // `await this.db.transaction(...)` form is unchanged.
      expect(repo).not.toMatch(/event: "tx_begin"/);
      expect(repo).not.toMatch(/event: "tx_commit"/);
      expect(repo).not.toMatch(/event: "tx_rollback"/);
      expect(repo).not.toMatch(/event: "child_synced"/);
      expect(repo).not.toMatch(/catch \(txErr\)/);
    });

    it("--trace off: invariant emission stays byte-identical to no-trace output", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS); // no emitTrace
      const orderDomain = files.get("domain/order.ts")!;
      // No __op param, no invariant_evaluated lines, no __inv_<i>_ok
      // temps — the trace-off path must produce identical source to
      // before Phase 6b shipped.
      expect(orderDomain).toMatch(/private _assertInvariants\(\): void \{/);
      expect(orderDomain).not.toMatch(/__inv_\d+_ok/);
      expect(orderDomain).not.toMatch(/event: "invariant_evaluated"/);
      // Call sites stay no-arg.
      expect(orderDomain).toMatch(/this\._assertInvariants\(\);/);
      expect(orderDomain).not.toMatch(/this\._assertInvariants\("/);
    });

    it("--trace on: domain file injects requestLog import + value_computed + precondition_evaluated", async () => {
      const model = await buildModel("examples/sales.ddd");
      // Mirror what the CLI does for `generate ts <ddd> --trace`.
      const files = generateTypeScript(model, HONO_V4_PINS, { emitTrace: true });
      const orderDomain = files.get("domain/order.ts")!;
      // requestLog import — only when --trace is on, so the default
      // artefact's domain layer never touches an infra import.
      expect(orderDomain).toMatch(/import \{ requestLog \} from "\.\.\/obs\/als"/);
      // value_computed after a scalar assign — carries the post-write
      // value via `this._<field>`, the same path the assignment uses.
      expect(orderDomain).toMatch(
        /requestLog\(\)\.trace\(\{ event: "value_computed", aggregate: "Order", field: "[a-z]+", value: this\._[a-z]+ \}\)/,
      );
      // precondition_evaluated — boolean bound to a temp so BOTH pass
      // and fail outcomes log, then the conditional throw fires off the
      // same temp.
      expect(orderDomain).toMatch(/const __pre_\d+_ok = \(/);
      expect(orderDomain).toMatch(
        /requestLog\(\)\.trace\(\{ event: "precondition_evaluated", aggregate: "Order", op: "[a-zA-Z]+", expr: "[^"]+", passed: __pre_\d+_ok \}\)/,
      );
      expect(orderDomain).toMatch(/if \(!__pre_\d+_ok\) throw new DomainError\(/);
    });

    it("health + ready probes emit health_ok / db_error / health_degraded via the request logger", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const httpIndex = files.get("http/index.ts")!;
      // /health → liveness probe — debug line so probe traffic only
      // surfaces under LOG_LEVEL=debug, not the default info stream.
      expect(httpIndex).toMatch(
        /\.get\("log"\)\.debug\(\{ event: "health_ok", checks: \["liveness"\] \}\)/,
      );
      // /ready → success path logs health_ok (readiness, db).
      expect(httpIndex).toMatch(
        /\.get\("log"\)\.debug\(\{ event: "health_ok", checks: \["readiness", "db"\] \}\)/,
      );
      // /ready → failure path logs BOTH db_error (the underlying cause,
      // error level so it lands in any sane prod stream) AND
      // health_degraded (debug, the cumulative probe outcome).
      expect(httpIndex).toMatch(/\.get\("log"\)\.error\(\{ event: "db_error", error: message \}\)/);
      expect(httpIndex).toMatch(
        /\.get\("log"\)\.debug\(\{ event: "health_degraded", checks: \["db"\] \}\)/,
      );
    });

    it("repository emits aggregate_loaded / repository_save / find_executed / event_dispatched via requestLog()", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const repo = files.get("db/repositories/order-repository.ts")!;
      // ALS-backed logger import — repository methods have no `c` in scope.
      expect(repo).toMatch(/import \{ requestLog \} from "\.\.\/\.\.\/obs\/als"/);
      // findById: both not-found and found paths carry the aggregate_loaded
      // debug line — `found:false` on the empty branch, `found:true` on the
      // hydrated branch.
      expect(repo).toMatch(
        /requestLog\(\)\.debug\(\{ event: "aggregate_loaded", aggregate: "Order", id: id as string, found: false \}\)/,
      );
      expect(repo).toMatch(
        /requestLog\(\)\.debug\(\{ event: "aggregate_loaded", aggregate: "Order", id: id as string, found: true \}\)/,
      );
      // save: one repository_save debug after the transaction commits.
      expect(repo).toMatch(
        /requestLog\(\)\.debug\(\{ event: "repository_save", aggregate: "Order", id: aggregate\.id as string \}\)/,
      );
      // dispatcher: one event_dispatched info per pulled event.  The
      // `(event as object).constructor.name` cast handles the corner case
      // where the aggregate declares no events (pullEvents returns never[]).
      expect(repo).toMatch(
        /requestLog\(\)\.info\(\{ event: "event_dispatched", event_type: \(event as object\)\.constructor\.name, aggregate: "Order", id: aggregate\.id as string \}\)/,
      );
      // find_executed debug at every find return — including the empty-rows
      // branch so a no-result query is still observable.
      expect(repo).toMatch(
        /requestLog\(\)\.debug\(\{ event: "find_executed", aggregate: "Order", find: "[^"]+", rows: 0 \}\)/,
      );
      expect(repo).toMatch(
        /requestLog\(\)\.debug\(\{ event: "find_executed", aggregate: "Order", find: "[^"]+", rows: result\.length \}\)/,
      );
    });

    it("emits obs/log.ts with a configured pino base logger", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const log = files.get("obs/log.ts")!;
      // Standard structured logger — pino, not hand-rolled console.log.
      expect(log).toMatch(/from "pino"/);
      expect(log).toMatch(/export const baseLogger/);
      // Level is a runtime knob via LOG_LEVEL env (default info).
      expect(log).toMatch(/process\.env\.LOG_LEVEL \?\? "info"/);
      // pino's default { pid, hostname } base fields are dropped.
      expect(log).toMatch(/base: undefined/);
      // Envelope aligned with docs/old/proposals/observability.md:
      //   level emitted as label ("info") not pino's numeric severity,
      //   timestamp as `ts` ISO string not pino's default `time` epoch ms.
      expect(log).toMatch(/level: \(label\) => \(\{ level: label \}\)/);
      expect(log).toMatch(/new Date\(\)\.toISOString\(\)/);
      // Exposes the per-request child-logger type for downstream typing.
      expect(log).toMatch(/export type RequestLogger/);
    });

    it("emits obs/request-id.ts with the correlation-id middleware + bound child logger", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const reqId = files.get("obs/request-id.ts")!;
      // Mints a fresh UUID when no inbound header is set.
      expect(reqId).toMatch(/randomUUID\(\)/);
      // Honours an inbound X-Correlation-Id / X-Request-Id header.
      expect(reqId).toMatch(/CORRELATION_ID_HEADER = "X-Correlation-Id"/);
      expect(reqId).toMatch(/REQUEST_ID_HEADER = "X-Request-Id"/);
      expect(reqId).toMatch(
        /c\.req\.header\(CORRELATION_ID_HEADER\) \?\? c\.req\.header\(REQUEST_ID_HEADER\)/,
      );
      // Echoes the value back on the response (both headers).  Set AFTER
      // next() via direct headers mutation to avoid Hono's null-body
      // (204/304) Response-construction trap.
      expect(reqId).toMatch(/c\.res\.headers\.set\(CORRELATION_ID_HEADER, correlationId\)/);
      expect(reqId).toMatch(/c\.res\.headers\.set\(REQUEST_ID_HEADER, correlationId\)/);
      // Stashes the bare id on the Hono context for downstream onError.
      expect(reqId).toMatch(/c\.set\("requestId", correlationId\)/);
      // Binds a per-request child logger with the request_id field, so
      // every downstream `c.get("log").info(...)` call is correlated
      // without the seam having to re-pass the id.
      expect(reqId).toMatch(/baseLogger\.child\(\{ request_id: correlationId \}\)/);
      expect(reqId).toMatch(/c\.set\("log", log\)/);
      // Structured request_start + request_end log lines via pino.
      expect(reqId).toMatch(/log\.info\(\{ event: "request_start"/);
      expect(reqId).toMatch(/event: "request_end"/);
      expect(reqId).toMatch(/duration_ms:/);
    });

    it("boot script emits structured server lifecycle events via pino", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const index = files.get("index.ts")!;
      expect(index).toMatch(/import \{ baseLogger \} from "\.\/obs\/log"/);
      // server_starting (before listen) + server_listening (after) +
      // server_shutdown / server_drained on the signal path replace the
      // previous bare console.logs.
      expect(index).toMatch(/event: "server_starting"/);
      expect(index).toMatch(/event: "server_listening"/);
      expect(index).toMatch(/event: "server_shutdown"/);
      expect(index).toMatch(/event: "server_drained"/);
      expect(index).not.toMatch(/console\.log/);
    });

    it("generated package.json pins pino + pino-pretty", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const pkg = JSON.parse(files.get("package.json")!);
      expect(pkg.dependencies.pino).toMatch(/^\^?\d/);
      expect(pkg.devDependencies["pino-pretty"]).toMatch(/^\^?\d/);
    });

    it("http/index.ts mounts requestIdMiddleware before cors and any business route", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const httpIndex = files.get("http/index.ts")!;
      expect(httpIndex).toMatch(/import \{ requestIdMiddleware \} from "\.\.\/obs\/request-id"/);
      expect(httpIndex).toMatch(/app\.use\("\*", requestIdMiddleware\)/);
      // Order: requestIdMiddleware mounts BEFORE cors so every
      // downstream handler + onError sees the id.
      const reqIdIdx = httpIndex.indexOf("requestIdMiddleware");
      const corsIdx = httpIndex.indexOf("cors({");
      expect(reqIdIdx).toBeGreaterThan(-1);
      expect(corsIdx).toBeGreaterThan(-1);
      expect(reqIdIdx).toBeLessThan(corsIdx);
    });

    it("per-aggregate app.onError threads trace_id into every error envelope", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const routes = files.get("http/order.routes.ts")!;
      // trace_id pulled off the context via a typed cast (the
      // sub-router's OpenAPIHono is constructed without a typed
      // Variables block; the cast bridges to the parent app's
      // requestIdMiddleware without leaking `any`).
      expect(routes).toMatch(/\.get\("requestId"\) \?\? ""/);
      // RFC 7807: trace_id rides the x-request-id response header (off the
      // body); each status arm returns an application/problem+json body.
      expect(routes).toMatch(
        /"content-type": "application\/problem\+json", "x-request-id": trace_id/,
      );
      expect(routes).toMatch(/return problem\(403, "Forbidden", err\.message\)/);
      expect(routes).toMatch(/return problem\(400, "Bad Request", err\.message\)/);
      expect(routes).toMatch(/return problem\(404, "Not Found", err\.message\)/);
      expect(routes).toMatch(/return problem\(500, "Internal Server Error", "internal"\)/);
    });

    it("routes emit catalog log events at the right levels via the bound child logger", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const routes = files.get("http/order.routes.ts")!;
      // Business-narrative info lines from the create + operation seams.
      // The renderer bridges `c.get("log")` through an untyped cast
      // (zod-openapi's Env constraint rejects custom Variables) — the
      // same shape the trace_id read uses.
      expect(routes).toMatch(
        /\.get\("log"\)\.info\(\{ event: "aggregate_created", aggregate: "Order", id: created\.id as string \}\)/,
      );
      expect(routes).toMatch(
        /\.get\("log"\)\.info\(\{ event: "operation_invoked", aggregate: "Order", op: "[^"]+", id \}\)/,
      );
      // onError: client/domain faults → warn; system faults → error.
      expect(routes).toMatch(
        /\.get\("log"\)\.warn\(\{ event: "forbidden", aggregate: "Order", message: err\.message, status: 403 \}\)/,
      );
      expect(routes).toMatch(
        /\.get\("log"\)\.warn\(\{ event: "domain_error", aggregate: "Order", message: err\.message, status: 400 \}\)/,
      );
      expect(routes).toMatch(
        /\.get\("log"\)\.warn\(\{ event: "not_found", aggregate: "Order", status: 404 \}\)/,
      );
      expect(routes).toMatch(
        /\.get\("log"\)\.error\(\{ event: "extern_handler_threw", aggregate: err\.aggName, op: err\.opName, error: err\.message \}\)/,
      );
      expect(routes).toMatch(/\.get\("log"\)\.error\(\{ event: "internal_error",/);
      // Bare console.error retired — pino does the serialization.
      expect(routes).not.toMatch(/console\.error/);
    });
  });

  it("Hono routes use @hono/zod-openapi and expose /openapi.json", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const orderRoutes = files.get("http/order.routes.ts")!;
    expect(orderRoutes).toMatch(/from "@hono\/zod-openapi"/);
    expect(orderRoutes).toMatch(/createRoute\(\{/);
    expect(orderRoutes).toMatch(/operationId: "createOrder"/);
    expect(orderRoutes).toMatch(/operationId: "getOrderById"/);
    expect(orderRoutes).toMatch(/operationId: "addLineOrder"/);
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/app\.doc\("\/openapi\.json"/);
    expect(httpIndex).toMatch(/openapi: "3\.1\.0"/);
    expect(httpIndex).toMatch(/from "hono\/cors"/);
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@hono/zod-openapi"]).toBeTruthy();
  });

  it("emits a full wire-shape OrderResponse + findAll route + repo serializer", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const orderRoutes = files.get("http/order.routes.ts")!;
    // Response carries every aggregate field + parts + derived.
    expect(orderRoutes).toMatch(/OrderResponse = z\.object/);
    expect(orderRoutes).toMatch(/customerId:/);
    expect(orderRoutes).toMatch(/lines: z\.array\(OrderLineResponse\)/);
    expect(orderRoutes).toMatch(/total: MoneySchema/);
    // GET /  (the auto-included `all` find).
    expect(orderRoutes).toMatch(/path: "\/",[\s\S]+?operationId: "allOrder"/);
    // Repository emits a serializer used by route handlers.
    const repo = files.get("db/repositories/order-repository.ts")!;
    expect(repo).toMatch(/toWire\(root: Order\): unknown/);
    expect(repo).toMatch(/async all\(\): Promise<Order\[\]>/);
  });

  it("lowers `where` filter expressions to Drizzle operators (not a TODO comment)", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const repo = files.get("db/repositories/order-repository.ts")!;
    // sales.ddd's `activeForCustomer` declares
    //   where this.customerId == forCustomer && this.status == Draft
    // Both branches lower cleanly; the `&&` becomes `and(...)`.
    expect(repo).toMatch(
      /\.where\(and\(eq\(schema\.orders\.customerId, forCustomer\), eq\(schema\.orders\.status, "Draft"\)\)\)/,
    );
    // `as never` casts are gone from generated finds.
    expect(repo).not.toMatch(/as never/);
    // No TODO fallback for this find.
    expect(repo).not.toMatch(/TODO: translate where-clause[\s\S]*activeForCustomer/);
    // The import line picks up `and` (in addition to the always-present
    // `eq` / `inArray`).
    expect(repo).toMatch(/import \{[^}]*\band\b[^}]*\} from "drizzle-orm"/);
  });

  it("`all()` hydrates singular containments (not just collections)", async () => {
    // Regression for an earlier bug: the bulk-find path only loaded
    // ONE collection containment per find and silently dropped
    // singular containments.  The generated `all()` referenced an
    // undefined variable for `contains shipping: Address` — `npx tsc`
    // caught it as a no-undef use, but more importantly the
    // generated runtime code couldn't compile.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Order {
          sku: string
          derived display: string = sku
          contains shipping: Address
          entity Address { street: string }
        }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const repo = files.get("db/repositories/order-repository.ts")!;
    // The `all()` method now eagerly loads `shipping` via inArray +
    // builds a per-parent map keyed by parentId; hydrate looks up
    // the singular row with `?? null`.
    expect(repo).toMatch(/async all\(\): Promise<Order\[\]>/);
    expect(repo).toMatch(
      /const shippingRows = await this\.db\.select\(\)\.from\(schema\.addresses\)\.where\(inArray\(schema\.addresses\.parentId, rootIds\)\)/,
    );
    expect(repo).toMatch(/const shippingByParent = new Map<string, Address>\(\);/);
    expect(repo).toMatch(/shipping: shippingByParent\.get\(root\.id\) \?\? null/);
  });

  it("re-homes an extern operation to an aggregate-owned hook (base + scaffold-once subclass)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          function isMutable(): bool = status == Draft
          operation confirm() extern {
            precondition isMutable()
          }
        }
        repository Orders for Order { }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);

    // 1. The old injected handler registry is GONE (extern (b) Phase 2).
    expect(files.has("domain/order-extern.ts")).toBe(false);

    // 2. Generated ABSTRACT base — fields `protected` (no app-wide setter, S10
    //    fixed by construction); the op runs preconditions → hook → invariants;
    //    the hook is a `protected abstract` MEMBER of the aggregate.
    const base = files.get("domain/order.base.ts")!;
    expect(base).toMatch(/export abstract class OrderBase \{/);
    expect(base).toMatch(/protected _status: OrderStatus;/);
    expect(base).toMatch(/public confirm\(\): void \{/);
    expect(base).toMatch(/this\.checkConfirm\(\);/);
    expect(base).toMatch(/this\.confirmExtern\(\);/);
    expect(base).toMatch(/this\._assertInvariants\(\);/);
    expect(base).toMatch(/protected abstract confirmExtern\(\): void;/);
    // The editor + public setters are gone.
    expect(base).not.toMatch(/_externEditor/);
    expect(base).not.toMatch(/OrderEditor/);
    expect(base).not.toMatch(/^ {2}set status\(/m);
    // Factories are `this`-polymorphic so they construct the concrete subclass.
    expect(base).toMatch(/static _create<T extends OrderBase>/);

    // 3. Scaffold-once concrete subclass — user-owned, preserved on regen; the
    //    default hook throws loudly (mirrors the Elixir analog's raise).
    const subclass = files.get("domain/order.ts")!;
    expect(subclass).toMatch(/loom:scaffold-once/);
    expect(subclass).toMatch(/import \{ OrderBase \} from ".\/order.base"/);
    expect(subclass).toMatch(/export class Order extends OrderBase \{/);
    expect(subclass).toMatch(/protected override confirmExtern\(\): void \{/);
    expect(subclass).toMatch(
      /throw new Error\("extern operation 'confirm' on Order is not implemented/,
    );

    // 4. Route calls the operation directly — no registry, no editor.
    const routes = files.get("http/order.routes.ts")!;
    expect(routes).toMatch(/import \{ Order \} from "\.\.\/domain\/order"/);
    expect(routes).not.toMatch(/order-extern/);
    expect(routes).not.toMatch(/externHandlers/);
    expect(routes).toMatch(/aggregate\.confirm\(\);/);

    // 5. No boot-time registry verify — a missing impl is a COMPILE error now.
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).not.toMatch(/ExternHandlersRegistered/);
  });

  describe("extern handler exception envelope", () => {
    it("domain/errors.ts exports ExternHandlerError", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const errors = files.get("domain/errors.ts")!;
      expect(errors).toMatch(/export class ExternHandlerError extends Error/);
      // Carries op + agg names + the inner cause.
      expect(errors).toMatch(/readonly opName: string;/);
      expect(errors).toMatch(/readonly aggName: string;/);
      expect(errors).toMatch(/readonly cause: unknown;/);
      // Message embeds op + agg + inner.
      expect(errors).toMatch(/Extern handler '\$\{opName\}' on '\$\{aggName\}' threw/);
    });

    it("per-aggregate routes call the extern op directly — no handler wrap, no editor", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        context Sales {
          enum OrderStatus { Draft, Confirmed }
          aggregate Order {
            customerId: string
            status: OrderStatus
            function isMutable(): bool = status == Draft
            operation confirm() extern {
              precondition isMutable()
            }
          }
          repository Orders for Order { }
        }
      `,
        { validation: true },
      );
      const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
      const routes = files.get("http/order.routes.ts")!;
      // The op is aggregate-owned now: the route just calls it (preconditions →
      // hook → invariants run inside the method).  No editor, no registry, no
      // per-op ExternHandlerError wrap.
      expect(routes).toMatch(/aggregate\.confirm\(\);/);
      expect(routes).not.toMatch(/_externEditor/);
      expect(routes).not.toMatch(/externHandlers/);
      expect(routes).not.toMatch(/throw new ExternHandlerError\(/);
      // The shared onError still maps a stray ExternHandlerError (a Phase-1
      // extern commandHandler failure) to a 500 problem body.
      expect(routes).toMatch(/return problem\(500, "Internal Server Error", "internal"\)/);
    });

    it("does NOT register a defaultHook on OpenAPIHono (Zod's 400 stays the contract)", async () => {
      // The framework's default 400 envelope for Zod-OpenAPI schema
      // failures is the published contract for request-validation
      // errors.  Forking it would break every OpenAPI-generated
      // client.  Pin the absence.
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const httpIndex = files.get("http/index.ts")!;
      const orderRoutes = files.get("http/order.routes.ts")!;
      expect(httpIndex).not.toMatch(/defaultHook/);
      expect(orderRoutes).not.toMatch(/defaultHook/);
    });

    it("workflow extern op-call calls the aggregate-owned op directly", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        context Sales {
          enum OrderStatus { Draft, Confirmed }
          aggregate Order {
            customerId: string
            status: OrderStatus
            function isMutable(): bool = status == Draft
            operation confirm() extern { precondition isMutable() }
          }
          repository Orders for Order { }
          workflow confirmOne {
      create(orderId: Order id) {
            let order = Orders.getById(orderId)
            order.confirm()
          }
    }
        }
      `,
        { validation: true },
      );
      const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
      const wf = files.get("http/workflows.ts")!;
      // The op is aggregate-owned now: the workflow just calls it (preconditions
      // → hook → invariants run inside the method).  No registry, no editor, no
      // per-op ExternHandlerError wrap.
      expect(wf).toMatch(/order\.confirm\(\);/);
      expect(wf).not.toMatch(/order-extern/);
      expect(wf).not.toMatch(/externHandlers/);
      expect(wf).not.toMatch(/await handler\(order/);
    });
  });

  it("emits Hono workflow routes for non-transactional workflow", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation deductCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit - amount
          }
        }
        aggregate Order {
          customerId: Customer id
          status: OrderStatus
          placedAt: datetime
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        event OrderPlaced { order: Order id, at: datetime }
        workflow placeOrder {
      create(customerId: Customer id, amount: decimal, placedAt: datetime) {
          precondition amount > 0
          let customer = Customers.getById(customerId)
          customer.deductCredit(amount)
          let order = Order.create({
            customerId: customerId,
            status: Draft,
            placedAt: placedAt
          })
          emit OrderPlaced { order: order.id, at: placedAt }
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const wf = files.get("http/workflows.ts")!;

    // Imports + Zod schema for params. The Customer class itself isn't
    // imported here — the workflow only references `Customer id`
    // (lowered to a brand) and uses the CustomerRepository value.
    expect(wf).toMatch(
      /import \{ CustomerRepository \} from "..\/db\/repositories\/customer-repository"/,
    );
    expect(wf).toMatch(/PlaceOrderRequest = z\.object\(\{[\s\S]+?customerId: z\.string\(\)/);

    // Body wires repos on `db`, runs precondition, calls op, factory,
    // emit, then saves both, then dispatches events.
    expect(wf).toMatch(/const customers = new CustomerRepository\(db, events\);/);
    expect(wf).toMatch(/const orders = new OrderRepository\(db, events\);/);
    expect(wf).toMatch(/if \(!\(amount > 0\)\) throw new DomainError/);
    expect(wf).toMatch(/const customer = await customers\.getById\(customerId\);/);
    expect(wf).toMatch(/customer\.deductCredit\(amount\);/);
    expect(wf).toMatch(
      /const order = Order\.create\(\{ customerId: customerId, status: OrderStatus\.Draft, placedAt: placedAt \}\);/,
    );
    expect(wf).toMatch(
      /workflowEvents\.push\(\{ type: "OrderPlaced", order: order\.id, at: placedAt \}\);/,
    );
    expect(wf).toMatch(/await customers\.save\(customer\);/);
    expect(wf).toMatch(/await orders\.save\(order\);/);
    expect(wf).toMatch(/for \(const ev of workflowEvents\) await events\.dispatch\(ev\);/);
    // Non-transactional: no db.transaction wrapper.
    expect(wf).not.toMatch(/db\.transaction\(/);

    // http/index.ts mounts /workflows.
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/import \{ workflowsRoutes \} from "\.\/workflows";/);
    expect(httpIndex).toMatch(/app\.route\("\/api\/workflows", workflowsRoutes\(db, events\)\);/);
  });

  it("emits a transactional workflow wrapped in db.transaction", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow topUp transactional {
      create(customerId: Customer id, amount: decimal) {
          precondition amount > 0
          let target = Customers.getById(customerId)
          target.addCredit(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const wf = files.get("http/workflows.ts")!;
    expect(wf).toMatch(/await db\.transaction\(async \(tx\) => \{/);
    expect(wf).toMatch(/const customers = new CustomerRepository\(tx, events\);/);
    // Save inside the tx callback.
    const txOpen = wf.indexOf("db.transaction(async");
    const saveIdx = wf.indexOf("await customers.save(target);");
    const txClose = wf.indexOf("});", txOpen);
    expect(saveIdx).toBeGreaterThan(txOpen);
    expect(saveIdx).toBeLessThan(txClose);
  });

  it("emits a Hono /views router + per-view repository method", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order { }
        view ActiveOrders = Order where status == Confirmed
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);

    // 1. http/views.ts mounts the route; reuses the aggregate's
    //    list response schema for OpenAPI symmetry.
    const views = files.get("http/views.ts")!;
    expect(views).toMatch(/import \{ OrderResponse, OrderListResponse \} from "\.\/order\.routes"/);
    expect(views).toMatch(/path: "\/active_orders"/);
    expect(views).toMatch(/operationId: "activeOrdersView"/);
    expect(views).toMatch(/schema: OrderListResponse/);
    expect(views).toMatch(/await repo\.activeOrders\(\)/);
    expect(views).toMatch(/rows\.map\(\(r\) => repo\.toWire\(r\)\)/);

    // 2. http/index.ts mounts /views.
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/import \{ viewsRoutes \} from "\.\/views"/);
    expect(httpIndex).toMatch(/app\.route\("\/api\/views", viewsRoutes\(db, events\)\)/);

    // 3. The repository file gained an activeOrders() method whose
    //    Drizzle query embeds the lowered predicate.
    const repo = files.get("db/repositories/order-repository.ts")!;
    expect(repo).toMatch(/async activeOrders\(\): Promise<Order\[\]>/);
    expect(repo).toMatch(/eq\(schema\.orders\.status, "Confirmed"\)/);

    // 4. The aggregate routes file's response schema is exported so
    //    the views router can import it without duplicating shapes.
    const aggRoutes = files.get("http/order.routes.ts")!;
    expect(aggRoutes).toMatch(/export const OrderResponse = z\.object/);
    expect(aggRoutes).toMatch(/export const OrderListResponse =/);
  });

  it("emits a custom-shape view with per-row projection (full form)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          contains lines: OrderLine[]
          entity OrderLine { quantity: int, invariant quantity > 0 }
        }
        repository Orders for Order { }
        view OrderSummary {
          orderId: Order id
          status: OrderStatus
          lineCount: int
          from Order where status == Confirmed
          bind orderId = id, status = status, lineCount = lines.count
        }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const views = files.get("http/views.ts")!;

    // Custom Zod schema declared at top of the file.
    expect(views).toMatch(
      /const OrderSummaryRow = z\.object\(\{[\s\S]+?orderId: z\.string\(\),[\s\S]+?status: z\.enum\(\["Draft", "Confirmed"\]\),[\s\S]+?lineCount: z\.number\(\)\.int\(\),[\s\S]+?\}\)/,
    );
    expect(views).toMatch(/const OrderSummaryResponse = z\.array\(OrderSummaryRow\)/);

    // Route uses the custom response schema.
    expect(views).toMatch(/schema: OrderSummaryResponse/);

    // Body projects through bind expressions rooted at row var `r`.
    expect(views).toMatch(/orderId: r\.id/);
    expect(views).toMatch(/status: r\.status/);
    expect(views).toMatch(/lineCount: r\.lines\.length/);
    expect(views).toMatch(/projected as z\.infer<typeof OrderSummaryResponse>/);
  });

  it("rewrites X id follow refs to bulk-load + map lookups", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer { name: string, email: string  derived display: string = name }
        aggregate Order {
          customerId: Customer id
          status: OrderStatus
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        view CustomerOrders {
          orderId: Order id
          customerName: string
          customerEmail: string
          status: OrderStatus
          from Order where status == Confirmed
          bind orderId = id, customerName = customerId.name, customerEmail = customerId.email, status = status
        }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const views = files.get("http/views.ts")!;

    // Foreign aggregate's repo is imported and instantiated.
    expect(views).toMatch(
      /import \{ CustomerRepository \} from "..\/db\/repositories\/customer-repository"/,
    );
    expect(views).toMatch(/const customerRepo = new CustomerRepository\(db, events\)/);
    // Bulk load + map by id.
    expect(views).toMatch(
      /const customerById = new Map\(\(await customerRepo\.findManyByIds\(rows\.map\(\(r\) => r\.customerId\)\)\)\.map\(\(a\) => \[a\.id as string, a\]\)\)/,
    );
    // Projection rewrites the Id-follow refs.
    expect(views).toMatch(/customerName: customerById\.get\(r\.customerId as string\)!\.name/);
    expect(views).toMatch(/customerEmail: customerById\.get\(r\.customerId as string\)!\.email/);

    // Repo gained findManyByIds.
    const customerRepo = files.get("db/repositories/customer-repository.ts")!;
    expect(customerRepo).toMatch(
      /async findManyByIds\(ids: Ids\.CustomerId\[\]\): Promise<Customer\[\]>/,
    );
    expect(customerRepo).toMatch(/\.where\(inArray\(schema\.customers\.id, ids\)\)/);
  });

  it("workflow op-call to a parameterless extern calls the aggregate-owned op", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          function isMutable(): bool = status == Draft
          operation confirm() extern { precondition isMutable() }
        }
        repository Orders for Order { }
        workflow placeAndConfirm {
      create(orderId: Order id) {
          let order = Orders.getById(orderId)
          order.confirm()
        }
    }
      }
    `,
      { validation: true },
    );
    const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
    const wf = files.get("http/workflows.ts")!;

    // No registry import, no handler dance — the op is aggregate-owned.
    expect(wf).not.toMatch(/order-extern/);
    expect(wf).not.toMatch(/externHandlers/);
    expect(wf).toMatch(/order\.confirm\(\);/);
    // Save still happens at workflow exit.
    expect(wf).toMatch(/await orders\.save\(order\);/);
  });

  it("workflow op-call to a parameterized extern passes the args straight through", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        aggregate Order {
          customerId: string
          status: string
          function isMutable(): bool = status == "Draft"
          operation deduct(amount: decimal) extern {
            precondition isMutable()
            precondition amount > 0
          }
        }
        repository Orders for Order { }
        workflow chargeOrder {
      create(orderId: Order id, amount: decimal) {
          let order = Orders.getById(orderId)
          order.deduct(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const wf = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS).get(
      "http/workflows.ts",
    )!;
    expect(wf).toMatch(/order\.deduct\(amount\);/);
    expect(wf).not.toMatch(/await handler\(order/);
  });

  it("multi-hop X id.Y id.field follow loads aggregates in dependency order", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Region { name: string, countryCode: string  derived display: string = name }
        aggregate Customer { name: string, regionId: Region id  derived display: string = name }
        aggregate Order { customerId: Customer id, status: OrderStatus }
        repository Regions for Region { }
        repository Customers for Customer { }
        repository Orders for Order { }
        view OrdersWithRegion {
          orderId: Order id
          regionName: string
          countryCode: string
          from Order where status == Confirmed
          bind orderId = id,
               regionName = customerId.regionId.name,
               countryCode = customerId.regionId.countryCode
        }
      }
    `,
      { validation: true },
    );
    const wf = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS).get(
      "http/views.ts",
    )!;

    // Both auxiliaries loaded; Customer first, then Region keyed by
    // customer.regionId values.
    expect(wf).toMatch(
      /const customerById = new Map\(\(await customerRepo\.findManyByIds\(rows\.map\(\(r\) => r\.customerId\)\)\)/,
    );
    expect(wf).toMatch(
      /const regionByCustomerId = new Map\(\(await regionRepo\.findManyByIds\(\[\.\.\.customerById\.values\(\)\]\.map\(\(a\) => a\.regionId\)\)\)/,
    );
    // Chained projection.
    expect(wf).toMatch(
      /regionName: regionByCustomerId\.get\(customerById\.get\(r\.customerId as string\)!\.regionId as string\)!\.name/,
    );
  });

  it("emits <Vo>Schema / <Enum>Schema declarations for value-object + enum workflow params", async () => {
    // Regression for the Banking-system "Bundle import failed:
    // Can't find variable: MoneySchema" runtime crash.  The
    // workflow-routes emitter called `zodFor(p.type)` for each
    // workflow param — which returns a bare `MoneySchema` /
    // `<Enum>Schema` reference — without first declaring the
    // matching `const`.  esbuild bundles the file fine (it doesn't
    // fail on undefined identifiers), so the breakage only surfaces
    // at module evaluation when the runtime worker dynamic-imports
    // the bundle.  This test asserts that http/workflows.ts emits
    // the schema declarations needed to make its request schemas
    // self-contained, exactly like http/<agg>.routes.ts already does.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Banking {
        enum AccountStatus { Open, Frozen, Closed }
        valueobject Money {
          amount: decimal
          currency: string
          invariant amount >= 0
          invariant currency.length == 3
        }
        aggregate Account {
          holder: string
          derived display: string = holder
          status: AccountStatus
          balance: Money
          operation deposit(amount: Money) {
            precondition amount.amount > 0
            balance := Money { amount: balance.amount + amount.amount, currency: balance.currency }
          }
          operation withdraw(amount: Money) {
            precondition amount.amount > 0
            balance := Money { amount: balance.amount - amount.amount, currency: balance.currency }
          }
        }
        repository Accounts for Account { }
        workflow transferFunds transactional {
      create(
          fromAccount: Account id,
          toAccount: Account id,
          amount: Money,
        ) {
          let from = Accounts.getById(fromAccount)
          let to = Accounts.getById(toAccount)
          from.withdraw(amount)
          to.deposit(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const wf = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS).get(
      "http/workflows.ts",
    )!;
    // The Money schema is declared as a local const, with the
    // openapi("Money") tag so it appears in /openapi.json.  Invariant
    // refinements stay outside the openapi name (see emitWireSchema).
    expect(wf).toMatch(/const MoneySchema = z\.object\(\{[\s\S]*?\}\)\.openapi\("Money"\)/);
    // TransferFundsRequest references MoneySchema by name, not by
    // an inline z.object — that's what would otherwise crash at
    // boot when MoneySchema isn't declared.
    expect(wf).toMatch(/amount: MoneySchema,/);
    // Sanity: no dangling reference to a *Schema name that wasn't
    // declared in this file.  Match every `<X>Schema` reference,
    // then check each appears at least once as `const <X>Schema =`.
    const refs = new Set([...wf.matchAll(/\b([A-Z][A-Za-z0-9]*)Schema\b/g)].map((m) => m[1]));
    for (const name of refs) {
      expect(wf, `missing declaration for ${name}Schema in workflows.ts`).toMatch(
        new RegExp(`const ${name}Schema\\b`),
      );
    }
  });

  it("emits explicit isolationLevel for transactional(level) workflows", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow ser transactional(serializable) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow rr transactional(repeatableRead) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow ru transactional(readUncommitted) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow rc transactional(readCommitted) {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
        workflow plain transactional {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
      }
    `,
      { validation: true },
    );
    const wf = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS).get(
      "http/workflows.ts",
    )!;
    expect(wf).toMatch(/\}, \{ isolationLevel: "serializable" \}\);/);
    expect(wf).toMatch(/\}, \{ isolationLevel: "repeatable read" \}\);/);
    expect(wf).toMatch(/\}, \{ isolationLevel: "read uncommitted" \}\);/);
    expect(wf).toMatch(/\}, \{ isolationLevel: "read committed" \}\);/);
    // Bare `transactional` doesn't emit an isolationLevel — exactly
    // four occurrences across the file (one per leveled workflow).
    expect(wf.match(/isolationLevel/g)?.length).toBe(4);
    // The `plain` route still has the transaction wrapper, just without the option.
    expect(wf).toMatch(/operationId: "plainWorkflow"/);
    expect(wf).toMatch(/await db\.transaction\(async \(tx\) =>/);
  });

  it("Drizzle schema emits indexes for find-referenced columns + part FKs", async () => {
    // sales.ddd's Order.byCustomer + activeForCustomer drive
    // `customerId` and `status` indexes on the orders table; the
    // OrderLine part gets a parentId index so findById's eager-load
    // join doesn't sequential-scan.
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model, HONO_V4_PINS);
    const schema = files.get("db/schema.ts")!;
    expect(schema).toMatch(/import \{[^}]*\bindex\b[^}]*\} from "drizzle-orm\/pg-core"/);
    expect(schema).toMatch(
      /orderCustomerIdIdx: index\("orders_customer_id_idx"\)\.on\(table\.customerId\)/,
    );
    expect(schema).toMatch(/orderStatusIdx: index\("orders_status_idx"\)\.on\(table\.status\)/);
    // Part FK index keys off the real column (`order_id`), matching the migration.
    expect(schema).toMatch(
      /orderLineOrderIdIdx: index\("order_lines_order_id_idx"\)\.on\(table\.parentId\)/,
    );
  });

  // -------------------------------------------------------------------------
  // auth scaffolding
  // -------------------------------------------------------------------------

  describe("auth scaffolding", () => {
    async function emitForAuthSystem(src: string): Promise<Map<string, string>> {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(src, { validation: true });
      const { lowerModel } = await import("../../../src/ir/lower/lower.js");
      const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
      const { generateTypeScriptForContexts } = await import(
        "../../../src/platform/hono/v4/emit.js"
      );
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const sys = loom.systems[0]!;
      const dep = sys.deployables.find((d) => d.platform === "node")!;
      const contexts = sys.subdomains.flatMap((m) => m.contexts);
      return generateTypeScriptForContexts(contexts, HONO_V4_PINS, { deployable: dep, sys });
    }

    const SRC_AUTH_REQUIRED = `
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
              operation cancel() {
                precondition currentUser.role == "manager"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: node
          contexts: [Orders]
          port: 3000
          auth: required
        }
      }
    `;

    const SRC_NO_AUTH = `
      system Acme {
        user { id: string }
        subdomain Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: node
          contexts: [Orders]
          port: 3000
        }
      }
    `;

    it("emits auth/* files when deployable opts in via `auth: required`", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const keys = [...files.keys()];
      expect(keys).toContain("auth/user-types.ts");
      expect(keys).toContain("auth/verifier.ts");
      expect(keys).toContain("auth/middleware.ts");
    });

    it("does NOT emit auth/* files when the deployable has no `auth: required`", async () => {
      const files = await emitForAuthSystem(SRC_NO_AUTH);
      const keys = [...files.keys()];
      expect(keys).not.toContain("auth/user-types.ts");
      expect(keys).not.toContain("auth/middleware.ts");
    });

    it("http/index.ts mounts authMiddleware after cors() and asserts verifier registration", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const httpIndex = files.get("http/index.ts")!;
      expect(httpIndex).toMatch(/app\.use\("\*", authMiddleware\);/);
      expect(httpIndex).toMatch(/assertUserVerifierRegistered\(\);/);
      const cors = httpIndex.indexOf("cors({");
      const auth = httpIndex.indexOf('app.use("*", authMiddleware)');
      expect(cors).toBeGreaterThan(0);
      expect(auth).toBeGreaterThan(cors);
      // auth_enabled (info) emitted at boot whenever the verifier
      // assert clears, so every boot log advertises whether this
      // deployable expects authenticated requests.
      expect(httpIndex).toMatch(/import \{ baseLogger \} from "\.\.\/obs\/log"/);
      expect(httpIndex).toMatch(/baseLogger\.info\(\{ event: "auth_enabled", required: true \}\)/);
    });

    it("middleware bypasses /health, /openapi.json, /swagger", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const mw = files.get("auth/middleware.ts")!;
      expect(mw).toMatch(/"\/health"/);
      expect(mw).toMatch(/"\/openapi\.json"/);
      expect(mw).toMatch(/"\/swagger"/);
    });

    it("auth middleware attaches the principal to the ambient RequestContext + exposes requireCurrentUser", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const mw = files.get("auth/middleware.ts")!;
      // The principal is written onto the carrier (read by non-HTTP code)
      // as well as the Hono context (read by route handlers).
      expect(mw).toMatch(/import \{ requestContext \} from "\.\.\/obs\/als"/);
      expect(mw).toMatch(
        /const ctx = requestContext\(\);\s*\n\s*if \(ctx\) ctx\.currentUser = user;/,
      );
      // The principal's id is also stamped as the carrier's `actorId` — the
      // who-computed slice audit / provenance read.  Id key is `id` here.
      expect(mw).toContain("if (ctx) ctx.actorId = String(user.id);");
      expect(mw).toMatch(/c\.set\("currentUser", user\)/);
      // Ambient accessor — the analogue of .NET's ICurrentUserAccessor.User.
      expect(mw).toMatch(/export function requireCurrentUser\(\): User/);
      expect(mw).toMatch(/return user as User;/);
    });

    it("aggregate operation referencing currentUser gains a User parameter and the route threads currentUser into the call", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const order = files.get("domain/order.ts")!;
      expect(order).toMatch(/cancel\([^)]*currentUser: User[^)]*\)/);
      expect(order).toMatch(/currentUser\.role/);
      const route = files.get("http/order.routes.ts")!;
      // The context's Variables map doesn't declare `currentUser`, so the
      // read goes through a cast (`(c as unknown as { get(k: "currentUser") … })`)
      // — a bare `c.get("currentUser")` fails to type-check (key never).
      expect(route).toMatch(/const currentUser = \(c as unknown as \{ get\(k: "currentUser"\)/);
      expect(route).toMatch(/aggregate\.cancel\(currentUser\)/);
    });

    const SRC_WORKFLOW_GUARD = `
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order { }
            workflow archiveAll {
      create() {
              requires currentUser.role == "admin"
              let o = Order.create({ customerId: "c", status: "archived" })
            }
    }
            workflow touchOne {
      create() {
              let o = Order.create({ customerId: "c", status: "new" })
            }
    }
          }
        }
        deployable api {
          platform: node
          contexts: [Orders]
          port: 3000
          auth: required
        }
      }
    `;

    it("guarded workflow binds currentUser before the requires check, and denies with ForbiddenError (403)", async () => {
      // A `requires currentUser.…` guard in a workflow renders the bare
      // token `currentUser`; without a binding the handler throws a
      // ReferenceError (→ 500) before it can deny.  The handler must read
      // the request-scoped user — mirroring the per-operation route — so a
      // failed guard raises ForbiddenError, which onError maps to 403.
      const files = await emitForAuthSystem(SRC_WORKFLOW_GUARD);
      const wf = files.get("http/workflows.ts")!;
      // Read via a cast — the context Variables map has no `currentUser` key,
      // so a bare `httpCtx.get("currentUser")` would not type-check.
      expect(wf).toMatch(
        /const currentUser = \(httpCtx as unknown as \{ get\(k: "currentUser"\): import\("\.\.\/auth\/user-types"\)\.User \}\)\.get\("currentUser"\);/,
      );
      expect(wf).toMatch(/if \(!\(currentUser\.role === "admin"\)\) throw new ForbiddenError\(/);
      expect(wf).toMatch(/if \(err instanceof ForbiddenError\) return problem\(403,/);
      // The binding is conditional: only the guarded workflow's handler
      // gets it — `touchOne` never references currentUser.
      expect((wf.match(/\.get\("currentUser"\)/g) ?? []).length).toBe(1);
      // The guarded workflow DECLARES 403 in its OpenAPI responses (the
      // unguarded `touchOne` does not) — exactly one 403 across the file.
      expect(wf).toMatch(
        /403: \{ description: "Forbidden", content: \{ "application\/problem\+json": \{ schema: ProblemDetails \} \} \}/,
      );
      expect((wf.match(/403: \{ description: "Forbidden"/g) ?? []).length).toBe(1);
    });

    it("a `requires`-guarded operation declares 403 in its route responses; an unguarded one does not", async () => {
      // A `requires` guard (not a precondition) denies with ForbiddenError →
      // 403; the route's `responses` block gains a 403 ProblemDetails entry.
      // `block` is guarded, `nudge` is not — exactly one 403 in the file.
      const src = `
        system Acme {
          user { id: string, role: string }
          subdomain Sales {
            context Orders {
              aggregate Order {
                customerId: string
                status: string
                operation block() {
                  requires currentUser.role == "admin"
                  status := "blocked"
                }
                operation nudge() {
                  status := "nudged"
                }
              }
              repository Orders for Order { }
            }
          }
          deployable api { platform: node, contexts: [Orders], port: 3000, auth: required }
        }
      `;
      const files = await emitForAuthSystem(src);
      const route = files.get("http/order.routes.ts")!;
      expect(route).toMatch(/operationId: "blockOrder"/);
      expect(route).toMatch(
        /403: \{ description: "Forbidden", content: \{ "application\/problem\+json": \{ schema: ProblemDetails \} \} \}/,
      );
      // Only the guarded op declares it.
      expect((route.match(/403: \{ description: "Forbidden"/g) ?? []).length).toBe(1);
    });

    // -----------------------------------------------------------------------
    // currentUser inside find / view filters
    // -----------------------------------------------------------------------

    const SRC_FILTER_AUTH = `
      system Acme {
        user {
          id: string
          customerId: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order {
              find mine(): Order[] where customerId == currentUser.customerId
            }
            view MyOrders = Order where customerId == currentUser.customerId
          }
        }
        deployable api {
          platform: node
          contexts: [Orders]
          port: 3000
          auth: required
        }
      }
    `;

    it("repository find with currentUser filter gains a User parameter and imports the type", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const repo = files.get("db/repositories/order-repository.ts")!;
      expect(repo).toMatch(/import type \{ User \} from "\.\.\/\.\.\/auth\/user-types";/);
      expect(repo).toMatch(/async mine\([^)]*currentUser: User[^)]*\)/);
    });

    it('find route reads c.get("currentUser") and threads it into the repo call', async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const route = files.get("http/order.routes.ts")!;
      expect(route).toMatch(/const currentUser = \(c as unknown as \{ get\(k: "currentUser"\)/);
      expect(route).toMatch(/repo\.mine\(currentUser\)/);
    });

    it('view route reads c.get("currentUser") and threads it into the repo call', async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const views = files.get("http/views.ts")!;
      expect(views).toMatch(
        /const currentUser = \(httpCtx as unknown as \{ get\(k: "currentUser"\)/,
      );
      expect(views).toMatch(/repo\.myOrders\(currentUser\)/);
    });

    // -----------------------------------------------------------------------
    // `requires` clauses
    // -----------------------------------------------------------------------

    const SRC_REQUIRES = `
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              status: string
              operation cancel() {
                requires currentUser.role == "manager"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: node
          contexts: [Orders]
          port: 3000
          auth: required
        }
      }
    `;

    it("`requires` lowers to a ForbiddenError throw inside the aggregate method", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const order = files.get("domain/order.ts")!;
      expect(order).toMatch(/throw new ForbiddenError\(/);
      // The errors-module import is now narrowed to what the body actually
      // emits — this fixture has a `requires` (ForbiddenError) but no
      // invariants/preconditions, so DomainError isn't imported.
      expect(order).toMatch(/import \{ ForbiddenError \} from "\.\/errors";/);
    });

    it("errors.ts exports ForbiddenError", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const errors = files.get("domain/errors.ts")!;
      expect(errors).toMatch(/export class ForbiddenError extends Error/);
    });

    it("http/<aggregate>.routes.ts maps ForbiddenError to 403 in app.onError", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const route = files.get("http/order.routes.ts")!;
      // The onError arm logs the catalog event, then returns an RFC 7807
      // problem body (403 Forbidden) via the shared `problem(...)` responder.
      expect(route).toMatch(/if \(err instanceof ForbiddenError\) \{/);
      expect(route).toMatch(/return problem\(403, "Forbidden", err\.message\);/);
    });
  });

  // -------------------------------------------------------------------
  // wire-boundary validation on Hono routes.
  // -------------------------------------------------------------------
  describe("invariants on the wire (Hono Zod refines)", () => {
    it("absorbs single-field invariants on a value-object schema into idiomatic native chains", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      // sales.ddd Money: `invariant amount >= 0` + `invariant currency.length == 3`.
      const orderRoutes = files.get("http/order.routes.ts")!;
      expect(orderRoutes).toMatch(/amount: z\.coerce\.number\(\)\.min\(0\)/);
      expect(orderRoutes).toMatch(/currency: z\.string\(\)\.length\(3\)/);
      // No leftover `.refine(` for the single-field shapes.
      const moneyBlock = orderRoutes.match(
        /const MoneySchema = z\.object\(\{[\s\S]*?\}\)\.openapi\("Money"\)([^;]*);/,
      )!;
      expect(moneyBlock[1]).toBe("");
    });

    it("absorbs single-field op-precondition into idiomatic chain on <Op>Request", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      // sales.ddd Order.addLine: `precondition qty > 0` (with int qty).
      const orderRoutes = files.get("http/order.routes.ts")!;
      // `qty > 0` → recognised as min(1) on the int field.
      expect(orderRoutes).toMatch(
        /AddLineOrderRequest = z\.object\(\{[\s\S]*qty: z\.coerce\.number\(\)\.int\(\)\.min\(1\)/,
      );
    });

    it("excludes invariants referencing aggregate state from Create<Agg>Request", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const orderRoutes = files.get("http/order.routes.ts")!;
      // sales.ddd Order has `invariant lines.count > 0 when status == Confirmed`.
      // `lines` is a containment, not in the create-request body — the
      // classifier filters this out, so CreateOrderRequest carries NO
      // refine clause for it.
      const createBlock = orderRoutes.match(
        /const CreateOrderRequest = z\.object\(\{[\s\S]*?\}\)\.openapi\("CreateOrderRequest"\)([^;]*);/,
      )!;
      expect(createBlock[1]).toBe("");
      // And the schema still has the basic field set.
      expect(orderRoutes).toMatch(
        /CreateOrderRequest = z\.object\(\{[\s\S]*customerId:[\s\S]*status:[\s\S]*placedAt:/,
      );
    });

    it("excludes preconditions referencing helper-fns / aggregate state from <Op>Request", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model, HONO_V4_PINS);
      const orderRoutes = files.get("http/order.routes.ts")!;
      // Order.addLine has `precondition isMutable()` — references
      // `this.status` via a helper-fn.  Must NOT appear as a refine
      // on AddLineRequest (and the refine can't read `this`).
      const addLineBlock = orderRoutes.match(
        /const AddLineOrderRequest = z\.object\(\{[\s\S]*?\}\)\.openapi\("AddLineOrderRequest"\)([^;]*);/,
      )!;
      // Only the `qty > 0` precondition is wire-translatable, and it
      // was absorbed into the int chain — so no `.refine(` here.
      expect(addLineBlock[1]).toBe("");
      // Confirm has no params and `isMutable()`/`lines.count > 0`
      // preconditions — both server-only — so the schema is empty +
      // unrefined.
      expect(orderRoutes).toMatch(
        /const ConfirmOrderRequest = z\.object\(\{\s*\}\)\.openapi\("ConfirmOrderRequest"\);/,
      );
    });

    it("absorbs `string.matches(literal)` as `z.string().regex(/.../)` on Hono routes", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Auth {
            aggregate User {
              email: string
              derived display: string = email
              invariant email.matches("^[^@]+@.+$")
              create(email: string) { email := email }
            }
            repository Users for User { }
          }
        `,
        { validation: true },
      );
      const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
      const routes = files.get("http/user.routes.ts")!;
      expect(routes).toMatch(
        /CreateUserRequest = z\.object\(\{[\s\S]*email: z\.string\(\)\.regex\(\/\^\[\^@\]\+@\.\+\$\/\)/,
      );
    });

    it("renders `matches` in domain code as a `/pattern/.test(...)` regex literal", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Auth {
            aggregate User {
              email: string
              derived display: string = email
              invariant email.matches("^[^@]+@.+$")
            }
            repository Users for User { }
          }
        `,
        { validation: true },
      );
      const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
      const userClass = files.get("domain/user.ts")!;
      expect(userClass).toMatch(/\/\^\[\^@\]\+@\.\+\$\/\.test\(this\._email\)/);
    });

    it("emits cross-field invariants as `.refine()` with field-path attribution", async () => {
      // Use an in-memory model with a synthetic cross-field invariant
      // since sales.ddd's only cross-field rule is non-translatable.
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          context Shop {
            aggregate Reservation {
              fromTime: int
              toTime:   int
              invariant fromTime < toTime
              create(fromTime: int, toTime: int) { fromTime := fromTime  toTime := toTime }
            }
            repository Reservations for Reservation { }
          }
        `,
        { validation: true },
      );
      const files = generateTypeScript(doc.parseResult.value as Model, HONO_V4_PINS);
      const routes = files.get("http/reservation.routes.ts")!;
      // `fromTime < toTime` is cross-field — falls through to .refine.
      expect(routes).toMatch(
        /CreateReservationRequest = z\.object\(\{[\s\S]*?\}\)\.openapi\("CreateReservationRequest"\)\.refine\(\(data\) => data\.fromTime < data\.toTime, \{ path: \["fromTime"\], message: "Invariant violated: [^"]*" \}\)/,
      );
    });
  });
});
