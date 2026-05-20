# Value provenance — `provenanced`

> Status: proposal. Not in `ddd.langium`.

## Problem

A computed business value — the canonical example is `order.total` —
should be able to answer *"why is this 128.40?"* long after it was
computed, even after the code that produced it has changed. Finance,
pricing, billing, and compliance domains need every derived number to
carry a reviewable record of the inputs, the rule, and the moment that
produced it. Loom should make this a first-class language property, not
a hand-rolled logging side-effect.

## Design principles (settled in the source threads)

1. **The user marks intent; the compiler infers the rest.** The author
   writes one keyword. The dependency graph is recovered from the
   expression AST — the user never restates inputs (`derived from: …`
   was considered and rejected), and never writes version numbers
   (`rule X v7` was rejected). Rule identity is derived from the
   published artefact (git commit + source path + span).
2. **Structure ≠ values.** Two artefacts, produced at two different
   times:
   - a **rule snapshot** — emitted at compile/publish time, holds the
     expression *structure* (AST) and its source anchor, **no runtime
     values**;
   - a **trace record** — emitted at runtime when the value is
     computed, holds the actual leaf values.
   "Explain" zips the two together.
3. **Reference, don't copy.** A trace points at a git
   `commitHash` + `sourcePath` + `sourceSpan`; it never embeds source.
4. **Link, don't inline.** When a provenanced value is itself an input
   to another provenanced value, the downstream trace stores a
   *pointer* (`sourceTraceId`) to the upstream trace, not a nested
   copy. This is what stops a `YearlyReport → 12×Monthly → 30×Daily`
   tree from exploding. (Aligns with W3C PROV-LINKS.)
5. **Historical truth survives code change.** An old trace still
   explains a past value even if the rule was later edited or deleted.
   Live code is needed only to *recompute*, never to *explain*.

## Surface

Provenance attaches to a **computed value**. In Loom that is a
`derived` member (value objects, aggregates, entity parts), so the
keyword rides on `derived` exactly the way `display` rides on a
property. No separate input list, no version, no policy block:

```ddd
context Orders {
  aggregate Order {
    contains lines: OrderLine[]
    discount: Money
    taxRate: decimal

    // One keyword. The compiler reads the expression and recovers the
    // lineage: lines[].quantity, lines[].price, discount, taxRate.
    derived total: Money provenanced =
      lines.sum(l => l.quantity * l.price) - discount + (subtotal * taxRate)

    derived subtotal: Money = lines.sum(l => l.quantity * l.price)
  }
}
```

Reading the attached metadata uses ordinary member access on the
provenanced value — two reserved accessors:

```ddd
// inside an expression body / test:
let why = order.total.provenance     // structured lineage view
let text = order.total.explain()     // rendered human explanation
```

### Why `derived … provenanced` rather than `@provenanced`

The source conversation sketched `@provenanced(level="full")`, but
Loom has no `@`-annotation surface. Its idiom for "modifier on a
declaration" is a bare keyword (`private invariant`, `display`,
`private operation`, `transactional`). `provenanced` as a trailing
modifier on `derived` is the consistent Loom rendering. An optional
granularity argument mirrors `transactional(serializable)`:

```ddd
derived total: Money provenanced = …                  // default: full lineage
derived total: Money provenanced(values) = …          // record leaf values only
derived total: Money provenanced(operations) = …      // record the rule path only
```

## Language additions

| Addition | Form | Notes |
|---|---|---|
| `provenanced` modifier | `DerivedProp` gains `(provenanced?='provenanced' ('(' grain=ProvGrain ')')?)` after the type | `ProvGrain returns string: 'values' \| 'operations'` |
| `.provenance` accessor | reserved member on a provenanced value | yields the structured lineage view type |
| `.explain()` accessor | reserved zero-arg call on a provenanced value | yields a rendered `string` |

Explicitly **not** added: `derived from:` input lists, `using` / `by`
/ `at` clauses, `trace id`, `rule … v7` version syntax. All were
considered and rejected in favour of compiler inference.

## Lowering & generation

```
.ddd source ──► IR (derived prop flagged provenanced, dependency
                    graph already resolved by lower-expr.ts)
            ──► compile/publish: emit rule snapshot artefact
            ──► runtime: emit trace record on each computation
            ──► Explain service zips snapshot⊕trace
```

**Rule snapshot** (compile-time, one per provenanced rule; suggested
extension `.loomsnap.json`, sibling to the existing `.loom/wire-spec.json`
contract artefact):

```
{
  "snapshotId", "ruleId",
  "commitHash", "repo", "source": { "path", "span": {start,end} },
  "publishedAt", "kind": "derived-field",
  "target": { "type": "Order", "field": "total", "valueType": "Money" },
  "expression": { "text", "ast" },     // structure only — NO values
  "dependencies": [ resolved symbol paths ],
  "bindings": [ resolved symbolIds ]
}
```

**Trace record** (runtime, one per computed value):

```
{
  "traceId", "ruleSnapshotId", "computedValue",
  "inputs": [
    { "path", "value" },                 // raw/external leaf
    { "path", "sourceTraceId" }          // provenanced upstream → pointer
  ]
}
```

**Explain** loads the trace (values) + snapshot (AST), walks the AST
injecting recorded leaf values, and renders. Three read modes:

| Mode | Uses | Answers |
|---|---|---|
| Explain | stored trace + snapshot | "what produced this value, as of when" |
| Recompute | current code | "what would the value be today" |
| Audit-compare | old trace vs current rule | "did the rule change since" |

The IR already carries fully-resolved `refKind` / `receiverType` /
`memberType` on every expression node (see `src/ir/loom-ir.ts`), so
the dependency graph and snapshot AST are a projection of existing IR —
no re-resolution. Per-platform support is a runtime SDK + an
append-only trace store; a language-neutral canonical JSON contract
(snapshot / trace / input-binding) plus thin per-backend SDKs is the
recommended path, with optional W3C PROV (PROV-N / PROV-JSON) export.

## Open questions

- Final spelling of `.provenance` / `.explain()` (member vs reserved
  collection-op).
- Snapshot granularity: per-rule (chosen for v1) vs per-module rollup
  (optimisation later).
- "Business-significant" boundary: one trace per meaningful snapshot,
  not per micro-op — the precise rule is convention for now.
- Report/SQL-aggregation provenance (query snapshot + dataset
  reference + optional row drill-down) is a natural extension flagged
  as a storage-explosion risk; no surface proposed yet.

## Relationship to other aspects

- Provenance, audit, and logging all consume the **same call-context
  backbone** — see [`execution-context.md`](./execution-context.md).
- The [load-spec layer](./load-specifications.md) is designed to feed
  provenance: the repository load trace records *what shape was
  requested*, the evaluation trace records *what paths were actually
  used*, so Explain can show both.
