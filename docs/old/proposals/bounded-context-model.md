# Bounded contexts as the unit — subdomain rename, deployable binding, framework/storage per BC, structural visibility

> Status: design agreed in conversation, not yet implemented. Coordinates with [`workflow-and-applier.md`](./workflow-and-applier.md) (merged), [`lifecycle-operations.md`](./lifecycle-operations.md) (proposed), and supersedes the per-aggregate-storage stance of [`storage-and-platform-config.md`](./storage-and-platform-config.md) + [`storage-and-platform-config-plan.md`](./storage-and-platform-config-plan.md) + [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) (those proposals' grammar work mostly survives — the granularity choice is what changes).

> **[2026-06-20 status audit]** SHIPPED — `subdomain`/`context` model + per-context binding + the `storage`/`dataSource` split (D-STORAGE-SPLIT/D-GRANULARITY) are all in the grammar (`ddd.langium`) and validated; deployable `contexts:`/`dataSources:` live. No longer 'not yet implemented'.

> **Pinned decisions** (see [`docs/decisions.md`](../../decisions.md)):
>
> - **D-GRANULARITY** — bindings are per-context, not per-aggregate
>   for v1; this proposal's framing is what got pinned.
> - **D-STORAGE-SPLIT** — three keywords land in v1: `storage`
>   (physical), `dataSource` (per-context, per-kind binding),
>   `deployable` (carries `contexts:` and `dataSources:`).
>   §"Storage instance binding — on the deployable" below is
>   updated by this decision: the deployable holds
>   `dataSources: [...]` (a list of `dataSource` refs), not a
>   `storage: { Context: instance }` map.

## Problem statement

Today's Loom structural model has six unrelated frictions that resolve together once the bounded context is restated as the central organising unit:

1. **`module` is doing two unrelated jobs** — it groups bounded contexts (subdomain-like role) AND serves as the deployment-bundling unit. The name collides with Evans's "module" (which is a within-BC sub-package, not a wrapper of BCs).

2. **No subdomain concept exists** — DDD's business-side grouping has no surface in Loom, despite being the most natural way to organise mid-size projects.

3. **Cross-context visibility is unclear** — today's rule is "only `X id` references cross context boundaries" plus a custom scope provider that enforces it. The boundary works but feels arbitrary; nothing in the model explains *why* it's that boundary.

4. **Per-aggregate storage configuration is fine-grained but wrong-grained** — the existing storage proposals commit to per-aggregate `storage Name { for: Sales.Order }` declarations. This optimises for mixed-strategy flexibility (one aggregate ES, another state-based, in one BC) — a real but uncommon pattern — at the cost of N-per-aggregate verbosity for the 95% case where a BC's aggregates share a store. It also doesn't account for the deployable boundary, which is the *actual* transactional gate.

5. **`transactional` workflow constraints aren't validatable** — today's validator can't tell you that `transactional workflow X { ... }` is infeasible because the aggregates it touches end up in different processes. The feasibility chain (deployable + storage + framework compatibility) needs to be modelled before it can be checked.

6. **Export / consume ceremony is being designed even though it isn't needed** — the obvious "explicit `export` keyword + `consumes` declaration" pattern from object-oriented modules doesn't earn its keep in a code-generated DSL where the IR knows every cross-BC reference. Nesting can carry the visibility decision structurally; ceremony just adds drag.

This proposal addresses all six in one coordinated revision. The thread is: **the bounded context is the unit**. Storage binds to it, framework binds to it, the deployable selects it, visibility radiates from it, transactional feasibility derives from it. Most of the friction above is a symptom of distributing the BC's natural responsibilities across other constructs.

## Prior art surveyed

DDD canon (Evans, Vernon, Khononov):

| Concept | Role |
|---|---|
| **Subdomain** | Business-side grouping. Core / supporting / generic classification. Maps to one or more BCs. Has no implementation topology. |
| **Bounded context** | Linguistic boundary, ubiquitous language, the model boundary. The unit where the rest of DDD's structural rules apply. |
| **Module** (Evans) | Sub-package *within* one BC. Code organisation only. Aggregates in different modules share the BC's vocabulary. |
| **Aggregate** | Unit of consistency. Single-aggregate transactional. |
| **Context map** | Relationships *between* BCs (partnership, customer-supplier, conformist, ACL, OHS, published language, shared kernel, separate ways). |

Loom today inverts the module/subdomain naming and collapses the "BC binds to infra" question into per-aggregate storage decisions. Both choices have local justifications but compound into structural friction.

Framework prior art (the storage/framework discussion):

| Concern | Survey finding |
|---|---|
| Per-aggregate vs per-BC storage | Ash binds storage at resource (= aggregate); EF Core implicitly per-DbContext (= roughly per-BC); Marten one IDocumentStore per BC; most teams in practice pick one per BC. |
| Mixed-framework within one transaction | Marten + Dapper or Marten + EF Core on same Postgres connection: yes. Different processes (cross-deployable): no. Different physical instances: only via 2PC, which nobody wants. |
| EF + Dapper split for reads | A known optimisation for high-traffic read paths. For code-generated stacks, the ergonomic motive for EF (write-side magic) disappears — Dapper becomes viable for everything. |
| Read-side projections via direct table access | Anti-pattern; the source BC owns its data; cross-BC reads go through events (subscribed → local projection) or published query contracts. |

Visibility prior art:

| Language | Visibility model |
|---|---|
| Java / C# | Annotative (`public`, `internal`, `private`, `package-private`) |
| Rust | Structural + explicit (`pub` keyword; module nesting determines default scope) |
| TypeScript | Module-scoped by default; `export` to publish |
| Python | Convention (`_name` for private) + `__all__` |
| Erlang / Elixir | Explicit `export` list at module top |

Loom diverges from all of them deliberately: in a code-generated DSL, the IR-level usage graph is fully known at compile time. Visibility-as-keyword exists in hand-written languages because the compiler can't see every consumer. Loom can. Annotative visibility is therefore ceremony without much functional payoff — the IR can derive "is this consumed externally?" structurally, and tooling/validators can flag accidental cross-BC reaches without an `export` modifier carrying the load.

## Design — the bounded context is the unit

Six structural constructs, each with one job:

| Construct | Role | Cardinality |
|---|---|---|
| `system` | Project root | one per project |
| `subdomain` | Namespace + organisational grouping (business-area) | many per system; pure namespace, no language semantics beyond path prefix |
| `context` (bounded context) | Linguistic + transactional + deployment unit; owns storage instance and framework choice | many per subdomain |
| `aggregate` | Consistency unit; single-aggregate transactional default | many per context |
| `deployable` | Process / runtime unit; selects which contexts it hosts | many per system |
| `storage` | Infrastructure instance (physical Postgres, Redis, etc.) | many per system |

Each does exactly one job; the conflations that today's `module` and per-aggregate-storage choices create dissolve.

### Subdomain

Pure namespace. Carries no language semantics beyond:
- Organisational grouping (the business-area folder for the contexts inside).
- Path prefix in fully-qualified type references (`Billing.Subscriptions.BillingPeriod`).
- A documentation root (visualisations, dependency graphs, etc., can group at subdomain level).

Does **not** carry:
- Type declarations (no subdomain-level VOs or enums in v1).
- Storage / framework binding.
- Visibility modifiers.
- Deployment role.

```ddd
subdomain Billing {
  context Subscriptions { ... }
  context Invoicing { ... }
}
```

Bare `context` directly under `system` is allowed — treated as if in an implicit `_default` subdomain. Most small projects won't introduce subdomains at all.

### Bounded context — owns storage and framework

Each context declares:
- The framework it's implemented with (`framework: efcore | dapper | marten | drizzle | ashEcto | ...`).
- (Per-framework constraints — see "Per-backend implications" below.)

```ddd
context Orders {
  framework: efcore
  
  aggregate Order { ... }
}

context Subscriptions {
  framework: marten             // event-sourced + document, single library
  
  aggregate Subscription eventSourced { ... }
}

context HighTrafficCatalog {
  framework: dapper             // generator emits raw SQL for both reads and writes
  
  aggregate Product { ... }
}
```

The framework choice is a **domain-level decision** (event sourcing wants Marten; perf-sensitive paths want Dapper; standard CRUD wants EF Core) and doesn't change between environments. Per-BC, not per-aggregate.

### Storage instance binding — on the deployable

The framework is on the BC; the **physical storage instance** is on the deployable. This separation matters because the same BC will bind to different physical databases in dev vs. prod, while its framework stays the same.

```ddd
storage postgresMain    { type: postgres; url: env.PG_MAIN_URL }
storage postgresAudit   { type: postgres; url: env.PG_AUDIT_URL }

deployable api {
  contexts: Orders, Subscriptions, AuditLog
  storage: {
    Orders:        postgresMain,
    Subscriptions: postgresMain,    // co-located with Orders → potentially co-transactable
    AuditLog:      postgresAudit,   // isolated
  }
  port: 8080
}

deployable apiProd {
  contexts: Orders, Subscriptions, AuditLog
  storage: {
    Orders:        postgresProdMain,
    Subscriptions: postgresProdMain,
    AuditLog:      postgresProdAudit,
  }
  port: 8080
}

storage postgresProdMain  { type: postgres; url: env.PG_PROD_MAIN_URL }
storage postgresProdAudit { type: postgres; url: env.PG_PROD_AUDIT_URL }
```

Shorthand for the common case (all contexts share one storage instance):

```ddd
deployable api {
  contexts: Orders, Subscriptions
  storage: postgresMain          // applies to every context in this deployable
  port: 8080
}
```

### BC = exactly one deployable

A context is hosted in exactly one deployable. A deployable hosts many contexts. This is enforced by validator and is what makes the rest of the model tractable:

- Workflow's host deployable is always inferrable (= the deployable hosting the workflow's BC).
- Storage binding from the deployable's `storage:` clause has one resolution per context.
- Cross-BC, same-deployable transactional workflows are feasible (subject to storage / framework checks).
- Cross-BC, cross-deployable interactions are always async (event subscription, HTTP calls).

Read-only patterns that *look* like "BC hosted in many places" are actually separate BCs:
- An admin dashboard that serves a read of Orders → separate BC with its own projection (subscribed to Orders events).
- HA / load-balanced replicas of one BC → still one BC, one deployable; the runtime handles horizontal scaling. Not a DSL concern.

This is the single load-bearing constraint that everything else hinges on. Sub-rules in the validation section.

### Subdomain spans deployables freely

Since a deployable selects *contexts* (not subdomains), and a subdomain can contain many contexts, a subdomain naturally spans deployables:

```ddd
subdomain Billing {
  context Subscriptions { framework: marten;  ... }   // hosted in api (sync request/response)
  context Invoicing     { framework: dapper;  ... }   // hosted in worker (background cron)
}

deployable api    { contexts: Subscriptions; storage: postgresMain; port: 8080 }
deployable worker { contexts: Invoicing;     storage: postgresMain; port: 9000 }
```

Billing as a subdomain is the union of its BCs across whatever deployables they live in. No language change needed — subdomain being a pure namespace makes this fall out naturally.

### Transactional workflow feasibility

`transactional` (per the workflow-and-applier proposal) is the modifier on a workflow that says "this whole workflow commits atomically." It was previously underspecified about what makes it feasible. Sharpening:

A `transactional` workflow is feasible iff **all four** hold:

1. The workflow itself lives in BC `W`; `W` is hosted in deployable `D`.
2. Every aggregate the workflow touches lives in a BC hosted in `D` (no cross-deployable reach).
3. Every touched BC's storage binding (per `D`'s `storage:` clause) resolves to the same physical instance — i.e., one connection / one transaction primitive is possible.
4. Every touched BC's framework is mutually co-transactable on that physical instance per the platform compatibility table (EF + Dapper on Postgres: yes; Marten + EF on Postgres: yes; Drizzle + EventStoreDB: no; cross-runtime: always no).

Validator runs this chain. Failures are compile-time errors with clear suggestions ("`PaymentReconciliation` workflow is `transactional` but touches `Identity.Users.User` whose BC is hosted in deployable `auth`, not `api` — change to non-transactional and use event-based coordination").

The chain explains why each layer of the model exists: BC-as-one-deployable simplifies link 1+2; per-BC storage binding decides link 3; per-BC framework decides link 4. Each is independently meaningful; together they say which workflows can be atomic and which must be sagas.

### Framework compatibility table

Per-platform; lives in `src/platform/registry.ts` alongside the existing `family@version` pinning. Sketch:

| Platform | Framework | Co-transactable with | Notes |
|---|---|---|---|
| .NET | EF Core | EF Core, Dapper, Marten (same Postgres) | All share a `DbConnection`/`DbTransaction`; Loom-emitted wrapping wires the connection. |
| .NET | Marten | Marten, EF Core, Dapper (same Postgres) | Marten exposes its session as `IDocumentSession`; can share `NpgsqlConnection`. |
| .NET | Dapper | Dapper, EF Core, Marten (same Postgres) | Dapper takes a connection; trivially compatible. |
| TS / Hono | Drizzle | Drizzle, raw `pg` (same Postgres) | Shared `pg.Client` with `BEGIN`/`COMMIT`. |
| TS / Hono | Drizzle | EventStoreDB | **no** (different infra) |
| Phoenix | Ecto | Ecto (same Postgres) | One Ecto repo per BC. |
| (cross-runtime, any) | (any) | (none across .NET / TS / Phoenix processes) | Different processes; never. |

Same-runtime + same-physical-instance is the necessary and sufficient condition for co-transactability. Cross-process or cross-instance is always async.

### Framework recommendations

Three-tier positioning for .NET:

| Framework | Default for | Why |
|---|---|---|
| **EF Core** | Standard CRUD; rich aggregate hierarchies (`Order { items: LineItem[]; shipping: Address }`) wanting typed relational tables; dev-velocity-first | LINQ-everywhere, mature tooling, Owned Types / navigation properties map Loom's aggregate-with-entities cleanly onto normalised tables. |
| **Marten** | Event sourcing; document-shaped aggregates; mixed ES + state in one BC | Native ES, document storage, projections all under one `IDocumentSession`; one transactional umbrella; awkward only for rich relational hierarchies which Marten stores as JSON. |
| **Dapper** | Perf-critical paths; SQL-honest teams; anti-ORM stance | Loom generates all SQL (INSERT/UPDATE/DELETE/SELECT, migrations, repositories, transaction wiring). The hand-coder cost that normally makes Dapper a heavier choice than EF disappears entirely under a code generator. Highest performance ceiling; predictable behaviour; statically verifiable queries. |

The Dapper-as-power-play positioning is unique to code generation. Hand-coding teams pick EF for ergonomics and bolt on Dapper for read paths; generated code removes the ergonomic motive for EF, making Dapper viable for entire BCs without the boilerplate cost.

TS / Hono: **Drizzle** as the default — typed-SQL-builder, no ORM magic, similar position to Dapper on the .NET side.

Phoenix: **plain Ecto** as the only framework choice; per the existing platform (the Ash foundation was removed — `foundation: ash` is now a validation error).

### Per-aggregate storage — the per-aggregate proposals' work survives, as a future override

The existing per-aggregate storage proposals committed to `storage Name { for: Sales.Order, use: pg, ... }`. The granularity is wrong-grained for the dominant case, but the work isn't wasted: it becomes the **override mechanism** for the genuine cross-infra-in-one-BC case (rare). v1 ships per-BC; per-aggregate stays a deferred v2 feature for when empirical pressure demands it. The existing proposals' grammar and IR work can land mostly intact; just bind it to BC by default and treat per-aggregate as override.

When per-aggregate override is eventually added, the validator's transactional-feasibility chain (link 3 above) handles it naturally: if two aggregates in one BC bind to different physical instances, transactional workflows touching both become infeasible — which is exactly the right answer.

### Visibility — nesting IS the rule; no `export` keyword

There is no `export` keyword. There is no `consumes` declaration. The placement of a declaration in the nesting hierarchy *is* the visibility decision:

| Declared at | Visible to |
|---|---|
| Inside `aggregate { ... }` | Anything in the same BC (the aggregate's own `apply()`, projections, workflows, other aggregates in this context) — **BC-scope** |
| Inside `workflow { ... }` | Same — BC-scope |
| Inside `projection { ... }` (when projections land) | Same — BC-scope |
| At `context { ... }` top level | Anything anywhere — **published**; part of the BC's stable contract |
| At `system` root | Universal — visible everywhere; intended for genuinely cross-cutting types (`Money`, `EmailAddress`, `IsoCurrency`) |

Reference syntax: bare type names work when globally unique; dotted paths (`Subdomain.Context.Type`) used for disambiguation. Same as today's existing aggregate id rule (`Order id` works cross-context with no ceremony), extended uniformly to every declarable thing.

```ddd
system AcmeShop {

  // System-root universals
  valueobject Money { amount: decimal; currency: IsoCurrency }
  enum IsoCurrency { USD EUR GBP }

  subdomain Identity {
    context Users {
      event UserDeactivated { userId: User id, at: datetime }    // context-level → published
      enum UserStatus { Active Suspended Deleted }                // context-level → published

      aggregate User {
        email: EmailAddress
        status: UserStatus
      }
    }
  }

  subdomain Billing {
    context Subscriptions {
      framework: marten

      valueobject BillingPeriod { start: date; end: date }        // context-level → published
      event SubscriptionExpired { subscriptionId: Subscription id, at: datetime }

      aggregate Subscription eventSourced {
        event ItemActivated { sku: string, at: datetime }         // aggregate-nested → BC-scope (internal to Subscriptions BC)

        customerId: User id                                       // cross-BC bare reference (globally unique)
        period: BillingPeriod
        status: SubscriptionStatus                                // BC-local enum (declared below)
      }
      enum SubscriptionStatus { Active PastDue Cancelled }        // context-level → published
    }

    context Invoicing {
      framework: efcore

      aggregate Invoice {
        customerId: User id
        period: BillingPeriod                                     // cross-BC bare reference to sibling
        userStatus: UserStatus                                    // cross-subdomain bare reference
      }
    }
  }

  // Deployable bindings
  deployable api {
    contexts: Users, Subscriptions, Invoicing
    storage: postgresMain
    port: 8080
  }
  storage postgresMain { type: postgres; url: env.PG_MAIN_URL }
}
```

Nothing has `export`. Nothing has `consumes`. The cross-BC references resolve by bare name (globally unique) or by dotted path (when ambiguous). `SubscriptionExpired` is publicly subscribable; `ItemActivated` is BC-internal — a workflow in `Invoicing` can subscribe to the latter but a workflow in another subdomain cannot.

**The validator rule that makes the boundary real:**

A workflow / projection in BC `A` subscribing to an event declared inside an aggregate of BC `B` (where `A ≠ B`) is a compile-time error (`loom.cross-bc-internal-event`). The solution is to either subscribe to a context-level published event of `B`, or build a local projection from one if `B` doesn't publish what's needed.

Same rule for any aggregate-nested declaration: cross-BC reaches into aggregate-internal types / VOs / events fail at compile time. The placement is the boundary; the validator enforces it.

### What's stable — the published contract surface

Everything declared at `context { ... }` top level (or `system` root) forms the BC's published contract. These need schema stability:

- Context-level events
- Commands (per workflow-and-applier proposal)
- Views (read-side contracts; the form for cross-BC reads)
- Context-level VOs and enums (when referenced cross-BC)
- Aggregate id types (`Order id` representation matters because consumers store/transmit it)

Everything inside `aggregate { ... }` / `workflow { ... }` / (future) `projection { ... }` is BC-internal and free to evolve:

- Aggregate fields
- Aggregate-internal events
- Workflow-internal events and state
- Operation bodies
- Apply handlers
- Internal VOs / enums

The `contracts.json` artifact (introduced by workflow-and-applier) is derived from the published surface — a type appears in the catalog when at least one external consumer references it. No declarative marking needed.

**Stability mechanism for v1: Level 1 (convention + tooling).**

The build emits:
- `<outdir>/.loom/contracts.json` — catalog of all published types + their cross-BC consumers.
- `<outdir>/.loom/asyncapi.yaml` — events as channels.
- `<outdir>/.loom/openapi.yaml` — commands + views as HTTP endpoints.

These artifacts are committed to the repo. PR review surfaces schema diffs the way it surfaces code diffs. No declarative versioning, no language-level breakage detection. Empirically how most published-contract systems handle this (Stripe, GitHub).

Level 2 (snapshot-based breakage detection) and Level 3 (explicit `event Name v1 / v2` versioning) are deferred to follow-up proposals when empirical pressure demands them.

### Cross-BC reads — via published views or local projections

Cross-BC reads do NOT happen by direct database access from one BC to another's tables. The two clean patterns:

**Pattern A — Source BC publishes a read view:**

```ddd
context Invoicing {
  view InvoiceList {          // published read contract
    rows: from Invoice select { id, customer: customerId, total, issued: issuedAt }
    pagination, filters, sort...
  }
}

context Reports {
  // Reports calls Invoicing.InvoiceList over its API; Invoicing implements + owns the query.
  // No direct DB access; the view IS the contract.
}
```

**Pattern B — Consumer subscribes to events and builds a local projection:**

```ddd
context Reports {
  // Subscribes to context-level events from Invoicing and folds a local read
  // model, fully owned by Reports.  Design now specified in projection.md:
  projection InvoiceLedger keyed by invoice {
    invoice: Invoice id;  total: Money;  status: InvoiceStatus
    on(e: InvoiceIssued) { invoice := e.invoice; total := e.total; status := Issued }
    on(e: InvoicePaid)   { status := Paid }
  }
}
```

The `projection` construct is now specified in
[`projection.md`](./projection.md) (was "deferred to a follow-up proposal") —
cross-BC reads always go through one of these two routes; never direct table
access. A projection fold is **pure** (folds foreign events only, reads no
repos); cross-source enrichment happens up in a `view` over the projection.

## Grammar additions

### Rename: `module` → `subdomain`

```langium
// Was:
Module:
    'module' name=ID '{'
        contexts+=Context*
    '}';

// Becomes:
Subdomain:
    'subdomain' name=ID '{'
        contexts+=Context*
    '}';
```

Context-as-direct-child-of-system stays allowed; treated as `_default` subdomain (today's behaviour).

### Deployable selects contexts (not subdomains)

```langium
// Was:
Deployable:
    'deployable' name=ID '{'
        'modules' ':' moduleRefs+=[Subdomain:ID] (',' moduleRefs+=[Subdomain:ID])*
        ('port' ':' port=INT)?
        // ... other clauses
    '}';

// Becomes:
Deployable:
    'deployable' name=ID '{'
        'contexts' ':' contextRefs+=[Context:ID] (',' contextRefs+=[Context:ID])*
        ('storage' ':' storageBinding=StorageBinding)?
        ('port' ':' port=INT)?
        // ... other clauses
    '}';

StorageBinding:
    StorageRefSimple | StorageRefPerContext;

StorageRefSimple:
    storageRef=[Storage:ID];

StorageRefPerContext:
    '{' bindings+=ContextStorageBinding (',' bindings+=ContextStorageBinding)* ','? '}';

ContextStorageBinding:
    contextRef=[Context:ID] ':' storageRef=[Storage:ID];
```

### Context owns framework choice

```langium
Context:
    'context' name=ID '{'
        ('framework' ':' framework=Framework)?
        members+=ContextMember*
    '}';

Framework:
    'efcore' | 'dapper' | 'marten' | 'drizzle' | 'ashEcto' | ...;
```

The framework value is open-ended; per-platform registries decide which ones are legal for which deployables. Default (no `framework:` line) picks the platform's default (e.g., `efcore` on .NET, `drizzle` on TS, `ashEcto` on Phoenix).

### No new visibility keywords

No `export`, no `consumes`, no `public` / `internal` / `private` modifiers. Visibility is structural — defined by where a declaration is nested. Grammar doesn't change for this.

## Validation rules

| Code | Rule |
|---|---|
| `loom.bc-multi-deployable` | A context is referenced by more than one deployable's `contexts:` clause. |
| `loom.context-no-deployable` | A non-trivial context (has aggregates / workflows) isn't referenced by any deployable. Warning, not error — supports incremental development. |
| `loom.transactional-cross-deployable` | A `transactional` workflow touches an aggregate whose BC is hosted in a different deployable than the workflow's BC. |
| `loom.transactional-cross-storage` | A `transactional` workflow's touched BCs bind (in the host deployable's `storage:` clause) to different physical storage instances. |
| `loom.transactional-incompatible-frameworks` | A `transactional` workflow's touched BCs use frameworks that aren't co-transactable on the bound storage per the platform registry. |
| `loom.cross-bc-internal-event` | A workflow / projection in BC `A` subscribes via `on(e: Event)` to an event declared inside an aggregate / workflow / projection of BC `B ≠ A`. Suggestion: subscribe to a published context-level event of `B`, or build a local projection. |
| `loom.cross-bc-internal-type` | A field / parameter / event payload references a type (VO / enum) declared inside another BC's aggregate / workflow / projection. Same suggestion. |
| `loom.framework-mismatch-deployable` | A context's chosen framework isn't supported by the deployable's platform (e.g., `framework: marten` in a TS/Hono deployable). |
| `loom.storage-binding-missing` | A deployable's `contexts:` clause includes a context whose storage isn't resolvable from the deployable's `storage:` clause. |
| `loom.subdomain-types-not-supported` | A type declaration (VO / enum / event) appears directly inside a `subdomain { ... }` block. Subdomains are namespace-only in v1. |

## IR shape

```typescript
export interface SystemIR {
  subdomains: SubdomainIR[];
  contexts: ContextIR[];               // includes both subdomain-nested and direct-under-system
  deployables: DeployableIR[];
  storages: StorageIR[];
  rootTypes: TypeIR[];                 // system-root VOs/enums
}

export interface SubdomainIR {
  name: string;
  contexts: ContextIR[];               // back-reference for ergonomics; no semantics beyond namespacing
}

export interface ContextIR {
  name: string;
  subdomain: SubdomainIR | null;       // null = direct child of system
  framework: Framework;                // resolved (platform default applied if unspecified)
  aggregates: AggregateIR[];
  workflows: WorkflowIR[];
  // projections: ProjectionIR[];      // when projections land
  views: ViewIR[];
  contextTypes: TypeIR[];              // BC-published VOs, enums, events, commands
  hostingDeployable: DeployableIR;     // resolved during validation; exactly one
}

export interface DeployableIR {
  name: string;
  contexts: ContextIR[];               // direct references; many per deployable
  storage: StorageBindingIR;           // resolved: per-context map
  port?: number;
  platform: Platform;
}

export interface StorageBindingIR {
  perContext: Map<string, StorageIR>;  // context name → resolved storage instance
}

export interface StorageIR {
  name: string;
  type: 'postgres' | 'redis' | 'kafka' | ...;
  config: Record<string, unknown>;
}
```

`AggregateIR` / `WorkflowIR` carry their nested type declarations directly (BC-internal). `ContextIR.contextTypes` carries the published surface. Enrichment derives the catalog from cross-BC references.

### Lowering

| Phase | Change |
|---|---|
| ⑤a `lower.ts` | `lowerSubdomain` (renamed from `lowerModule`); flattens subdomain children into `system.contexts` while preserving subdomain back-references. `lowerDeployable` resolves `contexts:` refs and the `storage:` binding. `lowerContext` resolves `framework:` (with platform default fallback). |
| ⑥ `enrichments.ts` | Resolve each context's `hostingDeployable` (exactly one; validator error otherwise). Build the cross-BC reference graph for `cross-bc-internal-*` checks. Build the transactional-feasibility lookup tables. |
| ⑦ `validate.ts` | Run all validation rules above. |
| ⑨ `system/wire-spec.ts` + new `system/contracts-catalog.ts` | Derive `contracts.json` from context-level published types + cross-BC reference graph. Emit AsyncAPI from events + OpenAPI from commands/views. |

## Per-backend implications

### .NET / EF Core (the default)

- One `DbContext` per BC.
- Aggregate hierarchies map to EF's Owned Types + navigation properties.
- The deployable hosts multiple `DbContext`s, one per context. EF supports this via DI (`AddDbContext<OrdersContext>(...)` per BC).
- `transactional` workflows touching multiple BCs sharing the same physical Postgres use a shared `DbConnection` + `DbTransaction`; Loom emits the wrapping (probably via `IDbConnectionFactory` + manual `BeginTransaction` since `DbContext` has its own transaction scope to coordinate).
- Migrations: `MigrationsIR` derives schema SQL; Loom emits raw SQL applied via `dotnet ef database update` or via DbUp; choice deferred to a follow-up.

### .NET / Marten

- One `IDocumentStore` per BC.
- Aggregates: event-sourced → Marten event streams; state-based → Marten documents.
- Views: Marten projections (inline / async / live) for event-derived; Marten LINQ for document queries.
- Hierarchical aggregates stored as JSON-nested documents; not relationally normalised. Acceptable for document-shaped domains; awkward for rich hierarchies (those should pick EF Core).
- `SaveChangesAsync()` per BC; cross-BC `transactional` works when both BCs use Marten on the same Postgres (shared `NpgsqlConnection`).

### .NET / Dapper

- Loom generates everything: INSERT / UPDATE / DELETE / SELECT per aggregate operation; per-view SELECT statements; per-finder query bodies; migration SQL.
- Repository plumbing: thin Dapper-based wrappers per aggregate.
- Transaction wiring: one `IDbConnection` per workflow invocation; explicit `BeginTransaction` / `Commit` / `Rollback` around the workflow body.
- Event dispatch: integrates with existing `IDomainEventDispatcher`.
- No change tracking — generator emits precise UPDATEs based on the operation's IR-known mutations.
- Highest performance ceiling per BC.

### TS / Hono + Drizzle (the default)

- One Drizzle schema per BC.
- Aggregates lower to typed table declarations + query builders.
- `transactional` workflows touching multiple BCs sharing the same Postgres connection: shared `Client` with explicit `BEGIN` / `COMMIT`.

### Phoenix / Ecto

- One Phoenix context module + `Ecto.Repo` per BC.
- Aggregates as `Ecto.Schema` modules; lifecycle maps to `Ecto.Changeset`-backed context functions (create / update / delete).
- Workflows as plain context functions / `Ecto.Multi` transactions.

## Backward compatibility

Breaking against today's grammar:

1. `module Name { ... }` → `subdomain Name { ... }` — pure rename, mechanical.
2. `deployable D { modules: A, B; ... }` → `deployable D { contexts: ctxA, ctxB; ... }` — semantic shift: the user enumerates contexts directly. For projects where each module had one context, the migration is "rename `modules:` clause to `contexts:` and update the names." For projects with multi-context modules, the user enumerates each context.
3. Per-aggregate `storage Name { for: Sales.Order; ... }` declarations from the storage proposals — if any project adopted them, they're not yet wired into the toolchain; defer migration to whenever per-aggregate override lands as v2.
4. Today's `emit EventName must be in same context` validator — no change; this proposal generalises that intuition into the broader "cross-BC reference must hit published surface" rule.

Examples needing updates: `examples/acme.ddd`, `examples/sales.ddd`, every fixture under `test/fixtures/`. Re-baselining required.

### Migration recipe

Before:
```ddd
system Acme {
  module Billing {
    context Subscriptions { aggregate Subscription { ... } }
    context Invoicing { aggregate Invoice { ... } }
  }
  module Identity {
    context Users { aggregate User { ... } }
  }
  deployable api { modules: Billing, Identity; port: 8080 }
}
```

After:
```ddd
system Acme {
  subdomain Billing {
    context Subscriptions { framework: marten; aggregate Subscription { ... } }
    context Invoicing     { framework: efcore; aggregate Invoice { ... } }
  }
  subdomain Identity {
    context Users { framework: efcore; aggregate User { ... } }
  }
  deployable api {
    contexts: Subscriptions, Invoicing, Users
    storage: postgresMain
    port: 8080
  }
  storage postgresMain { type: postgres; url: env.PG_MAIN_URL }
}
```

Mechanical (`s/module /subdomain /; s/modules: /contexts: /`) with three additional decisions: pick a framework per context (defaults available), enumerate contexts on the deployable, declare storage instance(s) and bind on the deployable. None of these decisions are forced — sensible defaults pick the platform's default framework and reuse existing single-storage conventions.

## Coordination with other proposals

- **[`workflow-and-applier.md`](./workflow-and-applier.md)** (merged) — workflows live in contexts; this proposal supplies the per-BC framework and storage that workflows use; `transactional` feasibility chain depends on this proposal's BC-deployable-storage-framework binding.
- **[`lifecycle-operations.md`](./lifecycle-operations.md)** — aggregate `create` / `operation` / `destroy` per-aggregate routing works the same regardless of which storage the BC binds to; no interaction.
- **[`storage-and-platform-config.md`](./storage-and-platform-config.md) + plan + micro-plan** — these proposals' per-aggregate `storage Name { for: ... }` model is superseded as the default; their work survives as the future per-aggregate override mechanism for the rare cross-infra-in-one-BC case. Recommend folding their grammar / IR work into this proposal (per-BC binding now; per-aggregate override as deferred).
- **[`loom-forms.md`](./loom-forms.md)** — forms bind to aggregates; aggregates live in contexts; this proposal doesn't change the form binding surface.
- **[`payload-transport-layer.md`](./payload-transport-layer.md)** — `contracts.json` is derived from the published surface this proposal defines. The payload-transport-layer work for command/event payloads composes cleanly.
- **[`exception-less.md`](./exception-less.md)** — errors are part of the published contract surface; same stability rules apply.

## Open questions

1. **Projections as first-class construct.** Design now specified in [`projection.md`](./projection.md) (a `projection` context member folding foreign events into a pure, derived read model). Fits the structural visibility model as anticipated: projection state is queryable intra-BC; cross-BC reads go via `view`s over projections (`projection.md` v1.1).
2. **Subdomain-level `consumes` import-alias shortcut.** Considered and deferred. Useful only if cross-BC dotted paths become genuinely painful in practice; collision-aliasing is the only legitimate use case. Add if pressure builds.
3. **Per-aggregate storage override** (the v2 surface from the storage proposals). Add when at least one concrete user case demands cross-infra coexistence within a single BC.
4. **Schema versioning Level 2 / 3.** Level 1 (convention + tooling, catalog + AsyncAPI + OpenAPI + code review discipline) suffices for v1. Layer Level 2 (snapshot-based breakage detection) when accidental breaks become recurring; Level 3 (explicit `v1 / v2` declarations) when multi-version coexistence is genuinely needed.
5. **Cross-system / external event subscription.** Today's workflow-and-applier proposal lists this as an open question; this proposal doesn't address it. The contracts catalog + AsyncAPI emission gives a starting point.
6. **`publish` keyword for promoting aggregate-internal events to context-level published events.** v1 ships with declare-at-the-level-you-want; if a user needs an internal event AND its published counterpart, they declare both. Add `publish` syntax later if the duplication becomes painful.
7. **Subdomain classification (`core` / `supporting` / `generic`).** Considered, deferred. Pure annotation initially; could drive tooling decisions later (warnings about over-investment in generic subdomains, etc.). Compose cleanly when added.
8. **Migrations runner choice per framework.** EF has migrations; Dapper doesn't; Marten manages its own schema; Drizzle has its own. Loom's `MigrationsIR` is framework-agnostic but the runner integration per framework needs spelling out — separate proposal.
9. **Storage type-system completeness.** Beyond `postgres`, today's `storage` grammar accepts `redis`, `kafka` etc. but doesn't generate code for them. Coordination with the platform registry to define what each storage type means semantically (transactional? eventually-consistent? message-broker?) is needed.

## Implementation phases

| Phase | Scope | Approx. |
|---|---|---|
| C1 | Grammar: `module → subdomain`, `modules: → contexts:`, `framework:` on context, deployable `storage:` binding clauses; regen Langium artifacts; rename in IR (`ModuleIR → SubdomainIR`). | ~1 wk |
| C2 | Validation: bc-multi-deployable, cross-bc-internal-*, framework-mismatch-deployable, storage-binding-missing; deployable host resolution in enrichment. | ~1.5 wk |
| C3 | Transactional-feasibility validation: link the four-condition chain (deployable + storage + framework) into the existing `transactional` workflow check; platform compatibility tables in `src/platform/registry.ts`. | ~1 wk |
| C4 | Per-backend storage/framework wiring (TS/Drizzle baseline + .NET/EF Core baseline): emit per-BC schema / DbContext, deployable composition wires multiple BCs into one process. | ~2 wk |
| C5 | Marten + Dapper backend implementations on .NET (each picks up the framework-choice surface; emit per-framework code). | ~3 wk |
| C6 | Visibility-driven catalog: derive `contracts.json` from cross-BC reference graph; emit AsyncAPI + OpenAPI from published surface. | ~1.5 wk |
| C7 | Migrate examples + fixtures + docs (`language.md`, `architecture.md`, `generators.md`, `platforms.md` updates). | ~1.5 wk |

Total ~11.5 weeks focused. C4–C5 partially parallelisable.

Sequencing: C1 → C2 → C3 are blocking; C4 onward partially parallel. The work composes with workflow-and-applier (already merged) and lifecycle-operations (proposed) without phase-level conflicts — the validator and IR changes here strengthen what workflow-and-applier defers as "platform-deferred."

## Verification

When implementation lands, end-to-end verification:

1. Each validation rule has a positive and negative test under `test/parsing.test.ts` or a sibling suite.
2. Lowering tests cover the new IR shape (SubdomainIR + ContextIR with framework / deployable resolution).
3. Per-backend generator tests assert byte-shape of emitted code for representative examples — one BC per framework choice across the three .NET frameworks.
4. Slow-gate runs: `LOOM_TS_BUILD=1`, `LOOM_DOTNET_BUILD=1`, `LOOM_PHOENIX_BUILD=1`, `LOOM_REACT_BUILD=1` against migrated examples.
5. Multi-deployable e2e: a project with two deployables sharing one subdomain (one BC each), verify cross-deployable interactions (event subscription) work and cross-deployable `transactional` is rejected.
6. Catalog artifacts (`contracts.json`, `asyncapi.yaml`, `openapi.yaml`) match expected shape for the migrated `examples/acme.ddd`.

## Appendix — sealed decisions summary

For quick scanning, the load-bearing decisions this proposal commits to:

| Decision | Position |
|---|---|
| `module` keyword | Renamed to `subdomain`. |
| Subdomain role | Pure namespace + organisational grouping. No types, storage, framework, deployment, or visibility role. |
| Deployable binding | Selects contexts directly (not subdomains). |
| BC ↔ deployable | Exactly one deployable hosts each BC. Many BCs per deployable. |
| Subdomain ↔ deployable | A subdomain can span many deployables (via its contexts). |
| Storage granularity | Per-BC default. Per-aggregate override deferred to v2. |
| Framework granularity | Per-BC. EF default / Marten cool kid / Dapper power play on .NET; Drizzle on TS; Ecto on Phoenix. |
| Storage instance binding | On the deployable. Environment-specific. |
| Framework choice binding | On the context. Domain-specific. |
| Transactional feasibility | Deployable + storage + framework-compat chain; validator-enforced. |
| Visibility model | Structural — nesting IS visibility. No `export` / `consumes` keywords. |
| Aggregate-nested declarations | BC-scope (visible to all BC-internal consumers). |
| Context-nested declarations | Published — part of stable contract surface. |
| Subdomain-nested types | Not supported in v1. |
| System-root declarations | Universal (Money, EmailAddress, IsoCurrency). |
| Cross-BC reference syntax | Bare name when globally unique; dotted path (`Subdomain.Context.Type`) when ambiguous. |
| Cross-BC reads | Via published views or local projections — never direct table access. |
| Schema stability | Level 1 (catalog + AsyncAPI + OpenAPI artifacts + code review). Higher levels deferred. |

---

*Conversation thread that produced this proposal: design discussion covering module/context rename, deployable binding (subdomain-as-namespace vs subdomain-as-deployment-unit), storage granularity (per-aggregate vs per-BC), framework choice positioning (EF / Marten / Dapper for .NET), transactional feasibility chain (deployable + storage + framework compatibility), cross-BC visibility model (explicit `export` rejected in favour of structural-nesting visibility), aggregate-internal vs context-published event distinction, and the published surface (`contracts.json` derived from usage).*
