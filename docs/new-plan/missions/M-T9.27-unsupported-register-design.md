# M-T9.27 — The `*-unsupported` register: enumerate the gaps before draining them (design)

> **Status: SLICES 1–3 LANDED** (#2444, #2488) — the register + its gate, the
> 19 non-gaps renamed out of the suffix, and every gap owned by a mission.
> **Slice 4 open.** First drain landed too: M-T6.33 (#2506) took
> `MAX_OPEN_GAPS` down by five, by re-classification; the live value is the
> constant in `test/system/unsupported-register.test.ts`.
> `src/diagnostics/unsupported-register.ts` is the machine-checked truth; the
> counts in the body below are as-of slice 1 unless a section says otherwise.
> Sources: language-size review 2026-08-04/05. `src/diagnostics/unsupported-register.ts`
> is the machine-checked truth; this doc is the planning view over it.
> Relates to M-T9.8 (allowlist ratchet — the same discipline, one register over),
> M-T5.21 (callable unification — the other half of the same review).

## Problem

The standing policy is **no permanent skips: every target supports the whole
surface**. That makes each `*-unsupported` diagnostic a *commitment* — a TODO
with an eleven-target obligation behind it. Sixty-nine codes in `src/` carry the
suffix.

Three things were true of that list before this mission, and each one blocks a
gap-filling sprint:

**1. It could not be enumerated.** The codes were inline string literals across
~50 files. Producing the list required writing a throwaway script. You cannot
plan, assign, or size a backlog you have to grep for.

**2. 53 of 69 were unowned.** Measured against the live roadmap:

```
gap codes:                                          69
  mentioned anywhere in docs/new-plan:              16
  ORPHANED — no mission, no track entry, nothing:   53
```

A sprint against that list drains whatever someone happens to find, not what is
actually open.

**3. The suffix is not a classifier — it misclassifies 27 of the 69.** This is
the finding that matters most, because it is invisible until you read every
emission site. `-unsupported` conflates four unrelated things:

| kind | meaning | count | drains? |
|---|---|---:|---|
| **gap** | a target hasn't implemented it yet | **42** | to zero |
| **never** | semantically impossible or deliberately refused | **13** | never |
| **scope** | a declared v1 limit with a named successor | **8** | when its mission runs |
| **rule** | not a gap at all — closed vocabulary or misuse error | **6** | never; misnamed |

Examples of each, so the distinction is concrete:

- **never** — `loom.projection-groupby-join-invalid`: *"'join' and 'group by'
  don't compose — a join is a by-id bulk load AFTER the query."* That is a
  statement about relational semantics, not about any backend.
  `loom.policy-write-global-invalid` is a documented deliberate never
  (`surface-redundancy-cuts.md` §4). Neither will ever drain, and both inflate
  the debt number.
- **rule** — `loom.auth-ui-misplaced`: *"'auth: ui' is only valid on a frontend
  deployable; backends use 'auth: required'."* A misuse error the suffix regex
  swept in. `loom.ui-handler-statement-unknown` (handler bodies take `toast`/`refetch`
  only) and `loom.interp-format-unknown` (the closed ICU set) are the same —
  closed vocabularies, permanently.
- **scope** — `loom.criterion-unsupported-target` names its own successor
  (*"reserved for the forthcoming `from <Criterion>(args)` surface"*), so it is
  M-T5.4's, not a sprint row.

**A third of the apparent debt is permanent by design.** No naming convention
separates those from the real work — which is why `kind` is an explicit,
reviewed field in the register and not something derived from the code name.

## Slice 1 — the register (LANDED)

`src/diagnostics/unsupported-register.ts` — one row per suffixed code carrying
`kind`, the `file:line` emission site, a one-line *what*, an owning `mission`
where one exists, and `verified` (classification confirmed against the site).
`openGaps()` returns the 42 that are actually work.

### Gate

`test/system/unsupported-register.test.ts` enforces four invariants:

1. every suffixed code emitted in `src/` is registered — **a new gap cannot be
   minted silently**, the failure `allowlist-ratchet.test.ts` exists to stop,
   one register over;
2. every registered code is still emitted — **a drained gap deletes its row in
   the same PR**, so the register ratchets down instead of becoming a graveyard;
3. no duplicate rows;
4. the open-gap count is pinned at `MAX_OPEN_GAPS` — asserted both `<=` and
   `===`, so draining without lowering the pin fails loudly and minting a gap
   without raising it fails too. **The live value is the constant in
   `test/system/unsupported-register.test.ts`**; it was 42 at slice 1 and came
   down by five at M-T6.33, but it moves in both directions, so this doc does
   not restate it (retro §91 — a count in prose is a cache with no
   invalidation).

**Mutation-proven** (CLAUDE.md — a green first run proves nothing):

| mutation | result |
|---|---|
| delete the `loom.when-unsupported` row | invariants 1 + 4 fail |
| rename `loom.vanilla-document-unsupported` at its emission site | invariants 1 + 2 fail |

## The 42 gaps, grouped as work

The register is per-code because the gate has to be. Sprint planning is
per-**unit**, and the 42 codes collapse to **ten** — which is the number worth
planning against. (Five stamp codes are literally one rule with five names; see
M-T5.21 §Symptom 1.)

| # | unit | codes | owner |
|---|---|---:|---|
| 1 | ~~**Lifecycle stamps**~~ — **DRAINED (M-T6.33)**, and not as expected: both arms re-verified as permanent refusals, so the five codes were renamed out rather than emitted. `MAX_OPEN_GAPS` down by five | ~~5~~ 0 | M-T6.33 `done` |
| 2 | **Projections** — groupby, query-time, projection-source, workflow-source, whole-table aggregation, Java field shapes | 6 | M-T4.2 |
| 3 | **Persistence adapters** — dapper, mikroorm, unlowerable find predicates, persistence-mode, saving-shape | 5 | M-T6.23 |
| 4 | **Frontend primitives** — Chart, DataGrid, Flutter renderers, frontend collection ops, Feliz async effects | 5 | M-T1.1 / M-T1.3 |
| 5 | **Governance emission** — `mask unless`, context `filter`, `ignoring` bypass, `audited` records, provenance runtime | 5 | M-T3.2 |
| 6 | **Misc backend tails** — context `test`, paged queryHandler, in-system api call, elixir `shape: document`, `when` gate, Java workflow instance fields | 6 | mixed |
| 7 | **Unions & carriers** — discriminated unions, generic carriers, `or`-union operation returns | 3 | M-T5.1 / M-T5.3 |
| 8 | **UI read paths** — ui→projection reads, `on <channel>.<Event>` realtime, `auth: ui` on feliz/flutter | 3 | M-T1.3 |
| 9 | **Event sourcing** — `persistedAs: eventLog` is Hono-only; event-sourced workflow storage is nowhere | 2 | — |
| 10 | **Inheritance** — TPH storage, polymorphic `<Base> id` refs | 2 | M-T5.7 |

**Sizing.** Ten units, of which four (1, 9, 10, and most of 7) are single
features × backends and three (2, 3, 5) are genuine multi-week tracks. That is
a plausible sprint-and-a-half, not a quarter — which is only knowable *because*
the enumeration exists.

**Since slice 1:** unit 1 is drained (see below) and every remaining unit has an
owning mission — slice 3 minted the six that were missing, so the "units 1, 6, 9
have no owner" hole this table originally recorded is closed.

## Slice 2 — rename the 19 non-gaps out of the suffix (LANDED)

The 13 `never` + 6 `rule` codes no longer read as parity debt. **The remaining
suffix now means exactly one thing: work, now (`gap`) or later (`scope`).**
`UnsupportedKind` is narrowed to those two, so a future `kind: "never"` row is a
*compile* error, not a review catch.

Three suffixes, each carrying a distinct meaning:

| suffix | means | count |
|---|---|---:|
| `-invalid` | semantically impossible or deliberately refused | 15 |
| `-no-effect` | parses, does nothing | 2 |
| `-unknown` | not a member of a closed vocabulary | 2 |

| was | now |
|---|---|
| `loom.backfill-target-unsupported` | `loom.backfill-target-invalid` |
| `loom.policy-write-global-unsupported` | `loom.policy-write-global-invalid` |
| `loom.projection-groupby-join-unsupported` | `loom.projection-groupby-join-invalid` |
| `loom.projection-groupby-keyed-unsupported` | `loom.projection-groupby-keyed-invalid` |
| `loom.projection-groupby-source-unsupported` | `loom.projection-groupby-source-invalid` |
| `loom.projection-query-and-fold-unsupported` | `loom.projection-query-and-fold-invalid` |
| `loom.projection-source-join-unsupported` | `loom.projection-source-join-invalid` |
| `loom.projection-source-ignoring-unsupported` | `loom.projection-source-ignoring-no-effect` |
| `loom.projection-workflow-source-eventsourced-unsupported` | `loom.projection-workflow-source-eventsourced-invalid` |
| `loom.projection-workflow-source-ignoring-unsupported` | `loom.projection-workflow-source-ignoring-no-effect` |
| `loom.projection-workflow-source-join-unsupported` | `loom.projection-workflow-source-join-invalid` |
| `loom.store-cross-store-on-liveview-unsupported` | `loom.store-cross-store-on-liveview-invalid` |
| `loom.store-lifetime-liveview-unsupported` | `loom.store-lifetime-liveview-invalid` |
| `loom.auth-ui-on-backend` | `loom.auth-ui-misplaced` |
| `loom.channelsource-unsupported-transport` | `loom.channelsource-transport-invalid` |
| `loom.seed-raw-unsupported-column` | `loom.seed-raw-column-invalid` |
| `loom.store-url-field-unsupported` | `loom.store-url-field-invalid` |
| `loom.interp-format-unsupported` | `loom.interp-format-unknown` |
| `loom.ui-handler-unsupported` | `loom.ui-handler-statement-unknown` |

No behaviour change: same checks, same messages, same emission sites — only the
stable ids move, along with their `src/diagnostics/messages.ts` catalog keys
(18 of the 19 had entries). The renamed rows leave the register entirely; it
now holds 50 rows (42 `gap` + 8 `scope`).

**Gotcha for whoever does a rename like this next:** a repo-wide
search-and-replace rewrote *both sides of the arrow* in this very section,
turning the mapping into `X-invalid → X-invalid`. Prose that documents a rename
is data the rename script will happily eat. Check the doc that describes the
change, not just the code.

## Slice 3 — mission every orphaned gap (LANDED)

23 of the 42 gaps had no owner. Six missions minted, grouped by the shape of the
work rather than by code name: **M-T6.32** capability emission, **M-T6.33**
lifecycle stamps, **M-T6.34** event-sourced storage, **M-T6.35** persistence
adapters, **M-T6.36** Java emitter shapes, **M-T1.20** frontend surface.

Two invariants make the ownership stick, both mutation-proven: every `gap` cites
a mission, and **every cited id resolves to exactly one `## M-Tx.y` heading** in
`docs/new-plan/`. The second was not decoration — T6 carried three duplicate
mission ids (`M-T6.25` ×3, `M-T6.26` ×3) from two separate renumbering attempts
that had each collided again, so the field would have pointed at ambiguity.
Renumbered to M-T6.29/30/31 in the same change.

### First drain (M-T6.33, 2026-08-11)

The lifecycle-stamp unit re-verified as **not gaps at all** — its five codes were
one shared body whose two arms read only the model (`dep.auth`, `sys.user`,
`agg.persistedAs`), never a backend capability. Renamed to
`loom.stamp-principal-without-auth` and `loom.stamp-on-event-sourced-invalid`;
five validators collapsed to one; five register rows removed. **`MAX_OPEN_GAPS`
came down by five** (the live value is the constant in
`test/system/unsupported-register.test.ts`).

Note how that number moved: **by re-classification, not by emitting anything.**
Two of the remaining five units (M-T6.32, M-T6.35) carry the same verify-first
flag for the same reason, so expect it to move that way again —
`loom.filter-bypass-unsupported` ("`ignoring` … has no effect") in particular
reads like the `-no-effect` rows slice 2 renamed out.

**2026-08-17 — the prediction held, twice.** M-T6.32's verify-first step came
back **closed on the platform axis**: all four capability sets
(`supportsNonRelationalFilter`, `FILTER_BYPASS_FAMILIES`, `AUDIT_OP_BACKENDS`,
`PROVENANCE_BACKENDS`) are 5/5 with named emitters — including the
`loom.filter-bypass-unsupported` row called out above. **M-T6.34** (event-sourced
storage), which carried no verify-first flag, was overturned the same way:
`EVENT_SOURCING_BACKENDS` and `EVENT_SOURCING_WORKFLOW_BACKENDS` are both 5/5.
The residue in each case is on the **adapter** axis, not the platform one, and
belongs to M-T6.35. Reading: the verify-first flag was under-applied — every
register row minted from a code identity rather than from a re-read emitter
deserves it.

That mission also surfaced a gate hole worth remembering: the five old sites
were **invisible to `diagnostic-catalog.test.ts`**, because its scanner only
records a site whose `code:` is a *string literal* and the old sites emitted
`code: backend.code` — a property access off the table row. Collapsing the table
made them literals, which is what exposed them. Indirection at the emission site
can hide a diagnostic from a gate that claims to cover the whole surface; the
rest of the scanned surface was surveyed and is clean.

## Open slices

**Slice 4 — the full 419-code registry.** Extend beyond the suffixed subset to
every `loom.*` code, with `kind: "rule" | "gap"`, a docs anchor, and a
completeness test (an unregistered code fails the fast suite — the shape
`walker-stdlib-completeness.test.ts` and `print-completeness.test.ts` already
use). This is where the 143 undocumented codes and the 8-of-419 fix-hint
coverage get addressed. **Deliberately last** — it applies to the ~350 `rule`
codes, which do not drain and are not urgent. The gap ratchet in slice 1 is the
piece the policy actually needs.

## Sequencing note

The ratchet's real moment is **after** the drain, not during it — it does not
guard a list that is actively shrinking, it guards the zero afterwards. Slice 1
landed now anyway because the *enumeration* is the sprint's input, and the pin
comes free once the rows exist.
