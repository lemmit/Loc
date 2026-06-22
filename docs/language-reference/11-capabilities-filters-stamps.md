# 11. Capabilities, filters & stamps

> **Grammar:** `Capability`, `with`/`implements`, `FilterDecl`, `StampDecl` · **Validators:** capability application; `loom.*` filter codes · **Docs:** [`../capabilities.md`](../capabilities.md)

Typed pure mixins: `capability` blocks (fields + `filter` + `stamp`), their application via `with` / `implements`, the cross-cutting `filter` predicate on every read, lifecycle `stamp`s, and the built-in `auditable` / `softDeletable` / `crudish`.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`capability`** — mixin of fields + filter + stamp; `Self id` self-reference.
- **`with` / `implements`** — aggregate-level and context-level application.
- **`filter`** — predicate applied to every read; aggregate vs context scope; `this` in scope.
- **`stamp onCreate|onUpdate`** — lifecycle-stamping assignments; per-backend emission site.
- **Built-in `auditable`** — createdAt/updatedAt as `managed`.
- **Built-in `softDeletable` / `crudish`** — soft-delete behaviour; generated `update(...)`.
