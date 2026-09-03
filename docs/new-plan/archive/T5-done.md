# T5 — Language core & type system — completed missions

*Archived 2026-09-02 from [`../T5-language-core.md`](../T5-language-core.md). Every mission below is closed (`done` / `shipped` / `closed` / `concluded` / `withdrawn`); the bodies are moved verbatim (links re-based one level deeper) so the evidence trail stays readable. Nothing here is open work — the live track file lists what remains.*

## M-T5.6 — Strict decimal/money bounds bug — `done` (verified 2026-07-14) · **S** · P1 ⭐ correctness
Sources: [full-code-review-2026-07](../../audits/full-code-review-2026-07.md) #6.

## M-T5.11 — Extern domain extension — `done` (verified 2026-07-13) · —

## M-T5.15 — Scalar-return operation HTTP-contract convergence (BUG-003) — `done` (2026-07-27) · **S–M** · P2 ⭐ parity break
Sources: [showcase-coverage-bugs](../../audits/showcase-coverage-bugs.md) BUG-003.

## M-T5.17 — Surface normalization: aggregate-header modifiers + `httpStatus` — `done` · **S–M** · P3
Sources: language-surface review 2026-07-14, `src/language/ddd.langium` (`Aggregate`/`ApiStatus`), D-DOCUMENT-AXIS §4.

## M-T5.18 — Soft-keyword sprawl: dedup, gate, root-cause reduction — `done` (Tracks B + A + C landed) · **M** · P3
Sources: language-surface review 2026-07-14 #5, `src/language/ddd.langium` (the six identifier rules), M-T5.15 BUG-004.

## M-T5.20 — Route the whole denial ladder through `resolveErrorStatus` — `done` · **M** · P2 ⭐ drift-prone
**DONE (2026-08-18) — every rung of the ladder resolves on all five backends.** `DomainError` is in `STDLIB_ERROR_STATUS` at 422, and both rungs now resolve through `resolveErrorStatus` at the runtime arm *and* the declared OpenAPI response on node/.NET/java/python/elixir. Two shared seams had to move with them: the app-wide `structuralErrorStatuses` fold in `enrichments.ts` only iterated `STRUCTURAL_CONFLICT_ERRORS`, so an override could never reach a ladder rung; and `errorStatuses()` in `openapi-errors.ts` handed back the literals. Proven by `test/conformance/denial-ladder-override-parity.test.ts` — one `httpStatus DomainError -> 418` moves **all five**, asserted as a single cross-backend equality so a backend that silently ignores the clause fails even while its own per-leg suite is green.

**A deliberate deviation from this mission's text, reached independently by both halves of the work.** The brief said to take the RFC 7807 `title` from `errorTitle`. That is wrong here: `errorTitle("DomainError")` is `"Domain Error"`, which breaks RS-15's pinned `"Unprocessable Entity"` *and* the committed `wire-contract` golden. The title instead derives from the **resolved status's IANA reason phrase**, which is strictly stronger against the drift this mission exists to remove — a title and a status read off the same number cannot disagree, which is exactly the elixir `"Precondition Failed"`-against-422 bug class #2300 had to fix by hand.

**`NotFound` — the last rung — closed 2026-08-18.** It was parked because the aggregate-not-found 404 had **two producers, and which fired was backend-dependent**: hono's `getById` threw `AggregateNotFoundError` into `onError`, while .NET returned a bare `NotFound()`, java a `ResponseEntity.notFound()`, python a `None` check — and that bare-return pattern repeated across projection/workflow/find paths. Resolving only the declaration would then have published a status those paths never answered. **M-T6.31 removed the second producer** (every bare framework return became the shared not-found carrier — they were bypassing the app's problem filter and answering an empty-bodied 404 anyway), leaving ONE producer per backend, so `errorStatuses()` now resolves `NotFound` like its four siblings and each backend's handler arm plus its hand-rolled declared sets read the resolved value.

Landing it also drained an intra-function split the `Forbidden` rung had had: `deriveContextOperations` spelled the `httpStatus` resolver inline at two call sites and **omitted it at both `errorStatuses("getById")` calls**, so an override moved a find's declared 404 while `GET /<aggs>/{id}` and its `can_<op>` probe kept publishing 404. Same shape on java's `openapi-customizer.ts`, which passed no resolver at three hand-rolled sites.

Two 404s stay literal **on all five, elixir included**: the framework routing 404 (`no route for <verb> <path>`) and the objectStore blob-absence 404. Neither is the domain rung. Gated by `test/conformance/override-status-census.test.ts`, whose four ratcheting `NotFound` waivers were deleted in the same PR and whose sites now cover both the runtime arm and the declared set per backend.

Original brief follows.
**The ladder is half-routed today, and RS-15 is the proof.** `src/util/error-defaults.ts` already owns a status table plus the `httpStatus <Error> -> <Code>` per-api override path — and the table already names four of the five rungs (`NotFound` 404, `Forbidden` 403, `Disallowed` 409, `ValidationError` 422). But only the **structural-conflict** rung actually reads it: `resolveErrorStatus("Disallowed", …)` / `"UniquenessConflict"` / `"ConcurrencyConflict"` / `"ReferencedInUse"` resolve through the table on every backend, so a user can remap them and the runtime response + the OpenAPI declaration move together by construction. The other rungs — the **domain floor**, `Forbidden`, `NotFound` — are **hardcoded integer literals** at each backend's exception-handler arm (`problem(403, "Forbidden", …)`, `Problem(context, 404, …)`, `problem_response(conn, 422, …)`, …), and `DomainError` is not in the table at all.

Two costs, both now measured rather than hypothetical:
1. **Changing a rung is an N-place edit.** RS-15 moved the domain floor 400 → 422; that was five hardcoded runtime literals across five backends, plus four docs, plus a fixture rebaseline — and the only thing keeping the five in agreement afterwards is a test that asserts the same literal five times. The `Disallowed` rung would have been a one-line table edit.
2. **A user cannot remap it.** `httpStatus DomainError -> 400` (say, for a client that can't handle 422) is inexpressible, even though the identical clause works for `Disallowed`. That asymmetry is invisible from the DSL — nothing tells an author which rungs are overridable.

**The work:** add `DomainError` to `STDLIB_ERROR_STATUS` (422, post-RS-15), then convert each backend's exception-handler arm from a literal to `resolveErrorStatus(<name>, ctx.structuralErrorStatuses)` — the same call shape the conflict rung already uses, so the pattern is copy-paste per backend rather than invention. The RFC 7807 `title` should come from the existing `errorTitle` derivation at the same time (it is hardcoded next to each literal, so it drifts identically — elixir shipped a `"Precondition Failed"` title against a 422 status until #2300 fixed it). Also confirm the **OpenAPI declaration** side reads the resolved value: today the declared `responses` map is built separately from the runtime arm, which is exactly the runtime/declaration drift the override mechanism exists to prevent.

**Verification:** `test/generator/domain-denial-detail-parity.test.ts` already pins the resolved default on all five, so a regression is caught; add one case per backend asserting an `httpStatus DomainError -> 400` override moves BOTH the runtime arm and the declared response. `conformance-parity` guards the cross-backend spec.

Sources: found 2026-07-29 while landing RS-15 (#2300) — the five-place edit *was* the evidence. `src/util/error-defaults.ts`, `docs/old/proposals/exception-less.md` (A1, the table's origin), `docs/conformance-semantics.md` RS-15. Relates to M-T5.17 (which added the `httpStatus` surface this mission finishes wiring).

**Regression + restoration (#2462 → #2340, recorded 2026-08-10):** main's route-derivation unification (#2462) re-derived the DECLARED response set but never re-threaded the `DomainError`/`Forbidden` `httpStatus` override into the four backends' runtime handlers — **silently reverting this mission's own feature** on four backends and elixir's per-op controller; #2340's rebase restored it. `denial-ladder-override-parity.test.ts` did not catch the revert — a default-emission census cannot distinguish "resolved to the default" from "hardcoded", which is exactly M-T9.25 round-2 item 1 (re-run the census UNDER AN OVERRIDE). Those bare returns were M-T6.30/M-T6.31's read-path envelope split, and draining them is what made the `NotFound` rung convertible (see above) — the mission is `done` as of 2026-08-18.
