# CI gating — what runs where, and how `main` stays green

Why this exists: agents landed several breakages on `main` that no PR check
could have caught, because the gates that *would* have caught them don't gate
PRs. This documents the tiers and the merge-queue path that fixes it without
making every push slower.

## The failure mode

Branch protection requires only **`tests-passed`** (the fast vitest rollup).
Every heavy gate — the runtime/boot e2e suites, the deploy build — is a
*non-required* check. Two consequences:

1. **Many heavy gates never run on a PR at all.** `tenancy-e2e`, the five
   `*-obs-e2e`, the four `*-oidc-e2e`, `auth-oidc-compose-e2e`, and `pages`
   trigger on `push: [main]` only. Whatever they catch, they catch *after*
   merge — on `main`, where it sits red.
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
