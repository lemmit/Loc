// Canonical backend identifiers for the shared fixture corpus.
//
// Each corpus feature is authored ONCE as a platform-agnostic `.ddd` whose
// deployable spells `platform: __PLATFORM__`; the harness swaps the token for
// the value below to emit that feature on a given backend.  See
// `docs/old/plans/global-test-coverage-plan.md` (Phase 0).

/** Stable backend keys used by the manifest + coverage gate.  `vanilla` is the
 *  sole elixir backend (plain Ecto/Phoenix — the Ash foundation was removed). */
export const BACKENDS = ["node", "dotnet", "java", "python", "vanilla"] as const;
export type Backend = (typeof BACKENDS)[number];

/** The `platform:` clause each backend key lowers to in a deployable block. */
export const PLATFORM_CLAUSE: Record<Backend, string> = {
  node: "node",
  dotnet: "dotnet",
  java: "java",
  python: "python",
  vanilla: "elixir",
};

/** Human label for diagnostics. */
export const BACKEND_LABEL: Record<Backend, string> = {
  node: "Hono/TS",
  dotnet: ".NET",
  java: "Java/Spring",
  python: "Python/FastAPI",
  vanilla: "Elixir (Phoenix/Ecto)",
};
