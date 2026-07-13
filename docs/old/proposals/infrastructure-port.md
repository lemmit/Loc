# Infrastructure port — the third service role (options)

> Status: **proposal / problem-framing.** Exploratory — options, not a
> pinned design; **usage-pulled, not scheduled** (no concrete biting case
> yet). Each axis lists alternatives with a lean; the end assembles them
> into three shapes to react to.
>
> **Companions:** the `extern` family — [`../extern.md`](../../extern.md)
> (backend `operation … extern`),
> [`extern-function-hook-escape-hatch.md`](./extern-function-hook-escape-hatch.md)
> (frontend `function`/`hook … extern`),
> [`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md)
> (frontend `component … extern`) — and the resource model
> ([`workflow-resource-consumption.md`](./workflow-resource-consumption.md),
> [`resource-model-and-source-types.md`](./resource-model-and-source-types.md)).
> This note is the application-layer sibling of both families.
>
> **Relationship to existing constructs:** distinct from
> [`domain-service.md`](./domain-service.md) (the *no-infrastructure*
> cross-aggregate domain rule — this is its mirror image), from `workflow`
> (the application orchestration that *calls* a port), and from `resource`
> (infrastructure Loom **can** generate an adapter for — a port is
> infrastructure it **cannot**). It reuses the `extern` family's four-move
> pattern wholesale; it does not invent new plumbing.

## The gap, precisely

DDD has three service roles. Loom maps two of them and is proposing a
third (the domain service). The **infrastructure service** is the only
role with no honest home — and, crucially, the only one whose *adapter*
must not live in the model at all:

| Role | Touches | Loom today |
|---|---|---|
| aggregate `operation` | own aggregate state | shipped |
| `criterion` | pure `bool`, queryable | shipped |
| domain service | domain objects, cross-aggregate, **no infra** | proposed (`service`) |
| `workflow` | repos, transactions, orchestration | shipped |
| `resource` handle | object-store / queue / HTTP I/O **Loom can generate** | shipped (Phase 4) |
| **— missing —** | **a technical capability Loom *cannot* generate; human-supplied adapter** | **this note** |

The shipped `resource` model already lets a workflow call out to
infrastructure — `files.put(…)`, `jobs.enqueue(…)`, `rates.get(…)` —
but only over a **closed, per-kind verb vocabulary** for `sourceType`s
Loom ships an adapter for (`s3`, `rabbitmq`, `restApi`, …). The hole is
everything *off* that list: `EmailSender`, `PdfRenderer`,
`PasswordHasher`, `FraudScorer`, an internal `FxRates` that isn't a plain
REST call, a `Clock`/`IdGenerator` you want injectable for tests. These
share a shape — *a named cluster of effectful methods the application
depends on but does not implement* — that none of the existing constructs
fits:

- not a `resource` — Loom has no `sourceType` adapter and no closed verb
  set for "send an email"; the method shapes are the *author's*, not the
  registry's;
- not an `operation … extern` — that is bolted to a single aggregate, is
  decision-shaped (preconditions + a handler that mutates *that* aggregate
  inside the load→save lifecycle), and is not reusable across call sites;
- not a domain service — that is defined by touching **no** infrastructure;
  a port is *all* infrastructure.

**The one constraint that defines it** (and makes it enforceable): a port
declares **signatures only — no body, ever** — and may be called only from
the application layer (`workflow`, and extern handlers). It is the exact
mirror of the domain service: where a domain service is pure domain logic
that may touch no infra, a port is pure infra dependency that carries no
domain logic. Both edges are policed by the same backward-edge machinery
`pipeline-layering.test.ts` already owns.

## Name it for the abstraction, not the implementation

The instinct to call this `infrastructureService` is the trap. In
hexagonal/DDD terms the thing the **model** owns is the **port** (the
abstraction); the *service* is the **adapter**, and the adapter must live
*outside* the model — hand-written, swapped per environment, mocked in
tests. Loom's whole thesis is "the `.ddd` is the spec; infrastructure is
generated or supplied, never authored into the spec." A construct that
reads `infrastructureService { …body… }` invites authoring the adapter
into the model — exactly backwards.

So the construct declares a **port**; "infrastructure service" is the
*role it plays*, and a good word for the generated artefact + the
validator nudge ("provide the `EmailSender` infrastructure service"), not
the keyword. The adapter is wired by the proven `extern` machinery, which
already keeps the implementation outside the model.

## Reusing the `extern` four-move pattern

[`extern-function-hook-escape-hatch.md`](./extern-function-hook-escape-hatch.md)
pins the governing principle: **`extern` is the universal foreign-code
modifier, and the construct it attaches to tells Loom how to wire it.**
The shapes already named are `operation` (backend mutation), `component`
(render), `function` (pure value), `hook` (React state). A port is the
one remaining shape — *a stateful cluster of effectful application
methods* — and it inherits the same four moves (`docs/extern.md` §1):

1. a declaration marks the unit **user-supplied**;
2. Loom emits a **typed contract** from the declaration (an interface /
   typed registry, in wire/Loom types);
3. Loom owns the **surrounding plumbing** and the **call sites** (DI on
   the backend, `await` threading like a resource-op);
4. a **fail-fast** guarantees the adapter exists — the `extern` startup
   gate verbatim (.NET Scrutor / Hono registry verify; `mix`/`tsc` where
   linking is compile-time).

Because a port is *inherently* external, the `extern` marker is arguably
implied by the keyword (Axis 6) — but the family invariant is what makes
this an incremental feature, not new plumbing.

---

## The design axes (each an open choice)

### Axis 1 — What may it touch / return?

- **(1a) Pure outbound capability** — takes scalars, value objects, and
  wire DTOs of aggregates passed in; returns a value (or a domain error,
  Axis 4). **No aggregate mutation, no repository, no persistence.** The
  caller (workflow) owns load/save. *(lean)*
- **(1b) May mutate aggregates passed in** — rejected. That is a
  *coordinator domain service* concern ([`domain-service.md`](./domain-service.md)
  Shape B), not infrastructure; conflating the two re-imports the
  anemic-domain risk and muddies "who saves."

*Lean: (1a). A port is for the *effect/lookup*, not for a domain
decision over aggregate state.*

### Axis 2 — Who may call it?

- **(2a) Workflows only** — mirrors resource consumption exactly
  (`workflow-resource-consumption.md` §2: resource-ops are workflow-only).
  The application layer owns I/O orchestration. *(lean, floor)*
- **(2b) Also `extern` handlers** — an `operation … extern` handler that
  talks to a billing engine should be able to lean on a shared `Billing`
  port instead of inlining its own HTTP client. Natural fast-follow.
- **(2c) Also aggregate operations / domain services / criteria** —
  **rejected.** This is the line that keeps the domain layer
  infrastructure-free; a port reachable from an `operation` puts I/O back
  inside the aggregate. The whole point of placing it at the application
  layer is enforced by *forbidding* this edge.

*Lean: (2a) floor, (2b) fast-follow. The caller set is the layering, made
enforceable.*

### Axis 3 — Open vs closed method vocabulary

- **(3a) Open, author-declared signatures** — unlike `resource`'s closed
  per-kind verb registry, a port declares its own methods
  (`send(to: string, subject: string, body: string): void`). This is the
  *reason the construct exists*: Loom cannot know your `EmailSender`'s
  shape. *(lean)*
- **(3b) Closed registry, like `resource`** — defeats the purpose; that is
  literally what `resource` already is.

*Lean: (3a). The port is the open-vocabulary escape hatch; `resource` is
the closed-vocabulary known-infra path. Same call surface, opposite
vocabularies.*

### Axis 4 — Async & errors (not really a choice)

Ports are I/O, so they thread `await` and mark their workflow async —
identical to resource-ops (`workflow-resource-consumption.md` §5).
Failures mirror the shipped `ExternHandlerError` / `ResourceError` →
5xx envelope for the bug/unavailable regime; *expected* domain failures
ride an `or`-union return (`charge(...): Receipt or CardDeclined`),
consistent with [`failure-taxonomy.md`](./failure-taxonomy.md). Listed
only to pin it.

### Axis 5 — Transactional span

A port call is external I/O that cannot roll back with the DB
transaction, so — exactly as for resource-ops
(`loom.resource-op-in-transaction`) — a port call **inside a
`transactional(…)` span is a validation error**, with the message
pointing at the outbox pattern. Calls before/after the span are fine.

*Not a choice: reuse the resource rule verbatim.*

### Axis 6 — Naming & the `extern` marker

- **`port Foo { … }`** — hexagonal, honest, names the *abstraction*; reads
  as "an abstraction the app depends on." Extern-ness is intrinsic (a port
  is *always* implemented outside), so a separate `extern` keyword is
  arguably redundant. *(lean)*
- **`port Foo extern { … }`** — keep the visible `extern` marker for
  family consistency (the function-hook proposal's "one modifier" rule),
  at the cost of one redundant word. A reasonable alternative if the
  family-uniformity is judged more valuable than terseness.
- **`infrastructureService Foo { … }`** — the original instinct; **kept as
  the role label** (docs, generated artefact names, the validator nudge),
  not the keyword, because the `{ … }`-with-body reading invites the
  author-the-adapter-in-the-model anti-pattern. Could be admitted as a
  long-form alias.
- **`service Foo extern`** — rejected: `service` is claimed by the domain
  service ([`domain-service.md`](./domain-service.md)), and "an extern
  domain service" is a contradiction (domain service ≡ no infra).

*Lean: keyword `port`; extern-ness intrinsic (or an explicit `extern` for
family visibility); "infrastructure service" is the role, not the
keyword.*

### Axis 7 — Scope & deployable wiring

- **Context-scoped, ambient like resources** — a `port` carries a
  `for: <context>` and is in scope (by name) in any workflow of that
  context, exactly like a resource handle. *(lean — mirrors the resource
  surface the team already shipped.)*
- **System-scoped, referenced explicitly** — simpler grammar, but breaks
  the resource-handle symmetry.

Either way the **backend deployable must declare it provides the
adapter** — the natural home is a `serves:`-adjacent clause (e.g.
`ports: [EmailSender]` / reuse `dataSources:`-style wiring), and the
fail-fast at startup is the existing extern gate: a deployable hosting a
context whose workflows call a port, without a registered adapter, fails
to boot. *(Open question 3.)*

---

## Three assembled shapes

> **Syntax is illustrative** — the `port` construct does not exist; bodies
> use proposed syntax. The shipped guard keyword is `precondition` (→ 400);
> `or`-union results need the variant-`match` Loom still lacks (see
> `failure-taxonomy.md`).

### Shape A — "Pure outbound port" (minimal floor)

*Axis 1a · 2a · 3a.* A named cluster of effectful signatures, callable
from workflows; Loom emits the interface + DI + fail-fast gate; you write
the adapter outside the model.

```ddd
context Sales {
  port EmailSender {
    send(to: string, subject: string, body: string): void
    sendTemplated(to: string, template: string, data: json): void
  }

  workflow PlaceOrder(cmd: PlaceOrderCmd) {
    let order = Order.create(cmd)
    emailSender.send(order.customerEmail, "Order received", renderConfirmation(order))
  }
}
```

- **Pros:** smallest honest fill of the role; reuses the extern gate and
  the resource async/await threading verbatim; trivially mockable (a fake
  adapter in tests — the DIP payoff); composes with the resource model.
- **Cons:** does not cover an extern *operation* handler that wants the
  same port (Shape B).

### Shape B — "Port callable from extern handlers" (fast-follow)

*Axis 2b.* The same port, now reachable from an `operation … extern`
handler, so the handler decision can lean on a shared capability instead
of inlining its own client.

```ddd
aggregate Subscription {
  operation renew() extern {
    precondition isActive()
  }
}
// the hand-written ConfirmRenew handler resolves the Billing port from DI
// and calls billing.charge(...), instead of newing up an HTTP client.
```

- **Pros:** unifies the two backend escape hatches — `extern` owns the
  *aggregate decision*, the port owns the *shared capability*; no
  duplicated clients across handlers.
- **Cons:** widens the caller set (still application-layer only); needs the
  extern-handler DI surface to expose ports.

### Shape C — "Unify port and resource" (north star, deferred)

A `resource` whose adapter is *Loom-generated* and a `port` whose adapter
is *human-supplied* are the same construct under one model: *something the
application calls out to over a typed contract*; the only axis that
differs is **who writes the adapter**. The eventual model lets a
`resource` declare a custom `interface` (→ it becomes a port) and a `port`
adopt a known `sourceType` (→ it becomes a resource), with the verb
vocabulary open or closed accordingly.

- **Pros:** one mental model for all outbound calls; the resource registry
  and the port escape hatch become two ends of one dial.
- **Cons:** large; risks blurring the deliberate known/unknown-infra line
  before it has earned its keep. *Record as the north star; do not build.*

---

## Recommendation

**If pulled by a real case, ship Shape A first, Shape B as the
fast-follow, keep C as the north star** — and until then, hold. Rationale:

1. The role is genuinely missing, but `extern` operations +
   `resource { kind: api }` already cover the common cases; per the
   `extern` family's own discipline (function-hook §8), this should be
   *pulled by a concrete capability that neither covers*, not built
   speculatively. The current status is exactly that: no biting case yet.
2. Shape A is high-value, low-risk *when needed*: it is the extern gate +
   resource async threading composed, with an open vocabulary — almost no
   new plumbing, and the testability win (mockable adapter) is immediate.
3. Shape B unifies the two backend hatches and is the natural second slice.
4. Shape C is the right eventual model but trades the crisp
   known/unknown-infra distinction for elegance; adopt it only once both
   sides have settled.

Generated placement *is* the proof of the constraint, and it is the exact
inverse of the domain service (`domain-service.md`): a domain service is a
stateless Domain-layer unit with **no injected infrastructure**; a port is
an **interface in the Application/Infrastructure boundary with no domain
logic**, whose adapter is hand-written and DI-injected into the workflow
handler. The workflow gets *both* injected — domain services it calls
directly, ports through DI — and that asymmetry (domain service: no ctor
deps; port: pure ctor dep) is the layering made physical.

## Author guidance — `port` vs `resource { kind: api }`

Both let a workflow call out to an external system, so they will be
confused. The line is **who writes the adapter and how typed the contract
is**, and it resolves with four questions in order:

```
1. Is the capability a plain HTTP API you reach with plain GET/POST
   + JSON, and does Loom ship a sourceType adapter for it (restApi)?
      yes → keep going          no  → port
2. Are path-keyed get/post verbs enough — i.e. you don't need
   domain-named methods (charge / refund / render / send)?
      yes → keep going          no  → port
3. Do you want Loom to OWN the client (generated fetch, dev-compose
   sidecar, vendor-neutral source) rather than hand-writing it?
      yes → keep going          no  → port
4. Is the closed resource verb vocabulary (get/post) sufficient, with
   no need for your own auth/retry/SDK/streaming logic?
      yes → resource { kind: api }   no → port
```

In one line: **`resource { kind: api }` is the closed-vocabulary,
Loom-owns-the-adapter path for plain REST; `port` is the
open-vocabulary, you-own-the-adapter escape hatch for everything else.**

| | `resource { kind: api }` | `port` |
|---|---|---|
| Adapter author | **Loom** (generated `restApi` client) | **you** (hand-written, DI-injected) |
| Vocabulary | **closed** — `get` / `post` (registry verbs) | **open** — you declare `charge(...)` / `send(...)` |
| Contract shape | path + JSON | domain-named, typed signatures |
| Transport | HTTP/REST only | anything (SMTP, gRPC, SDK, in-proc, SOAP) |
| Dev sidecar | yes (compose) | no — your adapter, your deps |
| Fail-fast | binding/capability validation | extern startup gate (adapter must register) |
| Reach for it when | thin REST passthrough Loom can drive | the capability is off-registry or needs a real client |

Worked calls:

- `rates.get("/usd/" + cmd.currency)` → **`resource { kind: api }`** — a
  thin REST read; Loom's `restApi` adapter is exactly right.
- `billing.charge(order.total, card)` → **`port`** — domain-named, needs
  your Stripe SDK + idempotency keys + retry; not a path-keyed GET.
- `emailSender.send(to, subject, body)` → **`port`** — not HTTP-shaped at
  all (SMTP / provider SDK); no `restApi` adapter applies.
- `invoicePdf.render(order)` → **`port`** — a library/CPU capability, no
  network verb fits.

Gray zone (an HTTP API you *could* hit with get/post but want typed,
domain-named methods and your own auth): either works; lean
`resource { kind: api }` for a thin passthrough you want Loom to drive,
`port` the moment you want a `charge`/`refund`-shaped contract and to own
the client. If you find yourself wrapping `rates.get(...)` in a helper to
give it a real signature, that is the signal to promote it to a `port`.

## Open questions

1. **`extern` marker** — intrinsic to `port` (terser) or written
   explicitly for family uniformity (Axis 6)?
2. **Method payload typing** — domain types vs wire DTO at the boundary;
   reuse `extern`'s `domainToRequestExpr` conversion so a domain change
   breaks the adapter's signature (the contract bite the function-hook
   proposal relies on).
3. **Deployable wiring & fail-fast** — `ports:` clause on the backend
   deployable vs implicit-from-usage; confirm the startup gate is the
   existing extern verify (Axis 7).
4. **`port` vs `resource { kind: api }`** — decision tree drafted above
   ("Author guidance"); open sub-question is the gray zone (a typed
   HTTP API) — confirm the lean (passthrough ⇒ resource, domain-named
   contract ⇒ port) survives real use.
5. **Cross-context ports** — own context only (mirror resources, §workflow-resource-consumption 9.5) or system-wide?
6. **Testing surface** — the mockable adapter is the headline feature;
   define how a `test`/`test e2e` substitutes a fake port (likely: the
   adapter registry already swappable, so this is documentation, not new
   machinery).
