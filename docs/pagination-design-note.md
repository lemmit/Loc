# Pagination — design note for the implementing agent

> Status: **design agreed, not yet implemented.** Companion to
> `multi-tenancy-design-note.md`. Pagination is a prerequisite *only in spirit* for the
> real-time cache-invalidation feature — see "Relationship to the caching feature" at the
> bottom for why it barely matters to the core mechanism.

## Goal

Today every list/`findAll` endpoint returns a **complete array** — no `page`/`pageSize`, no
`Paged<T>` wrapper, no count (`src/generator/react/api-builder.ts:192-221`; auto-`findAll`
added in `src/ir/enrichments.ts`). Add server-side pagination so lists return a bounded page
plus enough metadata to drive a paged UI, across all backends.

## Decisions locked

1. **Offset/limit (page + pageSize), not cursor — for v1.** Simplest, composes cleanly with
   the existing filter/`find` query params, and matches the "stronicowanie + filtry" the source
   design assumes. Cursor pagination is better at very large scale but complicates keys, ETags,
   and "jump to page N" UIs; defer it.

2. **`Paged<T>` response wrapper.** Lists return:

   ```
   { items: T[], page: int, pageSize: int, total: long, hasMore: bool }
   ```

   `total` is included so page-count UIs work; if `total` ever becomes a perf problem on huge
   tables, that's the trigger to revisit cursor mode.

3. **Paged by default; `unpaged` marks the exceptions — fail-safe toward bounded responses.**
   List/`findAll` queries are paged by default (a forgotten annotation can't accidentally ship an
   unbounded full-table scan to the client). Small reference lists — typically the same
   `crossTenant` lookup data (country/plan catalogs) — opt out:

   ```ddd
   aggregate Country crossTenant unpaged { ... }
   ```

   (Symmetry with the tenancy markers: a positive default + a named exception, same philosophy.)

4. **Defaults (keep the surface to one keyword):**
   - `pageSize` default **50**, hard max **200** (clamp server-side; reject/ clamp larger).
   - `page` default **1**, 1-based.
   - **Stable default order by `id`** so page boundaries are deterministic. Custom ordering is an
     open item (see below), not v1.
   - Params are optional query string: `?page=2&pageSize=50` (omitted ⇒ page 1, default size).

## Where it plugs in (integration seams)

Language / IR:
- `src/ir/loom-ir.ts` — a `paged` flag (or `pageable` kind) on list/find query nodes; an
  `unpaged` modifier on the aggregate.
- `src/ir/enrichments.ts` — the pass that already synthesises auto-`findAll` marks it `paged`
  unless the aggregate is `unpaged`. `wireShape` is **unaffected** — the item shape is identical;
  only the envelope changes.
- `src/language/ddd.langium` + `ddd-validator.ts` — the `unpaged` modifier + validation.

.NET (`src/generator/dotnet/`):
- Repository: `Skip((page-1)*pageSize).Take(pageSize)` + a `CountAsync()` for `total`
  (`templates/repository.tpl.ts`), wrapped in `PagedResult<T>`.
- Controller: bind `page`/`pageSize` query params, clamp, pass through.
- Apply **after** the tenant `WHERE` filter and any `find` predicate (ordering matters:
  filter → order → page).

Parity:
- TS/Hono — `src/platform/hono/...` + `src/generator/ts/`: same `Paged<T>` shape and clamps.
- Phoenix/Ash — `src/generator/phoenix-live-view/`: Ash has first-class pagination
  (`offset`/`keyset`) — map to `offset` for v1.

React (`src/generator/react/api-builder.ts`):
- Generate paged hooks (e.g. `useAll<Plural>(page, pageSize)` / a `…Paged` variant) consuming
  `Paged<T>`. **Critically, the query key must include `page`/`pageSize`/filter** —
  `["orders","list",{page,pageSize,...filter}]` — so distinct pages cache separately. Consider a
  `keepPreviousData`/`placeholderData` option for smooth page transitions.

## Open items / decide while implementing

- **Custom ordering** — v1 is fixed `order by id`. A DSL `order by <field> [asc|desc]` on lists
  is the natural follow-up; needed before sortable column headers are meaningful.
- **`total` cost** — `COUNT(*)` on huge filtered sets can be slow; consider `hasMore` via
  `Take(pageSize+1)` as a cheaper alternative and making `total` opt-in.
- **Tests** — parsing test for `unpaged`; generator test per backend asserting `Skip/Take` +
  envelope; a React build test that the hook signature + key include page params.

## Relationship to the caching feature — and does it actually matter?

**Honest answer: barely, for correctness.** Real-time invalidation works at the query-key
**prefix** level — `invalidateQueries({ queryKey: ["orders"], exact: false })` nukes every entry
underneath, whether that's one full-array list or fifty distinct paged entries. The mechanism is
completely agnostic to pagination. So the caching feature can be built against either world.

Where pagination *does* shift things:

1. **It changes the ETag pillar's value, not its design.** The source doc motivates ETags by
   "don't refetch giant JSON lists on every ticket." With pagination, lists are already small, so
   the 304 optimization saves less per request (though there are more requests). Without
   pagination, full-array refetch-on-every-ticket is exactly the expensive case ETags soften. Net:
   pagination and ETags are partial substitutes; you want at least one.
2. **It improves the refetch fidelity** — only the on-screen page refetches, not the whole table.

So: implement pagination for its own sake (unbounded lists are a real problem) and for fidelity to
the source design's `useGet…PagedQuery`, **not** because the caching feature needs it. When
planning caching, assume paged lists exist — but know the invalidation logic wouldn't change a
line if they didn't.
