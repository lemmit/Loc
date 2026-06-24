# Blazor Server — a server-rendered .NET frontend

> Status: **PROPOSED.** Nothing here is implemented. This note scopes a
> Blazor Server frontend target for the .NET platform and — more
> importantly — identifies the **enabling refactors** that should land
> *first*, so Blazor is "Angular spelled in C#" (a `WalkerTarget` on the
> shared `walkBody` engine) rather than a second forked walker. Sibling of
> [`angular-frontend.md`](./angular-frontend.md) (the closest structural
> precedent — a non-JSX target on the shared engine) and
> [`htmx-server-rendered-frontend.md`](./htmx-server-rendered-frontend.md)
> (which explicitly defers .NET to Blazor: "redundant — richer, expected").

## TL;DR

1. **Blazor's *wiring* is `phoenixLiveView`** — a server-rendered, stateful
   UI mounted *by the backend process* (the .NET app), no SPA build, no
   Vite. The platform contract already models this (`elixir` is
   `isFrontend:false, needsDb:true, mountsUi:true` with
   `hostableFrameworks: {phoenixLiveView,…}`). Blazor = "`dotnet` gains a
   server-render framework the way `elixir` hosts LiveView."

2. **Blazor's *topology* is Angular, not HEEx.** `@if{}` / `@foreach{}`
   are control-flow blocks (Angular `@if`/`@for`); state writes are
   in-place `f = v` (not Elixir's immutable pipe-thread); event handlers
   are inline lambdas / method refs (not hoisted `handle_event/3`
   clauses). The HEEx fork was forced by Elixir being **functional** —
   none of those forces act on Blazor.

3. **The only thing Blazor doesn't share with the four JS frontends is
   that its binding expressions are C#, not JS.** Remove that one
   obstacle — by routing the body-walker's leaf expression emission
   through the `ExprTarget` the .NET backend already owns (`CS_TARGET`) —
   and Blazor rides the shared `walkBody` like Angular. **That refactor is
   the whole game.** Without it Blazor needs a duplicated C# expression
   renderer inside the frontend layer; with it, ~zero new expression code.

## 1. Where Blazor sits

| Axis | HEEx / LiveView (forked engine) | **Blazor Server** | Angular (shared `walkBody`) |
|---|---|---|---|
| Hosted by | the elixir backend process | the **dotnet** backend process | separate SPA bundle |
| Control flow | `<% if/for %>` template blocks | `@if{}` / `@foreach{}` blocks | `@if{}` / `@for{}` blocks |
| State write | `\|> assign(:f, v)` (immutable thread) | `f = v` in-place | `f.set(v)` in-place |
| Event handler | **hoisted** `handle_event/3` | inline `@onclick="() => …"` / method | inline `(click)="…"` statement |
| Iteration | for-comprehension (functional) | `@foreach` (imperative) | `@for` |
| Binding expr language | Elixir | **C#** | TypeScript |
| Data fetch | inline `create_x!(args)` | `await Mediator.Send(…)` in lifecycle | `toSignal(httpClient…)` |

Wiring follows the LiveView precedent exactly; the *engine* follows
Angular. The single cross-cutting novelty (row 6) is the expression
language, and the genuinely-new seam (row 7) is in-process async fetch.

## 2. The enabling refactors (land these first)

### R1 — Make `walkBody`'s expression rendering pluggable via `ExprTarget` (the linchpin)

Today the shared body-walker carries a **private, hardcoded-JS** expression
renderer: `emitExpr` in `src/generator/_walker/walker-core.ts` (the 17-arm
switch ~lines 1170–1386) emits `===`, `.map`, JS literals, camelCase
members. All four shared-walker frontends (React/Vue/Svelte/Angular) ride
it because they're all JS/TS.

Meanwhile the **five backends** already share `renderExprWith(e, target,
ctx)` + the `ExprTarget` contract (`src/generator/_expr/target.ts`, shipped
— see [`render-expr-target-unification.md`](./render-expr-target-unification.md)),
and the .NET backend's `CS_TARGET` (`src/generator/dotnet/render-expr.ts`)
already emits exactly the C# Blazor needs (`==`, LINQ `.Where`, PascalCase
members, `m`/`L` literal suffixes, money-as-native-decimal).

These are two disconnected expression worlds. **R1 extends the shipped
`ExprTarget` unification down into the walker:** route the plain leaf arms
(`literal` / `binary` / `member` / `method-call`→collection-op / `ternary`
/ `convert` / `list`) through an injected `ExprTarget` on `WalkContext`,
while the walker keeps its frontend-only wrapper concerns layered on top —
api-hook detection (`tryDetectApiHook`), state-ref read/write, store-field
ref, and lambda-param name mapping. None of those touch the leaf table.

- JS frontends inject a JS leaf table = the current `emitExpr` behavior,
  gated **byte-identical** for every `examples/*.ddd` × {react, vue,
  svelte, angular} (the pattern that guarded the `WalkerTarget` slices
  #607–#627 and the backend `ExprTarget` extraction #843).
- Blazor injects `CS_TARGET` and gets correct C# for free.

This is the same "emitters, not name resolution" payoff `CLAUDE.md` cites
for the resolved IR, pushed one layer further: a C#-expression frontend
becomes a *leaf table*, not a re-derivation of the walker's dispatch.

**Sub-point — statements (`StmtTarget`, scoped small).** Event-handler
bodies (state writes, api calls, `let`) flow through the walker's *JS*
statement emitter (`stmtToJs` ~line 1407+). The .NET backend has
`renderCsStatements` (`render-stmt.ts`). The `ExprTarget` proposal
explicitly left a `StmtTarget` as an open question (its §8); Blazor makes
it concrete but the walker-side surface is tiny (state-write, `let`,
expr-stmt, api-call) — a thin injected hook, **not** a full extraction.
Flag it; do not over-build it.

### R2 — Generalize "a backend hosts a server-render framework" beyond the Phoenix special-case

Mirror the `phoenixLiveView` threading, but first audit the elixir/LiveView
wiring for `is-elixir` / `is-phoenix` booleans that should become
framework-keyed before adding the second instance:

- **Grammar** — add the `blazorServer` framework keyword (the `Platform` /
  framework surface in `src/language/ddd.langium`); the platform stays
  `dotnet`.
- **Platform** — add `blazorServer` to `dotnet`'s `hostableFrameworks`
  (`src/platform/dotnet.ts`); today it hosts only `STATIC_BUNDLE_FRAMEWORKS`
  (the embedded-SPA `ClientApp/` path).
- **Validator** — `checkDeployable` framework-hostability (rule 13b) and
  design-pack-format (rule 14) in `src/language/validators/deployable.ts`.
- **Pack format** — a `razor` format alongside `heex` in
  `src/util/builtin-formats.ts`.

The refactor value is making these two rows in one table (`dotnet` +
`blazorServer`, `elixir` + `phoenixLiveView`), not a phoenix special-case
plus a blazor special-case.

### R3 — Separate the server-rendered design-pack + shared-frontend pieces from the JS-only ones

`ashPhoenix` is `format: heex`, no Vite/stack (the host owns the build); a
Blazor pack (`format: razor`) is the same category. In
`src/generator/_frontend/`: `zod-schemas` and the api-hook layer are
JS/SPA-specific (Blazor calls in-process `IMediator.Send`, no zod), but
**menu derivation** (`menu-emitter.ts`, pure data) and the **Playwright
smoke spec / page objects** are framework-neutral and reusable. R3 confirms
those are cleanly separable so Blazor reuses the menu + e2e pieces without
dragging in the JS-only ones.

## 3. The one genuinely-new seam (implementation, not refactor)

**In-process data fetch.** Blazor Server loads via injected `ISender`,
awaited in `OnInitializedAsync`, results held in a `@code` field — the
analogue of Angular's `toSignal` hooks but `await`-based and hoisting into
a lifecycle method. This is the Blazor implementation of the
`buildHookUse` / `renderApiCall` / `renderApiHoisting` triple. It reuses
the existing CQRS handlers/DTOs the .NET backend already emits (no new
backend code; the UI calls the domain in-process, never reimplements it).

## 4. Fork vs share — the decision, pinned

**SHARE `walkBody` as an Angular-shaped `WalkerTarget` (`BLAZOR_TARGET`),
contingent on R1. Do NOT fork like HEEx.**

Rationale: HEEx forked (`src/generator/elixir/heex-walker-core.ts`) because
Elixir's *functional* topology diverges structurally — immutable socket
pipe-threading, hoisted `handle_event/3` clauses, for-comprehensions,
`cond do`/`if do` template blocks. Blazor is **imperative/OO** exactly like
Angular's component class: in-place field mutation, block `@if`/`@foreach`,
inline event lambdas. Every one of those maps onto a `WalkerTarget` seam
Angular already exercises (`renderConditionalChild` / `renderForEach` /
`renderEventHandler`-as-statement / `renderStateWrite`-as-assignment). The
*only* divergence from the four JS frontends is the expression language,
which R1 removes. With R1, forking would duplicate the entire engine for
**zero topology gain**.

## 5. Worked example

### `.ddd` (page DSL, unchanged surface)

```ddd
ui Admin {
  framework: blazorServer
  page Orders {
    List orders {
      column "Name" => o.name
      onRowClick row => navigate(OrderDetail, row.id)
    }
  }
}

deployable app {
  platform: dotnet
  serves: OrdersApi
  ui: Admin            // dotnet mounts the Blazor UI in-process
  design: blazor@v1
}
```

### Generated `Orders.razor` (target output)

```razor
@page "/orders"
@inject MediatR.ISender Mediator
@inject NavigationManager Nav

<h1>Orders</h1>
@if (orders is null)
{
    <p>Loading…</p>
}
else
{
    <table class="table">
        <thead><tr><th>Name</th></tr></thead>
        <tbody>
            @foreach (var o in orders)
            {
                <tr @onclick="() => Nav.NavigateTo($\"/orders/{o.Id}\")">
                    <td>@o.Name</td>
                </tr>
            }
        </tbody>
    </table>
}

@code {
    private IReadOnlyList<OrderResponse>? orders;

    protected override async Task OnInitializedAsync()
    {
        orders = await Mediator.Send(new FindOrders());
    }
}
```

Note what is reused, not rewritten: `o.Name` (PascalCase member), the
`FindOrders` query + `OrderResponse` DTO, and the `==`/literal idioms all
come straight from `CS_TARGET` and the existing .NET backend emitters via
R1. The walker contributes the page structure; the `WalkerTarget`
contributes the Razor seams (interpolation `@expr`, `@if`/`@foreach`
blocks, `@onclick`, the lifecycle-hoisted fetch).

## 6. Sequencing

1. **R1** — `ExprTarget` into `walkBody`, byte-identical gate on the four
   JS frontends. *Unlocks everything; valuable on its own (one expression
   dispatch instead of two worlds).*
2. **R2** — platform/framework wiring (additive, framework-keyed).
3. **R3** — pack-format `razor` + `_frontend` JS-only separation.
4. **Implement Blazor** — `BLAZOR_TARGET: WalkerTarget` (Angular-cloned
   seams, C# leaf via `CS_TARGET`) + the `await`-based data-fetch seam +
   `designs/blazor/v1` razor pack + a `generated-blazor-build` CI gate
   (`dotnet build /warnaserror` against the emitted project, mirroring
   `dotnet-build.yml`).

R1 is independently mergeable and independently valuable, so it is the
right first PR even if Blazor itself slips.

## 7. Open questions

- **R1 leaf boundary.** The frontend `emitExpr` does more than the backend
  `ExprTarget` (api-hook detection, state/store refs, lambda-param JS-name
  map). Confirm the clean cut is "wrapper concerns stay in the walker, the
  17 leaf arms go behind `ExprTarget`" — and that the JS leaf table
  reproduces today's output byte-for-byte before any C# table is wired.
- **`StmtTarget` size.** Is the walker-side statement surface really just
  {state-write, `let`, expr-stmt, api-call}, or do match/conditional
  children drag more in? Settle during R1's sub-point.
- **Pack realism.** Blazor packs render Razor markup, not TSX strings —
  does the design-pack loader's required-emit set need a `razor`-format
  variant, and does the existing Handlebars pack layer suit Razor (which
  has its own `@`-sigil that collides with nothing in Handlebars `{{ }}`,
  so likely fine)?
- **Auth UI-gate parity.** Like Angular, Blazor should inherit
  action-button gating through the shared walker for free; the page
  `requires` / nav-link-hiding wave is a parity tail, not a blocker.
- **Interactivity mode.** Target Blazor Server (SignalR circuit,
  stateful — the LiveView analogue) for v1; Blazor WebAssembly / the .NET 8
  unified render modes are a later axis, not v1 scope.
