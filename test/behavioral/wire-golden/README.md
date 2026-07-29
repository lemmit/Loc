# Wire goldens — the canonical cross-backend runtime contract

One file per shared behavioral system (`../systems/*.ddd`). Each is the
**reviewed answer key** for the exact bytes a booted backend returns when the
emitted `test e2e` suite is replayed against it: an ordered list of
`{seq, method, templated path, status, normalized body}`.

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
  vote would have broken the one correct backend.
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

## Known divergences

Live exceptions are **explicit** in [`test/_helpers/wire-waivers.ts`](../../_helpers/wire-waivers.ts),
each naming its RS-rule and its exit. The registry **ratchets down**: a waiver
that stops matching fails the gate as stale, so a fix must delete its waiver in
the same PR.
