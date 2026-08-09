# M-T9.26 — `RouteTarget`: seal the HTTP-emission surface behind a contract

*Phase 1 (divergence audit) + Phase 2 (seam contract + slicing plan). This is the **design-first deliverable for maintainer sign-off**, per [`RUNBOOK.md`](../RUNBOOK.md) step 3 and the [M-T9.2](./M-T9.2-persistence-seam-design.md) precedent. **No extraction code lands until this is signed off.***

> **STATUS: DESIGN — awaiting sign-off.** Measurements below are code-verified against `main` @ `e1eec64` (2026-08-03) using `examples/showcase.ddd` → `hono_api`. Re-verify before implementing; this repo's statuses rot.

---

## 0. TL;DR

The node backend's **HTTP-emission surface is the largest un-sealed emitter in the toolchain** — 56% of a feature-rich generated project, 183 coupling sites across 18 emitter files — and unlike the persistence surface M-T9.2 examined, **its divergence is leaf-shaped, not compositional.** That is precisely the condition under which this repo's `Target` pattern works.

Three findings:

1. **The emission is highly regular.** Every route is one `app.openapi(createRoute({…}), async (c) => {…})` pair — a *spec object* plus a *handler body* whose interior is already framework-neutral domain logic. The framework appears only at four seams: router construction, input binding, response emission, error mapping.
2. **OpenAPI derivation is already framework-agnostic** and would not need re-implementing per framework — `@hono/zod-openapi@1` is a wrapper over `@asteasolutions/zod-to-openapi` + `@hono/zod-validator` + `openapi3-ts` (registry-verified, not from memory).
3. **The precedent already exists in-tree, one level down.** `src/generator/_obs/` is exactly this shape: a neutral catalog (`log-events.ts`) plus per-framework renderers (`render-hono.ts` / `render-dotnet.ts` / `render-phoenix.ts`). `RouteTarget` generalises that from *log calls* to *the route surface*.

**The seam is justified on its own merits** — a compile-checked contract in place of hand-threaded branches — **independent of whether a second framework is ever added.** A second framework is out of scope and stays subject to the [T10 freeze](../T10-new-targets.md).

---

## 1. Phase 1 — divergence audit

### 1.1 The measurement

`examples/showcase.ddd` → `hono_api` (auth + workflows + realtime + projections; 51 files, 4163 LOC):

| surface | files | LOC | share of project |
|---|---|---|---|
| framework shell (references Hono) | 15 | **2337** | **56%** |
| persistence layer (references Drizzle) | 13 | 1427 | 34% |

The shell is not merely "routing." It absorbs the cross-cutting features: `auth/middleware.ts`, `auth/handshake.ts`, `obs/tracing.ts`, `obs/request-id.ts`, `http/realtime.ts`, `http/workflows.ts`, plus the per-aggregate `*.routes.ts`.

Emitter-side coupling — Hono-API tokens across `src/platform/hono/v4/` + `src/generator/typescript/`:

| token | sites | seam it belongs to |
|---|---|---|
| `c.req` | 37 | input binding |
| `c.json` | 33 | response emission |
| `hono/` imports | 32 | imports |
| `OpenAPIHono` | 31 | router construction |
| `createRoute` | 28 | route spec |
| `app.openapi` | 22 | route registration |
| `@hono` imports | 17 | imports |

**183 sites across 18 files** (strict count; per-line token counts overlap).

### 1.2 The shape every route already has

From `routes-builder.ts:552`–`:775` — the emitted form is invariant:

```ts
export function squadRoutes(repo: SquadRepository): OpenAPIHono {
  const app = newApp();
  app.openapi(
    createRoute({ method, path, tags, operationId, request: {…}, responses: {…} }),
    async (c) => {
      const { id } = c.req.valid("param");     // ← input-binding seam
      const found = await repo.findById(…);    // ← framework-NEUTRAL body
      if (!found) throw new AggregateNotFoundError("not_found");
      return c.json(repo.toWire(found), 200);  // ← response seam
    },
  );
  return app;
}
```

The handler interior — repository calls, domain construction, invariant checks, error throws — is already platform-neutral IR-rendered TypeScript. **The framework touches only the edges.** That is the structural difference from persistence, where the ORM's API pervades the *body* of every repository method.

### 1.3 Fragment × divergence classification

Honest classification — `leaf` = mechanical substitution behind a contract method; `adapter` = needs a small shim; `structural` = genuinely different topology.

| fragment | emitted file(s) | Hono form | class | note |
|---|---|---|---|---|
| router construction / mounting | `http/index.ts` | `newApp()` → `OpenAPIHono`; `app.route(p, sub)` | **leaf** | cf. `express.Router()` + `app.use(p, r)` |
| route registration + OpenAPI | `*.routes.ts` | `app.openapi(createRoute({…}), h)` | **leaf** | `createRoute`'s payload ≈ `registry.registerPath`'s |
| input binding | `*.routes.ts` | `c.req.valid("param"\|"json"\|"query")` | **leaf** | a validator middleware writes the same bag |
| response emission | `*.routes.ts` | `c.json(x, 200)` / `c.body(…, status, hdrs)` | **leaf** | cf. `res.status(200).json(x)` |
| error → problem+json | `http/problem-details.ts` | `app.onError` | **leaf** | Express 5.2 forwards async rejections natively |
| context storage | auth + obs | `c.set/get` (+ the `Variables` cast, `_obs/render-hono.ts:27`) | **leaf** | cf. `res.locals` |
| log seam | all | `renderHonoLogCall` | **already sealed** | in `_obs/`; `RouteTarget` calls it, does not absorb it |
| **raw request access** | `auth/middleware.ts:295` | `c.req.raw` → Web `Request` | **adapter** | Hono is Web-Standards-based; a Node `IncomingMessage` host needs `toWebRequest()`. The OIDC verifier takes a Web `Request`. |
| **SSE realtime** | `http/realtime.ts` | `streamSSE(c, …)`; `stream.writeSSE/onAbort/aborted/sleep` | **structural (small)** | ~57 emitted LOC; a distinct lifecycle, not a rename. Earns its own contract method rather than a substitution. |

**Two entries are not free**, and this design records them rather than glossing them: raw-request access and SSE. Both are confined to one file each and total under ~120 emitted LOC — bounded, unlike the ORM write-path divergence M-T9.2 hit a hard wall on.

### 1.4 Why this differs from M-T9.2's decline

M-T9.2 declined `QueryTarget` because ORMs **compose through different APIs**: Drizzle's function combinators (`eq(col, val)` — operands must be split by role) cannot share a walk with SQLAlchemy's operator overloads (`(l op r)` — uniform recursion). The *composition* diverged, not just the spelling.

HTTP frameworks do not have that property here. Both register a `(path, handler)` pair against a router, and both bind inputs and emit responses through a per-request object. The divergence is **which method name on which object** — textbook leaf divergence, the class `ExprTarget` already absorbs. M-T9.2's own addendum applies directly: a **callback/AST-returning** target works where a string-returning one cannot.

---

## 2. Phase 2 — seam design

### 2.1 Shape and home

Following `_expr` / `_walker` / `_obs` / `_workflow`:

```
route/
  target.ts        # the RouteTarget contract + renderRoutesWith() dispatcher
  spec.ts          # RouteSpecIR — the neutral route descriptor
  openapi.ts       # zod-to-openapi registry emission (framework-independent)
```

**Home is deliberately NOT `src/generator/_route/` at slice 1** — see open question 1. It starts at `src/platform/hono/v4/route/` and is promoted only when a second consumer exists. Either way no backward edge is introduced, so `pipeline-layering.test.ts` and `backend-packages-layering.test.ts` stay green.

### 2.2 The neutral descriptor

The dispatcher owns the walk over routes; the target owns the spelling.

```ts
export interface RouteSpecIR {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;                     // "/{id}/update" — brace form; the target re-spells
  operationId: string;
  tags: readonly string[];
  params?: ZodSchemaRef;
  query?: ZodSchemaRef;
  body?: ZodSchemaRef;
  responses: ReadonlyArray<{ status: number; schema?: ZodSchemaRef; problem?: boolean }>;
}
```

### 2.3 Contract sketch

```ts
export interface RouteTarget {
  // --- imports + router construction ---
  imports(needs: RouteNeeds): string[];
  openRouter(fnName: string, params: string, returnType: string): string[];
  closeRouter(): string[];
  mountChild(basePath: string, childExpr: string): string;

  // --- per-route ---
  /** Emit one route.  `body` is the ALREADY-RENDERED, framework-neutral
   *  handler interior; the target only wraps it. */
  route(spec: RouteSpecIR, body: string[]): string[];

  // --- the leaf seams the handler body reaches through ---
  readParam(name: string): string;       // c.req.valid("param") → { id }
  readQuery(): string;
  readBody(): string;
  respondJson(expr: string, status: number, cast?: string): string;
  respondEmpty(status: number): string;
  respondProblem(status: string, title: string, detail: string): string;
  requestPath(): string;                 // c.req.path
  rawRequest(): string;                  // c.req.raw — adapter on non-Web-Standard hosts

  // --- context storage ---
  ctxSet(key: string, expr: string): string;
  ctxGet(key: string, type: string): string;

  // --- the two recorded non-leaf seams ---
  errorHandler(arms: ProblemArm[]): string[];
  sseStream(opts: SseOpts): string[];
}
```

`route()` returning `string[]` rather than a fused template is the design's load-bearing choice: it lets a target emit **one** artifact (Hono: `app.openapi(createRoute(…), h)`) or **two** (a router registration plus a separate `registry.registerPath(spec)`) from the same `RouteSpecIR`. That is what keeps the OpenAPI split a leaf concern instead of a fork.

### 2.4 What stays per-backend (recorded declines)

- **.NET / Java / Python / Elixir do not join this seam.** Each emits its HTTP surface through framework-native machinery (attribute-routed `[ApiController]`, Spring `@RestController`, FastAPI decorators, Phoenix router macros) in a different *language*. `RouteTarget` is a **node-family seam** — in-scope backends: `node` only. This mirrors `WorkflowStmtTarget` (4 of 5) and HEEx declining `walkBody`: expected, not a failure.
- **The `_obs/render-hono*.ts` renderers stay put.** Already sealed.

### 2.5 Slicing plan (easiest-first, byte-identical per slice)

Each slice keeps output **byte-identical** to today's Hono emission, gated by the existing fixtures + `hono-build.yml` + `behavioral-e2e.yml`. One slice per PR.

| # | slice | files | gate |
|---|---|---|---|
| 1 | `RouteSpecIR` + `renderRoutesWith` + `HONO_TARGET` leaf table; port **`routes-builder.ts`** only | `route/*`, `routes-builder.ts` | fixtures byte-identical + `npm test` |
| 2 | port `explicit-handlers-builder.ts` + `projection-query-routes-builder.ts` | 2 | same |
| 3 | port `workflow-builder.ts` HTTP surface (leave workflow *statements* on `WorkflowStmtTarget`) | 1 | + `behavioral-e2e` |
| 4 | port `auth-emit.ts` — introduces the `rawRequest()` adapter seam | 1 | + `run-oidc` label |
| 5 | port `realtime-builder.ts` — the `sseStream()` contract method | 1 | + `run-channels` label |
| 6 | lift OpenAPI emission to `route/openapi.ts`; evaluate whether Elixir's `openapi-emit.ts` / Java's `openapi-customizer.ts` can consume a neutral `RouteSpecIR` | 3 backends | `conformance-parity` |

Slice 6 is the only one with value beyond node, and it should be **re-scoped after slice 1** — plausibly only the *spec model* is shareable across languages, not the emission. Do not promise it up front.

### 2.6 Sequencing prerequisite — byte-identical gating needs a quiet baseline

*Added 2026-08-03 after a pre-implementation conflict check. This is a design constraint the original draft missed, not a scheduling note.*

Every slice is gated on **output byte-identical to today's Hono emission**. That method silently requires the baseline to hold still: if another in-flight PR *changes* what the emitters emit, there is no fixed target to be identical to, and the gate degrades from a proof into a diff against a moving reference.

**Check before starting any slice** — for each file in the slice, does an open PR modify it?

```bash
git fetch origin
git diff --numstat origin/main...origin/<branch> -- src/platform/hono/v4/
```

**Blocked as of 2026-08-03:** [#2340](https://github.com/lemmit/Loc/pull/2340) (M-T9.25, cross-backend differential gate) touches **five of the six files in the slice 1–3 blast radius** — `routes-builder.ts` (87+/35−), `explicit-handlers-builder.ts` (22+/4−), `projection-query-routes-builder.ts` (24+/4−), `workflow-builder.ts` (34+/8−), `projection-builder.ts` (2+/1−). [#2363](https://github.com/lemmit/Loc/pull/2363) adds 12 lines to `routes-builder.ts`. Both change *emitted output*, so they move the baseline as well as the source. **Slices 1–3 wait for #2340 to land.**

**Do not "start with slice 4 or 5 instead" to route around this.** `auth-emit.ts` and `realtime-builder.ts` are uncontended, but they are the two fragments §1.3 classifies as **`adapter`** and **`structural`** — the deliberate exceptions. Deriving the contract from its two worst-fit consumers would shape `RouteTarget` around the exceptions rather than the rule, which is how a seam ends up with the single-use methods §2.6 exists to reject. Easiest-first is a correctness property of this plan, not a convenience.

### 2.6b Success criterion — and the anti-criterion

Byte-identical Hono output through the seam, **plus**: every `RouteTarget` method must be exercised by the existing fixture corpus. A method no path reaches is dead contract surface.

The anti-criterion is M-T9.2 §0.4's lesson, and it applies here too: *a ~10-method interface over mostly-divergent arms is net-negative indirection.* If a slice's port yields a method used exactly once, fold it back into the leaf table rather than keeping the abstraction. **This mission is allowed to conclude as a partial decline** — that would be a real result, not a failure.

---

## 3. Open questions for sign-off

1. **Is a one-consumer seam acceptable?** `_workflow/` has four consumers, `_expr/` five; `RouteTarget` would have one. Its justification is *contract* value (sealing, compile-checked omissions), not sharing value. **Recommendation: start at `src/platform/hono/v4/route/` and promote to `src/generator/_route/` only at the second consumer** — avoiding the speculative-generality debt `decisions.md` already criticises in the removed stub adapters.
2. **Does slice 6 (OpenAPI) survive contact?** Elixir and Java derive the spec in their own languages; only `RouteSpecIR` is plausibly shared, and it would have to cross the IR/generator boundary cleanly. Re-scope after slice 1.
3. **Does this reopen T10?** It should not. The seam is justified here without reference to a second framework. If sign-off wants the firewall explicit, add a line to `T10-new-targets.md` noting M-T9.26 is a sealing mission that does not imply an unfreeze.

---

## 4. Provenance

Measurements taken 2026-08-03 against `main` @ `e1eec64`: generated `examples/showcase.ddd` and counted coupling in `hono_api`; emitter-side counts by token grep over `src/platform/hono/v4/` + `src/generator/typescript/`. The `@hono/zod-openapi` dependency chain was verified against the npm registry (`@asteasolutions/zod-to-openapi ^8.0.0`), not asserted from memory.
