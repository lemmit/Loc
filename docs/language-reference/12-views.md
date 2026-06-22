# 12. Views

> **Grammar:** `View`, shorthand & full form, `bind` · **Validators:** bind exhaustiveness; queryable filter · **Docs:** [`../views.md`](../views.md)

Saved typed queries: the `view X = Agg where …` shorthand returning the wire shape, the full form with a declared output shape and `bind` projections, and the `requires` authorization gate.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **Shorthand `view`** — `view X = Agg where filter [ignoring …]`; result is the aggregate wire shape.
- **Full form** — `view X { Props from Agg where … bind name=expr }`; declared shape; exhaustive bind.
- **`bind` projections** — full expression language per row (collection ops, derived, arithmetic).
- **`requires` on a view** — auth gate before the `where`.
- **Per-backend emission** — the emitted query/endpoint on at least two backends.
