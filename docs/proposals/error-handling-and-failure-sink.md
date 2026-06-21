# Error handling & the failure sink — global boundary, customizable

> Status: **PROPOSED (design note).** "Proposal C" of the actions/async family.
> This is the **terminus** the async note keeps deferring to: where an error goes
> when nothing handles it locally. It spans **both tiers** — a frontend global
> **error boundary** and a backend global **error handler** — because every
> system has both. Loom ships a **good default**; customization is a declarative
> **override**. It depends on nothing hard, and complements
> [Proposal B](async-actions-and-effects.md) (the unhandled-`await` terminus),
> the exception-less backend `Result` model (`exception-less.md`), typed `error`
> records (`payloads.md`), and observability (`observability.md`). Nothing is
> implemented.
>
> **Notation.** Examples are tagged 🔶 proposed; the `.ddd` source *and* the
> generated target are shown together (the repo's two-examples rule).

## TL;DR

Errors are **values** (typed `error` records, `payloads.md`). An error that isn't
caught locally must be **routed to a terminal handler** — and that terminus is
tier-shaped: on the backend it becomes an HTTP **Response**, on the frontend a
**UI** effect. Loom ships sane defaults for both (problem+json + 500 / a toast +
error boundary), and a declarative `errors { }` policy overrides them. This
completes the handling hierarchy the async note started:

1. per-call `onError` / `match` — handle *here*
2. block `onError` / `attempt { }` — handle *the chain*
3. **global sink (this note)** — the terminus for anything unhandled

## 1. One concept, two projections

The same error vocabulary routes to two different outputs, linked by the wire
status code:

| Tier | Terminus | Default |
|---|---|---|
| backend | an HTTP **Response** (status + problem+json body) | 500 + RFC 9457 envelope, logged + traced |
| frontend | a **UI** effect (toast / error page / redirect) | non-blocking toast + telemetry |

Because the `error` types are shared, one error spans both ends: the backend maps
`Unauthorized → 401`, and the frontend boundary maps that `401` back to
`navigate(Login)`. Two halves of one contract — exactly like the `await … onError`
↔ backend `Result` symmetry in Proposal B, one level up.

## 2. Good defaults — the 90%, with zero declaration

**Backend default sink.** An unhandled `Failed` variant or thrown exception →
HTTP **500** with an RFC 9457 `problem+json` body
(`{ type, title, status, detail, traceId }`), logged and traced
(`observability.md`). Typed errors that carry a status map to it automatically
(validation → 422, auth → 401/403, not-found → 404).

**Frontend default boundary.** An unhandled `await`/`attempt`/`spawn` failure → a
non-blocking toast (`"Something went wrong"`) + telemetry; a render-time crash →
the global error-boundary fallback page; a network/offline failure → a retry
banner.

You write a policy *only* to override these — the defaults always exist.

## 3. Customization — the `errors { }` policy

A declarative map from `error` type → handler, with `else` as the catch-all
(falling back to the built-in default if omitted). The output vocabulary differs
per tier, so the two policies are distinct but share the error types:

```ddd
errors api {                          // 🔶 backend policy (spelling open)
  NotFound          => 404
  ValidationError v => 422 problem { problems: v.fields }
  Unauthorized      => 401
  else              => 500            // → the default problem+json envelope
}

errors ui {                           // 🔶 frontend policy
  Unauthorized => navigate(Login)              // ties to auth.md session handling
  Offline      => Banner { "You're offline — retrying…" }
  else         => Toast { "Something went wrong" }
}
```

Backend projection (ASP.NET shown — one `IExceptionHandler` / ProblemDetails map):

```csharp
public ValueTask<bool> TryHandleAsync(HttpContext ctx, Exception ex, CancellationToken ct) {
  var (status, body) = ex switch {
    NotFound          => (404, Problem(404)),
    ValidationError v => (422, Problem(422, problems: v.Fields)),
    Unauthorized      => (401, Problem(401)),
    _                 => (500, Problem(500)),     // default envelope + traceId
  };
  ctx.Response.StatusCode = status;
  return ctx.Response.WriteAsJsonAsync(body, ct).ContinueWith(_ => true);
}
```

Frontend projection (React — boundary + api-client interceptor):

```tsx
function onApiError(e: ApiError) {
  switch (e.kind) {
    case "Unauthorized": return navigate("/login");
    case "Offline":      return showBanner("You're offline — retrying…");
    default:             return toast("Something went wrong");
  }
}
// <ErrorBoundary fallback={DefaultErrorPage}> wraps the app for render crashes.
```

## 4. Projection per target

| Backend | Global handler emitted as |
|---|---|
| Hono | `app.onError((err, c) => …)` |
| ASP.NET | `IExceptionHandler` + `ProblemDetails` |
| FastAPI | `@app.exception_handler(...)` |
| Spring | `@ControllerAdvice` / `@ExceptionHandler` |
| Phoenix | `action_fallback` + `Plug.ErrorHandler` |

| Frontend | Global boundary emitted as |
|---|---|
| React | Error Boundary component + api-client interceptor |
| Vue | `app.config.errorHandler` / `onErrorCaptured` |
| SvelteKit | `handleError` hook + `+error.svelte` |
| Angular | `ErrorHandler` provider + HTTP interceptor |

All target-native — the `errors { }` policy is a neutral routing table that
projects to each framework's idiom, the same way `attempt { }` projects to a CE
vs `try/catch`.

## 5. Where the status mapping lives (open)

Two reasonable homes for the backend status of a typed error:

- **On the `error` record** — `error NotFound status 404` (co-located; the error
  knows its own status; DRY). The default sink reads it; the policy only handles
  cross-cutting overrides + the catch-all.
- **In the policy** — all mappings in one place (`errors api { … }`), nothing on
  the record.

Recommended: **status on the record for the default**, policy for overrides and
the frontend UI mapping. So a plain `error NotFound status 404` needs *no* policy
at all — it just maps; the policy is for the non-obvious cases.

## 6. Relationship to the rest

- **Proposal B** — this is the "propagate" terminus the async note routes to when
  no `onError`/`match`/`attempt` catches a failure.
- **`exception-less.md`** — the backend sink is what turns an unhandled `Failed`
  variant / exception into the Response; the policy is the mapping table.
- **`payloads.md`** — the matched error types *are* the declared `error` records.
- **`observability.md`** — the sink is the canonical log/trace hook; the
  `traceId` in the default envelope comes from there.
- **`auth.md`** — `401 → navigate(Login)` is the canonical frontend override.

## 7. Staging

Defaults first (every system gets a sane sink with no work), customization
second. Independent of the actions/async stages — a parallel track.

1. **Backend default sink** — consistent problem+json envelope + observability
   `traceId`, made a wire contract across all backends.
2. **Frontend default boundary** — wire the unhandled-`await` terminus + a
   render-time error boundary with a default fallback page.
3. **`errors { }` policy** — the declarative override on both tiers; `error …
   status N` on the record for the common case.

## 8. Decisions & open items

**Settled (this note):** one concept, two tier projections; a good default that
needs no declaration plus a declarative override; it is the terminus of the
`onError`/`match`/`attempt` chain; it reuses typed `error` records and
observability (no new error vocabulary).

**Open:**
- **`errors { }` spelling and scope** — `errors api { }` / `errors ui { }` vs one
  block; system-wide vs per-deployable, and override precedence.
- **Status home** — on the `error` record (`status 404`) vs in the policy (§5;
  recommended: on the record).
- **Retry / backoff** — automatic retry of failed `await`s (transient errors) is
  probably a *separate* concern; likely out of scope here.
