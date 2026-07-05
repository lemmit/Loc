// ---------------------------------------------------------------------------
// Runtime-semantics conformance rule registry (RS-rules).
//
// The machine-readable source of truth behind `docs/conformance-semantics.md`.
// Each entry names a cross-backend RUNTIME guarantee — the values a booted
// backend actually sends/accepts over the wire — that the STRUCTURAL parity
// gate (`docs/conformance.md`, the OpenAPI spec-diff) is blind to.
//
// Every rule here was established by a real fix (see `provenance`); the point
// of the registry is that the next regression is a NAMED rule violation, and
// that there is one target for the enforcement work (A6.2 — a second backend
// in the per-PR behavioral tier). `semantics-rules.test.ts` pins the shape so
// a rule can't be added as prose only.
//
// Boundary: a guarantee belongs here ONLY if a structural spec-diff cannot
// catch its violation. Spec shape (operationIds, schema names, field-name
// sets, enum value-sets, 7807 envelope) stays in `docs/conformance.md`.
// ---------------------------------------------------------------------------

/** The five backends the runtime contract spans. */
export const BACKENDS = ["node", "dotnet", "java", "python", "elixir"] as const;
export type Backend = (typeof BACKENDS)[number];

/** The lowest tier that can gate a rule today (see conformance-semantics.md
 *  § "How a rule is enforced"):
 *   - `static`      : assertable against emitted source, no boot (per-PR).
 *   - `behavioral`  : needs a booted round-trip; per-PR only for node today
 *                     (T1) until A6.2 widens the behavioral tier (T2).
 *   - `full`        : only the nightly/label 5-backend docker stack (T3). */
export type GatingTier = "static" | "behavioral" | "full";

export interface SemanticsRule {
  /** Stable id — `RS-<n>`. Never renumbered; a retired rule is marked, not
   *  deleted, so provenance links stay valid. */
  readonly id: `RS-${number}`;
  readonly title: string;
  /** One-line sketch of the `.ddd` construct that triggers the rule. */
  readonly trigger: string;
  /** The observable runtime behavior a conforming backend exhibits. */
  readonly observable: string;
  /** Backends that conform today. A backend flagged as a *target* (the rule
   *  is a guard against a known-open regression, not yet proven everywhere)
   *  is listed in `targets`, not here. */
  readonly conforms: readonly Backend[];
  /** Backends where the rule is asserted defensively against a known/possible
   *  regression rather than proven-conforming. Subset-disjoint from `conforms`. */
  readonly targets?: readonly Backend[];
  /** The fix(es) that established the rule — PR refs / gap-doc sections. */
  readonly provenance: readonly string[];
  readonly tier: GatingTier;
}

export const SEMANTICS_RULES: readonly SemanticsRule[] = [
  {
    id: "RS-1",
    title: "Wire keys are camelCase, both directions",
    trigger: "an aggregate with a multi-word field (`commitSha: string`) on create/update",
    observable:
      'POST {"commitSha":…} persists commit_sha and reads back {"commitSha":…}; a multi-word field is never silently dropped to a 422',
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["#1620", "#1632", "#1636"],
    tier: "behavioral",
  },
  {
    id: "RS-2",
    title: "Enum values use declared casing on the wire",
    trigger: "enum BuildState = Passed | Failed; a field of that type on a create body",
    observable:
      'POST {"buildState":"Passed"} → 201 and reads back "Passed" (not "passed"/"PASSED")',
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["#1622"],
    // Gated statically per-PR by test/conformance/enum-casing-parity.test.ts —
    // the emitted enum definition fixes the wire value, no boot needed.
    tier: "static",
  },
  {
    id: "RS-3",
    title: "No persistence-internal columns leak to the wire",
    trigger:
      "any read of a softDeletable/auditable aggregate, or an ORM that auto-stamps timestamps",
    observable:
      "GET returns exactly the wireShape keys — no inserted_at/updated_at, no internal jsonb envelope",
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["§14", "#1628"],
    // Gated statically per-PR by test/conformance/wire-no-leak-parity.test.ts —
    // asserts the framework-timestamp leak signature is absent at each backend's
    // wire-serialization site.
    tier: "static",
  },
  {
    id: "RS-4",
    title: "Declared temporal fields round-trip",
    trigger: "an aggregate declaring `createdAt: instant` with an explicit create",
    observable:
      'POST {"createdAt":"2026-01-01T00:00:00Z"} reads back the same instant (ORM auto-value does not clobber it)',
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["#1626"],
    tier: "behavioral",
  },
  {
    id: "RS-5",
    title: "Union-variant absence match is a presence check everywhere",
    trigger: "`find one X or absent` feeding a match { X => … | absent => … }",
    observable:
      "the absent arm is taken when the row is missing, identically across backends (nullable-subject ternary)",
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["#1631"],
    // Gated statically per-PR by the pre-existing
    // test/conformance/union-find-absence-parity.test.ts — it anchors each
    // backend's absence-check leaf (node `result == null`, python `is None`, …)
    // and the 404 ProblemDetails mapping across all five.
    tier: "static",
  },
  {
    id: "RS-6",
    title: "Boolean create defaults materialize at the wire boundary",
    trigger: "`active: bool = true`; a create body omitting `active`",
    observable: 'POST {} (no active) reads back {"active":true}, not a zero-value false/null',
    conforms: ["node"],
    targets: ["dotnet", "java", "python", "elixir"],
    provenance: ["full-code-review-2026-07 B14"],
    tier: "behavioral",
  },
  {
    id: "RS-7",
    title: "Value-object subfields survive a jsonb round-trip",
    trigger:
      "valueobject Money { amount, currency } as an aggregate field on a jsonb-storing backend",
    observable:
      "GET returns the nested {amount,currency}; a later op reading self.price.amount does not raise",
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["#1660"],
    tier: "behavioral",
  },
  {
    id: "RS-8",
    title: "Associations persist and preload on round-trip",
    trigger: "an op mutating a containment or X id[] ref-collection (`lines += …`, `members += t`)",
    observable:
      "after the op, GET nests the added child / lists the added id — no in-memory projection that omits the join write",
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["§11c", "#1626"],
    tier: "behavioral",
  },
  {
    id: "RS-9",
    title: "Error bodies converge on RFC 7807 with the 400/422 split",
    trigger: "a create violating an invariant vs a create with a malformed body",
    observable:
      "malformed body → 400, well-formed-but-invalid → 422; identical problem-body shape on every backend",
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["#1620", "generated-code-review-2026-06-30"],
    tier: "behavioral",
  },
];
