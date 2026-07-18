# Test-authoring language — scoped principals, fixtures, data generation

> Status: **PROPOSED / on paper** (2026-07-18). No grammar surface yet. Motivated
> by draining the behavioural tenancy/auth corpus cluster (PR #2043): the harness
> today authenticates every request as **one** fixed principal, which is enough
> for the flat fixtures (`tenancy-filter`, `auth-simple`, `tenancy-owned`,
> `auth-oidc`) but structurally cannot express `tenancy-hierarchy` (a policy
> read-ladder that compares visibility *between* principals) or the async
> fixtures (`outbox`, `eventsourced-workflow`, `workflow-view`). This proposal is
> the language surface that closes those, grounded in mechanisms the harness
> **already has** — it invents as little as possible.

## Problem

A `test e2e "…" against <deployable>` body today is a flat sequence of API calls
and one-shot value assertions, executed under a **fixed ambient context**:

- **One principal for the whole run.** `test/behavioral/cases.mjs` exports a
  single `DEV_CLAIMS = { tenantId: "acme", role: "agent" }`; every runner passes
  it once (`E2E_DEV_CLAIMS`, or a single OIDC token), and the emitted
  `__authHeaders()` stamps the *same* `x-loom-dev-claims` / `Bearer` header onto
  every request. There is no way to say "act as a different user for this call."
- **No grouping or shared setup.** Each `test e2e` block re-seeds its own data
  inline; there is no `describe`-style group or shared background.
- **No data generation.** Only literals — so per-test isolation by unique keys
  (the workhorse pattern of real e2e suites) can't be written.
- **One-shot API assertions.** The API tier fetches once and asserts; there is no
  retry, so an assertion that depends on asynchronously-settled state races it.

Each gap blocks concrete corpus coverage:

| gap | fixture it blocks | why |
|---|---|---|
| single principal | `tenancy-hierarchy` | the `policy` deep/global/local ladder asserts *different* principals at different org nodes see different row sets — needs ≥2 identities in one test |
| no grouping/background | (all multi-assertion fixtures) | an expensive seed (the org tree) is repeated per assertion |
| no data generation | per-test-isolated suites | can't namespace rows by a unique key to avoid cross-test collision |
| one-shot API assert | `outbox`, `eventsourced-workflow`, `workflow-view` | the effect settles asynchronously; a synchronous read races it |

## What already exists (build on it, don't reinvent)

- **Principal channel** — every backend's dev-stub verifier merges a base64
  `x-loom-dev-claims` header over its identity; OIDC verifiers validate a
  `Bearer` JWT (`src/system/e2e-render.ts` `__authHeaders`; the behavioural
  harness forwards `E2E_DEV_CLAIMS` / `E2E_BEARER_TOKEN`; `test/behavioral/oidc-mock.mjs`
  mints tokens). Multi-principal is *just more of the same header, per call*.
- **Auto-retry assertions already exist for the UI tier.** The intrinsic-matcher
  catalogue (`src/util/intrinsic-matchers.ts`) tags matchers `on: "locator"`
  ("web-first, **auto-retrying**") vs `on: "value"` (one-shot). Emitted Playwright
  specs poll via `waitFor()` / `waitForURL()` / auto-retrying `toBeVisible` /
  `toHaveText` / `toHaveCount`. The API tier is the only one that's one-shot — so
  async support is *extending an existing retry model to the API tier*, not a new
  `eventually` block or a backend `settle` seam.
- **Readiness polling** — the backend runners already `waitForPort()` /
  `waitForReady()` (check-and-recheck until `/ready`) before tests run.
- **Isolation is per-case today** — a fresh DB per fixture file (PGlite per case
  on node; `resetDatabase()` drop-schemas before each backend case boots).

The design below reuses all four.

## Proposed surface

### 1. Context — `as <user>` (WHO)

Name concrete users of the declared `user {}` shape; act as them per call or per
block. `tenantId` is nothing special — just a field of `user {}`, resolved by the
backend's tenancy middleware exactly as `role` is by an auth guard. The switch is
lexically scoped: a `suite`/`background`/`test`/`as`-block sets the current user
for its scope; inner `as` overrides; the un-scoped root is a named built-in
`system` (the claim-less admin identity the dev-stub already falls back to) — so
"no `as`" is *stated* (`as system`), never an invisible global.

**`.ddd` (generic, role-based — no tenancy):**
```
user { id: guid  role: string }
...
test e2e "only an agent may close a ticket" against d {
  user agent  = { id: "u-1", role: "agent" }
  user viewer = { id: "u-2", role: "viewer" }
  let t = api.tickets.create({ subject: "x", open: true })
  as viewer { expect(api.tickets.close(t)).toThrow(403) }
  as agent  { api.tickets.close(t); expect(api.tickets.getById(t).open).toBe(false) }
}
```

**Generated `e2e/*.e2e.test.ts`:**
```ts
it("only an agent may close a ticket against d", async () => {
  const base = ENDPOINTS.d;
  const __users = {
    agent:  __principalHeaders({ id: "u-1", role: "agent" }),
    viewer: __principalHeaders({ id: "u-2", role: "viewer" }),
  };
  const t = await __post(`${base}/api/tickets`, { subject: "x", open: true }, __users.agent);
  await expect(async () => { await __post(`${base}/api/tickets/${t.id}/close`, {}, __users.viewer); })
    .rejects.toThrow(/→ 403\b/);
  await __post(`${base}/api/tickets/${t.id}/close`, {}, __users.agent);
  expect((await __get(`${base}/api/tickets/${t.id}`, __users.agent)).open).toBe(false);
});
```

`__principalHeaders(user)` base64-encodes the whole user object into
`x-loom-dev-claims` (dev-stub) or, under an `auth {}` system, mints a `Bearer`
token — the identical `.ddd` surface, only the emitted header builder differs by
backend flavour. Fields are validated against `user {}` (`loom.principal-unknown-claim`),
so a malformed principal is a compile error, not a silent 401.

### 2. Grouping + lifecycle — `suite` / `background` / `setup` / `cleanup` (GIVEN)

`background` runs **once per suite** (`beforeAll`) — a shared seed for read-heavy
suites. `setup` runs **before each test** (`beforeEach`) — the per-test build
pattern. `cleanup` is `afterEach`. Setup blocks state their own acting user; no
call is header-less.

**`.ddd` (the `tenancy-hierarchy` acceptance fixture — read-only over a shared seed):**
```
suite "org tree policy" against d {
  user admin = { id: "u-admin", role: "admin" }     // claim-less bootstrap principal
  user atB   = { id: "u-b", tenantId: "org_a.b" }
  user atC   = { id: "u-c", tenantId: "org_a.b.c" }
  background as admin {
    let a  = api.orgs.create({ name: "A" });  a.setPath("org_a")
    let ab = api.orgs.signUpChild({ nm: "B", seg: "b", par: a })
    let abc= api.orgs.signUpChild({ nm: "C", seg: "c", par: ab })
    as atB { api.accounts.create({ label: "at-b", amount: 1 }) }
    as atC { api.accounts.create({ label: "at-c", amount: 2 }) }
  }
  test "deep policy sees descendant" as atB { expect(api.accounts.findAll().length).toBe(2) }
  test "local policy sees own floor" as atB { expect(api.memos.findAll().length).toBe(1) }
}
```

**Generated** — `beforeAll` seeds once; both tests are reads, so counts are stable
and there is nothing to clean up:
```ts
describe("org tree policy against d", () => {
  const base = ENDPOINTS.d;
  const __users = { admin:…, atB:…, atC:… };
  async function __background() {
    const a = await __post(`${base}/api/orgs`, { name: "A" }, __users.admin);
    await __post(`${base}/api/orgs/${a.id}/set_path`, { p: "org_a" }, __users.admin);
    const ab  = await __post(`${base}/api/orgs/sign_up_child`, { nm: "B", seg: "b", par: a.id }, __users.admin);
    const abc = await __post(`${base}/api/orgs/sign_up_child`, { nm: "C", seg: "c", par: ab.id }, __users.admin);
    await __post(`${base}/api/accounts`, { label: "at-b", amount: 1 }, __users.atB);
    await __post(`${base}/api/accounts`, { label: "at-c", amount: 2 }, __users.atC);
  }
  beforeAll(__background);
  it("deep policy sees descendant", async () => { expect((await __get(`${base}/api/accounts`, __users.atB)).length).toBe(2); });
  it("local policy sees own floor", async () => { expect((await __get(`${base}/api/memos`,    __users.atB)).length).toBe(1); });
});
```

#### Isolation taxonomy (a suite-level knob, not a per-author default)

There isn't one isolation model — there are four; the author picks per suite via
`isolation:` (default `shared`):

| model | how | needs | cost |
|---|---|---|---|
| **`shared`** (default) — `background`/beforeAll | seed once, tests read | — | free |
| **`per-test`** — `setup`/beforeEach with unique keys | each test builds its own structure | `unique.*` (see §3) | free (codegen) |
| **`reset`** — truncate + reseed between tests | full isolation | runner reset seam | expensive |
| **per-case** (today) | fresh DB per fixture file | — | exists |

Black-box HTTP e2e **cannot** use transaction-rollback isolation (the backend
owns and commits the transaction), so `reset` means truncate-between or a backend
`POST /__test/reset` seam — the reason it's opt-in, not default. Read-dominant
suites over a shared seed (every tenancy/policy parity assertion) need none of it.

**Subtlety:** unique-key isolation isolates by *key*, not by *global query* — a
per-test unscoped `findAll()` still sees other tests' rows. The two escapes the
language should make natural: the read is **principal-scoped** (tenancy `findAll`
returns only your tenant → other tests invisible for free) or **key-scoped** to
what this test created. Only genuinely-global queries fall back to `isolation: reset`.

### 3. Data — `unique.*` generators + `factory` / `make` (the per-test pattern)

`unique()` / `unique.email()` / `unique.int()` lower to a per-run counter or UUID
in the emitted suite — the primitive that makes `isolation: per-test` viable
without any reset. `factory`/`make` builds a valid entity with overridable
defaults, killing the largest source of test boilerplate.

**`.ddd`:**
```
factory order { code: unique.code(), status: "Draft", total: { amount: 0, currency: "USD" } }
...
suite "orders" against d isolation: per-test {
  setup { o = make order { total: { amount: 10, currency: "USD" } } }   // fresh per test
  test "reads back its total"  { expect(api.orders.getById(o).total.amount).toBe(10) }
  test "starts in Draft"       { expect(api.orders.getById(o).status).toBe("Draft") }
}
```

**Generated:**
```ts
describe("orders against d", () => {
  const base = ENDPOINTS.d;
  let __seq = 0; const unique = { code: () => `code-${++__seq}` /* … */ };
  function __makeOrder(over) { return { code: unique.code(), status: "Draft", total: { amount: 0, currency: "USD" }, ...over }; }
  let o;
  beforeEach(async () => { o = await __post(`${base}/api/orders`, __makeOrder({ total: { amount: 10, currency: "USD" } }), __users.system); });
  it("reads back its total", async () => { expect((await __get(`${base}/api/orders/${o.id}`, __users.system)).total.amount).toBe(10); });
  it("starts in Draft",      async () => { expect((await __get(`${base}/api/orders/${o.id}`, __users.system)).status).toBe("Draft"); });
});
```

### 4. Expectation — API-tier auto-retry assertions (WHEN-async), not `eventually`

The async fixtures don't need a new keyword or a backend drain seam — they need
the API tier to gain the **same auto-retry** the UI tier's `on: "locator"`
matchers already have. An assertion over an async-settled read re-fetches and
re-checks until it holds or the readiness-style timeout fires (bounded, exactly
as Playwright's web-first assertions and the runners' `waitForReady` already do).
The reads are idempotent GETs, so re-fetching is side-effect-free.

**`.ddd`:**
```
api.orders.place(o)
expect(api.shipments.byOrder(o).length).toBe(1)   // API-tier retrying form (outbox settles the shipment)
```

**Generated** — the fetch+assert is wrapped in the same poll the UI tier uses,
instead of a one-shot fetch:
```ts
await __post(`${base}/api/orders/${o.id}/place`, {}, __users.system);
await __eventually(async () => {
  expect((await __get(`${base}/api/shipments/by_order?order=${o.id}`, __users.system)).length).toBe(1);
});   // __eventually = the API-tier twin of Playwright toPass: retry until pass or timeout
```

This is modeled as a **property of the assertion** (the catalogue already carries
`on`), extended to the API tier — one new lowering path in `e2e-render.ts`, no new
surface keyword, no per-backend change. `eventually`-as-a-block and a backend
`settle` seam are both rejected: the former duplicates a mechanism we have, the
latter is a third async model and a 5-backend seam.

### 5. Deferred — the clock (`at` / `advance`), WHEN-temporal

`at "2024-02-01" { … }` / `advance 3.days { … }` is the natural sibling for
time-dependent domains (auditable timestamps, provenance, expiry invariants), but
it is a **different cost class**: the principal rides in a header the backend
already reads, whereas the clock must be *injected into the backend* — a
test-clock seam (`x-loom-test-clock` under a test profile, or a threaded clock
abstraction) on all five backends. Parked as a separate track, not part of this
proposal's slice.

## Grammar additions (sketch)

```
Suite:      'suite' name=STRING 'against' target=[Deployable] ('isolation' ':' iso=IsolationMode)? '{'
              (users+=UserDecl | factories+=FactoryDecl)*
              (background=BackgroundBlock)? (setup=SetupBlock)? (cleanup=CleanupBlock)?
              tests+=TestBlock* '}' ;
UserDecl:   'user' name=ID '=' claims=RecordLit ;
FactoryDecl:'factory' name=ID defaults=RecordLit ;
AsBlock:    'as' user=([UserDecl] | RecordLit) '{' body+=TestStmt* '}' ;
TestBlock:  'test' name=STRING ('as' user=[UserDecl])? '{' body+=TestStmt* '}' ;
IsolationMode: 'shared' | 'per-test' | 'reset' ;
// `make <factory> { overrides }` and `unique(.<kind>)` are expressions;
// the API-tier retry is a lowering flag on an e2e assertion, not new syntax.
```

The existing standalone `test e2e "…" against d { … }` stays valid (a
degenerate one-test suite with an implicit `as system`).

## Lowering & pipeline touchpoints

- **grammar** (`ddd.langium`) — the rules above; regenerate committed parser.
- **IR** (`loom-ir.ts`) — a `TestSuiteIR` (users, factory defaults, lifecycle
  blocks, isolation mode) and a per-statement/assertion `principal` + `retry`
  flag on the existing test-case IR.
- **lowering** (`src/ir/lower/`) — resolve `as`/`user`/`make`/`unique`, thread the
  lexically-scoped current-user onto each API call, tag async assertions retrying.
- **emission** (`src/system/e2e-render.ts`) — **the only heavy edit**: emit
  `describe`/`beforeAll`/`beforeEach`, `__principalHeaders`/`__users`, `__make*`,
  `unique`, `__eventually`, and thread the per-call principal header into
  `__get`/`__post` (which gain an optional headers arg).
- **five backends** — **untouched**. Everything lands in the emitted TS suite,
  which every backend already dispatches over HTTP; OIDC principals reuse the
  mock-issuer token minting already in `test/behavioral/oidc-mock.mjs`.
- **validation** — `loom.principal-unknown-claim` (field vs `user {}`), a warning
  on an un-`as`'d principal-sensitive call ("acting as `system` implicitly").

## Acceptance fixtures

- `tenancy-hierarchy` — the policy read-ladder, expressed with `background` +
  `as` (§2). Primary acceptance.
- `outbox` / `eventsourced-workflow` / `workflow-view` — retired from the deferred
  list by the API-tier retry (§4).
- The existing flat fixtures (`tenancy-filter`, `auth-simple`, `tenancy-owned`,
  `auth-oidc`) must re-lower byte-compatibly under the degenerate single-`test`
  form (no `suite`), so the shipped behavioural coverage is unaffected.

## Open questions

1. **Keyword for the literal** — `user alice = {…}` (natural, slight overload with
   the top-level `user {}` block) vs `principal alice = {…}` (unambiguous, second
   word). Leaning `user`.
2. **Inline `as`** — allow `as { id:"u-1", role:"agent" } { … }` for one-offs, or
   named-only? Leaning: allow both.
3. **Implicit `system`** — warn on an un-`as`'d principal-sensitive call, or stay
   silent? Leaning: warn (nudges authors to state intent).
4. **Isolation default** — `shared` (proposed) vs forcing an explicit choice.
5. **Table/parameterized tests** — `for (who, n) in [ … ] { test … }` as sugar for
   the ladder; in this slice or a follow-up? Leaning: follow-up.
6. **Clock** — confirm it's a separate track (backend seam), not smuggled in here.

## Phasing

- **Phase 1 (this proposal, no backend change):** Context (`as`/`user`/`system`) +
  Grouping/lifecycle (`suite`/`background`/`setup`/`cleanup` + `isolation:`) +
  Data (`unique`/`factory`/`make`) + API-tier retry. Unblocks `tenancy-hierarchy`
  + the three async fixtures.
- **Phase 2 (separate track):** the clock (`at`/`advance`) + its per-backend
  test-clock seam. Table-tests as sugar can ride either phase.
