# Proposal surface-stability review — 2026-07-08

A snapshot audit of Loom's design-proposal corpus for **language-surface
stability** — does any proposal, if implemented, introduce the very
anti-patterns the "stable, smooth, without surprises" goal exists to remove?
Two adversarial passes: (A) the six proposals authored this session, (B) the
pre-existing PROPOSED/PARTIAL corpus. Every keyword/collision claim was
verified against `src/language/ddd.langium`, the validators, and the
emitters on the working tree; file:line references are ±2.

## The lens — anti-patterns hunted

1. **Magic names/strings** — behavior hinging on the compiler recognizing a
   blessed string rather than a visible declarative shape.
2. **Redundancy** — two ways to say one thing (alias / duplicate form).
3. **Keyword overload / soft-keyword sprawl** — one keyword meaning two
   things, or a common-word keyword forcing re-admission across the ~6
   identifier unions in `ddd.langium`.
4. **Silent no-ops** — surface that parses/validates but emits nothing
   (especially partial cross-backend support failing silently).
5. **Footguns / security holes / races** — tenancy, auth, concurrency,
   persistence.
6. **Derive-don't-stamp violations** — storing what is re-derivable.
7. **Cross-proposal conflicts.**

---

## Part A — session proposals (all findings FIXED)

Status: every item below was corrected in the proposal docs this session
(commits on `claude/loom-language-cleanup-2o2atp`).

| # | Proposal | Sev | Finding | Resolution |
|---|---|---|---|---|
| A1 | organization-context | blocker | Moves the tenant read `filter` off an unforgeable JWT claim (`currentUser.orgPath`) onto a caller-*submitted* value, with the authorization gate left as an open question — a latent cross-tenant read/write hole if any backend ships the switch without the gate. | Added a BLOCKING-PREREQUISITE callout: gate must be fail-closed, per-backend, parity-tested (sibling of `tenancy-e2e`) before the surface is admitted; sequenced *with* authorization. |
| A2 | scaffolded-navigation | blocker | Mischaracterized the real default sidebar. The default is the hardcoded `prepareAppShellVM` grouping (`menu-emitter.ts:12-27`), **not** the per-page bag. "No `menu {}` ⇒ no sidebar" would silently strip the sidebar from every scaffolded UI; the migration couldn't recover it. | Corrected the problem statement; scaffold must materialize the full Aggregates/Workflows/Views grouping; migration covers default-driven UIs (golden-nav snapshot gate); enumerated all five frontends' sidebar drivers. |
| A3 | expressible-builtins | concern | Self-inflicted overload: `onWrite precondition` reuses the existing imperative `precondition` statement keyword for an unrelated declarative construct. | Renamed to `writeGuard` — **then superseded**: the whole write-guard/`old` surface was struck when versioning became default-on for every aggregate (removed its only consumer). See `expressible-builtins.md` §1. |
| A4 | expressible-builtins | concern | Self-inflicted redundancy: `new` used as an alias of `this` — a second spelling (and a costly soft keyword) in the anti-redundancy proposal. | Dropped `new` — **then moot**: the guard surface it belonged to was struck (see A3). |
| A5 | expressible-builtins ↔ organization-context | concern | The `deep`/`global` read-anchor was specified two incompatible ways (principal vs operating context) — security-relevant. | Added a joint cross-proposal seam; recommended principal-anchored reads, switch = explicit widening. |
| A6 | organization-context | concern | Claimed "purely additive" — false for the trust model (filter basis shifts from unforgeable to submitted). | Reframed honestly; reads stay principal-anchored by default. |
| A7 | scaffolded-navigation | concern | Label-exact section merge silently produces a duplicate on `"orders"`/`"Order"`. | Warn on near-miss labels; key scaffold sections on the `area` ref, not the rendered string. |
| A8 | surface-redundancy-cuts | concern | Cut of `UiBlockBinding` may remove a real capability (per-binding-site `framework:` override — only `UiBlockBinding` expresses divergent frameworks for a shared `ui`). | Gated the cut on a grep verifying no divergent per-binding framework. |
| A9 | surface-redundancy-cuts | nit | Making `write global` a parse error trades a good explanatory message for a cryptic one. | Keep the `loom.policy-write-global-unsupported` validator error; treat as already-handled, not a cut. |
| A10 | with-implements-split | nit | Headline ergonomics assume `implements` in header position, but `ImplementsDecl` is a member — load-bearing, not soft. | Flagged as a required grammar-ambiguity resolution before implementing. |

Cleanest of the session set: `with-implements-split` and the `ids guid` /
criterion-block-form cuts.

---

## Part B — pre-existing corpus (OUTSTANDING — owner decisions)

These are on proposals authored outside this session. **Not edited** here
(in-flight design owned by others); surfaced for the owners. Where a finding
touches a session proposal, the reconciliation was recorded in the session
doc (see Part C).

### Blocker

- **B1 · i18n-strings** — `loom.user-visible-concat` bans `+`-concatenation
  in user-visible slots, but that breaks **shipped examples**
  (`sales-ui.ddd:35`, `:51`), the `${}` template-literal replacement **has
  no grammar support** (a real parser feature waved off as "sugar"), and it
  fires globally on backend-only apps. *Fix:* land `${}` grammar + codemod
  first; gate the diagnostic to translatable-frontend systems.

### Security / tenancy / auth

- **B2 · authorization** — the authz "current row" pronoun is spelled
  `resource`, colliding with the `resource` infra declaration keyword
  (`ddd.langium:266`; not in `NameRefIdent`). Overload + sprawl. *Fix:*
  `record` / `row` / `this`.
- **B3 · multi-tenancy + quickstart** — `crossTenant` is fail-*open*; its
  safety rests on `denyByDefault`, which quickstart §4.3 makes **opt-in**. A
  forgotten toggle leaves a `crossTenant AuditTrail` world-readable; no
  single lint catches the composition. *Fix:* require an explicit read
  policy on a `crossTenant` aggregate under `tenancy by`, independent of the
  global default.
- **B4 · sensitivity-and-compliance** — `mask: none` on a `sensitive(pii)`
  field ships plaintext on the wire while the source reads as protected.
  *Fix:* require an explicit authz justification, or rename `mask:
  plaintext` so the leak is legible.
- **B5 · channels Part II (unshipped)** — an author-set cache tier on an
  authz-scoped read is a cross-tenant poisoning vector. *Fix:* keep the tier
  derived; a shared/CDN tier on an authz-scoped read is a validation error.

### Silent no-ops / footguns

- **B6 · channels** — realtime UI subscription emits only for
  `platform === "node"` (`react/index.ts:257`); handler silently never fires
  on .NET/Phoenix. *Fix:* `loom.realtime-target-unsupported` error.
- **B7 · channels** — default `broadcast`/`ephemeral` delivery is
  at-most-once; a stateful reactor/projection silently drops events across
  restart. *Fix:* `loom.consumer-on-ephemeral-channel` warning.
- **B8 · channels + projection** — `channel`, `delivery`, `retention`,
  `carries`, `key`, `projection`, `keyed` are hard-reserved **with zero soft
  re-admission** — `Shipment { delivery: date }` fails to parse *today*.
  `projection.md:263` even cites a "soft-keyword precedent" that doesn't
  exist. *Fix:* add them to the five soft-keyword unions; correct the claim.
- **B9 · i18n** — extraction emits nothing on Vue/Svelte/Angular/Python/Java
  (untranslated literals, no diagnostic). *Fix:* scope explicitly with
  honest `loom.*` gaps, or spec the adapters first.
- **B10 · async-actions-and-effects** — `spawn` fire-and-forget: both
  canonical examples race (optimistic-rollback clobber; out-of-order
  autosave), no staleness/cancellation, and no LiveView lowering (silent
  no-op on the 5th frontend). *Fix:* keep deferred; require a named `async
  action`, a LiveView projection, and a staleness rule.
- **B11 · error-handling-and-failure-sink** — `errors {}` overloads the
  shipped RFC-7807 `errors[]` wire array; `errors api`/`errors ui` are magic
  barewords; the frontend boundary omits LiveView. *Fix:* rename
  (`errorPolicy`/`onFailure`), enumerate the tier slot, add a LiveView row.

### Nits

- **B12 · projection** — `ProjectionOnIR.allocates: boolean` is stamped but
  re-derivable from handler shape (derive-don't-stamp).
- **B13 · async-actions-and-effects** — `async` is stamped yet policed as
  derivable (`loom.missing-async`/`spurious-async`); defensible as
  function-colouring but argue it as an explicit exception.
- **B14 · named-actions-and-stores** — `action name=(ID | 'write')` one-off
  magic-name escape; use `LooseName`. Doc still describes the rejected
  `use <Store>` surface (stale).
- **B15 · accessibility** — derived heading `level` collides with authored
  `level:` (`sales-ui.ddd:35`); stale "no a11y infra" header (Phase 1 landed
  `PrimitiveDef.a11y`, unread by SPA emitters — stamped-but-unread).
- **B16 · quickstart** — `email {}` block keyword collides with the `email`
  field name; `job … on:` duplicates the event-triggered-workflow surface.
  *Fix:* `mailer`/`smtp`; fold event jobs into the existing reactor.
- **B17 · i18n-strings** — the flagship example emits invalid ICU
  (`::currency/${…}`) and uses primitives absent from the 53-primitive
  registry (teaches non-parsing code).

### Clean (verified no bad surface)

`uniqueness-and-indexes` (DB-authoritative, careful gating);
`sensitivity` propagation/subtyping (open-set tags the one nit — a typo'd
tag masks forever with no error; a tag registry would catch it);
`resource-model` value-position enums; `channel` vs `event`/`emit`
(complementary overlay, not redundant); `projection` vs `view` (distinct);
`store` vs `state` (clean lifetime split); `match await` (disciplined,
honest `loom.missing-effect-marker`).

---

## Part C — cross-proposal conflicts (must reconcile before either ships)

| Conflict | Between | Recommendation |
|---|---|---|
| Hierarchical path model | `authorization.md` first-class `DataKey` type + 6 magic ops **vs** `expressible-builtins` `string` + `startsWith` reduction | Pin the reduction (matches shipped `__loomDeepScope__` SQL); drop the `DataKey`-type surface. |
| `orgPath` ambient home | `authorization` decision-4 + `multi-tenancy` R5 stamp on `currentUser.orgPath` **vs** `organization-context` split | If the split lands, the write stamp reads `organizationContext.orgPath`. |
| `deep`/`global` read anchor | `expressible-builtins` **vs** `organization-context` | Anchor reads on the principal; a context switch is an explicit widening. |

(Session-side of each recorded in the respective session proposals.)

---

## Cross-cutting recommendation

The single largest surface-stability risk across the corpus is
**pre-settling common-word keywords for sugar that has not shipped** —
`spawn`/`async`/`errors`/`onError`/`attempt` (MVU), `email`/`job`/`cached`/
`live` (quickstart/channels), and the already-reserved-without-re-admission
`channel`/`delivery`/`retention`/`key`/`projection`. Each books
soft-keyword-sprawl or collision debt before the feature exists. **Rule:** do
not reserve a common-word keyword until its emitter lands; until then, route
the placeholder syntax through
[`../proposals/reserved-surface-signposting.md`](../old/proposals/reserved-surface-signposting.md)
as a `reserved-not-emitted` diagnostic rather than declaring it "settled."

## Method note

Part B's review was produced by an agent that dispatched its own
sub-agents and initially returned a placeholder; it was resumed to
synthesize. Findings that touch the session proposals (the Part C conflicts,
B2/B8 keyword claims) were re-verified against the grammar directly; the
remaining Part B items are as-reported and should be confirmed by the
proposal owners before action.
