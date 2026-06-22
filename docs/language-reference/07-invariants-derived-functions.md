# 7. Invariants, derived fields & functions

> **Grammar:** `Invariant`, `DerivedProp`, `FunctionDecl` · **Validators:** purity checks; `loom.*` invariant codes · **Docs:** [`../language.md`](../language.md)

The three pure, read-only member kinds shared by aggregates, value objects, and workflows: `invariant` predicates (with guards and `private`), `derived` computed fields (including the reserved `display`/`inspect`), and reusable `function` helpers.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`invariant`** — boolean predicate checked after mutation; `when <guard>`; where the check is emitted per backend.
- **`private invariant`** — server-only, not disclosed via OpenAPI.
- **`derived`** — computed read-only property; appears in `wireShape`; per-backend computation site.
- **Reserved derived `display` / `inspect`** — user-facing label vs developer debug form.
- **`function`** — pure helper callable from expressions; emitted as a method/function.
