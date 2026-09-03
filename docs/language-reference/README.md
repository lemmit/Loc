# The Loom Language Reference

The complete, surface-by-surface reference for the Loom DSL (`.ddd`).
Every language feature is documented once, in the chapter where it
belongs, with the `.ddd` source you write **and** the real generated
output on each platform that emits it — pick your backend
(node/dotnet/java/python/elixir) or frontend (react/vue/svelte/angular/feliz/flutter)
in the tabbed examples.

This reference is **non-sequential**: each chapter stands alone and
cross-links. Jump to the construct you need from the table below, or
read [the introduction](00-introduction.md) first for notation and the
shape of the compiler pipeline that turns these features into code.

> New here for the prose tour instead of the reference? Start with
> [`../language.md`](../language.md) and [`../page-metamodel.md`](../page-metamodel.md).

## Chapters

| # | Chapter | Covers |
|---|---------|--------|
| 0 | [Introduction & notation](00-introduction.md) | How to read this reference, the example convention, the ten-phase pipeline. |
| 1 | [Lexical structure](01-lexical-structure.md) | Comments, identifiers, literals, terminals, soft keywords, `import` / multi-file source. |
| 2 | [Systems & deployment topology](02-systems-and-topology.md) | `system`, `subdomain`, `context`, `deployable`, platforms, design packs, realization axes, `theme`. |
| 3 | [Domain modeling](03-domain-modeling.md) | `aggregate`, `valueobject`, `entity` parts, `event`, `enum`, fields, access modifiers, containment. |
| 4 | [The type system](04-type-system.md) | Primitives, `money`, `X id` refs, collections, options, the `paged`/`envelope`/`option` carriers. |
| 5 | [Expressions](05-expressions.md) | Literals, operators & precedence, member access, calls, collection ops, `match`, lambdas, conversions, `this`/`currentUser`. |
| 6 | [Behavior & statements](06-behavior-and-statements.md) | `operation`, `create`/`destroy`, `apply`, `precondition`/`requires`, `let`, `emit`, `for`, `if let`, `return`, assignment. |
| 7 | [Invariants, derived fields & functions](07-invariants-derived-functions.md) | `invariant` (+ guards, `private`), `derived` (`display`/`inspect`), pure `function`. |
| 8 | [Inheritance & polymorphism](08-inheritance-and-polymorphism.md) | `abstract aggregate`, `extends`, `inheritanceUsing` (TPH vs TPC), `find all <Base>`. |
| 9 | [Payloads, records & unions](09-payloads-and-unions.md) | `payload`/`command`/`query`/`response`/`error`, anonymous `or`, named unions, the tagged wire. |
| 10 | [Repositories & queries](10-repositories-and-queries.md) | `repository`, `find`, the queryable subset, `criterion`, `retrieval`, `loads`, `ignoring`, pagination, query-time `projection` (shorthand `select`-less form, `group by`). |
| 11 | [Capabilities, filters & stamps](11-capabilities-filters-stamps.md) | `capability`, `with`/`implements`, `filter`, `stamp`, `ignoring`, `auditable`/`softDeletable`/`crudish`. |
| 12 | *(retired)* | The `view` chapter went with the `view` feature (#2200); its successor, `projection`, lives in chapter 10 today (see the gaps list below for the folded form). |
| 13 | [Workflows](13-workflows.md) | `create`/`handle`/`on`/`apply`, `eventSourced`, `transactional`, isolation, resource consumption. |
| 14 | [APIs, storage, resources & channels](14-apis-storage-resources-channels.md) | `api`, `storage`, `resource`, `channel`, `channelSource`. |
| 15 | [UI: pages & structure](15-ui-pages-structure.md) | `ui`, `page`, `component`, `area`, `state`, `derived`, `action`, `menu`, `layout`, `scaffold`. |
| 16 | [UI: the walker primitive library](16-ui-walker-primitives.md) | Layout/display/input/action/formatter primitives, `Form`, `match`, `For`, `QueryView`. |
| 17 | [Authentication & authorization](17-auth.md) | `user`, `auth`, `permissions`, `requires`, `currentUser`, `sensitive` fields.  (`policy { … }`, named policy functions, `implies`, and `mask unless` are documented in [`../auth.md`](../auth.md) until this chapter grows them.) |
| 18 | [Testing](18-testing.md) | `test`, `test e2e`, matchers, automatic api/ui dispatch. |
| 19 | [Requirements & traceability](19-requirements-traceability.md) | `requirement`, `solution`, `testCase`, `verifies`/`covers`, `ddd verify`. |
| 20 | [Observability & provenance](20-observability-provenance.md) | The catalog envelope, `provenanced`, `ddd snapshot`. |
| 21 | [Externs](21-externs.md) | `extern` operations, `extern` components/functions, per-backend handler registries. |
| 22 | [Macros & the `with` clause](22-macros.md) | The macro system, the stdlib, project-local `.loom/macros`, `unfold`. |
| 23 | [Domain services & seeds](23-domain-services-and-seeds.md) | `domainService`, `seed` (declarative + `raw`). |

## Not yet chaptered

Surfaces that ship on `main` but have no reference chapter yet — the
per-feature doc is the reference for them until a chapter lands:

| Surface | Reference |
|---|---|
| `tenancy by user.<claim> of <Registry>`, `tenantOwned` / `tenantRegistry` / `crossTenant`, the deep / deny / global / self stances, the `policy {}` read ladder | [`../tenancy.md`](../tenancy.md) |
| `policy { allow / deny … }`, named `policy` functions, `permissions … implies …`, `mask unless` | [`../auth.md`](../auth.md) |
| Folded (`on(e: Event)`) projections, `keyed by`, `join`, `from <Projection>` / workflow sources, paged projections, `GET /projections/<name>` | [`../scaffold-macros.md`](../scaffold-macros.md) (`scaffoldDashboard`), [`../language.md`](../language.md) → "Inside a context", `docs/old/proposals/projection.md` (design record) |
| `migration "…" { sql / rename / backfill }` blocks, `unique (…)`, `index:` specs, destructive / rebaseline gating | [`../migrations.md`](../migrations.md) |
| `commandHandler` / `queryHandler`, `api { route GET "/…" -> Handler }`, `httpStatus` mappings | [`../extern.md`](../extern.md), [`../architecture.md`](../architecture.md) |
| `timerSource` (`cron:` / `every: 15s`) | [`../generators.md`](../generators.md), grammar `TimerSource` |
| `match` as a statement, `match await`, effect markers, page `action` handlers, stores (`persist` / `local`) | [`../actions.md`](../actions.md), [`../page-metamodel.md`](../page-metamodel.md) |
| Interpolation format specs (`{x, number, ::currency/USD}`, `plural`, `select`), the i18n catalog | [`../new-plan/T1-ui-frontend.md`](../new-plan/T1-ui-frontend.md) § M-T1.11 |
| `duration` constructors (`days(n)` …) and datetime arithmetic, the scalar intrinsics | [`../stdlib.md`](../stdlib.md), [`../language.md`](../language.md) → "Temporal arithmetic" |
| Mailer resources (`smtp` / `ses` / `sendgrid`), `localDisk` object storage, the `File` type | [`../resources.md`](../resources.md) |

## Conventions

Authoring and the platform-tabs example format are specified in
[`AUTHORING.md`](AUTHORING.md). The short version: each feature shows a
`.ddd` snippet and its real generated output in a tabbed picker, sourced
by actually running the generator — never hand-waved.
