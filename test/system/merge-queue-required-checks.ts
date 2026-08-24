// The merge-queue required-checks manifest — the single source of truth for
// which GitHub Actions checks branch protection should require on `main` once
// the merge queue is switched on (docs/ci-gating.md → "Enabling the merge
// queue").
//
// `workflow` is the file under `.github/workflows/`; `check` is the *check-run
// name* GitHub reports, which is the job's `name:` when it has one and the job
// id otherwise.  That string — not the file name, not the workflow `name:` —
// is what goes in the required-status-checks list.
//
// Invariants enforced by `merge-queue-readiness.test.ts`:
//   1. every listed workflow exists and has a `merge_group:` trigger, so the
//      check actually reports inside the queue (a required check that never
//      runs there leaves the queue pending forever);
//   2. every listed check name resolves to a real job in that workflow;
//   3. rollup jobs (`<stem>-passed`) are `if: always()` with a non-empty
//      `needs`, so they can't go green by being skipped;
//   4. no two entries claim the same check name (check-run names are global
//      across the repo).
//
// This file is NOT a test — it is imported by the test and quoted verbatim in
// docs/ci-gating.md's activation runbook.  Adding a gate to the required set
// means adding a row here, wiring `merge_group:` into its `on:` block, and
// giving it one stable check name.

export interface RequiredCheck {
  /** Workflow file name under `.github/workflows/`. */
  readonly workflow: string;
  /** Check-run name to require in branch protection. */
  readonly check: string;
  /** Which tier of the docs/ci-gating.md table this gate belongs to. */
  readonly lane: "per-pr" | "queue";
}

/**
 * Ordered required-checks set. Lane `per-pr` gates already run on every push
 * to a PR; lane `queue` gates are the heavy ones that only run on
 * `push: main` / label / the merge group. Both lanes must report inside the
 * queue, so both need `merge_group:`.
 */
export const REQUIRED_CHECKS: readonly RequiredCheck[] = [
  // ── Per-PR lane ──────────────────────────────────────────────────────
  // `tests-passed` is the JOB ID; the reported check name is the job's
  // `name:` — "tests passed". Branch protection already requires it; do not
  // rename it.
  { workflow: "test.yml", check: "tests passed", lane: "per-pr" },
  { workflow: "langium-generated.yml", check: "check", lane: "per-pr" },
  { workflow: "workflow-lint.yml", check: "workflow-lint", lane: "per-pr" },
  { workflow: "hono-build.yml", check: "build-generated-ts", lane: "per-pr" },
  { workflow: "dotnet-build.yml", check: "build-generated-dotnet", lane: "per-pr" },
  { workflow: "java-build.yml", check: "build-generated-java", lane: "per-pr" },
  { workflow: "python-build.yml", check: "build-generated-python", lane: "per-pr" },
  { workflow: "elixir-vanilla-build.yml", check: "elixir-vanilla-build-passed", lane: "per-pr" },
  { workflow: "corpus-build.yml", check: "corpus-build-passed", lane: "per-pr" },
  { workflow: "corpus-elixir-build.yml", check: "corpus-elixir-build-passed", lane: "per-pr" },
  { workflow: "generated-react-build.yml", check: "generated-react-build-passed", lane: "per-pr" },
  { workflow: "generated-vue-build.yml", check: "generated-vue-build-passed", lane: "per-pr" },
  {
    workflow: "generated-svelte-build.yml",
    check: "generated-svelte-build-passed",
    lane: "per-pr",
  },
  {
    workflow: "generated-angular-build.yml",
    check: "generated-angular-build-passed",
    lane: "per-pr",
  },
  { workflow: "generated-feliz-build.yml", check: "feliz-build", lane: "per-pr" },
  { workflow: "generated-flutter-build.yml", check: "flutter-build", lane: "per-pr" },
  { workflow: "conformance-parity.yml", check: "parity", lane: "per-pr" },
  { workflow: "behavioral-e2e.yml", check: "behavioral", lane: "per-pr" },

  // ── Queue-heavy lane ─────────────────────────────────────────────────
  { workflow: "behavioral-e2e-dotnet.yml", check: "behavioral-dotnet", lane: "queue" },
  { workflow: "behavioral-e2e-java.yml", check: "behavioral-java", lane: "queue" },
  { workflow: "behavioral-e2e-python.yml", check: "behavioral-python", lane: "queue" },
  { workflow: "behavioral-e2e-elixir.yml", check: "behavioral-elixir", lane: "queue" },
  { workflow: "behavioral-e2e-dapper.yml", check: "behavioral-dapper", lane: "queue" },
  { workflow: "behavioral-e2e-mikroorm.yml", check: "behavioral-mikroorm", lane: "queue" },
  { workflow: "behavioral-ui-e2e.yml", check: "behavioral-ui", lane: "queue" },
  { workflow: "behavioral-heex-ui-e2e.yml", check: "behavioral-heex-ui", lane: "queue" },
  { workflow: "tenancy-e2e.yml", check: "tenancy-e2e-passed", lane: "queue" },
  { workflow: "hono-obs-e2e.yml", check: "hono-obs-e2e", lane: "queue" },
  { workflow: "dotnet-obs-e2e.yml", check: "dotnet-obs-e2e", lane: "queue" },
  { workflow: "java-obs-e2e.yml", check: "java-obs-e2e", lane: "queue" },
  { workflow: "python-obs-e2e.yml", check: "python-obs-e2e", lane: "queue" },
  { workflow: "elixir-vanilla-obs-e2e.yml", check: "vanilla-obs-e2e", lane: "queue" },
  { workflow: "hono-oidc-e2e.yml", check: "hono-oidc-e2e", lane: "queue" },
  { workflow: "dotnet-oidc-e2e.yml", check: "dotnet-oidc-e2e", lane: "queue" },
  { workflow: "java-oidc-e2e.yml", check: "java-oidc-e2e", lane: "queue" },
  { workflow: "python-oidc-e2e.yml", check: "python-oidc-e2e", lane: "queue" },
  { workflow: "elixir-oidc-e2e.yml", check: "elixir-oidc-compose-e2e", lane: "queue" },
  { workflow: "auth-oidc-compose-e2e.yml", check: "auth-oidc-compose-e2e", lane: "queue" },
  {
    workflow: "migration-evolution-e2e.yml",
    check: "migration-evolution-e2e-passed",
    lane: "queue",
  },
  { workflow: "pages.yml", check: "pages-passed", lane: "queue" },
];
