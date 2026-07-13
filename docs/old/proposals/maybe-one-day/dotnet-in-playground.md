# .NET in the playground — running the generated .NET backend in the browser

> **Most probably won't do.** Captured architecture conversation, filed
> so the path is recoverable if the question comes up again.

## Problem

Today the playground (`web/`) generates a multi-deployable system from a
`.ddd` source, but only one backend variant actually *runs* in the
browser — the Hono (TypeScript) one. The .NET backend is exercised in
CI (`dotnet-build.yml`, `dotnet-obs-e2e.yml`) but the playground can't
boot it interactively. So a user pasting a `.ddd` source sees real
end-to-end behaviour for one of four supported backends. The other
three (`dotnet`, `phoenix`, and any future addition) are inert in the
demo.

This is fine for now — one runnable variant is enough to demonstrate
the wire shape. But "could the .NET output also run in the playground?"
is a fair question, and the answer is more interesting than it sounds.

## How the existing Hono runner works (so the .NET equivalent has a baseline)

The playground's runtime sits in a long-lived Web Worker. Boot
sequence:

1. **Pre-load PGlite WASM artefacts** — `pglite.wasm`, `initdb.wasm`,
   `pglite.data` (`runtime.worker.ts:117-148`). Cached at module scope
   for subsequent boots.
2. **Construct PGlite** with a data dir (`:memory:` or
   `opfs-ahp://loom-<source-hash>` for per-source OPFS persistence).
   Pre-loaded artefacts are passed in via the
   `{ pgliteWasmModule, initdbWasmModule, fsBundle }` escape hatch so
   PGlite skips its URL-based loading (which breaks under the `blob:`
   URL the worker bundle is loaded from).
3. **Apply the DDL** synthesised by `runtime/ddl.ts` from
   `wireShape` — this is the in-browser equivalent of EF/Drizzle
   migrations.
4. **`import()` the generated Hono bundle** as a blob URL. The bundle
   exports `createApp(db)`, `schema`, `drizzle`, `PGlite`.
5. **Wire it up:** `db = mod.drizzle(pglite, { schema })`,
   `app = mod.createApp(db)`.
6. **Dispatch:** each RPC serialises a `Request` into a typed
   envelope, the worker reconstructs it, calls `app.fetch(req)`,
   serialises the `Response` back, and returns to the page.

The thing that makes this work is the **Drizzle PGlite adapter** —
Drizzle ships a driver that translates Drizzle queries into in-process
`pglite.query(sql, params)` calls. **No socket. No Postgres wire
protocol. No `pg` client.** Function calls all the way down.

That's the missing piece for .NET: there's no equivalent of "Drizzle's
PGlite adapter" for EF Core or Npgsql.

## Why ASP.NET Core doesn't simply port

Four independent obstacles. They compose; addressing one doesn't help
with the others.

### 1. There's no `browser-wasm` runtime pack for `Microsoft.AspNetCore.App`

You can't reference the ASP.NET Core framework from a `browser-wasm`
project at all. This isn't a packaging oversight — it reflects the
fact that the framework's hosting model assumes a real server process.

### 2. Kestrel can't listen on a port

ASP.NET Core's standard host model expects a web server that listens on
a TCP socket and feeds requests into the middleware pipeline. Browsers
don't expose listener sockets. Even Web Workers can't `bind()` and
`accept()`.

### 3. Npgsql needs `System.Net.Sockets`, which `browser-wasm` doesn't provide

Even setting hosting aside, `Npgsql` is built around
`System.Net.Sockets.Socket` speaking the Postgres wire protocol.
`browser-wasm` doesn't expose `System.Net.Sockets` (browsers give you
`fetch` and `WebSocket`, no raw TCP). So `new
NpgsqlConnection("Host=…")` throws before it can connect to anything.

### 4. PGlite isn't a server

Even if (3) were solved, **PGlite isn't a Postgres server.** It's
PostgreSQL compiled to WebAssembly and exposed as a **JS library**:
`new PGlite()` gives you an object with `.query(sql, params)` and
`.exec(sql)`. There's no listener, no port, no startup-message
handshake. So there's nothing on the other end of the wire even if
`.NET` could open a socket.

### What this rules out

The naive read — *"PostgreSQL runs in WASM and EF Core can connect to
PostgreSQL, so EF Core + Npgsql + PGlite should just work"* — is wrong
at every layer above the actual SQL engine. PGlite is real Postgres at
the parser/planner/executor level; everything around it that .NET
expects to find (TCP, wire protocol, host process) is missing.

## What works in the browser today

Counterbalancing the obstacles, several things *do* work:

- **Blazor WebAssembly** runs .NET assemblies in the browser, on a mono
  interpreter by default (AOT is opt-in). This includes `System.*`,
  `Microsoft.Extensions.DependencyInjection`,
  `Microsoft.Extensions.Logging`, `Microsoft.Extensions.Configuration`,
  `System.Text.Json`, and the full reflection surface (under
  interpreter mode).
- **Roslyn compiles in the browser** (proven by DotNetLab — a public
  Blazor-hosted C# + Razor compiler playground).
- **`Dapper`** runs unmodified on Blazor WASM in interpreter mode. It
  uses `System.Reflection.Emit` for its compiled mappers, which works
  on the interpreter but breaks under full AOT.
- **JSInterop** lets .NET code call JS functions and vice versa, with
  `System.Text.Json`-based marshalling at the boundary.

These together mean the *runtime* side is solved — what's missing is
the plumbing between them: how .NET reaches PGlite, and how the React
UI in the playground reaches the .NET handlers.

## The two-piece bridge

### Piece A — PGlite as `IDbConnection`

The right way to bridge .NET to PGlite is to write a small custom
`DbConnection` subclass that routes ADO.NET operations through
JSInterop to `pglite.query`. The shape:

```csharp
class PgliteConnection : DbConnection {
    // Open/Close/State machine. CreateCommand returns PgliteCommand.
}

class PgliteCommand : DbCommand {
    protected override DbDataReader ExecuteDbDataReader(CommandBehavior _) {
        var rows = JS.InvokeAsync<JsonElement>(
            "pglite.query", CommandText, ParamArray()).Result;
        return new PgliteDataReader(rows);
    }
    public override int ExecuteNonQuery() { /* same, return affectedRows */ }
}

class PgliteDataReader : DbDataReader {
    // Read(), GetValue(i), GetName(i), FieldCount, GetFieldType(i).
}
```

This is the *whole* bridge — perhaps 500 lines. **Real, unmodified
Dapper from NuGet** then works against it via the `IDbConnection`
extension methods. No Npgsql, no wire protocol, no sockets, no shim
of Dapper itself.

EF Core would also work over this bridge, in principle — by
implementing a `DbProvider` over `PgliteConnection`. That's option (b)
in the analysis below. The Dapper path is option (c): cheaper, less
authentic to the production output, but workable for a playground.

**This piece is open-sourceable** as a standalone NuGet
(`Pglite.Data` or similar) regardless of whether the rest of the
playground story ships. It solves a googleable problem ("how do I use
Postgres in Blazor WASM?") that currently has no good answer.
Candidate homes: a Loom-org repo, or offered to the ElectricSQL
(PGlite) team as a sibling to their JS bindings.

### Piece B — request dispatch into .NET

The React UI in the playground today sends serialised HTTP requests
across the worker boundary to `app.fetch` on the Hono side. For the
.NET variant the equivalent is a `[JSInvokable]` entrypoint:

```csharp
[JSInvokable("Dispatch")]
public static async Task<string> Dispatch(
    string method,
    string path,
    string? body,        // already a JSON string when present
    string headersJson)
{
    var resp = await _router.RouteAsync(method, path, body, headersJson);
    return JsonSerializer.Serialize(resp, LoomJson.Default.SerializedResponse);
}
```

The boundary uses **strings + primitives**, matching the existing Hono
protocol in `web/src/runtime/protocol.ts` exactly. Don't take Blazor
JSInterop's "you can pass typed objects" shortcut — having two
serialisation regimes (one at the JSInterop boundary, another for
handler parameter binding) is a parity-bug magnet.

Inside `Dispatch`, a small **router** does the work the Microsoft
Minimal API stack does on the server:

1. Match `(method, path)` against a registered route table. Pattern
   matching with `{param}` segments, ~80 lines.
2. Bind handler parameters from route values, query string, body, and
   DI. Look at `MethodInfo.GetParameters()`, match by name against
   the request, convert via `TypeDescriptor.GetConverter` for primitives
   or `JsonSerializer.Deserialize` for body parameters. ~150 lines.
3. Invoke the handler, handle the return value (`IResult`, `Task<T>`,
   bare value, `void`). ~50 lines.
4. Serialise the response. JSON if it's a value, status+headers if it
   came back via `IResult`. ~30 lines.

This is **not a Minimal API shim** — it's a tiny dispatcher that
happens to do a similar job. The generated source registers routes by
calling it directly (see "two layers" below).

## What gets emitted

Loom adds a `dotnet-browser` `PlatformSurface` (`src/platform/`)
sibling to the existing `dotnet` one. ~90% of the emit code is shared
— handlers, repositories, DTOs, Mediator wiring are identical to the
production `dotnet` variant. Three things differ:

### 1. `Program.cs` / DI registration

Production:
```csharp
builder.Services.AddDbContext<AppDb>(o => o.UseNpgsql(connStr));
```

Browser:
```csharp
builder.Services.AddSingleton<IDbConnection>(_ => new PgliteConnection());
```

### 2. Data access

Production: EF Core `DbContext` + `LINQ-to-SQL`.

Browser: Dapper repository methods over `IDbConnection`. Same
repository *interface*; different *implementation*.

The repository interfaces are part of the IR — only the bodies change.

### 3. JSON serialisation: source-gen, explicit names

Both variants should emit DTOs with explicit `[JsonPropertyName("…")]`
sourced from `wireShape`, and a source-generated `JsonSerializerContext`
listing every wire-shaped type:

```csharp
[JsonSourceGenerationOptions(
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(CreateOrder))]
[JsonSerializable(typeof(OrderDto))]
[JsonSerializable(typeof(OrderDto[]))]
[JsonSerializable(typeof(ProblemDetails))]
// …mechanically, one line per wire-shaped type
public partial class LoomJson : JsonSerializerContext { }
```

Reasons:

- **AOT-safe / trim-safe.** Reflection-based `System.Text.Json` works
  on the interpreter but breaks under AOT and bites under trimming.
- **Explicit beats convention** for wire parity. Naming-policy magic
  (`JsonNamingPolicy.CamelCase`) has edge cases on acronyms; explicit
  `[JsonPropertyName]` driven by `wire-spec.json` survives them.
- **Compile-time error** if a DTO is missing from the context.

The `wire-spec.json` (built by `src/system/wire-spec.ts`) is the
shared source of truth for `[JsonPropertyName]` placement here, Zod
schemas in Hono, and typespecs in Phoenix. Cross-backend parity is
gated by `conformance-parity.yml`.

### Project file differences

```xml
<!-- Production dotnet -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Npgsql" Version="…" />
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="…" />
    <PackageReference Include="Dapper" Version="…" />
  </ItemGroup>
</Project>
```

```xml
<!-- dotnet-browser -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <RuntimeIdentifier>browser-wasm</RuntimeIdentifier>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Loom.Browser.Runtime" Version="…" />
    <PackageReference Include="Dapper" Version="…" />
  </ItemGroup>
</Project>
```

Three structural differences:
1. SDK (`Microsoft.NET.Sdk.Web` → `Microsoft.NET.Sdk.BlazorWebAssembly`).
2. No `Microsoft.AspNetCore.App` framework ref — there's no
   `browser-wasm` runtime pack for it.
3. `Npgsql` + `Microsoft.EntityFrameworkCore` → `Loom.Browser.Runtime`
   (the PGlite connection + dispatcher + router live there).

`Microsoft.Extensions.*` (`DependencyInjection`, `Logging`,
`Configuration`) are normal NuGet packages that work fine on
`browser-wasm` — DI / logging / config code survives untouched.

## Two layers, decoupled — the Minimal API question

The dispatcher (above) is the **runtime**. Whether the *registration
syntax* in the generated `Program.cs` looks like real Minimal API is
a separate, optional layer.

### Phase A — attribute-style registration (smaller, lands first)

```csharp
router.Add("GET",  "/orders/{id}", (Guid id, IOrderRepo r) => r.FindAsync(id));
router.Add("POST", "/orders",      (CreateOrder c, IMediator m) => m.Send(c));
```

That's ~100 lines of router runtime + the parameter binder.
Functionally complete. Generated source obviously diverges from the
production `dotnet` variant on the registration calls. Everything
else — handlers, DTOs, repos — is identical.

### Phase B — Minimal API sugar (optional, additive)

A thin shim package layered on top:

```csharp
namespace Loom.Browser.Hosting;

public sealed class WebApplication { internal Router Router { get; } /*…*/ }

public static class EndpointRouteBuilderExtensions {
    public static RouteHandlerBuilder MapGet(this WebApplication app, string pattern, Delegate handler) {
        app.Router.Add("GET", pattern, handler);
        return new RouteHandlerBuilder(/*…*/);
    }
}

public static class Results {
    public static IResult Ok(object? v) => new JsonResult(200, v);
    public static IResult NotFound() => new StatusResult(404);
    public static IResult Created(string uri, object? v) => new CreatedResult(uri, v);
}
```

Combined with a per-variant `GlobalUsings.cs`:

```csharp
// dotnet-browser variant
global using Loom.Browser.Hosting;
global using WebApplication = Loom.Browser.Hosting.WebApplication;
global using Results        = Loom.Browser.Hosting.Results;
global using IResult        = Loom.Browser.Hosting.IResult;
```

```csharp
// production dotnet variant
global using Microsoft.AspNetCore.Builder;
global using Microsoft.AspNetCore.Http;
```

…makes this `Program.cs` **byte-identical across both variants**:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<IOrderRepository, OrderRepository>();
var app = builder.Build();

app.MapGet("/orders/{id}",
    async (Guid id, IOrderRepository repo) => await repo.FindAsync(id));
app.MapPost("/orders",
    async (CreateOrder cmd, IMediator m) =>
        Results.Created($"/orders/{cmd.Id}", await m.Send(cmd)));

app.Run();
```

Only the `.csproj` and `GlobalUsings.cs` differ. The diff between
the two project trees is small and concentrated, not sprinkled
through every handler.

### The argument for and against Phase B

**For:** Source identity. Reviewers and learners reading the
playground output see code that reads like real ASP.NET Core Minimal
API — including registration. The conformance story extends from
"the wire shape is identical" to "the generated source is nearly
byte-identical across backends." That's a meaningful product
property.

**Against:** Maintenance treadmill. Every .NET release adds Minimal
API features (`WithName`, `WithOpenApi`, route groups, filters,
keyed services, problem-details defaults, `[FromKeyedServices]`).
Loom would either chase the surface forever or freeze on a subset
that drifts further from real Microsoft surface with each release.

**Recommendation:** Phase A first; defer Phase B until the playground
exists and the asymmetry is measured against real reader friction.
The runtime doesn't change between phases — Phase B is pure surface
sugar over Phase A's router.

## Two genuine paths — and which one this proposal recommends depends on what the playground is *for*

There are two architecturally honest answers, and the choice between
them depends on a framing question about what the playground is
*for*.

### Framing A — the playground is a faithful preview of the production multi-deployable system

If the playground's job is to show a user the same architecture Loom
emits in production — backend + UI talking via a real wire contract,
all four backends interchangeable behind it — then the wire boundary
inside the browser is **load-bearing.** Erasing it for one variant
quietly turns the demo into something different from what the
generator produces.

In this framing the recommended path is the middle ground:
**Blazor WASM as the runtime substrate, with `[JSInvokable] Dispatch`
as the wire entrypoint, React UI unchanged.** Blazor is reduced from
a UI framework to "the way to run .NET in the browser"; the React
side talks to it exactly the way it talks to Hono today. This is
what the phased plan below builds.

### Framing B — the playground is a teaching/exploration tool

If the playground's job is just to demonstrate that the DSL produces
runnable code in each target language — see your `.ddd` come alive,
inspect what the .NET handlers look like, click around — then the
wire boundary is **not** load-bearing. The CI gates
(`conformance-parity.yml`, the per-backend build workflows) already
prove cross-backend parity; the playground doesn't have to
re-demonstrate it for human eyes.

In this framing the recommended path is **Blazor WASM end-to-end:**
the UI is Blazor components, handlers are injected services,
component code calls them directly. No dispatcher, no router, no
shim. Much cheaper to ship. See [Alternative plan: minimal
possible dotnet playground setup](#alternative-plan-minimal-possible-dotnet-playground-setup)
below for the full sketch.

### Which framing is right for Loom?

The proposal author's read (from `CLAUDE.md`'s emphasis on
conformance, wire-spec, parity tests, and the production
multi-deployable Docker compose model) is that Loom leans toward
framing A. But this is a real product decision, not a technical one
— if Loom's product owner reframes the playground as primarily a
teaching surface, framing B becomes the better engineering
trade-off, and the difference in cost is large (months vs weeks).

**The phased plan below targets framing A. The alternative plan
targets framing B. Pick one before starting.**

## What this would cost — phased

### Phase 1: spike (~2 days)

1. Blazor WASM page in a worker that boots and reports "hello".
2. Exposes `pglite.query` to the page via `IJSRuntime`.
3. Round-trips one `SELECT 1` end-to-end.
4. Round-trips a `Dapper.Query<Foo>` against a hand-written table.

If this passes, the architecture is real. If it doesn't, you've spent
two days and learned something concrete (likely about
`Reflection.Emit` under whatever build mode, or about JSInterop
serialisation of result rows).

### Phase 2: Pglite.Data + router (~1 week)

1. Polish `PgliteConnection` / `PgliteCommand` / `PgliteDataReader`.
2. Router with route table + parameter binder + `IResult`-style result
   handling.
3. `[JSInvokable] Dispatch` entrypoint exposed to JS.
4. Tests against a hand-written project (no generator involvement
   yet) — confirm a Dapper-backed handler can be invoked end-to-end.

### Phase 3: Loom emitter variant (the bulk)

1. New `dotnet-browser` `PlatformSurface` in `src/platform/registry.ts`,
   sharing emit code with the existing dotnet target. Different
   `Program.cs`, different DI, Dapper repo emission instead of EF.
2. Source-gen `JsonSerializerContext` emission.
3. Explicit `[JsonPropertyName]` on all DTO fields, sourced from
   `wireShape` (probably backfill into the production `dotnet`
   variant too — relying on naming-policy is a parity-bug magnet).
4. Migrations: use the existing `MigrationsIR` SQL, applied at boot
   via `pglite.exec` (mirrors the Hono path's `synthDDL`).

### Phase 4: worker integration

1. A `dotnet-runtime.worker.ts` next to `runtime.worker.ts`,
   dispatching to `BlazorRuntime.Dispatch` instead of `app.fetch`.
2. Same `SerializedRequest` / `SerializedResponse` protocol.
3. Playground UI switch to choose which backend the in-page UI talks
   to (or generate both and let the user toggle).

### Phase 5 (optional): Minimal API sugar

The Phase B shim layer described above. Pure surface, additive,
non-blocking.

## Alternative plan: minimal possible dotnet playground setup

This is the framing-B path. Substantially cheaper, with one
architectural concession: the .NET variant in the playground is a
Blazor WASM monolith, not "ASP.NET Core backend + React frontend
talking via wire shape." The wire-boundary-in-browser story applies
only to the Hono variant; the .NET variant is demonstrated as
"Blazor on top of the same handlers + repos."

### What gets shipped

1. **`Pglite.Data`** — the `PgliteConnection` / `PgliteCommand` /
   `PgliteDataReader` package. **Identical to Phase 2 of the
   recommended plan.** ~500 lines. Open-sourceable on its own.
2. **A Blazor WASM project template** that the `dotnet-browser`
   emitter populates. Includes:
   - `Program.cs` with `WebAssemblyHostBuilder.CreateDefault(args)`,
     DI registrations, `PgliteConnection` as singleton `IDbConnection`.
   - One Razor page per UI view in the IR — generated from the
     same UI primitives the React design pack consumes, but rendered
     into Razor markup.
   - Handlers + repos + DTOs — identical to production .NET output
     except for the EF→Dapper swap and DI registration.
3. **A Blazor design pack** — new sibling of `designs/mantine/` etc.,
   rendering UI primitives (`List`/`Detail`/`Form`/`MasterDetail`/
   `Stack`/`Heading`/`Button`/`Card`/`Toolbar`/`match`) as Razor.
   This is the meaningful new generator work. The walker target
   contract (`src/generator/_walker/target.ts`) already abstracts
   the framework-shaped seams; a `BlazorTarget` implementing it
   slots in alongside the existing `tsx-target.ts` and
   `heex-target.ts`.
4. **Worker integration** — a `dotnet-runtime.worker.ts` that boots
   Blazor WASM, exposes `pglite.query`, and forwards UI events.
   Simpler than the framing-A dispatcher because there's no
   request-shaped marshalling — Blazor's own JSInterop handles
   component events.

### What does *not* get shipped

- **No router.** Components inject services and call them directly.
- **No dispatcher.** No `[JSInvokable] Dispatch` entrypoint, no
  serialised request envelopes, no JSON parameter binding per call.
- **No Minimal API shim** (Phase B in the recommended plan). Nothing
  to mimic.
- **No `[JsonPropertyName]` source-gen for wire conformance** — there's
  no wire to conform to in this variant. The CI gates still cover
  production .NET wire shape; the playground variant doesn't.

### What gets gained

- **Months of work disappear.** No router, no dispatcher, no Minimal
  API shim, no per-DTO source-gen JSON wiring, no worker-side
  request envelope translation.
- **No Microsoft-surface treadmill.** The shim doesn't exist;
  there's nothing to drift.
- **Smaller Loom surface to maintain.** The `dotnet-browser`
  PlatformSurface is mostly UI generation (the Blazor design pack)
  plus the EF→Dapper swap.

### What gets lost

- **The .NET playground demo no longer mirrors the production
  multi-deployable architecture.** Production emits ASP.NET Core +
  React talking via HTTP; playground emits Blazor monolith. A user
  copying playground code into a production project would find the
  shapes diverge significantly in `Program.cs`, in the UI layer, and
  in how the UI talks to handlers.
- **The Blazor design pack is non-trivial.** Razor's component model
  is different enough from React's that the existing UI primitive
  emitters can't be lightly reused — a real `BlazorTarget`
  `WalkerTarget` implementation is needed. This is the dominant cost
  in this plan.
- **No cross-backend conformance demonstration inside the
  playground.** The Hono variant's React UI talking via wire still
  works; the .NET variant's Blazor UI doesn't participate in the
  same demonstration. (CI parity gates are unaffected.)

### Cost estimate

| Piece | Recommended plan | This plan |
|---|---|---|
| `Pglite.Data` | ~1 week (Phase 2) | ~1 week (same) |
| Router + dispatcher + parameter binder | ~1 week (Phase 2) | — |
| Minimal API shim (optional Phase B) | ~1 week | — |
| `dotnet-browser` emitter — backend code | ~2 weeks (Phase 3) | ~1 week |
| `dotnet-browser` emitter — UI | — (reuses React) | ~3-4 weeks (new Blazor design pack) |
| Worker integration | ~3 days (Phase 4) | ~3 days |
| Source-gen JSON + `[JsonPropertyName]` | ~1 week (Phase 3) | — |
| **Total** | **~6-7 weeks** | **~5-6 weeks** |

The totals look closer than the rhetoric suggests because the Blazor
design pack is genuinely expensive — it's the one piece that this
plan adds rather than removes. If a Blazor design pack would be
wanted anyway for other reasons (e.g. a `phoenixLiveView`-style
"Blazor-native" deployable variant in production), then this plan
becomes much cheaper relative to the recommended one.

### When to pick this plan

- **Pick this** if the playground is primarily a teaching/marketing
  surface, the Hono variant is sufficient for "see the wire shape
  working," and demonstrating .NET means "show me C# code working in
  the browser with real Postgres."
- **Pick the recommended (framing A) plan** if the playground is the
  product's primary live demonstration of the multi-deployable wire
  architecture, and "the .NET variant is a Blazor monolith" would
  meaningfully misrepresent what Loom emits.
- **A third option:** ship `Pglite.Data` first as standalone OSS
  (it's identical in both plans and useful on its own), then defer
  the rest until the framing decision is forced by a real user need.

### Minimal-minimum: just ship `Pglite.Data`

If even this plan feels like too much, the irreducible kernel is
`Pglite.Data` alone. Publish it as a standalone NuGet (`Pglite.Data`
or similar — see the open-source candidate discussion earlier). It
solves a real, googleable problem ("how do I use Postgres in Blazor
WASM?") and costs Loom nothing to maintain because it isn't part of
Loom's playground at all — it's a standalone Microsoft-ecosystem
artefact. The rest of the .NET playground story (either framing)
can be picked up later by Loom or by anyone else; `Pglite.Data` is
the unblocking ingredient.

## Open questions

1. **AOT.** Default Blazor WASM interpreter mode is fine for Dapper
   and reflection-based `System.Text.Json`. If perf matters,
   `<RunAOTCompilation>true` breaks both unless you switch to
   `Dapper.AOT` and source-gen `System.Text.Json` exclusively. The
   playground probably doesn't care; the proposal assumes
   interpreter.
2. **Trimming.** Blazor WASM trims aggressively by default. Dapper
   needs DTO members to survive trimming — either disable trimming
   for the playground build, or annotate DTOs with
   `[DynamicallyAccessedMembers]`. Cheaper to disable for now.
3. **Blazor JSInterop's `JsonSerializerOptions`.** Blazor's JSInterop
   uses its own `JsonSerializerOptions` for `[JSInvokable]` argument
   marshalling, separate from the dispatcher's. If a generated handler
   ever does `JS.InvokeAsync<OrderDto>("…")`, the DTO would be
   marshalled with Blazor's defaults, not the source-gen context.
   Defence: configure Blazor's JSInterop to share the same options
   at startup. Worth pinning down in the spike.
4. **Wire-format conventions that need to be uniform across backends.**
   - Money/decimal precision (JSON Number loses precision above
     2^53 — should money be a string on the wire?).
   - Date/time format (ISO-8601 across the board — already de facto).
   - `null` vs absent fields (matters for parity assertions).
   - Empty arrays vs `null` for empty collections.
   The wire-spec should pin all of these; the source-gen options on
   the .NET side need to honour the same choices Hono and Phoenix
   make.
5. **EF Core later?** Option (b) — a real EF Core provider over the
   same `PgliteConnection` bridge — preserves more authenticity at
   significant cost (the provider surface is wide). Not on the
   critical path. Could be a "phase 6" if the Dapper path proves
   the architecture and someone wants the next jump in fidelity.
6. **Phoenix.** This proposal is .NET-specific, but the same playground
   question applies to Phoenix (plain Ecto/Phoenix on Elixir). The BEAM in browser is
   experimental at best today (lumen/atomvm). Far less mature than
   Blazor WASM. Probably stays inert in the playground for the
   foreseeable future.

## Non-goals

- Running unmodified ASP.NET Core (with Kestrel, middleware pipeline,
  framework reference) in the browser. Not happening in any near
  future.
- Running production .NET projects from the file system in the
  playground. The browser variant is a *playground variant* of the
  output, not a way to host arbitrary user-written ASP.NET Core.
- Replacing the production `dotnet` generator. The `dotnet-browser`
  variant is a sibling; the production output continues to target
  real ASP.NET Core + EF Core + Npgsql.

## Cross-references

- `docs/platforms.md` — the `PlatformSurface` contract and the
  `family@version` pinning story that `dotnet-browser` would slot
  into.
- `docs/old/proposals/storage-and-platform-config.md` — broader
  conversation about platform configuration that this would touch.
- `web/src/runtime/runtime.worker.ts` — the Hono runtime worker that
  the .NET equivalent would mirror in structure.
- `src/system/wire-spec.ts` — the wire-shape source of truth that
  drives `[JsonPropertyName]` on the .NET side.
- `src/system/migrations-builder.ts` / `MigrationsIR` — the migration
  SQL the browser variant would apply at boot.

## Summary

Three honest answers, in decreasing order of likelihood:

### Default: don't do it

The Hono runner already demonstrates the wire shape end-to-end; the
.NET parity is gated by CI (`conformance-parity.yml`,
`dotnet-build.yml`, `dotnet-obs-e2e.yml`). Adding a second runnable
backend to the playground is a lot of work for a marginal demo
improvement. The playground is one of four ways the generator's
output gets exercised; the others (the per-backend CI builds) already
prove the .NET side works. Until a real product need surfaces, this
proposal sits in `maybe-one-day/`.

### If forced to ship — minimum viable: just `Pglite.Data`

The irreducible kernel is the PGlite ADO.NET adapter (~500 lines).
Publish as a standalone NuGet. Useful on its own — solves a real
problem in the Microsoft ecosystem with no current good answer.
Doesn't commit Loom to anything else.

### If actually doing it — pick a framing first

Two real plans, two real framings. Pick before starting.

**Framing A (recommended plan).** Playground is a faithful preview of
the production multi-deployable architecture. Wire boundary inside
the browser is preserved. Total cost ~6-7 weeks.

| Piece | Role |
|---|---|
| `Pglite.Data` | The bridge. Unmodified Dapper works on top. |
| Blazor WASM | Runtime substrate — not used as UI, used as the way to run .NET in the browser. |
| Router + `[JSInvokable] Dispatch` | ~300 lines replacing Kestrel and the hosting pipeline. |
| Source-gen `JsonSerializerContext` + explicit `[JsonPropertyName]` | Cross-backend wire conformance. |
| `dotnet-browser` PlatformSurface | Mostly DI + Dapper repo emission. Handlers/DTOs unchanged. |
| Optional: Minimal API shim | Pure surface sugar over the router. Decoupled, additive. |

**Framing B (alternative plan — "minimal possible dotnet playground
setup").** Playground is a teaching/exploration surface. .NET variant
is a Blazor WASM monolith. No router, no dispatcher, no Minimal API
shim. Different UI generation (new Blazor design pack instead of
sharing React). Total cost ~5-6 weeks, dominated by the Blazor design
pack.

The cost gap is smaller than the rhetoric suggests because framing B
trades router-and-shim work for a new design pack. **Framing B
becomes substantially cheaper** if a Blazor design pack would be
wanted for *other* reasons (a hypothetical production Blazor
deployable variant, parallel to `phoenixLiveView`). In that world,
the .NET playground is almost free on top.

This proposal's author leans toward framing A, on the read that
Loom's identity is "all backends agree on the wire shape, here's
empirical proof." But this is a product call, not a technical one,
and reasonable people could pick framing B.
