# Reserved-surface signposting — make half-built honest

**Status:** PROPOSED
**Counterpart to:**
[`surface-redundancy-cuts.md`](./surface-redundancy-cuts.md) (cuts remove
the truly-dead; this makes the *roadmap* surface honest).

## Problem

The deepest "surprise" in Loom is not hard syntax — it is surface that
**parses, validates, and lowers, then silently emits nothing.** A user
writes it, gets no error, and gets no output. Worse, the handling is
*inconsistent*:

- `resource { ttl: … }` → the validator **warns** ("no-op knob").
- `storage { type: kafka }` → **silent**, emits nothing.
- `route "…" -> Ctx.Handler` → **silent**, emits nothing.
- `commandHandler … { }` → **silent**, emits nothing.

Same situation — "declared, not yet emitted" — three different behaviors.
*That* is the surprise, and it is the opposite of "no surprises." The fix is
not to delete these (they are roadmap, not dead) — it is to make the gap
**loud and uniform.**

## Proposal — one diagnostic for "reserved, not emitted"

A single diagnostic category, `loom.reserved-not-emitted`, raised
*identically* by every surface that is accepted-but-not-yet-emitted:

- **Default: a warning** — it does not break builds, but it prints, once,
  per reserved construct used, naming the feature and its tracking status.
- **Opt-in strict** (`--strict-reserved` / config) — promotes it to an
  error, for teams that want "no half-features in my generated app."

Every reserved surface routes through it, so the behavior is predictable:
write a reserved thing → get told it is reserved, every time, the same way.

## What it covers (roadmap surface — signpost, don't delete)

From the framework-magic + inert-surface audits, the accepted-but-unemitted
set (each is roadmap, so *not* a `surface-redundancy-cuts` deletion):

- unrealized `StorageType` values (`kafka`, `redis`, `elastic`,
  `meilisearch`, `clickhouse`, `bigquery`, `mysql`, `sqlite`);
- `cache` / `replica` resource kinds (no read-routing yet);
- inert `resource` knobs (`ttl`, `every`, `retain`, `readonly`, `keyPrefix`);
- `route` transport bindings + `commandHandler` / `queryHandler` (the
  un-emitted application/transport layer);
- the `envelope` generic carrier (no backend emits a stable shape);
- `loads:` eager-load specs (lower to a no-op today).

The list is not fixed — it is *whatever is marked reserved* (below), so it
shrinks automatically as emitters land.

### Deferred-keyword debt — the highest-value application

A review of the whole proposal corpus found the single largest
surface-stability risk is **pre-settling common-word keywords for sugar that
hasn't shipped** — each books soft-keyword-sprawl or collision debt before
the feature exists. Prime candidates to hold *unreserved* until emission,
routed through this mechanism rather than declared "settled":

- MVU / effects family — `spawn`, `attempt`, `async`, `onError`, `errors`
  (`async-actions-and-effects`, `error-handling-and-failure-sink`);
- quickstart / channels — `email`, `job`, `cached`, `live`
  (all common field names: `user { email: … }`, `Build { … }`);
- messaging — `channel`, `delivery`, `retention`, `carries`, `key`,
  `projection`, `keyed` are hard-reserved **today** with *zero* soft
  re-admission (a model with `Shipment { delivery: date }` fails to parse).

The rule this proposal implies: **do not reserve a common-word keyword until
its emitter lands.** Until then the feature is a `reserved-not-emitted`
diagnostic on a *placeholder* syntax, not a keyword grabbed from the
identifier namespace. This directly serves the anti-sprawl goal.

## Mechanism

Two options for how a construct declares itself reserved:

1. **A central registry** — one list of `(construct, reason, tracking-link)`
   at the validator layer; the check walks the IR and raises the diagnostic
   for any listed construct that is present. Simple, one place to read
   "what's reserved."
2. **An in-tree `reserved("reason")` marker** on the grammar rule / lowered
   node, surfaced by a generic validator pass. Keeps the reason next to the
   feature.

Either way it lives at the validator layer (phase ④/⑦), never in the
emitters, and the diagnostic text names the feature + points at its tracking
doc.

## Why this is the high-leverage "no surprises" win

- It converts every silent no-op into an **honest signal** — the single
  biggest predictability gain, and it is **additive** (a warning), so it
  cannot break anyone.
- It **preserves the entire roadmap** — no feature is lost; the design
  ambition stays.
- The reserved list becomes a **compiler-enforced TODO** of exactly what is
  left to implement — more reliable than a doc, and it *self-empties* as
  emitters ship (marking something reserved, then removing the mark when it
  emits, is the lifecycle).
- Marking something reserved becomes a **reviewed decision** — you cannot
  accidentally ship accepted-but-silent surface; you either emit it or
  declare it reserved.

## Relationship to the other proposals

- **`surface-redundancy-cuts`** removes what has *no future* (redundant /
  single-value / always-invalid). **This** signposts what *has* a future but
  isn't built. Together: nothing parses-and-silently-does-nothing.
- It gives the parity-debt work (`docs/old/proposals/platform-parity-debt.md`) a
  runtime surface — a per-backend gap becomes a `reserved-not-emitted`
  diagnostic rather than a silent divergence.

## Open questions

1. **Default severity** — warning (recommended, additive) vs. error. If
   warning, is there a per-project config to escalate?
2. **Granularity** — per-*value* (`type: kafka` reserved, `type: postgres`
   fine) vs. per-*feature* (the whole `route` construct). The registry
   supports both; the question is the reason-text granularity.
3. **Marker vs. registry** (mechanism above) — one central list, or a
   `reserved(...)` annotation co-located with each rule.
4. **Codegen behavior under warning** — emit nothing (today) vs. emit an
   explicit stub/`TODO` comment in the output so the gap is visible in the
   generated project too.
