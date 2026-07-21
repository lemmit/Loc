# The Loom Language Reference

The complete, surface-by-surface reference for the Loom DSL (`.ddd`).
Every language feature is documented once, in the chapter where it
belongs, with the `.ddd` source you write **and** the real generated
output on each platform that emits it — pick your backend
(node/dotnet/java/python/elixir) or frontend (react/vue/svelte/angular)
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
| 10 | [Repositories & queries](10-repositories-and-queries.md) | `repository`, `find`, the queryable subset, `criterion`, `retrieval`, `loads`, pagination. |
| 11 | [Capabilities, filters & stamps](11-capabilities-filters-stamps.md) | `capability`, `with`/`implements`, `filter`, `stamp`, `ignoring`, `auditable`/`softDeletable`/`crudish`. |
| 13 | [Workflows](13-workflows.md) | `create`/`handle`/`on`/`apply`, `eventSourced`, `transactional`, isolation, resource consumption. |
| 14 | [APIs, storage, resources & channels](14-apis-storage-resources-channels.md) | `api`, `storage`, `resource`, `channel`, `channelSource`. |
| 15 | [UI: pages & structure](15-ui-pages-structure.md) | `ui`, `page`, `component`, `area`, `state`, `derived`, `action`, `menu`, `layout`, `scaffold`. |
| 16 | [UI: the walker primitive library](16-ui-walker-primitives.md) | Layout/display/input/action/formatter primitives, `Form`, `match`, `For`, `QueryView`. |
| 17 | [Authentication & authorization](17-auth.md) | `user`, `auth`, `permissions`, `requires`, `currentUser`, `sensitive` fields. |
| 18 | [Testing](18-testing.md) | `test`, `test e2e`, matchers, automatic api/ui dispatch. |
| 19 | [Requirements & traceability](19-requirements-traceability.md) | `requirement`, `solution`, `testCase`, `verifies`/`covers`, `ddd verify`. |
| 20 | [Observability & provenance](20-observability-provenance.md) | The catalog envelope, `provenanced`, `ddd snapshot`. |
| 21 | [Externs](21-externs.md) | `extern` operations, `extern` components/functions, per-backend handler registries. |
| 22 | [Macros & the `with` clause](22-macros.md) | The macro system, the stdlib, project-local `.loom/macros`, `unfold`. |
| 23 | [Domain services & seeds](23-domain-services-and-seeds.md) | `domainService`, `seed` (declarative + `raw`). |

## Conventions

Authoring and the platform-tabs example format are specified in
[`AUTHORING.md`](AUTHORING.md). The short version: each feature shows a
`.ddd` snippet and its real generated output in a tabbed picker, sourced
by actually running the generator — never hand-waved.
