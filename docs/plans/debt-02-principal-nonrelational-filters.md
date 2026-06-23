# Plan — DEBT-02 principal-referencing filters on non-relational aggregates

**Created:** 2026-06-22 · **Status:** in progress (claim PR open)

Closes the last remaining slice of **DEBT-02** from
[`debt-prioritized-backlog.md`](./debt-prioritized-backlog.md): a capability
`filter` that references `currentUser` (tenancy / row-level scoping) on a
**non-relational** (`shape(document)` / `shape(embedded)`) aggregate.

## Current state (verified on fresh `main`)

The gate is `validateContextFilterSupport`
(`src/ir/validate/checks/system-checks.ts`), diagnostic
`loom.context-filter-unsupported`. Two orthogonal axes already ship; their
**intersection** is what's still gated:

| | non-principal filter | principal filter (`currentUser.x`) |
|---|---|---|
| **relational** | node, dotnet, elixir, java, python | node, dotnet, elixir, java (not python) |
| **embedded** | node, dotnet, elixir, java | **dotnet only** ← gap |
| **document** | node, dotnet, java | **dotnet only** ← gap |

`.NET` handles every cell (EF `HasQueryFilter` is shape- and principal-agnostic).
The gate rejects a principal filter on any non-relational shape on
node/elixir/java via the `!usesPrincipal` guard on `supportsNonRelationalFilter`.

## Slices (one backend-shape at a time)

### Slice A — `embedded` + principal (node, elixir, java)
For an `embedded` aggregate the **root scalars are real columns**, so a principal
filter is structurally identical to the relational principal filter.

- **node** — the embedded read builder (`repository-embedded-builder.ts`) already
  weaves `contextFilterPredicate(...)`, which already threads the ambient
  `requireCurrentUser()` accessor for principal filters. Expectation: **gate
  unblock + verify + fixture**; no emitter change.
- **elixir (Ash)** — `renderBaseFilter` (`domain-emit.ts`) renders the principal
  via `^actor(:field)` per-aggregate regardless of shape. Expectation: **gate
  unblock + verify** (embedded resource root attrs are real columns).
- **java** — the static `@SQLRestriction` can't carry a runtime principal, so
  the embedded read needs the SpEL-principal clause woven into the scoped
  `findAll`/`findById` overrides, exactly like the relational-principal path.

The same `auth: required` + system `user {}` precondition the relational
principal path enforces applies here (no request principal otherwise).

### Slice B — `document` + principal (node, java) — IN PROGRESS (claim PR open)
A `document` aggregate filters **in-app** over the rehydrated aggregate, so the
principal predicate must be evaluated in-app against the request principal
(`requireCurrentUser()` / the injected accessor), not pushed to SQL. This is the
genuinely new rendering; sequenced after Slice A.

- **Gate:** `supportsPrincipalNonRelationalFilter` (`system-checks.ts`) now also
  accepts `document` for node/java (was `embedded`-only); the `auth: required` +
  `user {}` precondition flows through unchanged.
- **node (DONE):** `repository-document-builder.ts` — `documentCapabilityBody`
  keeps the principal predicate (was dropped); each in-app read site binds
  `const currentUser = requireCurrentUser();` (fail-closed) so the rendered
  `currentUser.tenantId` resolves, and imports the accessor when
  `aggregateUsesPrincipalContextFilter(agg)`. A find with its own `currentUser`
  param reuses it rather than re-binding.
- **java (in flight):** `emit/document-store.ts` — inject the
  `CurrentUserAccessor` bean + bind `var currentUser = currentUserAccessor.user()`
  before the `.stream().filter`, since `renderJavaExpr` emits a bare `currentUser`
  token (unlike the relational/embedded SpEL path).

`elixir` has no `document` shape (`validateSavingShapeSupport` gates it — see
DEBT-07), and `python` doesn't yet wire principal filters at all (out of scope —
its own DEBT-01 follow-up).

## Tests / gates
- One negative→positive validator test per unblocked cell.
- A `*-build` fixture per backend (e.g. `ts-build`, `phoenix-build`,
  `java-build`) carrying an `embedded` aggregate with a tenancy filter, so the
  generated project compiles under the per-backend build gate.
- OpenAPI/wire parity unaffected (read shape unchanged).
