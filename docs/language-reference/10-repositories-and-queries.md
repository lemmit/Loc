# 10. Repositories & queries

> **Grammar:** `Repository`, `find`, `Criterion`, `Retrieval` · **Validators:** queryable-subset checks; `firstNonQueryableNode` · **Docs:** [`../criterion.md`](../criterion.md)

Reading data: the `repository` container and its `find` operations, the restricted "queryable subset" a `where` clause admits, reusable `criterion` specifications, `retrieval` query bundles with `sort`/`loads`, and pagination.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`repository` & `find`** — query container; `find name(params): T [where …]`; auto `findById` / `find all`.
- **The queryable subset** — what a `where` admits (no lambdas, one-level traversal). Show a rejected case.
- **Return shapes** — single, collection, `T?`, `T paged`, `T envelope`.
- **`criterion`** — named pure predicate over a candidate type; composition with `&& || !`; ambient `of bool`.
- **`retrieval`** — query bundle `{ where, sort, loads }`; shorthand and full form; `Repo.run(retrieval, page?)`.
- **`loads:` shaping** — structural fetch paths (`this.lines[].product`).
- **`ignoring`** — capability-filter bypass on a read (`ignoring Cap` / `ignoring *`).
