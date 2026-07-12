# `extern` as a domain extension point (not an application-layer injected handler)

> Status: **Decided — implementation phasing D5 (2026-07-12).** Motivated by finding **S10** in
> [`docs/audits/generated-code-ddd-review-2026-07.md`](../audits/generated-code-ddd-review-2026-07.md)
> and a silent-no-op bug on the Elixir backend (below). Reconciles the
> `extern` *operation* escape hatch with the four-layer model in
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
> (`commandHandler` / `queryHandler`, partially landed in #1756 / #1793 / #1830).

## Thesis

The `extern` **operation** is modeled in the wrong layer. It is an
*application-layer injected handler* used to satisfy what is almost always a
*domain-layer* need ("a bit of business logic the DSL can't express"). That
layer mismatch is the root cause of three unrelated-looking defects — one per
backend family — and it is now avoidable, because the recently-landed
`commandHandler` / `queryHandler` layer gives the genuinely-application-layer
case ("talk to an external service") a first-class home.

The fix is not to patch the symptoms. It is to **re-home the `extern`
operation from an external injected handler to a domain-internal extension
point** — a `partial` method (.NET), an overridable hook (TS/Python/Java), a
behaviour callback (Elixir) — that is a *member of the aggregate* and therefore
already inside its encapsulation boundary. The external-service case moves to a
`commandHandler` that injects a domain-service port.

## 0. Premise — everything is in one repo

Loom-generated output, any hand-written extension code, and the consuming app
all live in **one repo that compiles together**. There is no separately-built,
separately-distributed "user project" that the generated code must reach across
a package boundary.

This premise is load-bearing, because almost the entire current `extern`
apparatus exists *only* to bridge that (non-existent) boundary:

| Current machinery | Exists to… | Under one-repo… |
|---|---|---|
| published per-op handler **interface** | be a stable distribution contract | unnecessary — caller and impl compile together |
| DI registry / Scrutor assembly scan | discover an impl in another assembly | unnecessary — the impl is a known repo file |
| dev-stub impl | keep the build alive when the real impl is elsewhere | unnecessary — a missing impl is a **compile error** |
| `[ExternHandler]` marker | tag the impl for the scan | unnecessary |
| **runtime** "Missing `[ExternHandler]`" boot check | fail late when no impl was linked | replaced by a **build-time** error |

So the domain-extension-point model below is not a trade against that
machinery — it is what lets us **delete** it. The extension becomes a
**repo-local, scaffolded-once, user-owned file** that regeneration preserves
(the existing `.loomignore` / user-owned-region mechanic), co-versioned next to
the generated aggregate, and a missing implementation is caught by the same
build that compiles everything else.

## 1. The three current failure modes (with generated-code evidence)

Today the framework owns this flow and hands the user handler the **live
aggregate** to mutate:

```
load aggregate → run preconditions → call user handler → run invariants → save → drain events
```

The *control flow* is fine. The flaw is uniform: **what the handler is
handed** — the raw entity — and it manifests differently per backend.

### 1a. .NET — over-exposes (finding S10)

To let an injected, application-layer handler mutate a domain entity, the
generator widens **every** setter the moment the aggregate has one `extern` op:

```ts
// src/generator/dotnet/emit/entity.ts:216
const hasExtern = operations.some(o => o.extern);
const setterVisibility = hasExtern ? "internal" : "private";   // internal ≡ app-wide in one assembly
```
```ts
// src/generator/typescript/emit/aggregate.ts:392 — Hono, same shape, public setters
if (hasExtern) for (const f of e.fields)
  externMutators.push(`set ${f.name}(v) { this._${f.name} = v; }`);
```

The generated Mediator handler hands over the live entity
(`src/generator/dotnet/cqrs/commands.ts:377`):

```csharp
var aggregate = await _repo.GetByIdForWriteAsync(command.Id, ct) ?? throw …;
aggregate.CheckConfirm(args);                       // preconditions
await _user.HandleAsync(aggregate, request, ct);    // ← live entity, open setters
aggregate.AssertInvariants();                       // invariants re-run (operation path is safe)
await _repo.SaveAsync(aggregate, ct);
```

The operation path re-checks invariants, so a persist-through-the-op is safe.
But the widened setters are **app-wide**: any code, anywhere, can now do
`order.Status = …` skipping the invariant, silently, because one op was
`extern`. The leak is the inevitable cost of giving an *external* holder write
access to the entity.

### 1b. Elixir — silent success-reporting no-op (a real bug)

Elixir has no injected-handler seam at all. An `extern` op emits a context
function that runs the preconditions and then persists an **empty changeset**
— no business logic, no place for the user's code, and it returns **HTTP 204**:

```elixir
# generated for: operation confirm() extern { precondition status == "draft" }
def confirm_order(%Sales.Order{} = record, params) when is_map(params) do
  with :ok <- ensure(is_mutable(record), :precondition_failed),
       :ok <- ensure(record.risk_score < 80, :precondition_failed) do
    record
    |> Ecto.Changeset.change(%{})                    # ← empty: nothing happens
    |> Sales.OrderRepository.persist_change()        # ← persists an unchanged row
  end
end                                                  # ← {:ok, record} → 204
```

Contrast a **non-extern** op (`cancel`, body `status := Cancelled`), which
actually mutates (`%{record | status: :Cancelled}` + `force_change` + persist).
The `extern` op is **not** validator-gated (compiles clean, no
`loom.*-unsupported`), so this is a **silent gap**: the API reports success for
an operation that did nothing. Arguably worse than S10 — on .NET the extern
logic at least runs; on Elixir it silently doesn't, and lies.

Verified by generating `test/fixtures/corpus/extern.ddd` with `platform:
elixir` → `sales.ex` `confirm_order/2` as above.

### 1c. TS / Python / Java — layer conflation (works, but wrong home)

These emit a typed per-op handler interface + a registry and inject the user's
implementation (the same application-layer machinery as .NET, minus the
setter-widening pathology since their entities are more permissive). It works,
but it models "hand-written domain logic" as an injected application-layer
service — the conflation this proposal removes.

## 2. The four-layer model makes the right home obvious

From [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md):

| Layer | Holds | Depends on |
|---|---|---|
| **domain** | aggregate, repository, workflow, value object, enum | nothing |
| **contract** | command, query, response, error | nothing |
| **application** | **`commandHandler` / `queryHandler`** (orchestration) | contract + domain |
| **transport** | routes | contract |

There are two genuinely-different needs currently both spelled `extern`:

- **"Domain logic the DSL can't express"** (compute a risk score with a
  hand-rolled algorithm, apply a bespoke state transition). This is a **domain**
  concern. It belongs *inside* the aggregate.
- **"Talk to an external service"** (billing engine, third-party API, config
  table). This is an **application** concern with an injected dependency. It
  belongs in a `commandHandler` that calls a **domain-service port**.

The current `extern` operation forces the first need through machinery built
for the second — hence the pathologies.

## 3. The proposed model

### 3a. `extern` operation → a domain extension point (a member of the aggregate)

Keep the framework flow (load → preconditions → **hook** → invariants → save →
drain). Change only **what the hook is**: not an external holder of the entity,
but a method *the aggregate owns*, so it reaches its own private state
natively. No setter widening. Per-backend idiom:

| Backend | Idiom |
|---|---|
| **.NET** | `sealed partial class Order`; the op body calls `partial void ConfirmCore(…)`; the user implements it in their own partial-class file. A partial method is a **member of `Order`** → full private access, no widening. (net10 / C# ≥ 13 supports partial methods with return types + accessibility.) |
| **Java** | aggregate class is `abstract` (or exposes a `protected` hook); the user writes a hand-written subclass overriding `protected void confirmCore(…)`. No package-wide setter leak. |
| **TS (Hono)** | the aggregate calls a `protected`/`#private`-adjacent hook the user supplies via a companion partial (subclass or a bound method), keeping fields `#private`. |
| **Python** | an overridable method on the aggregate (subclass / mixin the generated factory instantiates); fields stay name-mangled. |
| **Elixir** | a **behaviour**: generated `@callback confirm(Order.t(), map()) :: {:ok, Order.t()} \| {:error, term}`; the context delegates to a user callback module (config-resolved, or `defoverridable`). **This gives Elixir a real seam and fixes 1b.** |

`.NET` before → after (illustrative):

```csharp
// generated Order.cs — sealed PARTIAL, setters stay private
public sealed partial class Order {
    public OrderStatus Status { get; private set; }
    public void Confirm(/*…*/) { CheckConfirm(/*…*/); ConfirmCore(/*…*/); AssertInvariants(); }
    partial void ConfirmCore(/*…*/);                 // extension point
}
// user Order.Confirm.cs — a MEMBER of Order → private access, no widening
public sealed partial class Order {
    partial void ConfirmCore(/*…*/) { Status = OrderStatus.Confirmed; RaiseEvent(new OrderConfirmed(Id, …)); }
}
```

Elixir before (§1b) → after:

```elixir
# generated: a behaviour + delegation (real seam, not an empty changeset)
defmodule Sales.Order.Extern do
  @callback confirm(Sales.Order.t(), map()) :: {:ok, Sales.Order.t()} | {:error, term}
end
def confirm_order(%Sales.Order{} = record, params) do
  with :ok <- ensure(is_mutable(record), :precondition_failed),
       {:ok, record} <- Sales.Order.ExternImpl.confirm(record, params) do   # ← user module
    record |> Ecto.Changeset.change(Map.from_struct(record)) |> OrderRepository.persist_change()
  end
end
```

### 3b. "External service" → a `commandHandler` + domain-service port

The genuinely-application-layer case does not touch entity internals at all —
it orchestrates, calling a domain-service port that an infra adapter
implements. This is exactly Layer 3 and needs no new mechanism.

### 3c. Invariants still re-run

Unchanged: after the hook mutates, the framework re-asserts invariants and only
then saves. The extension point is *not* trusted to preserve invariants — it is
trusted only to make a decision; the aggregate's own guard still fires. (What
changes is that the guard can no longer be *bypassed from outside* the op.)

## 4. Migration / breaking change

Under the one-repo premise (§0) there is **no external contract to preserve**,
so the migration is mechanical: inline the existing handler body into the
co-located extension file and delete the bridging apparatus.

- **.NET** `[ExternHandler]` classes implementing `I<Op><Agg>Handler` → the body
  moves into a `partial void <Op>Core(…)` in a co-located partial file; the
  Scrutor scan, `ExternHandlerException`, dev-stub, and boot-time "Missing
  [ExternHandler]" check are **deleted**, and a missing impl becomes a compile
  error.
- **TS / Python / Java** per-op handler interfaces + registries → an overridable
  aggregate hook; the registry/marker plumbing is deleted.
- **Elixir** — net-new seam (was a silent no-op), so purely *additive*.

Because everything compiles together, the change can land as a single
regenerate: the first generation scaffolds the extension file (user-owned
thereafter), and the old registry files simply stop being emitted. A
deprecation window is optional, not required — there is no downstream package
depending on the old interface. The genuinely-external-service users move to a
`commandHandler` — a doc + example.

## 5. Decisions (settled 2026-07-12)

- **D1 — keyword.** Keep `extern`; its meaning narrows to "the op body is a
  hand-written domain hook, co-located and owned by the aggregate." The
  external-service case is a `commandHandler` + domain-service port, not
  `extern`. No new syntax.
- **D2 — hook signature.** Mirrors the operation's signature: domain-typed
  params in, the op's declared return type out (void / exception-less union).
  Runs post-precondition / pre-invariant; may mutate state and `emit`; the
  framework re-asserts invariants after. It is the op body, hand-written.
- **D3 — Elixir.** A generated default + co-located user override
  (`defoverridable`-style, delegating to a user-owned module scaffolded once).
  The default **fails loudly** (`raise "extern <op> not implemented"`), never
  the current silent empty-changeset 204. Exact override idiom fixed in the
  implementation design-review; the invariant is loud + co-located + user-owned.
- **D4 — per-backend consistency.** One uniform intent (hook owned by the
  aggregate, filled by a co-located user file that regeneration preserves), five
  idiomatic mechanisms (.NET `partial`, Java `protected` override, TS/Python
  overridable method, Elixir override).
- **D5 — scope & phasing.** No grammar/IR change (`extern` already parses; the
  op carries `extern: true`). Work is per-backend **emission** + deleting the
  injected-handler machinery. Five independent generator slices, phased by
  value: (1) Elixir (correctness) → (2) .NET (S10) → (3) TS → (4) Python →
  (5) Java. External-service migration = docs + example.

### Residual mechanism questions (finalized in each slice's design-review, not blockers)

These are *mechanism* details under the settled decisions above — each fixed
when its backend slice is built, not gating the direction:

- **Elixir override idiom** (D3) — ✅ **resolved in Slice 1.** A generated
  `@behaviour` module (`<Ctx>.<Agg>Extern`, one `@callback` per extern op,
  regenerated each run) + a **scaffold-once** user-owned impl module
  (`<Ctx>.<Agg>ExternImpl`, `@behaviour` + `@impl` stubs that `raise`). The
  context delegates the op to the impl and persists the returned struct's scalar
  columns via `force_change`. Loud both ways: a missing *implementation* is a
  runtime 500 (the `raise`), and a *newly-added* extern op is a
  `mix compile --warnings-as-errors` failure (unimplemented behaviour callback).
  See `docs/extern.md` → *Elixir/Phoenix*.

  **Regeneration-preservation mechanic (Slice 1 owns it for slices 2–5).** The
  generator had no write-if-absent seam — only `.loomignore` (manual, and it
  would block first-gen scaffolding). Slice 1 adds `src/util/scaffold-once.ts`:
  a `loom:scaffold-once` marker in a file's first-line comment tells the CLI
  writer to KEEP the on-disk copy when the file already exists (writing it only
  on first `generate`; reported as `preserved (scaffold-once): N`). It travels
  **in-band** in the file content — no `PlatformSurface.emitProject` signature
  change — so each later slice opts its user-owned extern file (a .NET partial
  file, a TS/Python/Java hook module) into preservation by emitting one comment
  line and reusing `isScaffoldOnce`.
- **.NET unimplemented-partial semantics** — a `partial void` left unimplemented
  compiles to a no-op; if the hook must be implemented, use a partial method
  *with a return* (C# ≥ 9 / net10) so omission is a compile error, or a
  `protected abstract`-style shape. Pick the one that makes "forgot to
  implement" a build error, per the one-repo premise (§0).
- **TS / Python hook shape** — subclass-override vs an assigned bound method vs a
  mixin the factory composes; whichever keeps fields private and the extension
  file user-owned across regen.
- **`emit` inside the hook** — confirm the hook uses the same `emit`/event-raise
  path a normal op body uses on each backend (D2 says yes).

## Relationship to other work

- **S10** (`docs/audits/generated-code-ddd-review-2026-07.md`) — this proposal
  is the principled resolution; the setter-visibility patch / scoped-facade were
  narrower alternatives that treat the symptom.
- **`unfoldable-api-derivation.md`** — the `commandHandler` layer this leans on.
- **Elixir silent no-op** — folded in as a correctness fix (§1b, §3a).
