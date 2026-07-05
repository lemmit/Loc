# Optimistic concurrency — the `versioned` capability

**Status:** in progress (branch `claude/generated-code-ddd-review-ld6gmz`).
**Origin:** `docs/audits/generated-code-ddd-review-2026-07.md` §S4 (P1) — "the missing
half of *aggregate = consistency boundary*". Analog: PR #1648 (`unique (...)` →
23505 → 409 across all five backends).

## What ships

An opt-in capability mixin `versioned` (registered in `src/macros/prelude.ts`
alongside `auditable`/`softDeletable`/`tenantOwned` — an identifier in the
capability clause, **zero new grammar**). An aggregate that declares it gets:

- a synthetic `version: int` field with **`token`** access — on the wire/response,
  echoed as an update **precondition**, absent from the create/update editable body
  (the routing that `src/ir/enrich/wire-projection.ts` already documents for a
  concurrency token: `forApiRead` includes it, `forCreateInput`/`forUpdateInput`
  drop it, `updatePreconditions()` carries it);
- a `version INTEGER NOT NULL DEFAULT 1` column on its state table
  (`src/system/migrations-builder.ts` → shared `sql-pg.ts` + the Ecto emitter; the
  `DEFAULT 1` clears the destructive-migration gate on populated tables);
- a per-backend guarded write using each ORM's native optimistic-lock switch —
  Hono `WHERE id=? AND version=?` + 0-rows→throw, .NET `.IsConcurrencyToken()`,
  Phoenix `optimistic_lock(:version)`, Python `version_id_col`, Java `@Version`;
- a `409 Conflict` arm in each backend's error mapper, mirroring #1648's
  unique-conflict arm.

Everything is gated on `agg.capabilities` carrying `versioned`, so a non-versioned
model is **byte-identical** (preserves the invariant every prior schema-touching
feature kept).

## Decisions

- **Opt-in, not always-on** — preserves byte-identical-when-unused; flipping the
  default to on is a separate later slice.
- **Version on the wire** (token precondition) — makes concurrent-update→409
  deterministically testable end-to-end and closes the think-time lost-update gap.
- **Transport: `If-Match` header** — keeps the editable request body clean.
- **Event-sourced rider** (separate, revertible commit): catch the event-log-insert
  `23505` **unconditionally** → 409. Today an event stream with no declared unique
  key falls through to an unhandled 500 on concurrent append.
- **Name `versioned`** (adjective, matching the sibling capabilities).
- `version` silently dropped from create input (as the synthetic `id` token is);
  document-shape aggregates' existing unguarded increment left as-is this slice.
- 409 emits a distinct `conflict` catalog event (vs reusing `disallowed`).

## Slice (mirrors #1648 file-for-file)

Shared: `src/macros/prelude.ts` (+ factories if `field` lacks a `default`),
`src/ir/enrich/enrichments.ts` (inject the token field on versioned aggregates),
`src/system/migrations-builder.ts` (the column).
Per backend (guarded write + 409 arm + update precondition):
`src/generator/typescript/repository-save-builder.ts` + `src/platform/hono/v4/routes-builder.ts`;
`src/generator/dotnet/emit/{repository,api}.ts`;
`src/generator/elixir/vanilla/{changeset-emit,context-emit,problem-details-emit}.ts`;
`src/generator/python/{repository-builder,index}.ts`;
`src/generator/java/emit/{entity,api}.ts`.
Tests: `test/generator/{typescript,dotnet,java,python,elixir}/*-concurrency-conflict.test.ts`,
`test/system/concurrency-version-column.test.ts`, `examples/showcase.ddd` opt-in.
