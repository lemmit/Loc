# CI gating — what runs where, and how `main` stays green

Why this exists: agents landed several breakages on `main` that no PR check
could have caught, because the gates that *would* have caught them don't gate
PRs. This documents the tiers and the merge-queue path that fixes it without
making every push slower.

## The failure mode

Branch protection requires only **`tests-passed`** (the fast vitest rollup).
Every heavy gate — the runtime/boot e2e suites, the deploy build — is a
*non-required* check. Three consequences:

1. **Many heavy gates don't run on a PR by default.** `tenancy-e2e`, the five
   `*-obs-e2e`, the five `*-oidc-e2e`, and `auth-oidc-compose-e2e` trigger on
   `push: [main]` only. Whatever they catch, they catch *after* merge — on
   `main`, where it sits red. (Each also accepts a per-PR **label** trigger as
   a manual escape hatch — see "The interim escape hatch" below — but that's
   opt-in, so the default is still post-merge. The cross-backend
   `behavioral-e2e-*` legs and the `pages` build have since been *promoted*
   to real path-scoped `pull_request:` triggers and are no longer in this
   bucket.)
2. **A red heavy gate doesn't block anything.** A gate can be broken (even
   unparseable) and still merge green. `behavioral-e2e-dapper.yml` had an
   unquoted colon in its `name:`, was a permanent `startup_failure`, and stayed
   red across 100% of recent `main` pushes — unnoticed, because it was *never*
   green, so there was no red-transition to alert on.
3. **A gate's `paths:` filter is a third, quieter switch.** Every heavy gate
   narrows itself to the files it thinks can break it. That list is written
   once, against whatever the test imported that day, and the test's
   dependencies then grow without it. The gate stays green and stays listed —
   and for a change confined to an unwatched dir it *never runs at all*, which
   is worse than a vacuous assertion because there is no assertion to inspect.

   Measured in #2397: **all 27 path-filtered gates omitted `src/macros/**` and
   `src/util/**`**; 26 omitted `src/language/**`, 23 `src/system/**`, 19
   `src/ir/**`. So a change to `src/macros/prelude.ts` — where the `auditable`,
   `tenantOwned`, `versioned` and `tenantRegistry` capabilities are defined —
   triggered none of them, as did a change to `src/util/naming.ts` or
   `src/util/code-builder.ts`, both imported by every emitter on every backend.

   The rule now: **a workflow that runs a test which generates a project must
   watch every phase on the generation path** — `src/language/**` (parse),
   `src/macros/**` (expand), `src/ir/**` (lower/enrich/validate),
   `src/system/**` (compose) and `src/util/**` (the naming / code-builder /
   platform-axes leaves every emitter imports). Those five run for *every*
   backend, so no per-backend argument excuses one.
   `test/system/workflow-path-coverage.test.ts` derives "runs a test that
   generates a project" from the test's own transitive import closure (a
   workflow cannot fall out of scope by rearranging imports) and fails the fast
   suite on drift. The generator's shared seams (`_walker`, `_expr`,
   `_frontend`) are deliberately *not* required — they are genuinely
   per-target, and requiring them would produce the false positives that get a
   gate like this weakened into theatre.

`cancel-in-progress: true` on the `push:main` gates made it worse: a rapid
follow-up merge cancels the previous commit's heavy jobs, so a real failure
gets attributed to a later, innocent commit.

> **Every gate in every tier runs locally.** The workflow → local-command
> reverse index is [`docs/testing.md`](testing.md) → "Running any CI gate
> locally"; pushing a commit just to see a check's verdict burns the shared
> runner pool and is never necessary.

## The tiers

| Lane | What | Rule |
|---|---|---|
| **Per-PR, every push** (required) | `test.yml` (fast vitest ×4 shards) + lint + web-tsc → `tests-passed` (unfiltered on PRs); `langium-generated`; `workflow-lint`; the typecheck/compile gates (`hono/dotnet/java/python-build`, `generated-*-build`, `corpus-build`); `behavioral-e2e` (Hono on PGlite, daemonless) as the runtime canary; `pr-gate` (the aggregate verdict over everything that triggered) | Cheap, parallel, no docker/db. Catches most regressions with fast feedback. |
| **Per-PR, path-scoped** (binding via `pr-gate`) | The cross-backend runtime legs `behavioral-e2e-{dotnet,java,python,elixir,dapper,mikroorm}` + `behavioral-ui-e2e` (each fires when the PR touches its backend's emitters, the shared IR, or the harness); the `pages` build (docs/web/src) | Docker/boot cost paid only by the PRs that can break them; when they fire, `pr-gate` makes them blocking. |
| **Merge queue** (`merge_group`, runs once on the final candidate — inert until the repo lives in an org) | The same cross-backend runtime matrix unconditionally, `tenancy-e2e` (10 legs), `*-obs-e2e`, `*-oidc-e2e`, `auth-oidc-compose-e2e`; the full `generated-react-build` Cartesian; `pages` build | What actually breaks `main` **and** the expensive ones. Runs once per landing, not per push. A PR revised 10× pays this once. |
| **Nightly / label** (unchanged) | `conformance-full`, `generated-a11y`, `frontend-fullstack-e2e`, `k8s-e2e` | Broad, slow, low churn — post-hoc is fine. |

Note: `generated-react-build`, `generated-vue-build` and
`generated-angular-build` each emit a **slim** matrix on PRs and the **full**
Cartesian everywhere else. Their `configure` job keys on
`github.event_name == 'pull_request'`, so `merge_group` (like `push:main` and
`workflow_dispatch`) falls through to the full sweep — the per-PR/pre-land
split the tiers call for is already built in, and the queue gets the full
Cartesian on the rebased candidate.

The playground suite is split the same way. `playground-e2e` (the whole
Playwright suite, including the network-gated bundle/boot specs) stays
post-merge / nightly / `run-e2e`-label; `playground-e2e-no-network` runs the
network-free subset (workspace, history, builder, requirements, editor) on
every PR touching `web/**` or `src/**`, so file-management and builder
regressions are caught before merge.

## No merge queue on a personal account: the `pr-gate` check

GitHub offers merge queues only on **organization-owned** repositories
(public on any plan; private on Enterprise Cloud). While this repo lives
under a personal account, the queue below cannot be switched on — and plain
required-status-checks can't substitute for it, because **every PR workflow
here is path-filtered**: a required check that gets path-skipped never
reports, and the PR blocks on "Expected — waiting for status" forever. A
docs-only PR would strand on all of them.

`pr-gate.yml` is the personal-account answer — one aggregate check that
branch protection can require safely. It is **event-driven** (v2): the v1
design was a single long-polling job, and under real load it fed on itself —
each open PR's gate parked a runner slot while polling (six parked gates ≈ a
third of the ~20-slot pool), starving the very jobs it waited for until its
timeout fired and needed a manual label re-arm. v2 never waits:

- It triggers on the `pull_request` events (including `labeled` — `run-*`
  heavy runs join the set — and `ready_for_review`, which fires the
  draft-gated fan-out) **and on `workflow_run: completed` of every other
  workflow**, so each completion re-evaluates the gate; the last workflow to
  finish always produces the final verdict. No polling, no timeout, no
  parked slot.
- Each evaluation is seconds: `scripts/pr-gate.mjs` reads the head SHA's
  check runs once and **posts a check run named `pr-gate`** via the Checks
  API (workflow_run-triggered jobs don't surface in the PR checks UI, so the
  job is `pr-gate-eval` and the canonical name rides the posted check). Any
  triggered red → `failure` with culprits named (fail-fast); checks still
  running → `in_progress` (blocks merge without claiming failure); all
  triggered checks green → `success`. A path-skipped workflow never appears
  on the SHA, so it's OK by construction.
- Zero other checks reporting **blocks** — `test.yml` runs unfiltered on PRs
  precisely so at least one check always comes; pending is *never* green.
- Re-running a red check to green fires `workflow_run: completed` again, so
  the gate re-evaluates **automatically** — no manual pr-gate re-run.
- **`workflow_run` delivery is best-effort, so the gate does not depend on
  it alone.** Under completion storms GitHub drops dispatches — observed
  live: a fully-green PR parked at `in_progress` because the events for its
  final two completions never arrived. Two defenses: the trigger carries
  `branches-ignore: [main, gh-readonly-queue/**]`, so the ~60 push-to-main
  completions per merge stop creating (skipped) eval runs at all — the storm
  source; and a **15-minute scheduled sweep** re-derives the verdict for
  every open PR and posts only where it differs from what's published,
  capping any dropped-event outage at one sweep interval. Both are pinned by
  `test/system/pr-gate.test.ts`.
- The decision core is pure and pinned by `test/system/pr-gate.test.ts` —
  including the fail-closed arms (unknown conclusions, cancelled runs,
  pending-never-green) and the `workflow_run.workflows` list's completeness
  both ways (a workflow missing from the list completes without
  re-evaluating; a stale name re-evaluates nothing).

**Branch protection on a personal account should require exactly two
checks: `tests passed` and `pr-gate`.** Everything else stays non-required
by name but becomes *binding through pr-gate* the moment it triggers.

If the repo ever moves to an organization, drop `pr-gate` from the required
list and follow the merge-queue runbook below instead — the queue subsumes
it and adds what pr-gate cannot: gating the *rebased combination* of
concurrent PRs.

## Draft PRs and the runner queue

The account's GitHub-hosted runner pool allows ~20 concurrent jobs
(Free plan), and a substantive PR push fires 30–50 jobs across the fan-out.
With this repo's claim-first culture — every PR *starts* as a draft and
pushes repeatedly while in progress — draft pushes were the bulk of the
queue load, and the queue was the bulk of CI latency (jobs have sat queued
for an hour before starting).

So the fan-out is **draft-gated**: on a draft PR only the fast lane runs —
`test.yml` (the required floor), `langium-generated`, `workflow-lint`, and
`pr-gate` (which waits on whatever ran). Every other per-PR workflow carries

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  <entry-job>:
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
```

Marking the PR **ready for review** fires the full fan-out (that's what the
`ready_for_review` type is for), and every push after that runs it too. The
`if` sits only on entry jobs — `needs:`-chained jobs cascade-skip, and the
`<stem>-passed` rollups treat skipped needs as OK, exactly as in the merge
queue. `pr-gate` also triggers on `ready_for_review`, so its verdict always
covers the full set. Drafts can't merge anyway, so nothing is lost — a
draft gets fast feedback, and "ready" means "now spend the fleet on me."

The label-gated heavy workflows (`run-obs`, `run-oidc`, …) are deliberately
NOT draft-gated: applying the label to a draft is an explicit request and
still works.

One deliberate side effect of the slot economy: `test.yml`'s `web-tsc` job
was folded into its `lint` job (`lint + web-tsc`) — each half was ~1 minute
of mostly-install, and a runner slot is the scarce resource here, not
wall-clock. The playground typecheck + DDL guard thereby joined the
`tests passed` rollup, which only makes the floor stricter.

## Enabling the merge queue (the structural fix)

A merge queue runs the required checks on the **rebased** merge candidate
before it lands, so the exact combination that will be on `main` is what gets
gated — this is what closes the "never ran on the PR" hole for the push-only
gates without charging every push.

### Readiness: done. The workflow side is complete.

Every workflow in the intended required set now (a) carries a `merge_group:`
trigger, (b) exposes exactly **one stable check name** suitable for
branch-protection "required status checks", and (c) behaves correctly on a
`merge_group` event. **The triggers are inert until the queue is turned on** —
all that remains is the repo-settings flip below.

The set is written down once, in
[`test/system/merge-queue-required-checks.ts`](../test/system/merge-queue-required-checks.ts),
which is the **source of truth** — the table below is a rendering of it.
`test/system/merge-queue-readiness.test.ts` (fast suite) asserts against the
real workflow files that every entry exists, has `merge_group:`, resolves to a
real job, and — for rollups — is `always()` over a non-empty `needs`. Drift is
a red per-PR test today rather than a stalled queue on flip day.

Two shapes of check name:

- **Single-job workflows** expose the job's own name (its `name:` if declared,
  else its job id). Nothing was added to these.
- **Matrix / multi-job workflows** cannot: their cell names are dynamic
  (`${{ matrix.backend }} × …`) and un-nameable in branch protection. Each got
  one `<file-stem>-passed` rollup job — `if: always()`, `needs:` every job in
  the workflow, fails when any need failed or was cancelled. A *skipped* need
  counts as OK, which is what makes a label-guarded job legitimate on an
  unlabelled PR run (in the queue it actually runs).

#### The required-checks list (39)

Per-PR lane — cheap, already runs on every push:

| Workflow | Required check name |
|---|---|
| `test.yml` | `tests passed` |
| `langium-generated.yml` | `check` |
| `workflow-lint.yml` | `workflow-lint` |
| `hono-build.yml` | `build-generated-ts` |
| `dotnet-build.yml` | `build-generated-dotnet` |
| `java-build.yml` | `build-generated-java` |
| `python-build.yml` | `build-generated-python` |
| `elixir-vanilla-build.yml` | `elixir-vanilla-build-passed` |
| `corpus-build.yml` | `corpus-build-passed` |
| `corpus-elixir-build.yml` | `corpus-elixir-build-passed` |
| `generated-react-build.yml` | `generated-react-build-passed` |
| `generated-vue-build.yml` | `generated-vue-build-passed` |
| `generated-svelte-build.yml` | `generated-svelte-build-passed` |
| `generated-angular-build.yml` | `generated-angular-build-passed` |
| `generated-feliz-build.yml` | `feliz-build` |
| `generated-flutter-build.yml` | `flutter-build` |
| `conformance-parity.yml` | `parity` |
| `behavioral-e2e.yml` | `behavioral` |

Queue-heavy lane — the gates that only run on `push:main` / label today:

| Workflow | Required check name |
|---|---|
| `behavioral-e2e-dotnet.yml` | `behavioral-dotnet` |
| `behavioral-e2e-java.yml` | `behavioral-java` |
| `behavioral-e2e-python.yml` | `behavioral-python` |
| `behavioral-e2e-elixir.yml` | `behavioral-elixir` |
| `behavioral-e2e-dapper.yml` | `behavioral-dapper` |
| `behavioral-e2e-mikroorm.yml` | `behavioral-mikroorm` |
| `behavioral-ui-e2e.yml` | `behavioral-ui` |
| `tenancy-e2e.yml` | `tenancy-e2e-passed` |
| `hono-obs-e2e.yml` | `hono-obs-e2e` |
| `dotnet-obs-e2e.yml` | `dotnet-obs-e2e` |
| `java-obs-e2e.yml` | `java-obs-e2e` |
| `python-obs-e2e.yml` | `python-obs-e2e` |
| `elixir-vanilla-obs-e2e.yml` | `vanilla-obs-e2e` |
| `hono-oidc-e2e.yml` | `hono-oidc-e2e` |
| `dotnet-oidc-e2e.yml` | `dotnet-oidc-e2e` |
| `java-oidc-e2e.yml` | `java-oidc-e2e` |
| `python-oidc-e2e.yml` | `python-oidc-e2e` |
| `elixir-oidc-e2e.yml` | `elixir-oidc-compose-e2e` |
| `auth-oidc-compose-e2e.yml` | `auth-oidc-compose-e2e` |
| `migration-evolution-e2e.yml` | `migration-evolution-e2e-passed` |
| `pages.yml` | `pages-passed` |

> **`tests passed`, not `tests-passed`.** `tests-passed` is the *job id* in
> `test.yml`; the check-run name GitHub reports is the job's `name:`, which is
> `tests passed`. Branch protection matches the check-run name. Paste the name
> from this table, and do not rename that job — it is the only required check
> `main` has today.

Everything *not* in these two tables stays as it is — `conformance-full`,
`differential-report`, `channels-e2e`, `api-call-e2e`, the `k8s-*` gates, the
`generated-*-e2e` SPA smokes, `playground-*`, `frontend-fullstack-e2e`,
`generated-a11y`, `phoenix-ui-e2e`, `elixir-vanilla-vo-e2e`, `ci-red-alarm`,
`cleanup-artifacts`, `email-e2e`, `context-integration-e2e`. They keep their
nightly / label triggers and must **not** be added to required checks (a
required check with no `merge_group` trigger stalls the queue forever).

### The activation runbook (repo settings — the only remaining step)

Nothing below is code; it is an admin action on `github.com/lemmit/Loc`.

1. **Do not remove `tests passed` at any point.** It stays required from the
   first click to the last, so there is never an unprotected window.
2. **Settings → Rules → Rulesets** (or **Settings → Branches → branch
   protection rule for `main`**, if the repo is still on classic protection).
   Target branch: `main`.
3. Enable **Require merge queue**. Recommended starting configuration:
   - merge method: **Squash** (matches how `main` lands today);
   - build concurrency: **5** (the queue-heavy lane is docker/boot-bound);
   - only merge non-failing pull requests: **on**;
   - "Merge candidates should require all checks to pass": **on**.
4. Enable **Require status checks to pass** and add **exactly** the 39 check
   names from the two tables above. Add them by pasting the name — the search
   box only offers checks GitHub has seen recently, and several of these have
   never reported on a PR (they are `push:main`-only today), so they must be
   typed in.
5. Save. From then on, PRs merge via the queue: GitHub builds a rebased
   candidate, runs all 39 checks on it, and lands it only if they are green.
6. **Watch the first day.** A check that never reports leaves candidates
   pending — if that happens, the cause is a missing `merge_group:` trigger or
   a mistyped check name. `npx vitest run test/system/merge-queue-readiness.test.ts`
   re-verifies the workflow half in ~1s; the mistyped-name half is settings-only.

To pull a further gate into the queue later: add `merge_group:` to its `on:`
block, give it one stable check name (a `<stem>-passed` rollup if it is a
matrix), add the row to `test/system/merge-queue-required-checks.ts` — the
readiness test will then fail until the workflow matches — and add the name to
the required-checks list in settings.

**Scriptable alternative.** The same configuration can be applied as a repo
ruleset via `gh api --method POST /repos/lemmit/Loc/rulesets` with a
`merge_queue` rule plus a `required_status_checks` rule whose
`required_status_checks[]` are the 39 names above. It is the reproducible path
and worth capturing once the settings are stable, but the UI path is primary:
ruleset JSON silently accepts check names that do not exist, which is the one
mistake that stalls the queue.

### Two merge-group behaviours worth knowing

- **`pages.yml` builds in the queue but never deploys.** The workflow is split
  into `build` (everything: docs render, playground typecheck, DDL unit, Node
  smoke, npm-mirror + vendor + vite build) and `deploy`
  (`if: github.event_name != 'merge_group'`, carrying the `github-pages`
  environment). The split is not cosmetic: the `github-pages` environment is
  branch-restricted to the Pages source, so a job carrying `environment:` would
  be rejected on a `gh-readonly-queue/**` ref *before any step ran* — the queue
  would see a hard failure on every candidate. `pages-passed` rolls the two up.
- **Label guards already pass in the queue.** The uniform idiom
  `github.event_name != 'pull_request' || github.event.label.name == '<label>'`
  short-circuits to `true` on `merge_group`, so every labelled gate runs
  unconditionally on a merge candidate with no edit. The readiness test pins
  that: a required job whose `if:` reads `github.event.pull_request` or
  compares `event_name` must use this idiom.

## The interim escape hatch: force a post-merge gate with a label

Until the queue is on, the push-only gates are invisible on a PR — you land,
then find out. The manual workaround is a **label trigger**: each of these
gates carries a `pull_request: types: [labeled]` trigger plus a job-level `if`
that runs the job *only* when a specific label is present. Add the label to a
PR and the otherwise-post-merge gate runs against that branch before merge.

The label names a **feature / blast-radius**, and one label fires every backend
of that feature at once — agents reason about *what they touched* ("I changed
the OIDC emitter"), not about the workflow-file inventory. So there is no
per-workflow label (`run-hono-oidc`), and no single mega `run-e2e` grab-bag —
the size that matches the blast radius is one label per feature family:

| Label | Fires | Notes |
|---|---|---|
| `run-obs` | `hono/dotnet/java/python/elixir-vanilla-obs-e2e` | observability runtime e2e, all five backends |
| `run-oidc` | `hono/dotnet/java/python/elixir-oidc-e2e` + `auth-oidc-compose-e2e` | OIDC code flow, all backends + the compose stack |
| `run-tenancy` | `tenancy-e2e` | already a 10-leg matrix internally |
| `run-migration-e2e` | `migration-evolution-e2e` | migrate-chain ≡ fresh-create + data-survival, 5 SQL backends |
| `run-conformance` | `conformance-full` | cross-backend runtime conformance |
| `run-channels` | `channels-e2e` | cross-deployable eventing |
| `run-differential` | `differential-report` | the nightly all-pairs DISCOVERY sweep over the wider compose stack. The **enforcement** half is no longer here: since M-T9.11 slice (c) each backend diffs its recorded responses against `test/behavioral/wire-golden/` inside its own `behavioral-e2e*.yml` leg, so runtime-value parity is a per-PR blocking gate needing no label |
| `run-e2e` | `phoenix-ui-e2e`, `playground-e2e`, `elixir-vanilla-vo-e2e` | legacy cluster — a coherent Phoenix/playground group, *not* a run-everything button |
| `frontend-fullstack` | `frontend-fullstack-e2e` | non-React fullstack round-trip |
| `a11y` | `generated-a11y` | axe-core WCAG-AA scan |
| `e2e-k8s` | `k8s-e2e` | kind-cluster smoke |

The job `if` is uniform: `github.event_name != 'pull_request' || github.event.label.name == '<label>'`
— so push, `merge_group`, and `workflow_dispatch` always run; a PR runs the gate
only when tagged with that exact label. Concurrency stays keyed on `github.ref`
with `cancel-in-progress: false`, so a labeled PR run (ref `refs/pull/N/merge`)
never collides with or cancels a `push:main` run.

This is a manual pre-merge check, **not** a replacement for the merge queue
above — the queue is the structural fix; labels are the interim "80/20."
**When you add a new post-merge gate, wire it to the matching `run-<feature>`
label (or mint a new one) and add a row here + in `CLAUDE.md`.**

## Guardrails added alongside

- **`workflow-lint.yml`** — validates every workflow file parses (YAML) and
  runs actionlint, on any `.github/workflows/**` change. Catches the
  `startup_failure` class (the dapper bug) on the PR.
- **`ci-red-alarm.yml`** — `workflow_run` notifier; opens/updates a single
  `ci-red`-labelled tracking issue when a monitored gate concludes `failure`
  on `main`. The red signal that was missing. Add a workflow's `name:` to its
  list when you add a new main gate.
- **`cancel-in-progress: false`** on the push-only post-merge gates, so a
  failure is attributed to the commit that caused it instead of being masked
  by the next merge.

## If the merge queue is too big a lift right now

The 80/20 without a queue: give `tenancy-e2e` / the behavioral cross-backend
gates / `pages` a `pull_request:` trigger scoped to their real blast radius
(not the full matrix), so the common breakers are caught pre-merge. This costs
per-push CI time — the queue is the better answer — but it closes the holes.
