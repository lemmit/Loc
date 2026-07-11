# Loom completeness audit — what is still missing (2026-07)

Independent audit of what Loom still lacks to be a **complete language/platform for full
business/domain-rich applications**. Conducted bottom-up from the code on `main`
(grammar, type system, IR, validators, generators, system composer) — deliberately
*without* reading `docs/plans/`, `docs/proposals/`, or existing gap lists, so it is an
unbiased second opinion rather than a restatement of the roadmap.

Method: full read of `src/language/ddd.langium` + `src/util/collection-ops.ts` +
`src/language/type-system.ts` spot checks, plus four parallel code surveys (backend
runtime surface, frontend/UI surface, expression/statement/type expressiveness,
system/architecture layer). Every ABSENT claim below was grep-verified against multiple
spellings.

---

## What is already genuinely strong (baseline)

Worth stating so the gaps read in proportion. Loom today is a real DDD compiler, not a
scaffolder: fully-resolved platform-neutral IR; five backends + four SPA frontends +
HEEx with gate-enforced parity; transactional aggregate saves; optimistic concurrency
(`versioned` → `If-Match`/409); event sourcing with snapshots; transactional outbox with
dead-lettering and idempotent consumers; state-bearing workflow sagas with correlation
and queryable instances; OIDC auth with typed claims, `requires`/`when` gates and
`denyByDefault`; row-level tenancy with registry + `crossTenant`; capabilities
(user-definable pure mixins) with `ignoring` bypass; audit trail, provenance, seeds,
soft delete; DDL migration diffing; RFC 7807 errors everywhere; `paged`/`envelope`/`option`
carriers and `or`-unions with variant match on all five backends; OpenAPI + AsyncAPI +
wire-spec artifacts; compose + Helm/k8s with health probes and secret split; SSE
realtime; traceability graph + `ddd verify`. Gaps are honest (`loom.*` validator codes),
not silent crashes — the audit found **no silent codegen gaps** on domain expressions.

The missing pieces cluster into three tiers.

---

## Tier 1 — Gaps that force authors out of the language today

These are the things a *typical* business app hits in week one, for which the only
answer today is `extern` or hand-written code.

### 1. The computation stdlib is near-empty

The single biggest gap, cutting across every backend at once (`src/language/type-system.ts`,
`src/util/collection-ops.ts`, `src/generator/_expr/target.ts`):

- **Strings:** `.length`, `.matches(regex)`, and (**shipped since this audit** —
  backtick templates, commit `938b99d0` / #1770) **string interpolation** via
  `` `Order {id} for {customer.name}` ``. Still no substring/split/replace/trim/
  upper/lower/startsWith/padding.
- **Math:** operators `+ - * / %` only. No `round`, `floor`, `ceil`, `abs`, `min`, `max`,
  `pow`. A rounding rule on an invoice total is inexpressible.
- **Dates:** `now()`, comparison, and (**shipped since this audit** — A5 temporal,
  #1754) **date arithmetic**: a `duration` primitive (`days`/`hours`/`minutes`
  constructors) and a closed `datetime`/`duration` algebra (`datetime + duration →
  datetime`, `datetime - datetime → duration`), so "due 30 days after issue" is now
  expressible. Still no `date`/`time` types, no calendar-relative offsets
  (`months`/`years` were deliberately dropped), no timezone story, no business-day math.
- **Collections:** closed set of 8 ops (`count, sum, all, any, where, first, firstOrNull,
  contains`). No `map`, `sortBy`, `groupBy`, `distinct`, `min/max`, `take/skip`,
  `flatMap`, `reduce`, `join`.
- **Conversions:** infallible widening only; fallible parses (`int("42")`,
  `datetime("…")`) are explicitly deferred (grammar comment at `PrimitiveConversion`).
- **No `uuid()`/`random()`**, and no config/env value readable from an expression body.

Because every op is one `ExprTarget` method per backend (5 leaf tables over one shared
dispatcher), the marginal cost per stdlib function is low and the leverage is enormous.
This is the highest-ROI area in the whole audit.

### 2. Control flow: no `if`/`else` statement

`Statement` admits `precondition | requires | let | emit | for-in | if let | return |
match | assign/call` — there is **no general `if (cond) { … } else { … }`** and no
`while`. Multi-statement conditional mutation must contort into effect-form `match` or
be split into operations. Assignment is also `this`-rooted only (no reassignable
locals). For a DSL whose pitch includes rich operation bodies, plain `if` is table
stakes.

### 3. No scheduled / background work primitive

Nothing in the grammar or any generator emits user-defined jobs, cron, timers, delays,
or retries (grep: `cron|schedule|@Scheduled|Oban|celery|quartz|hangfire` — only the
outbox relay loop exists). Consequences compound:

- No nightly billing / cleanup / digest jobs.
- **Workflows cannot time out or escalate** — a saga advances only on an inbound
  command/event; there is no `after 7 days …` deadline, no reminder step, no
  compensation trigger on expiry.

Almost every real business process has a temporal edge ("cancel unpaid orders after
48h"). This is the largest *backend* gap.

### 4. No email / notification integration

No SMTP/SES/SendGrid/webhook-out resource adapter exists (implemented adapters are
exactly `s3`, `rabbitmq`, `restApi` — `*/adapters/resource-clients.ts`). "Send a
confirmation email" — present in essentially 100% of business apps — has no story
beyond hand-coding behind `restApi` or `extern`.

### 5. Data tables are read-only fire hoses

The wire supports `paged`, but the frontend never uses it: `Table`/`QueryView` fetch the
whole collection with **no pagination, no column sorting, no dynamic filtering, no bulk
actions, no inline edit** (`src/generator/_walker/primitives/table.ts`, `controls.ts`).
The scaffolded list filter is substring-match over declared finder params only. Any
entity with >200 rows makes the generated admin UI impractical. Closing pagination +
sort alone (the wire shape already exists) would transform usability.

### 6. No reporting / aggregation queries

`view` projects and filters per-row (with per-aggregate collection binds like
`lines.count`), but there is **no cross-row aggregation** — no group-by, no
sum/avg-over-rows, no having (grep in query checks + renderers: none). Combined with no
charts on the frontend (below), Loom can run the transactional side of a business but
cannot show management what happened. A `view … group by` with aggregate binds would
complete the CQRS read side.

### 7. File upload has no end-to-end path

Backend `s3`/`objectStore` adapters exist (presigned URLs on Hono), but there is **no
file/binary field type**, no multipart endpoint derivation, and **no frontend file
input** (`form-fields-vm.ts` has no file arm). Documents, avatars, attachments —
unbuildable in-language.

---

## Tier 2 — Gaps that cap the platform's ceiling

Hit later, but decisive for "complete platform" status.

### Language & type system

- **Money has precision but no currency.** `money` is amount-only; two
  different-currency values add freely. The closed-arithmetic machinery already exists —
  a currency dimension (or `money&lt;USD&gt;`) is the natural completion.
- **No map/dictionary type**; only value objects and opaque `json`.
- **No user generics, no higher-order functions, no recursion** — carriers are the three
  blessed ctors only (grammar comment marks user generics deferred).
- **Invariants/preconditions carry no author message.** Users see derived diagnostics
  only; real products need "A refund cannot exceed the captured amount."
- **Aggregate operations cannot read repositories or create other aggregates** (workflow
  / domain-service only). Defensible DDD discipline, but combined with Tier-1 §2 it
  makes some ordinary logic awkward; worth a deliberate re-check once workflows have
  timers.
- **No i18n anywhere** — not in the language (labels/messages), not in the frontends.

### Backend & API

- **No API versioning** (`api` has `urlStyle` + `httpStatus` only; routes unversioned)
  and **no breaking-change gate** — wire-spec.json is a review artifact, not a check.
- **No data migrations** — DDL diffing only; a NOT-NULL backfill is an operator comment
  (`migrations-ir.ts` `sqlComment`), not generated code.
- **No HTTP idempotency keys** (POST create is not client-idempotent), **no rate
  limiting**, **no pessimistic locking**.
- **No per-field authorization** — `sensitive()` redacts logs, but role-gated field
  visibility on the wire doesn't exist.
- **Declared-but-unwired storage types:** `redis` (as cache client), `elastic`/
  `meilisearch` (no search query emission — **no full-text search at all**), `kafka`,
  `nats`, `clickhouse`, `bigquery`, `mysql`, `sqlite` parse + validate but emit nothing;
  `replica`/`readonly` have no read-routing. The surface promises more than the
  generators deliver — either wire them or trim the enum.
- **No `find` sort surface on the HTTP read path** (only `retrieval`'s `sort:` via
  `Repo.run` inside workflows); no client-driven dynamic filtering.

### System & operations

- **Backend deployables are runtime islands.** Channels/outbox dispatch in-process only;
  `channelSource` on a broker is `"declared, not provisioned"` (`asyncapi.ts:72`), and
  there is no consumer construct — two backend deployables cannot exchange events.
  Microservice-shaped systems don't actually communicate.
- **No service-to-service auth** (no client-credentials/token forwarding), pairing with
  the above.
- **Observability is log-events only** — no metrics endpoint, no OpenTelemetry/tracing,
  despite the structured catalog being a strong foundation.
- **Multi-tenancy lacks provisioning** (onboarding, per-tenant config; also
  `tenantOwned`'s filter claim is hardcoded `tenantId`, ignoring `tenancy by user.&lt;claim&gt;`).
- **No dev/staging/prod environment modeling** (Helm values overlay only), no TLS/cert
  emission, no HPA/scaling policy.
- **Test DSL has no clock control and no extern/resource mocking** — time-dependent
  domain logic (once it exists, Tier-1 §1/§3) will be untestable without
  `freezeTime`-style primitives.

### Frontend

- **No charts/dashboards** beyond the two-line `Stat` card — no time series, no KPI
  trend, no drill-down. (Pairs with the missing aggregation queries.)
- **Forms:** no multi-step wizard, no conditional/dependent fields (`CreateForm` renders
  all required fields, flat), no typeahead autocomplete (FK picker is a plain
  `&lt;select&gt;` — unusable at 10k customers), no per-field authorable validation UI.
- **UX primitives missing:** general `toast(…)` in action bodies (today only in realtime
  handlers), confirmation dialog (only `DestroyForm`'s `window.confirm`), drawers,
  general effects/`onMount`, polling/`refetchInterval`, optimistic updates.
- **Real-time is toast-only SSE** — no live-updating query/table binding, no websocket,
  no presence.
- **No calendar, no map, no rich-text display/editor, no media beyond `Image`/`Avatar`.**

---

## Tier 3 — Polish / deliberate-scope items

Reasonable to leave out, but worth a conscious decision:

- Local username/password auth (IdP-only is defensible; a bundled dev Keycloak exists).
- GraphQL / websocket API surfaces (REST+SSE is a coherent choice).
- Enum values with associated data; tuples; recursion.
- Accessibility surface (aria attrs not authorable; packs carry the burden).
- Theming beyond design tokens (no per-component override story besides `style:`).
- Response caching / CDN hints.

---

## Priority recommendation

If the goal is "a complete language for full business/domain-rich apps," the order that
unblocks the most real applications per unit of work:

1. **Stdlib sweep** — ~~date arithmetic + `duration`~~ (shipped, #1754),
   ~~string interpolation~~ (shipped, #1770), string ops, math
   fns, collection `map/sortBy/groupBy/distinct/min/max`, fallible parses. One
   `ExprTarget` method per backend per op; transforms expressiveness everywhere at once.
2. **Plain `if`/`else` statement** (and reassignable locals) — small grammar/IR change,
   removes the most-hit authoring wall.
3. **Timers/scheduling** — `every`/`at` job primitive + workflow `after`/deadline steps;
   unlocks the temporal half of business processes and saga timeouts/compensation.
4. **Table pagination + sorting** wired to the existing `paged` carrier, plus typeahead
   FK picker — the generated UI becomes production-usable.
5. **Email/notification resource kind** — the missing 100%-of-apps integration.
6. **Aggregating views + a chart primitive** — completes the read side (reporting).
7. **File/binary field type end-to-end** (upload endpoint + s3 + frontend field).
8. **Cross-deployable eventing** — provision the broker `channelSource` already parses,
   emit producer/consumer clients; without it multi-deployable systems are decorative.
9. **Money currency dimension** — cheap now, expensive to retrofit after users store
   amounts.
10. **Custom invariant messages + i18n seam** — quality-of-life that every shipped app
    needs.
