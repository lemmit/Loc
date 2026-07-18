# T3 — Security, tenancy & governance

*Weak-spot #3: the enforcement machinery is genuinely strong (tenancy by construction, policy ladders, OIDC on all targets) but the DEFAULTS are demo-grade: authz default-open, finds ungatable, sessions shallow, concurrency opt-in. The governance spine (execution-context → tenancy → authorization) is mostly built — these missions finish and default-harden it.*

## M-T3.1 — Deny-by-default + read/find gating — `partial` · **M** · P1
`requires`-on-find grammar **shipped** (PR #1962): `FindDecl` gains an optional `requires <expr>` gate before `where`, lowered currentUser-only in the bare context env (the read-side twin of the view gate), printed, validated (`loom.find-gate-not-current-user`), and emitted as an in-handler 403 (`ForbiddenError`/`ForbiddenException`) on **all five backends** (Hono / .NET / Java / Python / Phoenix) before the query runs. `validateDefaultDeny` now flags ungated author-declared named finds under `denyByDefault` (`loom.default-deny-ungated`) — the last structural authz hole closed; the auto-injected `find all` list route stays out of scope (compiler-synthesized, no author gate surface — declare an explicit `find all(): T[] requires <expr>` to gate it). Recommended-default flip **shipped** as docs + `ddd new` scaffold guidance (auth.md §enforcement now recommends `denyByDefault`; the starter `main.ddd` carries a commented `enforcement: denyByDefault` block). **Remaining (deferred, needs a major):** flip the *language* default from `opt` → `denyByDefault`.
Sources: [auth-providers-implementation](../old/plans/auth-providers-implementation.md) Phase 4, [auth.md](../auth.md) §enforcement, weak-spots §3.

## M-T3.2 — Authorization completion: items 3, 5, 6, 7 — `partial` · **L** · P1
Remaining from the policy family: item 3 operation/view/workflow gates (handler pre-checks → 403, relocating gating out of domain bodies); item 5 `exists <Aggregate>` quantifier (new ExprIR kind + per-backend EXISTS); item 6 field rules (mask/write + partial-update gating + wire-spec `fieldCapabilities`); item 7 `implies` permission closure + stable policy decision-id for audit. Honor the [policies-supplementary-note](../old/proposals/policies-supplementary-note.md) asks (converge on `requires <expr>`, decision-id, IR-inspectable gates).
Sources: [authorization](../old/proposals/authorization.md), D-POLICY-STYLE.

## M-T3.3 — P4 `deny` carve-outs — `open` · **M** · P2
`deny on X` / `deny write on X` deny-wins sentinel through the existing filter/write-scope seam (design checkpoint written; grammar `effect`, `PolicyDenyIR`, enrichment, 3 diagnostics, 5-backend always-false fragment). Open fork: `loom.policy-deny-shadows-allow` severity.
Sources: [authorization-phase4-deny](../old/plans/authorization-phase4-deny.md). Foundation for item 6 field masking.

## M-T3.4 — Versioned default-on + structural-409 mapper + idempotency — `done` · **L** · P1
`versioned` (optimistic concurrency) ships but is opt-in — default LWW contradicts "aggregate = consistency boundary". Phased per expressible-builtins: (a) route structural 409s (unique/version/when/FK/event-store) through the `httpStatus` error→status mapper — **done** (built-in conflict names `UniquenessConflict`/`ConcurrencyConflict`/`Disallowed`/`ReferencedInUse` in the stdlib status table; resolved app-wide via a first-declared-wins fold in enrichment — structural conflicts surface in app-global handlers with no per-context tag — and threaded through the runtime arm AND the OpenAPI declaration on all 5 backends so the two can't drift; absent an override every value stays 409 = byte-identical; `loom.reserved-structural-error-name` warns when a user `error` shadows a built-in; the Elixir destroy path additionally reconciled a pre-existing OpenAPI-409-vs-runtime-500 FK-restrict drift; open-question 3 resolved as "fixed internal set"); (b) versioning default-on for every aggregate — **done** (PR #1933): the macro expander auto-applies the built-in `versioned` capability to every non-event-sourced aggregate (event-sourced ones keep their intrinsic `(stream_id, version)` stream), so a lost-update bug can no longer be introduced by *forgetting* to opt in. Verified across all 5 backends: a plain scaffolded aggregate's served read exposes `version`, its state table carries the `version INTEGER NOT NULL DEFAULT 1` column, and its update path emits the guarded CAS + 409. Scope decisions (per owner, 2026-07-14): **no `unversioned` opt-out** and **version stays the existing `token` wire field** — the ETag/If-Match off-wire move and the `unversioned` modifier are deferred to a stacked follow-up; the `versioned` capability stays valid (redundant, idempotent) rather than deleted. Explicitly-declared `response` records read verbatim and do not auto-gain `version` (authoritative contracts — the strict/If-Match slice revisits this); (c) HTTP `Idempotency-Key` support so retried POST creates don't duplicate (new slice, no owning proposal yet) — **descoped** (2026-07-18, per owner). Rationale: aggregates in practice almost always carry a natural unique key, so a retried POST hits the slice-(a) `UniquenessConflict` (409) instead of duplicating — dedup is already covered. The residual gap idempotency keys would close is *response* idempotency (a safe retry replaying the original 201 rather than seeing 409); accepted as not worth the 5-backend fan-out + synthetic `__loom_idempotency` store for the current workload. Revisit if a caller needs to distinguish "my own retried create succeeded" from "another writer took this key".
Sources: [expressible-builtins](../old/proposals/expressible-builtins.md) Phases 1–2, weak-spots §3, ddd-review S4.

## M-T3.5 — OIDC session depth — `open` · **M** · P1
The callback stores the raw access token in a cookie: no refresh rotation, no PKCE, no silent renewal; no password reset story (IdP-owned by D-AUTH-OIDC — document the boundary loudly). Add PKCE + refresh rotation across the five backends' auth emitters; Phoenix-LiveView frontend `auth: ui` guard (the last frontend target).
Sources: `src/platform/hono/v*/auth-emit.ts`, [auth-providers-implementation](../old/plans/auth-providers-implementation.md), weak-spots §3.

## M-T3.6 — `organizationContext` + tenancy final surface — `blocked(M-T3.2)` · **L** · P2
The reconciled surface (7 pinned decisions): split principal (`currentUser`) from operating tenant scope (`organizationContext`); one unconditional `dataKey` stamp; `startsWith` prefix filter operator (expressible-builtins Phase 3, retiring `__loomDeepScope__`); `crossTenant` fail-closed; drop the ambient row pronoun. HARD PREREQ: the fail-closed, validator-enforced context-switch authorization gate on all five backends (+ a tenancy-e2e-sibling parity test) — sequenced after M-T3.2, never before.
Sources: [tenancy-authorization-final-surface](../old/proposals/tenancy-authorization-final-surface.md), [organization-context](../old/proposals/organization-context.md), [expressible-builtins](../old/proposals/expressible-builtins.md) Phase 3.

## M-T3.7 — Tenancy hardening tail — `partial` · **M** · P2
(a) `tenantOwned`'s filter claim is hardcoded to `tenantId`, ignoring `tenancy by user.<claim>` — plumb the declared claim; (b) tenancy isolation is runtime-e2e'd on node/python/java/dotnet ⚠ verify current matrix — extend to elixir; (c) malformed-claim 500 → clean 403/empty-set decision; (d) `loom.tenancy-claim-type-mismatch` gate if still missing.
Sources: [completeness-audit](../audits/completeness-audit-2026-07.md) §tenancy, [multi-tenancy-implementation](../old/plans/multi-tenancy-implementation.md) 1b-tail, [tenancy.md](../tenancy.md).

## M-T3.8 — Sensitivity phases 2–4 — `partial` · **L** · P2
Phase 2 `authorized(<category>)` declassification (2-lite warnings → errors); Phase 3 wire masking (`mask:` strategies in DTO emitters — today `sensitive()` only redacts logs, not the wire); Phase 4 sink-call classification (logs/errors/traces/metrics never receive plaintext).
Sources: [sensitivity-and-compliance](../old/proposals/sensitivity-and-compliance.md).

## M-T3.9 — Audit promotion: `audited(...)` + `logged` — `partial` · **M** · P2
Boolean `audited` ships on all five, ops AND lifecycle (verified 2026-07-13: `AUDIT_OP_BACKENDS` = `AUDIT_LIFECYCLE_BACKENDS` = all 5, `system-checks.ts:2464-2465`; the old plan's "gate claims node support that ships nowhere" note was stale). Remaining: the argument form `audited(actions|access|events|off)` (grammar change on three productions; prerequisite for access-audit mode), the `logged` marker, and the AuditRecord snapshot enrichment.
Sources: [audit-and-logging](../old/proposals/audit-and-logging.md), [lifecycle-audit-todo](../old/plans/lifecycle-audit-todo.md).

## M-T3.10 — Offerability: authz-aware `can_<op>` — `open` · **M** · P3
Fold the param-free authz slice into the `can_<op>` companion (`{allowed, reason, pendingValidation}`), so UIs can hide/disable correctly. Depends on M-T3.2 item 3 (gates relocated into policy).
Sources: [offerability-can-query](../old/proposals/offerability-can-query.md).

## M-T3.11 — Execution-context tail — `partial` · **S** · P3
Backbone complete on all 5. Remaining: user-facing build-flag surface (`emitContextBoundaries`/`emitProvenance`/`emitTracing`), scope-event genealogy fields, parallel-branch frame copying, the `scopeId` semantics decision (pin as D-tag).
Sources: [execution-context](../old/proposals/execution-context.md), D-CTX-SHAPE.

## M-T3.12 — Account management & identity batteries — `open` · **L** · P3 (proposal needed)
Signup/invite/role-assignment flows as macro-level batteries over the OIDC boundary (production-readiness §3.6); tenant provisioning/onboarding hooks into the registry.
Sources: [production-readiness](../old/proposals/production-readiness.md) §3.6, [quickstart-and-day-one-batteries](../old/proposals/quickstart-and-day-one-batteries.md) `saas` template.
