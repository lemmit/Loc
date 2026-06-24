# Unfoldable API derivation — peer-proposal coordination note

> Status: **COORDINATION NOTE** — companion to
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
> (merged #1055). Captures the post-merge peer audit so the
> implementation pass starts with the right scope and ordering.
>
> Written against `origin/main` at commit 090edc5. Re-audit if the
> shipped surface shifts before implementation begins.

## Peer status snapshot

| Peer proposal | Shipped state | Touches my retirement? |
|---|---|---|
| `lifecycle-operations.md` | Phase 1 shipped (#722) — `OperationIR.kind` | Provides what I depend on |
| `lifecycle-url-style.md` | PINNED — Phase 1 shipped (#722) | I reframe `urlStyle` as a macro input |
| `payload-transport-layer.md` | `Paged<T>` carrier + paged finds shipped on all 4 backends (#898/#916/#925/#933). **`<Agg>Wire payload` Phase 2 unshipped.** | The `<Agg>Wire` deprecation concern is hypothetical until P2 lands |
| `aggregate-inheritance.md` | I1 shipped (surface + IR + validators). **I2 (TPH emission) unshipped.** | The chain-walk-has-two-consumers split lands with I2 |
| `workflow-and-applier.md` | Appliers + Hono/.NET event-sourced emission shipped (#914, #889) | I extend routes to target workflow `handle`; no shipped friction |
| `failure-taxonomy.md` | DESIGN NOTE — nothing shipped | Pure design conversation |
| `domain-service.md` | DESIGN NOTE (options) — nothing shipped | Pure design conversation |
| **`extern-component-escape-hatch.md`** | **Tier 1 React SHIPPED (PR #802) — consumes `wireShape`-derived props interface today** | **Real conflict — see Action below** |
| `extern-function-hook-escape-hatch.md` | PROPOSED | Hypothetical until shipped |
| `channels.md` | Slice 1 surface + IRs shipped (#797); `DomainEventDispatcher` is the in-process emit path (Hono #970, .NET #1012, Phoenix #1020 — all shipped) | Handler `emit` syntax inherits today's path; transparent |
| `criterion.md` | Core shipped; filter-capability targeting on Hono/Drizzle (#760) + Phoenix (#762) shipped | queryHandler scaffold coordinates with existing API |
| `reified-criteria.md` | Retrieval + find criteria reified on all 4 backends (#890/#901/#910/#926/#936/#943/#952/#955/#963/#964) | queryHandler bodies dispatch through existing `Repo.run`/`Repo.findAll(criterion)` |
| `retrieval.md` | Surface + IR + lowering + validation shipped (#794); `Run<Name>Async` shipped on .NET (#810), Hono (#952), Phoenix (#955) | queryHandler scaffolds target `Repo.run(R(args), page?)` — known API |
| `validation-error-extension.md` | Hono (#782) + .NET (#829) shipped | RFC 7807 `errors[]` is response-shape only; no friction |
| `frontend-acl.md` | Phases 1+2 shipped (#769) | Form catch blocks don't touch wireShape |
| `loom-forms.md` | PROPOSED | Aligns with my proposal (both: operation params IS input shape) |
| `dispatch-delivery-semantics.md` | In-process dispatch shipped on all 3 backends; outbox unstarted | Outbox is delivery-time, transparent to handler grammar |

## Coordination items, ranked by urgency

### Urgent — shipped code consumes the retiring abstraction

**1. `extern-component-escape-hatch.md` Tier 1 (#802) — extern-component-builder calls `wireShapeFor(ent)`.**

The shipped React extern feature emits a typed `<Name>Props` interface derived from `wireShape`. Users have been writing `.tsx` against this since #802 landed.

Migration is straightforward but not free: switch the props emitter from `wireShapeFor(ent)` to walking `aggregate.fields + containments + derived` with the `forUiRead` filter (the same filter relocated to scaffold-time consumption). Output is byte-identical; failure mode (`tsc` breaks on domain rename) preserved.

**Action**: name the extern-component-builder explicitly in the proposal's Migration story Phase 1, alongside the four backend DTO emitters. Add a `LOOM_REACT_BUILD` regression test confirming `<Name>Props` regeneration matches byte-for-byte before vs after the migration.

### Real but not urgent — shipped backend DTO emitters need migration

**2. Backend DTO emitters on all four platforms are shipped and consume `wireShape`.**

The proposal's Migration story Phase 1 treats DTO emitter migration as a single bullet, but each backend (Hono in `src/generator/typescript/`, .NET in `src/generator/dotnet/dto-mapping.ts`, Elixir in `src/generator/elixir/`, React Zod in `src/generator/react/api-builder.ts`) has its own emitters with their own conformance tests.

**Action**: Phase 1 itemises as four independent slices (one per backend) so each can ship and be CI-gated independently. The cross-backend wire parity tests (`test/generator/{hono,dotnet}/*-wire-conformance.test.ts`) gate the migration: emitted output must match pre-migration byte-for-byte for the macro-form `api X from Subdomain` case (no unfolded contracts in test).

### Hypothetical — peer is unshipped

**3. `aggregate-inheritance.md` I2 — chain walk has two consumers.**

I1 shipped; I2 (TPH emission) unshipped. The "table emission walks chain for schema; contract emission walks chain for wire" split needs to be in I2's design from day one. Lands with I2 if I2 is sequenced after this proposal; needs a back-port if I2 ships first.

**Action**: when I2's design begins, the I2 owner cross-references this proposal's "wireShape retires from the IR" section and splits the chain-walk consumers.

**4. `payload-transport-layer.md` `<Agg>Wire payload` Phase 2.**

P2 not shipped. If P2 lands first, `<Agg>Wire payload` becomes user-facing syntax that needs a deprecation path when this proposal lands; if this proposal lands first, P2 is rewritten to not introduce `<Agg>Wire`.

**Action**: coordinate landing order before either implementation starts. Strongly prefer this proposal first — it removes a layer rather than adding one.

### Pure design conversation — no shipped code

**5. `failure-taxonomy.md` — error placement (`api` construct vs contract + system policy).**

Both designs unshipped. Pick the placement deliberately before either lands. Likely resolution: errors *named* in contract (per context — what counts as `NotFound` is domain-shaped), error → HTTP status *mapped* by a system-level policy declaration. Compatible with failure-taxonomy's "declarative policy bucket" framing if "policy bucket" lives at system scope rather than per-api.

**Action**: joint design pass between this proposal and failure-taxonomy before either commits grammar.

**6. `domain-service.md` — third construct between operation and workflow.**

DESIGN NOTE. Five-construct layering matrix after both proposals:

| Construct | Layer | Infrastructure? |
|---|---|---|
| `operation` | domain | No (single aggregate) |
| `service` | domain | No (cross-aggregate, pure) |
| `workflow` | application | Yes (orchestration) |
| `commandHandler` | application | Yes (single aggregate + save/emit) |
| `queryHandler` | application | Yes (read) |

`service` (no infra, cross-aggregate) is distinct from `commandHandler` (infra, single aggregate). They don't collide. Worth a layering-matrix table in either proposal so a reviewer sees all five side-by-side.

**Action**: domain-service should reference this proposal when it picks its committed shape (A / B / C) so the matrix is complete.

### Low-priority — proposals already aligned

**7. `channels.md` ↔ handler `emit`.** Slice 1 surface shipped; `DomainEventDispatcher` is the existing in-process emit path. Handler grammar inherits today's semantics. Slice 2+ (outbox, realtime) is layered underneath transparently. No coordination needed at the handler-body level.

**8. `criterion.md` / `retrieval.md` / `reified-criteria.md` ↔ queryHandler bodies.** All partial-shipped with public APIs. queryHandler scaffolds emit calls into existing `Repo.run(R(args), page?)` and `Repo.findAll(criterion)`. Mechanical.

## Net read

- One real concrete issue (extern-component-builder) — flag in the next implementation slice.
- One scope-honesty issue (four backend DTO migrations as four slices, not one) — fix in Phase 1 sequencing.
- Two design-coordination items (`<Agg>Wire` landing order, error placement) — design-stage decisions, low urgency.
- Two layering-matrix items (`domain-service`, the five-construct table) — documentation, no blocker.
- Everything else: coordinates cleanly through existing APIs.

The proposal is not blocked by any of these. The note exists so the implementation pass starts with the right scope and the genuinely shipped consumers (#802 in particular) aren't missed.
