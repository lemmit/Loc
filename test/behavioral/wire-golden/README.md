# Wire goldens — the canonical cross-backend runtime contract

One file per shared behavioral system (`../systems/*.ddd`). Each is the
**reviewed answer key** for the exact bytes a booted backend returns when the
emitted `test e2e` suite is replayed against it: an ordered list of
`{seq, method, templated path, status, normalized body}`.

The tail entries of every file are not from the e2e suite. They are **probes**,
issued through the same dispatch after the tier finishes, because an emitted
suite only ever requests what the API *serves* — so a whole class of response
was invisible to every golden. Appended *after* the tier so they never shift the
ordinals the rest of the file aligns on:

- the **framework-fault probes** (RS-9) — a wrong verb, an unknown path, and a
  body the server cannot parse. Before these existed the golden ran five legs
  green while those three requests answered five different shapes across three
  statuses — the gap `framework-error-contract-parity.test.ts` had to cover
  statically because nothing booted ever reached it.
- the **absent-read probes** (M-T6.31) — for each projection-show
  (`/api/projections/<p>/{key}`) and workflow-instance-show
  (`/api/workflows/<wf>/instances/{id}`) URL the tier hit, the same route
  re-requested with a key of the same shape that cannot exist. The `test e2e`
  DSL has no verb for "read a key that isn't there", so those two routes shipped
  three different 404 envelopes across the five backends with every golden
  green. Only projection/instance-bearing cases grow an entry; a case that reads
  neither route is skipped rather than guessed at.

Every backend runner (`../run.mjs`, `run-python`, `run-dotnet`, `run-java`,
`run-elixir`, plus the `run-dapper` / `run-mikroorm` persistence-adapter legs)
records its own run at its single `fetch`/`app.fetch` chokepoint and diffs it
against the golden here. A divergence fails that backend's **already per-PR**
`behavioral-e2e*.yml` workflow.

## Why a golden instead of an all-pairs diff

M-T9.11 slice (a) diffed the five backends against **each other** over the full
compose stack, nightly. Two problems, both fixed by this shape:

- **No oracle.** Pairwise disagreement says *they differ*, never *who is right*.
  RS-11 is the cautionary tale: three backends agreed on `version: 0` and all
  three were **wrong** (the `versioned` capability declares `= 1`). A majority
  vote would have broken the one correct backend. RS-15 is the second: four
  backends answered `400` for a tripped `precondition` and the lone `422` was
  the RFC-correct one, so the *majority* moved.
- **Nightly.** A golden turns the N-way diff into N **independent one-way**
  gates — if A ≡ golden and B ≡ golden then A ≡ B — so each rides a workflow
  that already boots that backend on every PR. No new CI boot.

The nightly all-pairs report (`.github/workflows/differential-report.yml`)
stays, as the **discovery** engine over the wider compose stack (showcase,
phoenix). This directory is the **enforcement** half.

## Normalization — what is compared and what is not

`toWireEntry` (`test/_helpers/wire-record.ts`) collapses the legitimately
per-run values and keeps everything else:

| Collapsed | Kept (and therefore contract) |
|---|---|
| uuid values → `<uuid>` | field **names** and key sets |
| ISO timestamps → `<timestamp>` | enum casing |
| `id` / `*Id` / `traceId` values → `<volatile:key>` | `[]`-vs-`null` absence shape |
| uuid/int path segments → `{id}` | list ordering, decimal values, status codes |
| query-param order | the request sequence itself |
|  | RFC 7807 error bodies — `type`/`title`/`status`/`detail`/`instance` |

Keys are **never** dropped — a missing timestamp key still surfaces as a
`key-set` divergence even though its value is normalized away.

## Changing a golden

A wire change is supposed to be visible. Rebaseline deliberately:

```bash
cd test/behavioral && LOOM_WIRE_UPDATE=1 node run.mjs ledger payments shapes sales
```

Then **read the diff** — it is the wire-contract change your PR is making, and
a reviewer approves it as such. `node` is the oracle these are captured from
(it is the only tier that boots in-process, so it is the cheapest to re-derive
and the one every other leg is measured against).

Escape hatch for local debugging only: `LOOM_WIRE_OFF=1` skips the gate.

## Adding a case — the golden is not optional

Every case a runner records is compared, so a NEW case (a corpus fixture that
grows a `test e2e`/`test` block, a new `../systems/*.ddd`, a new api entry in
`../corpus.json`) must land with its golden in the same PR. Two gates say so:

- **fast, no boot** — `../golden-coverage.test.ts` (part of plain `npm test`)
  derives the required case set the way `../cases.mjs` does and fails naming any
  case with no golden, plus any golden no case claims. This is what keeps the
  omission out of `main` instead of discovering it on seven booted legs.
- **booted** — `../wire-differential.mjs` fails the same way per backend.

Deliberately leaving a case uncompared needs a signed `GOLDEN_OPT_OUT` entry in
`../wire-differential.mjs`; it ratchets, like the waivers below.

## Known divergences

Live exceptions are **explicit** in [`test/_helpers/wire-waivers.ts`](../../_helpers/wire-waivers.ts),
each naming its RS-rule and its exit. The registry **ratchets down**: a waiver
that stops matching fails the gate as stale, so a fix must delete its waiver in
the same PR.
