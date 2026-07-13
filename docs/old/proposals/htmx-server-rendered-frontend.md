# HTMX server-rendered frontend — deferred (Go-first)

> Status: **NOTE (deferred).** Records the reasoning for a server-rendered
> HTML + HTMX target, **scoped to Go + Python only**, so it can be picked
> up later (Go first, after the Go backend lands). Deferred behind the SPA
> + new-backend work (Angular + Go now; Vue/Svelte/Python/Java in flight).
> Not a unified frontend — see the "why not unified" note below. Sibling
> of [`go-backend.md`](./go-backend.md) and the HEEx walker it mirrors.

## Why scoped to Go + Python (and not a unified frontend)

HTMX is **not** worth adding as a cross-backend frontend. It only unifies
the interactivity-wiring (`hx-get`/`hx-target`/`hx-swap` — identical HTML
attributes everywhere); it does **nothing** for the per-backend
*templating* layer. And the backends that already have a first-party
server-rendered story don't want it:

| Backend | Native server-render story | HTMX's role |
|---|---|---|
| .NET | **Blazor** (component model) / Razor | redundant — richer, expected |
| Phoenix | **LiveView** (shipped) | redundant — does this already, better |
| **Go** | `html/template` (bare, no interactivity) | **fills a real void** — de-facto interactivity layer for server-rendered Go |
| **Python** | Jinja2 (FastAPI is API-first, no native UI framework) | **fills a real void** — a leading choice, esp. for FastAPI |

So HTMX earns its keep **only** for Go and Python — the two backends with
no first-party server-rendered component framework to compete with.

## The architecture: a second server-rendered `WalkerTarget`

Model it exactly like the HEEx walker — a server-rendered `WalkerTarget`
(`src/generator/_walker/target.ts`), not a new frontend toolchain. Three
layers, with high sharing:

| Layer | What it is | Shared across Go + Python? |
|---|---|---|
| **Primitive → HTML + `hx-*` structure** | `List` → `<table>` + load-more `<button hx-get hx-swap>`; `Form` → `<form hx-post>`; `match` → conditional blocks. Pure HTML + `hx-*`. | **~100% shared** — backend-neutral; the bulk of the design work |
| **Template-syntax printer** | Value injection dialect: `{{ .Name }}` (Go `html/template`) vs `{{ name }}` (Jinja2). | **Per-backend** — small, focused; the `WalkerTarget` leaf seam |
| **Fragment-route glue** | Handler responding to `hx-get` with an HTML fragment instead of JSON. | **Per-backend, mostly free** — the backend already emits these routes for the JSON API; HTMX swaps JSON serialization for template render → `text/html` |

The shareable asset is the big one (the HTML+`hx-*` vocabulary + the
CSS/design-pack layer). The per-backend delta is a template-syntax printer
+ a response-glue swap on routes that already exist. Contrast two SPAs,
which share nothing below `wireShape` — **the second HTMX backend is cheap
once the first exists.**

## Pinned tradeoff: native engines, not a portable template

You *could* maximise sharing (~100% of template files) by emitting a
portable logic-less template (Mustache — has Go + Python runtimes). **Don't.**
Mustache-in-Go isn't idiomatic; it cuts against Loom's "looks hand-written
by someone who knows the stack" brand. Use native engines (`html/template`
or `templ` for Go, Jinja2 for Python), accept ~70% sharing via the shared
structure layer, keep the output idiomatic. The `state := …` client-local
seam is the awkward one in a server-rendered model — design it when picked up.

## When to pick this up

After the **Go backend** lands (Go first — most idiomatic, no competing
component framework). Python second, paired with the FastAPI backend.
Never for .NET or Phoenix.

## Cross-references

- [`go-backend.md`](./go-backend.md) — the first host backend.
- [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) /
  the HEEx walker — the existing server-rendered `WalkerTarget` precedent.
- [`docs/page-metamodel.md`](../../page-metamodel.md) — the framework-neutral
  page-DSL the walker consumes.
