# Fleet execution plan — 2026-08-31

*Scope: everything in [`../audits/real-todo-2026-08-30.md`](../audits/real-todo-2026-08-30.md)
**except T7 (deployment & operations), which the owner has taken out of scope**, plus the
remaining waves of the merged 251-row ledger. Written for execution by fleets of Opus
agents. Base: `main` @ `0a3f189`.*

**What changed under the audit while it was being written** — reconcile before dispatching:
`#2668` (ledger + wave 1, 19 rows), `#2694` (wave 2, 25 rows) and `#2690` (pairwise on all
five backends) all **merged**. `#2682` claims the diagnostic-firing census drains to **0**.
`#2696` drains two of the twelve `E2E_LESS_CORPUS_FIXTURES` entries. `#2689` mints six new
missions (M-T1.26, M-T4.12, M-T5.25, M-T6.50, M-T6.51, M-T9.39). Every one of those is
folded into the waves below.

---

## The one thing that decides whether a fleet works here

**Parallelism is bounded by file-tree disjointness, not by agent budget.** The merged
`targets-completeness-2026-08-30.waves.json` already partitions its 134 P0–P2 rows into 13
packets whose `fileTrees` do not overlap — that is why its wave 1 and wave 2 landed cleanly.
This plan keeps that discipline and extends it to the rest of the audit.

There are exactly **three shared resources** every packet contends for. Each gets a
protocol, because each has already caused a real collision in this repo:

### 1. The diagnostic catalog — `src/diagnostics/messages.ts` (2 880 lines) + `unsupported-register.ts`

**10 of the 13 ledger packets carry `needsValidatorSlot: true`.** Every honest-gate row
appends a `loom.*` code to `messages.ts`, a row to `unsupported-register.ts`, and a case to
one `src/ir/validate/checks/*.ts` leaf. Ten agents editing one 2 880-line catalog
concurrently is a guaranteed conflict storm.

> **Protocol — slot pre-allocation.** Wave 0 lands ONE docs+diagnostics PR that mints every
> `loom.*` code, `messages.ts` entry and `unsupported-register.ts` row the wave needs, keyed
> and alphabetically placed. Worker agents then only **raise** an already-existing code from
> their own emitter or check leaf. The 18 check leaves under `src/ir/validate/checks/` are
> per-theme, so per-packet check edits land in different files — that is disjoint enough
> once the catalog itself is pre-allocated.

### 2. The wire goldens — `test/behavioral/wire-golden/**` (50 files)

Any behavioural change rebaselines them, and a golden-heavy PR rots fastest (the 08-10
attention list recorded `#2485` as "48 of 61 files are wire goldens any behavioural PR
rebaselines").

> **Protocol — one golden owner per wave.** Packets that rebaseline goldens land **last**
> in their wave, in the fixed order listed per wave below. Everyone else rebases onto them.
> Never two golden-touching packets in flight at once.

### 3. Mission IDs in `docs/new-plan/T*.md`

Duplicate-ID collisions are this repo's most-repeated process failure: `M-T6.43` headed two
missions, `M-T9.25`/`M-T9.26` each headed two, `T6` once carried `M-T6.25` ×2 and
`M-T6.26` ×3. M-T9.32 ships the *detection*; the ID-allocation half is still open.

> **Protocol — the dispatcher mints every ID up front**, in the same Wave 0 PR, before any
> worker opens a draft PR. A worker never invents a mission ID.

---

## Wave 0 — Reconcile and pre-allocate · 2 agents, serial · blocks everything

Nothing else dispatches until this lands. Its whole job is to make the later waves
collision-free and to stop agents rebuilding merged work — the failure mode that produced
an empty commit on `main` (`f4df492`/`#2419`) when two agents fixed the same defect.

| Agent | Task | Deliverable |
|---|---|---|
| **W0-A** | Ledger reconciliation. Walk all 251 rows of `targets-completeness-2026-08-30.ledger.json` against merged `#2668`/`#2694`/`#2690` and open `#2696`/`#2689`/`#2673`–`#2678`. Add a `status` field per row (`drained` + PR / `open` / `claimed` + PR). Fold in the 5 findings from `real-todo-2026-08-30.md` and the 6 missions `#2689` mints. | `…ledger.json` gains `status`; a new `remaining.json` every later wave reads. **One number as the exit criterion: how many P0–P2 rows are actually left.** |
| **W0-B** | Mission-ID minting + the **reserved-names table** (see below). | One docs-only PR. |

> **Resolved 2026-08-31 — a pre-allocation PR is impossible; the reserved-names table is the only form.** Both register gates refuse an un-raised entry, by design:
> `test/system/unsupported-register.test.ts` invariant 2 — *"every registered code is STILL EMITTED — a drained gap must delete its row in the same PR, so the register ratchets down instead of becoming a graveyard"*; and `test/system/diagnostic-catalog.test.ts` invariant 3 — *"No orphans — every catalog entry is reachable from a call site."* A row minted ahead of its raiser fails both. That is the right behaviour and should not be weakened for a fleet's convenience.
>
> So W0-B publishes an **allocation table** instead, and each worker adds its own catalog row *in the same PR as the raiser*. Collision-free anyway, for a reason worth stating: `messages.ts` (514 keys) is **thematically grouped, not alphabetical** — so each packet's codes land in a different region of the file by construction, and disjoint-region inserts 3-way-merge cleanly. The table therefore assigns each reserved name **an anchor key to insert after**, not just the name. Workers insert at their anchor and never reflow the file.

**Why W0-A is not optional:** two of my own audit's five recommendations were already
overtaken within 24 hours. A fleet dispatched off a stale register spends its first hour
rediscovering merges.

---

## Wave 1 — Ledger P0 + the two structural seams · 7 agents

Straight from the merged `waves.json`, minus what wave 1/2 already drained (W0-A says
exactly which). **The sequencing constraints in that file are binding** — they were derived
from real coupling, not guessed:

- `cli` before `validator-diagnostics` and before every honest-gate row *(if the
  `ir-warnings-invisible-in-cli` row is not yet drained — `#2668` claims it; W0-A confirms)*
- `validator-diagnostics` VAL-1 before any other validator work
- `walker-shared` before `frontend-js`, `flutter`, `feliz`
- `feliz` FE-4 before any other feliz row
- `dotnet-adapters` ADP-2/ADP-3 as one decision, before ADP-9
- `elixir` ELX-ESCAPE-FUNNEL first in its packet
- the seed family (`SEED-*` + `CB-C6`) as one cross-backend slice
- the TPH cluster (`CB-C2/C3/C4/C10/C11/C12`) as one slice across three packets
- `wire-openapi` after the backend packets

| # | Packet | File tree | Rows (orig.) | Notes |
|---|---|---|---|---|
| 1 | `walker-shared` | `src/generator/_walker/**`, `_expr/**`, `_stmt/**`, `_frontend/**` | 12 | **Highest fan-out — dispatch first.** Every row changes 6–7 frontends at once |
| 2 | `dotnet-adapters` | `src/generator/dotnet/**` | 16 (3×P0) | ADP-2/ADP-3 is one decision |
| 3 | `node-ts` | `src/platform/hono/**`, `src/generator/typescript/**` | 18 (3×P0) | + M-T6.51 (node document finds ignore `ignoring`) |
| 4 | `elixir` | `src/generator/elixir/**` | 25 (3×P0) | biggest packet; ESCAPE-FUNNEL first |
| 5 | `python` | `src/generator/python/**` | 2 | + M-T6.50 (three collector gaps shipping `F821`) |
| 6 | `java` | `src/generator/java/**` | 3 | small; pair with `python` if agent budget is tight |
| 7 | `macros` | `src/macros/**` | 5 | + M-T5.25 (`ignoring` after `group by` silently dropped) |

**Golden order (last, serial):** `elixir` → `node-ts` → `dotnet-adapters`.

**Cross-packet slices** — the seed family and the TPH cluster span three packets each. Give
each to **one** agent that owns the slice across all three trees, dispatched *before* the
per-packet agents touch those files, not concurrently with them.

---

## Wave 2 — Frontends behind the seam · 5 agents · blocked on Wave 1 packet 1

| # | Packet | File tree | Content |
|---|---|---|---|
| 1 | `frontend-js` | `src/generator/{react,vue,svelte,angular}/**`, `designs/**` | 10 ledger rows + M-T1.26 (`Image`/`Avatar` `src:`/`alt:` on the pre-A12 helper) |
| 2 | `flutter` | `src/generator/flutter/**` | 6 ledger rows. FE-3 (routes registered verbatim) first — it is the only P1 that makes the shipped flutter example non-functional |
| 3 | `feliz` | `src/generator/feliz/**` | 7 ledger rows, FE-4 first |
| 4 | **`flutter-component-gate`** | `src/ir/validate/checks/ui-checks.ts`, `test/ir/user-component-deferred.test.ts`, `src/generator/flutter/component-emit.ts` | **Audit Finding 1 — see below.** Separate packet because it is validator-side, and the slot is pre-allocated |
| 5 | `wire-openapi` | `src/system/**`, `src/ir/util/openapi-errors.ts`, `test/conformance/**` | 5 rows — must follow the backend packets |

### Packet 2.4 in full — the Flutter component gate

Verified still live on `main` @ `0a3f189`: `ui-checks.ts:2139` reads
`const COMPONENT_FILTERING_FRAMEWORKS = new Set(["feliz", "angular"])`, and
`test/ir/user-component-deferred.test.ts:73` types its matrix `framework: "feliz" | "angular"`.
Flutter's `component-emit.ts` filters too, so a store-bearing component emits
`const SizedBox.shrink() /* unknown layout component: … */` at every call site with **no
diagnostic** — reproduced from `web/src/examples/store-showcase.ddd`.

Four ungated deferral conditions to cover (`hasAsyncEffectAction` is already gated by
`loom.flutter-async-effect-unsupported`):

| Deferral | Site |
|---|---|
| `usesStores` — reads a store field / calls a store action | `component-emit.ts:86` |
| `usesRouteId` — a `byId(id)` read | `component-emit.ts:84` |
| stateful **and** read-bearing (`ConsumerStatefulWidget`) | `isReadConsumer`, `:139` |
| `derivedNeedsShell` — a `derived` reaching a store / route id / `currentUser` | `:161` |

**Do the root cause, not just the row.** The gate's completeness test derives its scope from
a hand-written union type, so a gate whose scope is a literal cannot ratchet — which is
exactly how a third filtering emitter joined the codebase without joining the set. The
durable fix asks each frontend's component emitter whether it filters, the way
`WALKER_PRIMITIVES` asks each primitive whether it has a `heex` renderer. Generalizing that
across every hand-enumerated `Set` in `src/ir/validate/checks/` is Wave 5 packet 4.

---

## Wave 3 — Cross-feature crossings · 4 agents

The pairwise corpus is where the remaining *silent* bugs live: every finding in the waiver
registers came from feature × feature, not from any single-feature corpus. My 522-crossing
single-feature matrix found **zero** new silent gaps; the three-entry pairwise register
found three, two of which ship a project that does not compile.

| # | Packet | The bug | File tree |
|---|---|---|---|
| 1 | `pairwise-F1` | `shape: document` × `policy { allow … }` **crashes codegen** on node/java/python — the `authz-filter` `ExprIR` reaches the generic dispatcher and `renderExprWith` throws its invariant | `src/generator/_expr/target.ts` + the three document read paths |
| 2 | `pairwise-F2` | `mask unless` × non-relational shape on drizzle → **TS2339**: routes call `repo.toWireMasked` but only the relational repository builder emits it | `src/platform/hono/**` repository builders (3 of them) — changes each repo's PORT surface, so it needs per-shape tests + the behavioural leg |
| 3 | `pairwise-F5` | principal capability filter × `shape: document` × mikroorm → **TS2304**: the in-app predicate reads `currentUser` with no `requireCurrentUser()` bind | `src/generator/…/repository-document-builder` (mikroorm arm) |
| 4 | `pairwise-dimensions` | **Widen the corpus, don't just fix its findings.** Add the dimension that would have caught these earlier and re-run: the register is a ratchet in both directions, so a stale waiver fails too | `test/pairwise/**` |

Packet 4 is the leveraged one. Three waivers from a young corpus is a *discovery rate*, not
a bug count — the corpus has not finished telling us what is broken.

**Check `#2690` before dispatching** — it touched this register and re-opened two findings
as half-fixed.

---

## Wave 4 — Live capability gaps · 7 agents

The ~12 live rows of `unsupported-register.ts` (41 `gap` rows total; ~24 are latent seams
that ship on every target and must **not** be counted as backlog; ~5 are misuse/semantic
errors misfiled under the suffix).

| # | Packet | Gap | Size | Owner mission |
|---|---|---|---|---|
| 1 | `frontend-collection-ops` | **`loom.frontend-collection-op-unsupported`** — every stdlib collection op except `map` is a hard error in any page/component/store body, on all six frontends. `orders.count` does not compile | **L** | M-T1.20 |
| 2 | `elixir-document` | `loom.vanilla-document-unsupported` — the elixir `shape: document` residue: provenanced ops, derived-field predicates, cross-aggregate deref, VO/private/service/resource calls, reference collections | **M** | — (mint) |
| 3 | `dapper-residue` | `loom.dapper-unsupported` (aggregating projection over document/event-sourced source; deep/global tenancy scope filter; declared migration steps) + the dapper arm of `find-predicate` | **M** | M-T6.35 |
| 4 | `mikroorm-residue` | `loom.mikroorm-unsupported` (scalar-array root field; abstract base owning `contains`; migration steps) + the mikroorm arm of `find-predicate` | **M** | M-T6.35 |
| 5 | `store-persist-codecs` | `loom.store-lifetime-target-unsupported` — feliz and flutter cover **different** type sets, so a `persist:` store portable between them does not exist. Converge them | **S** | M-T1.20 |
| 6 | `component-async-effect` | `loom.feliz-async-effect-unsupported` + `loom.flutter-async-effect-unsupported` — `match await` in a component host. One seam, two targets; pairs naturally with 2.4 | **M** | M-T1.20 |
| 7 | `register-hygiene` | Rename the ~5 not-debt rows out of the `-unsupported` suffix (the slice-2 precedent renamed 19); collapse the three `load` v1 limits (`handler-load-nullable`, `workflow-load-array`, `workflow-load-nullable`) into **one** mission — they are one design decision wearing three names | **S** | M-T9.27 slice 4 |

**Two decisions the owner should make before dispatch, not during:**

- **`DataGrid` on HEEx** (`loom.datagrid-unsupported-target`, the last `KNOWN_HEEX_GAPS`
  entry). The pin's stated reason is sound — a TanStack client row model has no LiveView
  analogue, and it would need multi-column `ORDER BY` the repository does not expose. But
  the pin next to it (`Chart`) sat unexamined for a whole phase on a premise that turned
  out false. Either re-examine it deliberately or promote it to a settled never like
  Flutter's, per D-DATAGRID-TARGETS. **Don't fleet it undecided.**
- **`loom.toast-message-unsupported`** is a v1 expression subset on *every* target, not a
  parity gap. Widening it is a language decision (which expressions may reach a toast), so
  it needs a ruling before it needs an agent.

---

## Wave 5 — Coverage that hides gaps · 4 agents

Every wave above is only as trustworthy as the gates that check it. These four are the
enabling layer, and each closes a class rather than a row.

| # | Packet | Work |
|---|---|---|
| 1 | `e2e-less-drain` | `E2E_LESS_CORPUS_FIXTURES` is **12** and has been growing (9 on 08-17) — honestly, as compile-tier witnesses register rather than fake a runtime leg, but the effect is the same: 12 features are proven to generate and compile, never to run. `#2696` takes `policy-document` + `lifecycle-guard`. The next tranche is the fixture-change class (`extern`, `extern-handlers`, `handler-triad` — each needs `Order` to gain a create before any caller is expressible) |
| 2 | `flutter-runtime-leg` | **Flutter is never booted.** M-T9.38, currently `blocked(M-T1.21)` — `#2678` unblocks it. Finding 1 is exactly the shape that slips through a compile-only gate: it compiles, it analyzes clean, and the widget is simply absent |
| 3 | `feliz-runtime-leg` | Same, for Feliz. `#2674` unblocks it |
| 4 | **`gate-scope-derivation`** | The Finding-1 root cause, generalized. Audit **every** hand-enumerated `Set`/union in `src/ir/validate/checks/` that names targets or frameworks (`COMPONENT_FILTERING_FRAMEWORKS`, `CHART_FRAMEWORKS`, `PROJECTION_READ_FRAMEWORKS`, `DATA_GRID_FRAMEWORKS`, the `*_BACKENDS` family) and, where the set is derivable from the emitters, derive it. Where it is not, pin it with a completeness test that fails when a new target appears. This is the §F3 "one exhaustive walker instead of hand-enumerated switches" argument applied to the validator |

Packet 4 is the highest-leverage item in this whole plan. It converts a recurring bug class
into a gate — and the audit found the class by tripping over one instance of it.

---

## Wave 6 — Unbuilt subsystems · **OUT OF SCOPE (owner, 2026-08-31)**

*The owner has taken the unbuilt subsystems out of this plan alongside T7. The waves execute
0 → 5 and stop. This section is retained as the record of what was deferred and why the
sequencing below was chosen, so the next planner does not re-derive it.*

These are features with no code at all. **A fleet cannot parallelize an unproposed XL** —
dispatching 8 agents at a subsystem with no agreed design produces 8 incompatible designs.
The right first move is one design agent per subsystem producing a proposal + mission
decomposition, then a fleet per *approved* subsystem.

| Subsystem | Mission | Why it ranks here |
|---|---|---|
| **Brownfield adoption** (generate against an existing database) | M-T2.5 · XL · needs proposal | **Highest product value on the list.** For a product whose pitch is "the model is the source of truth", inability to adopt an existing schema is the single biggest adoption blocker |
| **Test-authoring DSL** | M-T5.19 · placement shipped, authoring unbuilt | Compounds with everything: it is how the runtime legs Wave 5 needs get written |
| **`timerSource` tail** | M-T4.1 · `partial` | Timezone/overlap sugar + saga deadlines. The temporal hole is mostly closed; this is the residue |
| **Callable unification** | M-T5.21 · design signed off in `#2444` | Cost-of-growth work: one production for "a named body runs here". Already has sign-off, so it can skip the design agent |
| **Delegating DAP debugger** | M-T8.1 · XL | `src/dap-server/` ships the remap layer only; the proxy that spawns `js-debug`/`coreclr`/JDWP is unbuilt. Editor-verified frontier — real work, low urgency |
| Domain-services Shape B · read-caching tier · backend-to-backend calls · LSP tail · static-analysis breadth · playground preview breadth | M-T5.14, M-T4.9, M-T4.10, M-T8.4, M-T8.9, M-T8.10 | P3 tail. Genuinely optional product surface — schedule against demand, not against the list |
| Mutation testing | M-T8.8 | Explicitly parked. Leave parked |

**Recommended order:** brownfield proposal first (longest lead time, highest value), test-authoring
DSL second (unblocks Wave 5's runtime legs), callable unification third (design already
signed off, so it is a straight implementation fleet).

---

## Not in this plan

- **T7 — deployment & operations.** Owner has taken it out of scope: the proxy/gateway, `ddd dev` + `ddd deploy`, terraform, deployable networking, the ops UI, k8s hardening.
- **The merge queue.** 39 gates already carry `merge_group:` triggers with stable check names, drift-pinned by `merge-queue-readiness.test.ts`. It is inert because GitHub offers merge queues only on org-owned repos. **This is an admin action (move the repo under an org), not engineering work** — no agent can do it, and it remains the cheapest available fix for "`main` can go red after a green PR". M-T9.7, `blocked(admin)`.
- **The ~24 latent register rows.** They ship on every target; they are the seam a *new* target would gate on. Draining them means deleting a gate, which is a decision, not a task. The matrix is frozen (2026-07-17), so there is no new target coming to trip them.

---

## Fleet mechanics

### Dispatcher checklist (once per wave)

1. Re-run W0-A's reconciliation delta — **on fresh `main`**. A wave dispatched off a
   week-old register rebuilds merged work.
2. Open **every** draft PR for the wave up front, one per packet, before any agent
   implements. The draft PR is the claim ticket; opening them all first makes intra-fleet
   collision impossible and lets a worker that finds its row already drained stop cleanly.
3. Post the wave's golden order and the pre-allocated slot table into each PR body.
4. Dispatch. One packet per agent. Never two agents in one file tree.

### Worker kickoff prompt

> Implement packet **`<packet-name>`** from `docs/new-plan/fleet-plan-2026-08-31.md`
> (wave `<N>`), rows `<ids>` from `docs/audits/targets-completeness-2026-08-30.ledger.json`.
> Follow `docs/new-plan/RUNBOOK.md` end to end. Your draft PR is **`#<N>`** — already open;
> update its body, do not open another. Your file tree is **`<tree>`** — do not edit outside
> it; if a fix needs a file in another packet's tree, write the handoff in your PR body
> instead of half-fixing it. Diagnostic codes and mission IDs are **pre-allocated** in the
> Wave 0 table; do not mint your own.

### The bar (non-negotiable, from `CLAUDE.md`)

- **Mutation-prove every gate.** A green first run proves nothing. Revert the fix with a
  **file copy**, never `git checkout -- <path>` — checkout restores HEAD and silently
  discards every other uncommitted edit in that file, so the proof fails for an unrelated
  reason and reads as a pass. Read *which* assertion failed.
- **Never a silent gap.** A feature lands on every target or gets an honest `loom.*` gate on
  the others. Never a crash, never a TODO emitted into compiling output.
- **Run the gates locally.** `docs/testing.md` → "Running any CI gate locally" is the
  workflow → command reverse index; completeness is pinned by `local-run-mapping.test.ts`.
  Do not use CI as a compiler — it burns a shared ~20-slot runner pool.
- **Waivers ratchet.** A fix deletes its waiver in the same PR. A drained `gap` row is
  deleted from `unsupported-register.ts` in the same PR.
- **Stay in your tree.** A packet that half-fixes into a neighbour's tree is worse than one
  that hands off — `#2668` deferred `F2-ADP-3` with a written handoff for exactly this
  reason, and that was the right call.

### Sizing

| Wave | Agents | Parallel? | Gate to clear before the next wave |
|---|---|---|---|
| 0 | 2 | serial | `remaining.json` exists; slot + ID table published |
| 1 | 7 | yes, minus the golden tail and the two cross-packet slices | all P0 rows drained |
| 2 | 5 | yes | walker seam landed and frontends rebased onto it |
| 3 | 4 | yes | pairwise generation + tsc waiver registers back to 0 |
| 4 | 7 | yes | live `gap` rows down from ~12; register hygiene landed |
| 5 | 4 | yes | flutter + feliz have a runtime leg; gate scopes derived |
| ~~6~~ | — | — | **out of scope (owner, 2026-08-31)** — the plan ends at wave 5 |

**~29 implementation agents across waves 1–5**, plus 2 in wave 0. Use Opus for every
implementation packet: each one is a cross-target correctness change with a mutation proof
attached, which is precisely where a weaker model produces a green-looking PR that proves
nothing.

### Risk register

| Risk | Mitigation |
|---|---|
| Register goes stale mid-wave (happened twice during the audit itself) | W0-A re-runs at the head of every wave, not just wave 0 |
| Two agents fix the same defect (`f4df492` was an empty commit narrating an already-landed fix) | All draft PRs opened before any implementation; a worker that finds its row drained stops and reports |
| The diagnostic catalog conflicts 10 ways | Slot pre-allocation (Wave 0-B) |
| Golden rebaseline churn | One golden owner per wave, fixed order, landed last |
| A packet's "fix" is proven by a gate that never reaches it | Mutation proof stated in the PR body with the failing assertion named — the recurring failure shape in `experience_gathered.md` §59/§63/§84 |
| **A shared working directory means a shared `out/`** — a concurrent agent running `npm run build` silently invalidates every other agent's in-flight probe | **Observed, not hypothetical: two of the seven Wave 0-A agents independently hit it and had to re-run their probes.** `bin/cli.js` runs the *compiled* emitters, so a probe against a half-written or stale `out/` reads as evidence and is not. Fix: the **dispatcher** builds once and tells workers *"`out/` is current — do not rebuild"*; a worker that believes it is stale reports rather than rebuilding under its peers. Where packets must build (a source-touching implementation wave, i.e. every wave after 0), give each agent its own **git worktree** — one `out/` per agent, no shared mutable build |
| ~~Wave 6 fleeted before design~~ | Moot — wave 6 is out of scope |
