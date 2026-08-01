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
    // Gated per-PR on node (behavioral-e2e) and now python (behavioral-e2e-
    // python, A6.2): the create→read round-trip asserts camelCase customerId/
    // placedAt survive both directions.
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
    provenance: ["#1626", "RST-9"],
    // Gated behaviorally on node and python per-PR (A6.2): the order create→read
    // asserts placedAt reads back equal to the submitted instant.  The
    // corpus-dotnet order round-trip now asserts the same (RST-9 canonicalized
    // the .NET instant wire form — trailing zero fractional seconds trimmed to
    // `…00Z` — bringing it into parity with node/python).
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
    conforms: ["node", "python", "java"],
    targets: ["dotnet", "elixir"],
    // Gated per-PR on node and python (A6.2), and on Java via the behavioral tier
    // (RST-10). The python behavioral gate surfaced (and the fix closed) a real
    // parity bug: the FastAPI create model hardcoded `active: bool = False` (the
    // zero value) instead of the declared default — omitting `active` arrived
    // False. Fix: the create request field uses the field's lowered `default`
    // expr (routes-builder.ts requestFieldDecl). Java (RST-10) hit the same class:
    // the Spring create record made the defaulted field a required primitive and
    // 400ed on an omitted key — fixed by boxing the create-DTO component and
    // materializing the declared default in the request→domain mapping (service.ts).
    provenance: ["full-code-review-2026-07 B14", "RST-10"],
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
    // Gated per-PR on node and python (A6.2): the product create→read asserts
    // the nested Money VO round-trips.
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
    // Gated per-PR on node and python (A6.2). The python behavioral gate
    // surfaced (and the fix closed) a real codegen bug on this exact path — the
    // emitted FastAPI route wrapped a cross-aggregate operation-param id as
    // `ProductId(...)` without importing it; the route import collector now
    // draws candidates from every context aggregate (routes-builder.ts).
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
  {
    id: "RS-10",
    title: "Rehydration trusts the store — invariants guard transitions only",
    trigger:
      "an aggregate with an invariant; a persisted row that predates a tightened invariant is read back",
    observable:
      "GET/findAll return the stored row (no invariant re-run on load), so it can be repaired via an operation; create and every mutator still assert",
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: ["generated-code-ddd-review-2026-07 §S6"],
    // Gated statically per-PR by test/conformance/rehydration-trust-parity.test.ts
    // on the two backends that construct domain objects on load (node + python:
    // repos hydrate via the non-asserting `_rehydrate`, while `create`/ops keep
    // asserting). .NET/Java materialize via EF/JPA and elixir loads Ecto
    // structs — no invariant runs on those load paths by construction.
    tier: "static",
  },
  {
    id: "RS-11",
    title: "A created `versioned` aggregate reads back at version 1",
    trigger: "a `versioned` aggregate created via POST, then read back",
    observable:
      "the optimistic-concurrency `version` on the first read is 1 — the `versioned` capability declares `version: int token = 1` (src/macros/prelude.ts), mirrored to `version INTEGER NOT NULL DEFAULT 1`. All five backends honor it: node stamps it in its versioned save, elixir carries the Ecto `default: 1`, and dotnet/java/python seed it in the domain `create` factory (`constructionSeededDefaults`) since a `token` field is dropped from the create body.",
    // Canonical value is 1 per the capability's `= 1` default — NOT a majority
    // vote (three backends agreed on the WRONG value).  Closed by M-T6.11
    // (#2255); re-verified per-PR by the M-T9.11 wire-golden gate, which pins
    // `version: 1` on the `payments` create→read round-trip on every backend.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "M-T9.11 differential run 30277275068",
      "PR #2220",
      "src/macros/prelude.ts (versioned `= 1`)",
      "fixed by M-T6.11 (PR #2255)",
      "pinned per-PR by the wire-golden gate (payments)",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-12",
    title: "Money wire scale is consistent across backends",
    trigger: "a money-typed field serialized to the wire (e.g. `costFloor`)",
    observable:
      'a money-typed field serializes at a FIXED scale of 4 on every backend — the canonical NUMERIC(19,4) storage scale (`MONEY_WIRE_SCALE`, src/generator/money-scale.ts). `12.5`, `12.50` and `12` all read back as `"12.5000"`, stored or derived. Each backend formats at the wire boundary: node `.toFixed(4)`, .NET `ToString("F4")`, Java `setScale(4, HALF_UP)`, Python `quantize(1e-4, ROUND_HALF_UP)`, Elixir `__money_round/1`.',
    // Owner decision (2026-07-27, refined 07-28): fixed scale 4, NOT "preserve
    // the submitted scale" — node's decimal.js normalizes at parse time and so
    // cannot echo a submitted scale at all, making a fixed scale the only
    // representable consistent choice.  Closed by M-T6.22 (#2255).
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "M-T9.11 differential run 30277275068",
      "PR #2220",
      "owner decision 2026-07-27 (fixed scale 4)",
      "fixed by M-T6.22 (PR #2255)",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-13",
    title: "A create POST returns the id envelope, not the whole aggregate",
    trigger: "any aggregate created via `POST /api/<plural>`",
    observable:
      'the 201 body is the id envelope `{"id": …}` and nothing else, on every backend. Elixir used to return the FULL aggregate (`{"id":…,"owner":"alice","balance":0}`) — a client written against the declared create response could read fields on one backend it cannot read on the other four. The OpenAPI spec-diff was structurally blind to it: the specs AGREED (elixir publishes the `{id}` envelope too); only the bytes differed.',
    // Found by the M-T9.11 per-PR wire-golden gate on the shared `ledger` /
    // `payments` / `sales` / `shapes` systems: four backends agree on the id
    // envelope and elixir is the outlier.  Here the majority and the oracle
    // coincide — the emitted OpenAPI create response is the id envelope, so
    // elixir is over-returning against its OWN published contract.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "M-T9.11 slice (c) wire-golden gate",
      "test/behavioral/wire-golden/{ledger,payments,sales,shapes}.json",
      "found: elixir `create_result/2` json(serialize(record)) vs its own Create<Agg>Response `{id}` schema (openapi-emit.ts)",
      'fixed: elixir create actions now answer `%{"id" => record.id}` (api-emit.ts x2, eventsourced-emit.ts)',
    ],
    tier: "behavioral",
  },
  {
    id: "RS-14",
    title: "`version` increments on every persisted mutation, document shapes included",
    trigger:
      "a `versioned` aggregate with `shape: document` (jsonb-stored): create, invoke an operation, read back",
    observable:
      "the optimistic-concurrency `version` reads back 1 + one per persisted mutation, for EVERY `shape:`. every backend now does. Historically the other three each dropped the bump on a DIFFERENT shape, which is why no single fixture caught it — document `Cart` / embedded `Wishlist` / plain `Order` (2 / 2 / 3 canonical) read back 1 / 2 / 3 on dotnet+java and 2 / 1 / 1 on elixir. dotnet/java: the ORM concurrency token is bound to a mapped column and a document aggregate's `version` lives inside the jsonb blob — the `dapper` persistence adapter (raw Npgsql, same .NET emitters, hand-rolled document SQL) increments correctly, which localizes the gap to the EF/JPA mapping rather than the .NET/Java wire emitters. elixir: the mirror image — the document path bumps, but an operation on an embedded/plain aggregate persists without touching `version` at all.",
    // RS-11 covered version at CREATE only; this is the INCREMENT path, and it
    // is shape-dependent AND inverted between backends.  Exactly the class the
    // differential exists to find: a field no test author thought to assert.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "M-T9.11 slice (c) wire-golden gate",
      "test/behavioral/wire-golden/shapes.json seq #3/#7; sales.json seq #12",
      "fixed (dotnet): the document SaveAsync resolves the next version first and stamps it into the serialized snapshot (`ToSnapshot() with { Version = … }`, emit/repository.ts)",
      "fixed (java): the document upsert writes the incremented counter back into the blob via `jsonb_set(excluded.data, '{version}', …)` (emit/document-store.ts)",
      "fixed (elixir): the relational/embedded operation persist path bumps `version` like the document path already did (context-emit.ts)",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-15",
    title: "A domain-floor rejection is 422, not 400",
    trigger:
      "an `operation` whose `precondition` is false at call time, or a violated `invariant` — any rejection the DOMAIN makes on a well-formed request",
    observable:
      'every backend answers 422 "Unprocessable Entity" with the RFC 7807 body. The request is well-formed; the server refuses it on SEMANTIC grounds, which is exactly what RFC 9110 reserves 422 for — 400 stays for a malformed or unparseable request. This also makes the denial ladder identical everywhere: `when` state gate -> 409, `requires` -> 403, precondition/invariant -> 422.',
    // Owner decision (2026-07-29).  Found by the M-T9.11 wire-golden gate:
    // node/python/dotnet/java answered 400 while elixir answered 422 — and
    // elixir's was the DELIBERATE, documented ladder, not an accident.  So this
    // was RS-12's shape (an open canonical decision), NOT RS-13's (a
    // one-backend bug), and the majority was the side that moved.  RS-11 is the
    // standing reminder that a vote is not an oracle.
    //
    // The four backends that moved already DECLARED 422 on these routes
    // (wire-boundary validation), so the published OpenAPI contract did not
    // change — only which rejections land on it.
    //
    // NOTE the `detail` WORDING is still divergent and is tracked separately:
    // node/python/dotnet/java name the failed predicate ("Precondition failed:
    // <expr>"), elixir sends a generic "A precondition failed".  RFC 7807 wants
    // `detail` specific to the occurrence, so elixir is the side to move; that
    // needs the predicate source threaded through its `:precondition_failed`
    // denial atom, which is a mechanism change rather than a status one.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found by the M-T9.11 wire-golden gate (test/behavioral/systems/wire-contract.ddd)",
      "owner decision 2026-07-29: 422, adopting elixir's deliberate denial ladder",
      "node routes/workflow/projection/explicit-handler onError; python _domain handler; dotnet DomainExceptionFilter; java onDomain",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-16",
    title: "The RFC 7807 `type` member is always present",
    trigger:
      "any error response — a tripped precondition, a wire-validation failure, a framework 404, a declared `error` payload — on a backend serving an api",
    observable:
      'the problem+json body carries all five RFC 7807 members — `type`, `title`, `status`, `detail`, `instance` — with `type` never omitted. Its VALUE depends on the kind of error: a FRAMEWORK problem (domain floor, wire validation, aggregate-not-found) carries "about:blank"; a DECLARED `error` payload carries its derived `/errors/<kebab-name>` URI (`errorTypeUri`, e.g. "/errors/not-found"). Omitting `type` is legal per RFC 9457 (absent means about:blank) but it is a WIRE divergence: a client reading `body.type` gets a string on four backends and `undefined` on the fifth.',
    // Found by the M-T9.11 wire-golden gate the moment the error envelope
    // joined it (RS-15) — the first time any golden contained an error body.
    // Java was the outlier for a framework reason, not an emitter oversight:
    // Spring's `ProblemDetailJacksonMixin` annotates `getType()`
    // `@JsonInclude(NON_DEFAULT)`, so the about:blank URI that
    // `ProblemDetail.forStatus` installs is silently dropped on the way out.
    // The fix writes it through `setProperty` instead, which serializes via the
    // mixin's `@JsonAnyGetter` (no suppression, and no duplicate key precisely
    // because `getType()` stays suppressed).  Verified on a real boot, not just
    // an emitted-string assertion.
    //
    // `instance` needed no help on any backend: Spring's message converter
    // fills a null instance with the request URI on the way out.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found by the M-T9.11 wire-golden gate (test/behavioral/systems/wire-contract.ddd seq #7) once RS-15 put an error body in the golden",
      "fixed (java): ApiExceptionAdvice's problem() sets `type` via setProperty to bypass Spring's NON_DEFAULT suppression",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-17",
    title: "A `when` state-gate rejection names the operation it refused",
    trigger:
      "an `operation … when <pred>` invoked in a state the predicate rejects — the 409 rung of the denial ladder",
    observable:
      'every backend answers 409 with title "Disallowed" and the occurrence-specific detail "operation \'<op>\' is not allowed in the current state of <Agg>.". The TITLE is the error NAME, not the status reason phrase — the sibling 409 rungs (UniquenessConflict / ConcurrencyConflict) are the ones titled "Conflict".',
    // Two independent divergences, and the split was NOT the one first recorded.
    //   * `detail` — elixir alone sent a fixed sentence ("Operation not allowed
    //     in the current state") because `:disallowed` was a bare atom carrying
    //     no message.  Same shape and same fix as RS-15: the reason is now a
    //     `{:disallowed, msg}` tuple built at the PRODUCER, which is why the
    //     event-sourced `command_error/2` clause being SHARED across an
    //     aggregate's commands never mattered — the consumer only binds it.
    //   * `title` — elixir AND **python** sent "Conflict".  The first draft of
    //     this rule recorded a 4-vs-1 split with python on the conforming side;
    //     that was inferred from python's (correct) DETAIL and never checked
    //     against its title.  It is 3-vs-2.  Recorded because it is the second
    //     time on this rule that the cheap inference was wrong.
    // Direction decided by Loom's own rule, not a vote: `errorTitle`
    // (src/util/error-defaults.ts) derives a title by humanising the ERROR NAME,
    // falling back to the status reason phrase only when there is no named
    // error — and `Disallowed` is a blessed stdlib name in STDLIB_ERROR_STATUS.
    //
    // NOT fixed here: elixir hardcodes the 409 literal where the other four
    // resolve it through `resolveErrorStatus("Disallowed", …)`, so an
    // `httpStatus Disallowed -> N` override moves four backends and not the
    // fifth.  That is the ladder-routing gap — mission M-T5.20.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-07-30 while extending the M-T9.11 golden set to the corpus feature cases — by READING the freshly-minted `state-gate` golden, before booting a second backend",
      "fixed (elixir): `{:disallowed, msg}` denial tuple + title Disallowed, via src/generator/elixir/vanilla/denial.ts",
      "fixed (python): the DisallowedError handler titled the response Conflict",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-18",
    title: "A provenanced field's lineage rides the wire as `<field>_provenance`",
    trigger: "a GET on an aggregate carrying a `provenanced` field (provenance.md)",
    observable:
      "the response body carries the lineage under the co-located snake_case key `<field>_provenance` (e.g. `total_provenance`), NOT a camelCase `<field>Provenance`. This is the one key in the wire shape that is deliberately NOT camelCase — it mirrors the backing jsonb column name, it is what `docs/provenance.md` documents, and it is what the SCAFFOLDED FRONTEND reads.",
    // Java emitted `totalProvenance` — its DTO record component name went
    // straight onto the wire.  A 4-vs-1 split where, unusually, the MAJORITY was
    // right: `<field>_provenance` is the documented key (provenance.md
    // §"Scaffolded UI") and the generated React detail page reads
    // `data.<field>_provenance` verbatim (scaffold/_body-builders.ts).  So the
    // camelCase key did not merely differ — it SILENTLY BLANKED the provenance
    // "?" disclosure on every generated UI pointed at a Java backend, with no
    // error anywhere: the frontend reads a key the backend never sends.
    //
    // Fixed with `@JsonProperty("<field>_provenance")` so the record keeps an
    // idiomatic Java component name while the wire key matches.  Verified on a
    // REAL BOOT (gradle:9-jdk25 + postgres), not an emitted-string assertion —
    // the whole failure mode here is a name that looks right in the source.
    //
    // Note this cuts AGAINST the general convention: every other wire key is
    // camelCase (`unitPrice`, `amountDue`, `createdAt`).  A future
    // "normalise the wire to camelCase" sweep must treat this key as a
    // deliberate exception, or it will re-break the frontend.
    //
    // A SECOND, LATER FINDING on the same rule, and the more instructive half.
    // This rule first shipped with elixir in `conforms` on the strength of a
    // GENERATED-SOURCE GREP.  When the elixir leg was finally BOOTED (2026-08-01),
    // it turned out vanilla never put the key on the wire AT ALL — its REST
    // serializer projects `wireShape`, and the provenance sidecar is not a
    // `wireShape` member on any backend (node appends it separately, after the
    // shape).  The grep had matched the co-located jsonb COLUMN, not the wire
    // key.  A generated-source grep is not a wire observation; only a boot is.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-07-30 by READING the freshly-minted `provenance` golden during the M-T9.11 coverage expansion — one key out of camelCase in an otherwise camelCase body",
      "confirmed by generating all five backends and diffing the emitted key, then by booting the Java project",
      "fixed (java): @JsonProperty on the DTO record component, src/generator/java/emit/dto.ts",
      "REOPENED 2026-08-01: the elixir leg's first real boot showed the key missing entirely — the earlier all-five close was inferred from a grep that matched the jsonb column, not the wire",
      "fixed (elixir): src/generator/elixir/vanilla/wire-serialize.ts appends the sidecar after the wire shape, as node does",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-19",
    title: "A declared `error` variant's fields ride the problem body",
    trigger:
      "an operation returning `T or <Error>` (payloads.md) whose error variant is selected — e.g. `operation reject(): string or NotFound { return NotFound { resource: code } }`",
    observable:
      'the RFC 7807 response carries the error payload\'s DECLARED FIELDS as extension members alongside type/title/status/detail — `NotFound { resource: string }` puts `"resource": "OR1"` on the body. The emitted OpenAPI for the union already declares them, so omitting them is a spec violation as well as a wire divergence.',
    // Java emitted the arm's status, title, type and detail and then dropped the
    // payload entirely: the client got a 404 with the right shape and NO DATA,
    // and `body.resource` read null on java alone.  The failure is quiet in a way
    // a status-only assertion cannot see — `toThrow(404)` passes on all five.
    //
    // Note java's sibling FIND-absence arm already set `resource` (hardcoded to
    // the aggregate name), which is why `union-find-absence` passed while
    // `operation-returns` did not — the two arms were written independently.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      'found 2026-07-30 by the M-T9.11 golden gate on the newly-minted `operation-returns` case (java leg): $.resource — golden "OR1" vs java null',
      "fixed (java): the union error arm projects `a.member.fields` via setProperty, src/generator/java/emit/api.ts",
      "fixed (dotnet, 2026-07-31): the same arm discarded the variant with `case <Union>_<Tag> _:` and so could project nothing — found only when the dotnet leg was actually run; the rule was briefly recorded as all-five conforming after the java fix alone",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-20",
    title: "`version` counts persisted mutations, not entity-graph dirtiness — OPEN (java)",
    trigger:
      "a `versioned` aggregate whose mutation touches only a CHILD (a single `contains`), or whose create also writes a value-object collection",
    observable:
      "`version` is 1 at create and +1 per persisted mutation, independent of WHICH part of the aggregate graph changed (RS-11 + RS-14). Java diverges in BOTH directions: a `ship` op mutating a single containment reads back 1 where the canonical value is 2 (the bump is missed), and a create carrying a value-object collection reads back 2 where the canonical value is 1 (an extra bump).",
    // Root cause is one mechanism, not two bugs: java maps `version` to JPA
    // `@Version`, and Hibernate bumps it from the dirtiness of the ROOT entity's
    // own state.  A change confined to a child/collection does not mark the root
    // dirty (no bump); a second flush that writes the collection during create
    // does (extra bump).  The other four backends set the counter explicitly at
    // the persist site, so they count MUTATIONS the way the capability declares.
    //
    // This is RS-14's family — "the version increment is shape-dependent and
    // inverted between backends" — in two shapes RS-14's fixture set never
    // reached.  RS-14 lists java as conforming; that holds for the shapes it
    // measured (document/embedded) and not for these.  Rather than edit RS-14's
    // history, this rule names the shapes it missed.
    //
    // Left OPEN deliberately: the fix is Hibernate-semantics work (forcing an
    // optimistic increment on child-only mutations without double-bumping the
    // collection write), it needs a container build + boot per iteration, and it
    // is a different unit from the golden-coverage expansion that found it.  The
    // two divergences are WAIVED in test/_helpers/wire-waivers.ts, which
    // ratchets: the waivers go stale and fail the moment java is fixed.
    conforms: ["node", "dotnet", "python", "elixir"],
    provenance: [
      "found 2026-07-30 by the M-T9.11 golden gate on the newly-minted `single-containment` and `value-collections` cases (java leg)",
      "single-containment #2 GET /api/orders/{id} $.version — golden 2 vs java 1",
      "value-collections #1 GET /api/invoices/{id} $.version — golden 1 vs java 2",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-21",
    title: "A union response carries its `type` discriminator",
    trigger:
      "an operation returning `T or <Error>` (payloads.md) that selects a SUCCESS variant — `operation accept(): string or NotFound`",
    observable:
      'the 200 body is the tagged form `{"type":"string","value":"OR1"}` — the discriminator named by `_payload/union-wire.ts`, the single source of truth for the tagged-wire shape. A typed client narrows on `type`; without it the union is unreadable.',
    // dotnet dropped the tag.  Its DTO carried the right attribute all along —
    // `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` — but
    // System.Text.Json only WRITES the discriminator when it serializes through
    // the BASE type, and `Ok(object)` leaves `ObjectResult.DeclaredType` null,
    // so STJ used the runtime type and the tag vanished.  The `(Union)` cast in
    // the emitted source does not survive the boxing: the code reads correct and
    // the wire is not, which is why only a booted round-trip found it.
    // Fixed with an explicit `ObjectResult { DeclaredType = typeof(<Union>) }`.
    //
    // ELIXIR VIOLATED THE SAME RULE, found one leg later, for an unrelated
    // reason — and the pairing is the point: the same guarantee broke once
    // because a framework silently declined to write the tag (dotnet) and once
    // because the emitter never produced it (elixir).  Vanilla carries a
    // returning op's outcome as a TUPLE (`{:ok, value} | {:error, tag, data}`)
    // and only the ERROR arm ever put its tag in the tuple; the controller
    // `json/2`s the success value straight through, so no later seam could have
    // added it.  Fixed at the producer (`renderReturningStmt`) from the tag +
    // shape the IR already carries on the `return` statement (`variantTag` /
    // `variantShape`) — the same two fields the TS backend reads.
    //
    // TWO SHAPES REMAIN UNIMPLEMENTED EVERYWHERE, and naming them is part of
    // the rule.  The AGGREGATE success variant (`operation adjust(): Item or
    // NotFound` falling through, or ending in `return this`) has NO CONFORMING
    // ORACLE: node's emitted domain method for the fall-through has no `return`
    // at all — the route `c.json`s `undefined` — and its `return this` renders
    // `{ type, ...this }`, spreading the domain class's PRIVATE `_`-prefixed
    // fields.  Vanilla is deliberately left untagged there rather than guessing
    // at a contract no shipped backend implements.  `conforms` below is
    // therefore scoped to the shapes with an oracle: SCALAR, RECORD LITERAL and
    // `none`.  The aggregate variant is its own (unowned) gap.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      'found 2026-07-31 by the M-T9.11 golden gate on `operation-returns` (dotnet leg): $.type — golden "string" vs dotnet null',
      "fixed (dotnet): ObjectResult.DeclaredType on the union success arm, src/generator/dotnet/emit/api.ts",
      "VIOLATED AGAIN 2026-08-01 on the elixir leg's first real boot: operation-returns #1 POST /api/orders/{id}/accept at $ — golden {type,value} vs a bare string",
      "fixed (elixir): src/generator/elixir/vanilla/operation-returns-emit.ts tags the success value from StmtIR.return's variantTag/variantShape",
      "aggregate-variant gap confirmed by generating that shape on node and reading the emitted method — no return statement at all",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-22",
    title: "The RFC 7807 envelope is exactly five members plus declared extensions",
    trigger: "any error response — a framework problem or a declared `error` payload",
    observable:
      "the body carries `type`, `title`, `status`, `detail` and `instance` (the request path) — and NOTHING a framework adds on its own. `instance` is never null, and no `traceId`/correlation member rides the body: trace correlation is an `x-request-id` HEADER, deliberately moved off the body so the envelope is byte-identical across backends. Only a declared error payload's own fields (RS-19) may extend it.",
    // dotnet diverged both ways at once — `instance` null AND an extra
    // `traceId` — because those arms called `ControllerBase.Problem(...)`, which
    // routes through ProblemDetailsFactory: the factory fills neither `instance`
    // nor the content type, and injects `traceId` from the ambient Activity.
    // The app's OWN exception filter already hand-builds the envelope for
    // exactly this reason; the union arms and the find-absence arm were the
    // sites that had not been converted.
    //
    // Worth stating as a rule rather than a fix note: "the framework helper adds
    // a member nobody else sends" is invisible to every static gate — the
    // emitted source names none of it.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-07-31 by the M-T9.11 golden gate on `operation-returns` + `union-find-absence` (dotnet leg): $.instance golden path vs dotnet null, and $.traceId golden absent vs dotnet present",
      "fixed (dotnet): the union + find-absence arms build ProblemDetails by hand with Instance = HttpContext.Request.Path, src/generator/dotnet/emit/api.ts",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-23",
    title: "An absent collection is `[]` on every PERSISTENCE ADAPTER, not just the default",
    trigger:
      "an optional value-object collection (`surcharges: Money[]?`) never written, read back on a non-default persistence adapter — `persistence: dapper` (.NET) or `persistence: mikroorm` (node)",
    observable:
      "the collection reads back as `[]`. This is RS-8's absence shape, but the point of THIS rule is that it holds per ADAPTER: the wire contract for a collection is the empty array, never null, so a client can iterate without a guard.",
    // RS-8 was only ever proven on the DEFAULT adapters, and they get it for
    // free by accident of storage topology: EF Core maps the collection to an
    // `OwnsMany` CHILD TABLE and Drizzle to a join, and an empty child set
    // materializes as an empty list.  Both alternative adapters store it as ONE
    // NULLABLE JSONB COLUMN instead, and faithfully round-trip SQL NULL — so the
    // same `.ddd`, same backend, different `persistence:` clause put `null` on
    // the wire.  Two adapters, one class:
    //   * dapper   — the row->domain hydrate emitted `is null ? (List<T>?)null`
    //   * mikroorm — the shared `deserializeField` optional arm short-circuited
    //     on null BEFORE the array arm's `?? []` could apply
    // Fixed on the READ in both, not the write, so rows already stored as NULL
    // are repaired rather than only new ones.
    //
    // The generalisable lesson: a persistence adapter is a WIRE-VISIBLE choice,
    // not an internal one.  Any rule proven only on the default adapter is
    // proven on one storage topology — which is why the dapper/mikroorm legs
    // carry the goldens too.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-07-31 by the M-T9.11 golden gate once the expanded set reached the dapper + mikroorm legs: value-collections #1 $.surcharges — golden [] vs null on BOTH",
      "fixed (dapper): src/generator/dotnet/emit/dapper.ts hydrates an absent jsonb collection to an empty list",
      "fixed (mikroorm): src/generator/typescript/repository-document-builder.ts deserializeField delegates an optional ARRAY to the coalescing array arm",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-24",
    title: "A plain `decimal` is a JSON NUMBER on the wire; only `money` is a string",
    trigger: "a GET returning an aggregate (or nested value object) with a `decimal` field",
    observable:
      'the value is a JSON number (`9.99`, `5`). This is the deliberate counterpart to RS-12, where `money` is a fixed-scale STRING (`"19.5000"`) so no float rounding can touch a monetary amount — the two types differ on the wire, and a backend must not collapse them.',
    // 4-vs-1 again, and a textbook FRAMEWORK-MEDIATED shape: nothing in the
    // vanilla emitter chose a string.  Jason's `Decimal` encoder emits a JSON
    // string, so every `%Decimal{}` that reached the serializer un-transformed
    // shipped quoted.  That is exactly right for money (RS-12 wants the string,
    // and `__money_round/1` leaves it a Decimal) and exactly wrong for a plain
    // decimal — the same accident produced the correct answer for one type and
    // the wrong one for the other, which is why reading the emitter would never
    // have found it.
    //
    // Fixed with a `__decimal_num/1` helper (`Decimal.to_float/1`) applied to
    // plain-decimal wire entries — property, DERIVED, and `decimal[]` element
    // alike.  `to_float` reproduces the ORACLE exactly rather than merely
    // narrowing the gap: node's value is a float64 to begin with.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      'found 2026-08-01 by the M-T9.11 golden gate on the elixir leg: value-collections #1 GET /api/invoices/{id} at $.lineItems[*].amount — golden 9.99 / 5 vs "9.99" / "5"',
      'root-caused by running Jason.encode!(%{a: Decimal.new("9.99")}) against the real library rather than reading the emitter',
      "fixed (elixir): src/generator/elixir/vanilla/wire-serialize.ts __decimal_num/1",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-25",
    title: "`internal` / `secret` fields never reach the read wire",
    trigger:
      "a GET on an aggregate carrying an `access: internal` field — e.g. the `tenantId` / `dataKey` the `tenantOwned` capability injects (docs/tenancy.md)",
    observable:
      "the response body OMITS the key entirely. `forApiRead` is the read-boundary projection every backend applies over `wireShape`; `internal` is domain-only state and `secret` is never disclosed anywhere.",
    // 4-vs-1.  The vanilla REST serializer projected the RAW `wireShape` and
    // never applied `forApiRead`, so a multi-tenant aggregate shipped its tenant
    // key to every client on every GET, and a `secret` field would have leaked
    // the same way.  What makes this more than a stray field: the SAME BACKEND's
    // OpenAPI emitter *did* apply `forApiRead`, so the served spec promised a
    // body the running server did not send.  Spec and runtime disagreed inside
    // one deployable — a divergence no spec-diff gate can see, which is the
    // premise of the whole runtime-differential tier.
    //
    // Fixed at both vanilla read-boundary projections (the REST serializer and
    // the returning-op success body).  Deliberately NOT applied to
    // `eventsourced-emit.ts`'s `structFields`, which names the in-memory struct's
    // fields — the domain needs its internal state.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-08-01 by the M-T9.11 golden gate on the elixir leg: tenancy-owned #1 GET /api/invoices/by_number at $.tenantId — absent in the golden, present on elixir",
      "fixed (elixir): forApiRead applied in src/generator/elixir/vanilla/wire-serialize.ts and operation-returns-emit.ts",
    ],
    tier: "behavioral",
  },
  {
    id: "RS-26",
    title: "An omitted UPDATE field is a client error, never a silent default",
    trigger: "`active: bool = true`; a PUT body omitting `active`",
    observable:
      'PUT without "active" is REJECTED (the field is required input) — it does NOT set active=false, and does not re-apply the create default either',
    // The exact inverse of RS-6, and the half that eats data.  RS-6 says an
    // omitted CREATE bool materializes its declared default; a default is a
    // CONSTRUCTION rule, so on update — where there is nothing to construct —
    // "absent" cannot mean "the default".  Loom's update contract is
    // full-replacement (PUT carries every field), so an omitted field is simply
    // a missing required one.
    //
    // Applying a wire default there silently rewrote stored state: for
    // `active: bool = true` a PUT omitting `active` set it to FALSE — not even
    // the declared default, because the value came from a hardcoded
    // implicit-bool rule rather than the model.  This is the proto3 lesson: a
    // wire-level default makes "absent" indistinguishable from "the default
    // value", which is why proto3 dropped custom field defaults and had to
    // re-add explicit field presence in 3.15.
    //
    // 1-vs-4, with the MINORITY correct.  Node's `.default(false)` was added
    // deliberately to match .NET model-binding and Phoenix, so four backends
    // agreed and the agreement was wrong (the RS-15 shape inverted).  All five
    // conform now, and NO TWO NEEDED THE SAME FIX (see `provenance`), which is
    // why the rule was worth numbering rather than patching one emitter.
    //
    // The node fix took two rounds, and the second is the reusable lesson: the
    // `.default(false)` was only the VISIBLE half.  `z.coerce.boolean()` is
    // `Boolean(input)` and `Boolean(undefined) === false`, so the coercion IS a
    // wire default — removing the `.default(` left the behaviour unchanged.  It
    // was invisible to the first version of the static gate (which keyed on the
    // absence of `.default(`) and surfaced only in the 5-way OpenAPI parity run,
    // because zod-to-openapi derives `required[]` from `schema.isOptional()` —
    // literally "does it accept `undefined`".  A gate that asks about SPELLING
    // rather than BEHAVIOUR passes a backend that still has the bug.
    //
    // The elixir regression later the same day is that lesson's twin.  A gate
    // can ask the right question in the right vocabulary and still ask the
    // WRONG ARTIFACT: the arm read the OpenApiSpex schema, which DOCUMENTS,
    // while the Ecto changeset, which ENFORCES, had quietly stopped listing the
    // field.  Where a backend splits "what the server says" from "what the
    // server checks" across two files, a conformance gate owes an assertion to
    // each — otherwise it certifies the promise, not the behaviour.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-08-01 while reconciling where `= default` belongs (domain vs wire): the emitted UpdateItemRequest carried `active: z.coerce.boolean().default(false)` against a model declaring `active: bool = true`",
      "fixed (node): zodFor gained a `create-body` context so the implicit-bool rule fires only on create — src/platform/hono/v4/routes-builder.ts",
      "fixed (node, round 2): dropping the `.default(false)` was not enough — `z.coerce.boolean()` is `Boolean(input)`, so a coerced bool still ACCEPTED an omitted key as `false` and zod-to-openapi (which reads `schema.isOptional()`) dropped it from the served `required[]`.  Body bools are now UNCOERCED `z.boolean()`; only query params keep the coercion — src/platform/hono/v4/routes-builder.ts",
      "fixed (python): requestFieldDecl gained a `slot` so the implicit bool `= False` fires only on create — src/generator/python/routes-builder.ts",
      "fixed (elixir): SPEC-only divergence — `@update_required` already listed every bool at runtime while the OpenApiSpex schema did not; renderProperties gained a slot — src/generator/elixir/vanilla/openapi-emit.ts",
      "fixed (dotnet): `[Required]` on a non-nullable value type cannot reject absence (RequiredAttribute tests for null; an omitted int/bool binds to 0/false). Operation params gained `[property: JsonRequired]` ALONGSIDE `[Required]` — presence is a deserialization question — src/generator/dotnet/dto-mapping.ts",
      "fixed (java): BOTH halves were wrong — the record used primitives (`int qty`, `boolean active`), so Jackson silently supplied 0/false for an omitted key while RequiredSet claimed qty required; operation components are now boxed + @NotNull (emit/dto.ts) and requiredParams no longer drops bare bools (emit/openapi-customizer.ts)",
      "regressed 2026-08-03 (elixir) by #2377's `isRequiredUpdateInput`, which tested the implicit-bool rule and never reached the explicit default, so `active: bool = true` came back omittable and `@update_required` stopped listing it — while the OpenApiSpex schema still advertised it. Elixir promised what it did not enforce; fixed by making the predicate `!isNullable(f)` (a default of EITHER kind is a construction rule, so neither relaxes a full-replacement update) — src/ir/enrich/wire-projection.ts",
      "the gate missed that regression because its elixir arm read update_item_request.ex (the OpenApiSpex SCHEMA) and not item_changeset.ex (validate_required, which ENFORCES); it now asserts both, and the fixture gained a bare `flag: bool` — the case that separates the create seam from the update seam",
    ],
    // Static: assertable against each backend's emitted update-request contract
    // (zod schema / Pydantic model / record attributes / RequiredSet /
    // OpenApiSpex `required:`) with no boot.
    tier: "static",
  },
  {
    id: "RS-27",
    title: 'A 404-BY-ID carries the sentence `"<Aggregate> <id> not found"` in `detail`',
    trigger:
      "`GET /api/<aggs>/{id}` (or `GET /api/<aggs>/{id}/history`) for an id that does not exist",
    observable:
      'the RFC 9457 body\'s `detail` is the sentence `"<Aggregate> <id> not found"` — the aggregate\'s PascalCase name, the requested id, and the words "not found" — on every backend. Not a machine token, not a framework default. The 404 an OPTIONAL FIND answers is a DIFFERENT class and keeps the `"not_found"` token; the rule is about reads addressed BY ID.',
    // The shape of the divergence is the interesting part: this was not five
    // backends inventing five strings.  FOUR agreed exactly, because on each of
    // them the message comes from one shared producer — the repository's
    // `getById` (`typescript/repository-builder.ts`, `python/repository-
    // builder.ts`, `java/emit/repository.ts`) or Phoenix's
    // `ProblemDetails.not_found_response/3`.  The two outliers were the two
    // routes that BYPASSED that producer:
    //
    //   • node's getById/history probed with `repo.findById` (returns null) and
    //     raised its own `AggregateNotFoundError("not_found")` — a machine
    //     token, no aggregate, no id.  The very same service's DELETE route
    //     already answered the sentence, because it loads via `repo.getById`.
    //   • .NET's getById returned `NotFound()`, ASP.NET's own bare 404, so it
    //     never reached `DomainExceptionFilter`'s `AggregateNotFoundException`
    //     arm that every OTHER .NET 404 goes through.  That ALSO put it outside
    //     RS-22's envelope (the factory omits `instance` and injects `traceId`)
    //     — an unmeasured hole in an existing rule, closed by the same fix.
    //   • java's getById returned `ResponseEntity.notFound().build()` — Spring's
    //     own bare 404, an EMPTY BODY — because the SERVICE read ended
    //     `.orElse(null)` while every java WRITE path loads through
    //     `repository.getById`, which throws.  Same bypass, third spelling.
    //
    // So the rule to remember is narrower than "agree on a string": a 404 must
    // be RAISED BY THE SHARED PRODUCER, never hand-rolled at the route. Every
    // hand-rolled 404 is a place where one route of one service answers
    // differently from the rest of itself.  THREE of five backends had it, and
    // in all three the bypass sat on the by-id READ while the writes were fine
    // — the read is where `findById`-returning-null tempts a local answer.
    //
    // WHY IT SURVIVED SO LONG — two independent blind spots, and both are worth
    // stating because they generalise:
    //
    //   1. NO CALLER.  Nothing in the repo had ever driven a `GET /<aggs>/{id}`
    //      404.  The API-operation caller census (`test/ir/api-caller-census.
    //      test.ts`) is what surfaced it: the destroy/list drain needed a
    //      "the row is really gone" assertion, and that assertion was the first
    //      request of its kind the goldens ever recorded.
    //   2. UNBASELINABLE.  Even had a test existed, the golden could not have
    //      held the field: the sentence embeds a per-run uuid and
    //      `WIRE_NORMALIZE` templated only PATH-shaped strings, so `detail`
    //      differed on every run of every backend.  A field that cannot be
    //      recorded cannot be gated.  Generalising the rewrite to any embedded
    //      uuid (`test/_helpers/wire-record.ts`) is what makes this rule
    //      enforceable at all.
    //
    // AND A THIRD, ABOUT THE VERIFICATION ITSELF.  java's bypass was missed on
    // the first pass because the survey read the REPOSITORY (which emits the
    // sentence) and stopped.  The first parity pin then encoded that same
    // mistake: a `.java`-wide `toContain` of the message, which the repository
    // satisfies — so "java emits the sentence" was literally TRUE while the
    // route answered `""`, and the pin went green until a booted leg failed.
    // The route-level assertions in `not-found-by-id-detail-parity.test.ts` are
    // scoped per FILE for exactly this reason: a 404 is a property of the ROUTE,
    // so only a route-scoped assertion can pin it.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      'found 2026-08-04 by the api-caller-census drain: adding `api.orders.destroy(id)` + `expect(api.orders.getById(id)).toThrow(404)` to corpus/core-domain made the python leg diverge from the node golden at $.detail — golden "not_found" vs python "Order <uuid> not found"',
      "fixed (node): the getById and history routes raise `new AggregateNotFoundError(`<Agg> ${id} not found`)` — the message `repo.getById` would have thrown — src/platform/hono/v4/routes-builder.ts",
      "fixed (dotnet): the getById action throws AggregateNotFoundException instead of returning `NotFound()`, so it routes through DomainExceptionFilter like every other .NET 404 (which also puts it back inside RS-22) — src/generator/dotnet/emit/api.ts",
      'THIRD offender found 2026-08-04 by the behavioural-java leg on PR #2429 (NOT by the emitter survey, which had cleared java by reading the repository): core-domain #9 GET /api/orders/{id} — golden {…RFC-9457…} vs java "" (404, empty body)',
      "fixed (java): the service read ends `.orElseThrow(() -> new AggregateNotFoundException(...))` instead of `.orElse(null)`, and the controller returns `ResponseEntity.ok(...)` instead of `notFound().build()`, so the @RestControllerAdvice renders the envelope — src/generator/java/emit/service.ts + emit/api.ts.  Thrown in the SERVICE (not the controller) so the read stays read-scoped: `repository.getById` loads through the WRITE scope when one is narrower.",
      "hardening (java): the five sites that spell the message now render one emitter-side helper, `javaNotFoundThrow` — src/generator/java/emit/common.ts",
      "elixir/python needed NO change, and this is now CHECKED at the route (not read): `show/2` and the history action call `ProblemDetails.not_found_response/3` directly; python's route calls `repo.get_by_id`, which raises",
      "enabler: WIRE_NORMALIZE now templates a uuid embedded ANYWHERE in a string value, not only in a path — without it no golden can hold a 404-by-id body — test/_helpers/wire-record.ts",
      "runtime-verified on node (PGlite), python (uvicorn + postgres) and java (gradle:9-jdk25 boot + postgres): all three match the golden byte-for-byte on core-domain, 0 divergences",
    ],
    tier: "behavioral",
    tier: "static",
  },
  {
    id: "RS-28",
    title: "An unrecognised error term is a sanitized 500, never a 400 that echoes it",
    trigger:
      "an `{:error, <term>}` / thrown fault that no declared error variant, wire-validation failure, or denial rung matches — e.g. a hand-written `extern` handler returning an unmodelled error, or an unexpected fault escaping a workflow's run",
    observable:
      'the response is 500 "Internal Server Error" and its RFC 7807 `detail` is the fixed string "internal". TWO claims, both wire-visible. STATUS: an error the server did not model is a SERVER fault, so 4xx is wrong on its face — 400 tells the caller to fix a request that was never the problem. DETAIL: the term is never rendered into the body; a serialized internal value leaks struct names, module paths and sometimes the failing value itself to an unauthenticated caller. MODELLED faults are unaffected — a declared `error` payload, a wire-validation failure, and each denial rung keep their own status and occurrence-specific `detail`; this rule governs only the arm none of them matched.',
    // Elixir answered 400 and `inspect/1`d the term into `detail`:
    //
    //   def respond(conn, {:error, reason}),
    //     do: ProblemDetails.problem_response(conn, 400, "Bad Request", inspect(reason))
    //
    // It survived RS-15's 400 → 422 sweep precisely because it is NOT the
    // domain floor: RS-15 moved the rejections the domain MAKES, and this is
    // the rejection nobody made.  Fixed via the shared `respondErrorTail` in
    // `denial.ts`; `_reason` is bound underscore-prefixed so nothing reads it.
    //
    // PYTHON WAS A SECOND, SMALLER DIVERGENCE ON THE SAME ARM, and the way it
    // was found is the point.  The elixir fix's own report proposed this rule as
    // all-five-conforming.  That list was INFERRED — checking it showed
    // node/.NET/java emit the literal `"internal"` while python emitted
    // `"An unexpected error occurred."`.  Python had no leak (its string was
    // fixed and reflected nothing), so it was not the defect this rule was
    // minted for; it simply was not byte-identical, and byte-identity is the
    // whole premise of the M-T9.11 golden.  Fixed in the same change.
    //
    // This is the THIRD time in this rule family that an all-five `conforms`
    // was asserted from reading rather than checking (RS-18 twice, RS-19 once).
    // The habit the registry needs is: enumerate the other backends' emitted
    // literal before writing the list, every time.
    //
    // Not caught by the M-T9.11 wire golden: no system in the shared corpus
    // reaches this arm, so all five legs were green with the divergence in
    // place — which is exactly why it needs a NAME.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-07-29 while landing RS-15 (#2300) by grepping the vanilla Phoenix denial protocol's edges; tracked as M-T6.24 (1)",
      'fixed (elixir): the shared respondErrorTail in src/generator/elixir/vanilla/denial.ts emits problem_response(conn, 500, "Internal Server Error", "internal")',
      'python divergence found 2026-08-01 by verifying the proposed conforms list instead of accepting it; fixed the same day — src/generator/python/index.ts now sends the literal "internal"',
      "pinned by test/conformance/internal-fault-parity.test.ts, which asserts the arm on all five",
    ],
    // STATIC: assertable against the emitted handler source on all five without
    // a boot.  Promote to `behavioral` when a corpus fixture reaches the arm —
    // an `extern` stub returning an unmodelled error would do it in one case.
    tier: "static",
  },
  {
    id: "RS-27",
    title: "The wire-validation rung is `Validation failed`, distinct from the domain floor",
    trigger:
      "a POST whose body fails wire validation — a missing required field, a wrong type, a tripped `invariant` expressible at the boundary",
    observable:
      'the 422 body carries title "Validation failed" and detail "One or more fields are invalid.", plus the `errors[]` pointer array. This is DELIBERATELY not the status reason phrase, because the DOMAIN FLOOR also answers 422 (RS-15) with title "Unprocessable Entity". Both rungs are 422; `title` plus `errors[]` is the only thing that tells a client "your JSON is malformed" from "your request was understood and refused". A backend that titles the validation rung with the reason phrase collapses the two.',
    // 4-vs-1, python the outlier: `"Unprocessable Entity"` / `"Request
    // validation failed."` against the other four's `"Validation failed"` /
    // `"One or more fields are invalid."`.  Both halves of the body differed.
    //
    // WHERE IT SAT is what makes it worth naming: wire validation is the
    // highest-traffic error path in any API — every malformed request hits it —
    // and it was invisible to every gate.  The M-T9.11 golden cannot see it
    // because NOT ONE of the 31 goldens records a 4xx body; conformance-parity
    // compares declared response SHAPES, not the values in them.
    //
    // Found by the M-T9.25 census probe on its first run: enumerate every 7807
    // arm each backend emits and diff them.  That probe exists because the two
    // bugs before it (a router that ignored an override, and mergeContexts
    // dropping the override maps) were both INTRA-backend — a backend
    // disagreeing with itself, which no comparison-to-another-backend gate can
    // see.  This one turned out to be cross-backend, found by the same sweep.
    conforms: ["node", "dotnet", "java", "python", "elixir"],
    provenance: [
      "found 2026-08-01 by the M-T9.25 7807-arm census, first run; confirmed by generating all five and reading the emitted arm, not by grepping the emitter",
      "fixed (python): src/generator/python/index.ts RequestValidationError handler",
      "pinned by test/conformance/problem-arm-census.test.ts, verified to FAIL on all three assertions with the fix reverted",
    ],
    // STATIC: assertable on emitted source.  Promote to `behavioral` the moment
    // a golden records a 4xx — that coverage hole is the larger finding here and
    // is tracked in M-T9.11's follow-on.
    tier: "static",
  },
];

// ---------------------------------------------------------------------------
// Diffable spec artifact.
//
// `SEMANTICS_RULES` above is the single source of truth; `serializeSemanticsSpec`
// derives a committed, pretty-printed JSON mirror (`semantics-spec.json`) so a
// contract change surfaces as a reviewable JSON diff — the `wire-spec.json` /
// `langium-generated` "derived file + CI drift gate" precedent.
//
// The registry is a GLOBAL toolchain contract, not a per-generated-system fact,
// so the mirror is committed here (test/conformance/), NOT emitted into each
// system's `.loom/` bundle. `semantics-spec-sync.test.ts` fails if this output
// drifts from the committed file; regenerate with `UPDATE_SEMANTICS_SPEC=1`.
// ---------------------------------------------------------------------------

/** Bump when the envelope shape (not the rules) changes. */
export const SEMANTICS_SPEC_VERSION = 1;

/**
 * Deterministic, pretty-printed JSON mirror of `SEMANTICS_RULES`.
 *
 * Stable across runs: rules sorted by numeric id; per-rule field order fixed
 * (id, title, trigger, observable, conforms, targets, provenance, tier);
 * `targets` omitted when absent. 2-space indent, trailing newline.
 */
export function serializeSemanticsSpec(): string {
  const rules = [...SEMANTICS_RULES]
    .sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)))
    .map((r) => {
      const out: Record<string, unknown> = {
        id: r.id,
        title: r.title,
        trigger: r.trigger,
        observable: r.observable,
        conforms: r.conforms,
      };
      if (r.targets) out.targets = r.targets;
      out.provenance = r.provenance;
      out.tier = r.tier;
      return out;
    });
  return `${JSON.stringify({ version: SEMANTICS_SPEC_VERSION, rules }, null, 2)}\n`;
}
