# CI gating — what runs where, and how `main` stays green

Why this exists: agents landed several breakages on `main` that no PR check
could have caught, because the gates that *would* have caught them don't gate
PRs. This documents the tiers and the merge-queue path that fixes it without
making every push slower.

## The failure mode

Branch protection requires only **`tests-passed`** (the fast vitest rollup).
Every heavy gate — the runtime/boot e2e suites, the deploy build — is a
*non-required* check. Two consequences:

1. **Many heavy gates don't run on a PR by default.** `tenancy-e2e`, the five
   `*-obs-e2e`, the five `*-oidc-e2e`, `auth-oidc-compose-e2e`, and `pages`
   trigger on `push: [main]` only. Whatever they catch, they catch *after*
   merge — on `main`, where it sits red. (All but `pages` now also accept a
   per-PR **label** trigger as a manual escape hatch — see "The interim escape
   hatch" below — but that's opt-in, so the default is still post-merge.)
2. **A red heavy gate doesn't block anything.** A gate can be broken (even
   unparseable) and still merge green. `behavioral-e2e-dapper.yml` had an
   unquoted colon in its `name:`, was a permanent `startup_failure`, and stayed
   red across 100% of recent `main` pushes — unnoticed, because it was *never*
   green, so there was no red-transition to alert on.

`cancel-in-progress: true` on the `push:main` gates made it worse: a rapid
follow-up merge cancels the previous commit's heavy jobs, so a real failure
gets attributed to a later, innocent commit.

## The tiers

| Lane | What | Rule |
|---|---|---|
| **Per-PR, every push** (required) | `test.yml` (fast vitest ×4 shards) + lint + web-tsc → `tests-passed`; `langium-generated`; `workflow-lint`; the typecheck/compile gates (`hono/dotnet/java/python-build`, `generated-*-build`, `corpus-build`); `behavioral-e2e` (Hono on PGlite, daemonless) as the runtime canary | Cheap, parallel, no docker/db. Catches most regressions with fast feedback. |
| **Merge queue** (`merge_group`, runs once on the final candidate) | The cross-backend runtime matrix — `behavioral-e2e-{dotnet,java,python,elixir,dapper,mikroorm}`, `tenancy-e2e` (10 legs), `*-obs-e2e`, `*-oidc-e2e`, `auth-oidc-compose-e2e`; the full `generated-react-build` Cartesian; `pages` build | What actually breaks `main` **and** the expensive ones. Runs once per landing, not per push. A PR revised 10× pays this once. |
| **Nightly / label** (unchanged) | `conformance-full`, `generated-a11y`, `frontend-fullstack-e2e`, `k8s-e2e` | Broad, slow, low churn — post-hoc is fine. |

Note: `generated-react-build` already emits a **slim** matrix on PRs
(`showcase.ddd` × every pack) and the **full** Cartesian on `push:main` /
`merge_group` — the per-PR/pre-land split the tiers call for is already built
into its `configure` job.

The playground suite is split the same way. `playground-e2e` (the whole
Playwright suite, including the network-gated bundle/boot specs) stays
post-merge / nightly / `run-e2e`-label; `playground-e2e-no-network` runs the
network-free subset (workspace, history, builder, requirements, editor) on
every PR touching `web/**` or `src/**`, so file-management and builder
regressions are caught before merge.

## Enabling the merge queue (the structural fix)

The `merge_group:` triggers are already present on `test.yml`, `tenancy-e2e`,
the `*-obs-e2e` / `*-oidc-e2e` gates, `auth-oidc-compose-e2e`, `pages`,
`behavioral-e2e`, and `behavioral-ui-e2e`. **They are inert until the queue is
turned on.** To activate:

1. Settings → Branches → branch protection for `main` → **Require merge queue**.
2. Set **required status checks** to exactly the set that has a `merge_group`
   trigger: `tests-passed` **plus** each heavy gate above. (A required check
   with no `merge_group` trigger would stall the queue — only require checks
   that run in the queue.)
3. To pull a remaining gate into the queue later, add `merge_group:` to its
   `on:` block and add it to the required-checks list.

A merge queue runs the required checks on the **rebased** merge candidate
before it lands, so the exact combination that will be on `main` is what gets
gated — this is what closes the "never ran on the PR" hole for the push-only
gates without charging every push.

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
| `run-differential` | `differential-report` | |
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
