# Value provenance — `provenanced`

> Status: **implemented on all five backends** (2026-07-03 audit). The
> keyword is in `ddd.langium`; lowering, emission, the `ddd snapshot`
> capture command, and the playground hook all ship. `provenanced` fields
> emit the lineage SDK + co-located `<field>_provenance` column + the
> `provenance_records` flush on **node/Hono, .NET, Java, Python, and
> elixir-vanilla** (`PROVENANCE_BACKENDS` in `system-checks.ts`; real
> emitters incl. `python/emit/provenance.ts` + `java/emit/provenance.ts`);
> only non-runtime targets (e.g. react) are gated
> (`loom.provenanced-backend-unsupported`). The original sketch attached
> provenance to `derived` computed values; the implemented design instead
> attaches it to **stored fields, instrumented per write-site**. The
> derived-value variant, the `.provenance`/`.explain()` accessors, and the
> Explain service remain **deferred** (see *Deferred*).

> **[2026-06-20 status audit]** Backend spread understated — provenance runtime now ships on TS/Hono, .NET (`dotnet/emit/provenance.ts`), AND elixir-vanilla (`elixir/vanilla/provenance-emit.ts`, #1400/DEBT-06). Only Python/Java + the Explain service / `.provenance` accessors remain deferred.

## Problem

A business value — the canonical example is `order.total` — should be
able to answer *"why is this 128.40, and what produced it?"* long after
the fact, even after the code that produced it has changed. Finance,
pricing, billing, and compliance domains need a reviewable record of the
inputs, the rule, and the moment of each write. Loom makes this a
first-class language property, not a hand-rolled logging side-effect.

## Design principles (settled in the source threads)

1. **The user marks intent; the compiler does the rest.** The author
   writes one keyword on a field. Every assignment to that field is
   instrumented automatically — the user never restates inputs
   (`derived from: …` rejected) and never writes version numbers
   (`rule X v7` rejected).
2. **Structure ≠ values.** Two artefacts, produced at two different
   times:
   - a **rule snapshot** — captured at publish time, holds the
     assignment's RHS expression *structure* (text + resolved IR AST)
     and its source anchor, **no runtime values**;
   - a **trace record** — emitted at runtime on each write, holds the
     actual leaf values + the computed result.
   A future "Explain" zips the two together.
3. **Reference, don't copy.** A trace points at a `snapshotId`; the
   snapshot points at a source path + span (and the capture's git
   commit). Traces never embed source.
4. **Per write-site, not per value.** The unit of provenance is an
   **assignment statement** (`:=`/`+=`/`-=`) whose target is a
   provenanced field — not a computed `derived` member. Each such site
   is its own immutable rule snapshot; a field's "current provenance" is
   whichever write last produced its value. This is the decisive
   departure from the original derived-value sketch.
5. **Historical truth survives code change.** Snapshots are captured as
   an immutable, append-only history (one file per capture). An old
   trace still explains a past value even if the rule was later edited;
   live code is needed only to *recompute*, never to *explain*.

## Surface

`provenanced` is a trailing modifier on a **stored `Property`**, exactly
the way `display` rides on a property. It is **not** allowed on
`derived` (the grammar omits it there, so that is a parse error):

```ddd
context Sales {
  aggregate Cart {
    label: string display
    total: int provenanced        // every write to `total` is instrumented
    discount: int

    operation applyTotal(base: int, qty: int) {
      total := base * qty - discount      // ← a per-site rule snapshot
    }
    operation bump(extra: int) {
      total := total + extra              // ← a second, distinct snapshot
    }
  }
}
```

Each `:=` above becomes a rule snapshot; at runtime each write records a
trace referencing that snapshot, with leaf inputs (`base`, `qty`,
`discount`; or `total`, `extra`) captured **before** the mutation so a
self-referential write records the value actually used.

A validator **warning** flags a `provenanced` field that no operation
ever writes (suppressed when the aggregate has an `extern` operation,
whose body the compiler can't see and which may be the writer).

## Language additions

| Addition | Form | Notes |
|---|---|---|
| `provenanced` modifier | `Property` gains `(provenanced?='provenanced')?` after `type` (and after `display`, before `check`) | Stored fields only; **not** on `DerivedProp`. |

Explicitly **not** added (this version): a granularity argument
(`provenanced(values)`), `derived from:` input lists, `trace id` /
`rule … v7` syntax, and the `.provenance` / `.explain()` accessors.

## Lowering & generation

```
.ddd source ──► IR  (FieldIR.provenanced; each assign/add/remove StmtIR
                     whose target resolves to a provenanced field carries
                     a ProvSite snapshot — resolved during lowering, which
                     is the last layer holding the AST/source span)
            ──► generate (TS/Hono): emit runtime SDK + a recordTrace(...)
                     call after each provenanced write
            ──► `ddd snapshot` (explicit prebuild step): capture the rule
                     snapshots into an immutable, dated history file
            ──► (future) Explain service zips snapshot ⊕ trace
```

**Snapshot identity (`snapshotId`)** is **content-addressed**: a hash of
the target (`Type.field`) + the RHS expression text. A rule that changes
gets a new id; an unchanged rule keeps its id across builds and captures,
so different code versions reference different snapshots *only where the
rule actually changed*. (Easiest scheme that satisfies the requirement;
can later be swapped for an AST-canonical or capture-versioned id without
touching call sites — see `src/ir/prov-id.ts`.) The git commit is
**not** part of the id; it is stamped once into the capture envelope.

**Capture is an explicit prebuild step**, not auto-emitted on
`generate` — analogous to `dotnet ef migrations add`. Run it deliberately
when rules change:

```bash
ddd snapshot <file.ddd> -o <out>
```

It writes one immutable file per system under
`<out>/.loom/snapshots/<UTC-timestamp>-<guid>.loomsnap.json`, never
overwriting a prior capture. The same capture is available in the
**playground** via the build-worker `snapshot` RPC
(`web/src/build/build.worker.ts` → `client.snapshot(text)`). Built by
`src/system/loomsnap.ts`.

**Snapshot file** (`*.loomsnap.json`):

```jsonc
{
  "captureId": "<guid>",
  "system": "ProvSystem",
  "commitHash": "<git HEAD or 'uncommitted'>",
  "capturedAt": "<ISO timestamp>",
  "snapshots": {
    "31c95d9a": {                              // = snapshotId, content-addressed
      "kind": "write-site",
      "target": { "type": "Cart", "field": "total", "valueType": "int" },
      "expression": { "text": "base * qty - discount", "ast": { /* resolved ExprIR */ } },
      "source": { "path": "…/prov.ddd", "span": { "start": 268, "end": 298 } }
    }
  }
}
```

**Runtime SDK** — the generated Hono project gets a `domain/provenance.ts`
emitting an append-only in-memory trace sink (v1). Each provenanced write
compiles to:

```ts
const __prov_1 = [{ path: "base", value: base }, { path: "qty", value: qty },
                  { path: "discount", value: this._discount }];   // inputs pre-mutation
this._total = base * qty - this._discount;
recordTrace("31c95d9a", { type: "Cart", field: "total" }, __prov_1, this._total);
```

**Emission is forced by presence**: any *written* provenanced field turns
on the SDK file + `recordTrace` calls (and qualifies the system for
capture). When absent, nothing is emitted and the build pays nothing. The
toggle is threaded as a flag (`emitProvenance`) rather than read off
presence at each site, so a future build-level switch can force emission
for other consumers (audit/logging) — see
[`execution-context.md`](./execution-context.md).

**Scope:** TypeScript/Hono only. The grammar/IR additions are
backend-neutral, so .NET / React / Phoenix lower the keyword without
crashing but emit no trace code.

## Deferred

- **Derived-value provenance.** The original sketch attached
  `provenanced` to a `derived` member and recovered the dependency graph
  from its expression. Superseded by the per-write-site model; could
  return as a complementary surface later.
- **`.provenance` / `.explain()` accessors** and the **Explain /
  Recompute / Audit-compare** read service that zips snapshot ⊕ trace.
- **Granularity argument** (`provenanced(values|operations)`).
- **Upstream linking** (`sourceTraceId` pointers between provenanced
  values) and the W3C PROV (PROV-N / PROV-JSON) export.
- **Other backends** (.NET / Phoenix runtime SDKs) and a durable
  (non-in-memory) trace store.

## Open questions

- Nested write paths (`this.line.qty := …` into a value object / part).
  v1 instruments **direct** aggregate fields only; nested targets carry
  no snapshot yet.
- Collision semantics: two byte-identical RHS expressions writing the
  same field share a `snapshotId` (by content-addressing). Desirable as
  dedup, but worth confirming against the "per-site" mental model.
- Report/SQL-aggregation provenance (query snapshot + dataset reference
  + optional row drill-down) — flagged as a storage-explosion risk; no
  surface proposed yet.

## Relationship to other aspects

- Provenance, audit, and logging are intended to consume the **same
  call-context backbone** — see
  [`execution-context.md`](./execution-context.md). The `emitProvenance`
  flag is the first instance of the build-level emission switch that doc
  describes.
- The [load-spec layer](./load-specifications.md) is designed to feed
  provenance: the repository load trace records *what shape was
  requested*, the evaluation trace records *what paths were actually
  used*.
