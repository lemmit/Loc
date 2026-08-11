# Bug discovery & quality plan — 2026-08-11

*Scope: the 145 merges on `main` 2026-08-02 → 2026-08-11 (the window since the [quality audit](../audits/quality-audit-2026-08.md) classified 988 commits and issued R1–R12), the open-PR set, and a re-classification of every fix-shaped merge in that window (≥36 match fix patterns mechanically; ~50 on manual read — a third of the window). This is the follow-up iteration the audit's §6 implies: score which recommendations landed and what they yielded, classify what **still** escapes, and mint the missions the audit left mission-less. Analysis + proposal — statuses live in [T9](T9-toolchain-health.md); every proposed mission is verify-first.*

---

## 1. Why "agents keep finding bugs" — the audit's model, re-confirmed

The 08-02 audit's answer stands and the nine days since are its controlled experiment: **the bugs are latent per-cell defects on a 5-backend × 6-frontend × adapters × packs surface, not regressions.** The fast suite pins emitted strings; the bugs live below that tier (does it compile? does the DDL load? does it boot? does it answer correctly? does it deny correctly?). Discovery is deliberate-audit-driven, and every audit converts its discovery class into a gate — so a high fix rate is the drain working, not quality falling. The proof from this window: nearly every fix PR names the *newly built gate* that found it, and the two census PRs alone (#2448, #2468) surfaced **nineteen real bugs** by giving emitted-but-never-called routes their first runtime caller.

The strategic point: **stop treating discovery as episodic.** Each mechanism below that was run once found bugs; the plan's job is to make the remaining unbuilt mechanisms exist and the built ones exhaustive.

## 2. R1–R12 scoreboard (what landed since 08-02, and what it paid)

| Rec | Status | Yield / evidence |
|---|---|---|
| R1 merge queue | **still blocked(admin)** | GitHub offers queues only on org repos; triggers stay inert (M-T9.7). Unchanged. |
| R2 required per-PR tier | **landed** — `pr-gate` | #2447 → v2 #2463 → dropped-event hardening #2465/#2483 (+ cron-cancel fix #2501). Every gate that *triggers* on a PR is now binding. |
| R3 instrument honesty | **landed, expanding** | Fixture parse census #2354 found **14 fixtures that never parsed** under green tests; two red-main syntax fixtures (#2372, #2382) confirmed the class; repo-wide `.ddd` source census in flight (#2498). |
| R4 gate-mutation policy | **landed** (#2380) | Now a CLAUDE.md convention ("mutation-prove a new gate"). Applies to *new* gates only — the stock of old tests is §5-D below. |
| R5 route-coverage census | **landed — highest payer** | #2448: 210 → 13 uncalled routes, **9 bugs**; #2468: runtime callers for the e2e-less corpus fixtures, **10 bugs**. |
| R6 behavioral matrix | mostly landed | M-T9.12 done; M-T9.13/9.14 partial; M-T9.15 (per-PR non-React cell) still open. |
| R7 sentinel `ExprIR` | **done** (M-T9.9, #2140) | |
| R8 derivation unification | **landed** | Route-builder unification PRs 0–5 (#2453, #2458–#2462) — all five backends render the route surface from `deriveContextOperations`. M-T9.26 (`RouteTarget`) continues it. |
| R9 grammar fuzz + swallowed errors | half landed | Recovery-honesty half subsumed by R3; generative half is M-T9.22, still open. |
| R10 flake budget | **nothing** | Minted below → M-T9.30. |
| R11 quality-delta dashboard | **nothing** | Minted below → M-T9.31. |
| R12 duplicate-claim hygiene | **nothing** | Folded into M-T9.31 (same weekly cron). |

## 3. What still escapes — classification of the 08-02 → 08-11 fixes

The compile-skip maps are empty, the wire golden rides every behavioral leg, the route census is drained to 13 pins — and ~50 bugs still merged as fixes in nine days. They cluster into six classes, four of which have **no owning discovery mechanism yet**:

### A. Negative-path HTTP semantics — the biggest unworked seam (≥7 fixes in 9 days)
Wrong verb → framework 404 bypassing the contract (#2485, "nothing BOOTED proved the framework-error contract"); Elixir accepting a PUT that omits a required field (#2440); malformed tenant claim → 500 instead of empty (#2442); framework-raised errors bypassing RFC 7807 on all five (#2472); the 401 violating an RFC 9110 MUST on all five (open #2500); malformed OIDC token → 500 (#2261). **Common shape:** every runtime gate drives the happy path plus hand-written negatives; the adversarial-request space (wrong verb/content-type, missing/extra/malformed fields, boundary values, bad auth material) is exercised only where a human thought to write a case. This is exactly **M-T9.21 (Schemathesis, open since 07-28 at P2)** — the window is the argument for promoting it to **P1** and building it now.

### B. Authorization surfaces the census never enumerated (severity-max class)
A `requires` in a `create` was lowered and then **ignored — the route was open** (#2446); the `join` mask bypass + default-deny blind to explicit handlers (#2443); the lifecycle-guard contract needed a re-landing with a CHECK (#2487, #2450, #2502). The negative-authz gate (M-T3.13/#2259) proved *finds* deny — nothing enumerates **all** gated surfaces, so each newly gated surface kind ships unverified. → **M-T9.28** below.

### C. Feature-pair and odd-shape compile breaks — the "uncompilable target code" class
`mask unless` + `audited` did not compile — .NET CS0128 + Python F821 (#2412); audited × dapper × document/ES (#2387, #2391); the `versioned` door G2 missed (#2321); `deny` shipped with nothing building it — python import bug (#2451); dapper corpus gate → two silent gaps (#2394); `policy { deny }` crashes codegen under dapper (open #2492); parameterless `find` on Flutter emitted `({})`, which isn't Dart (#2491); a Flutter deployable named `web` generates an unbuildable app (#2490). **Common shape:** the corpus is one-fixture-per-feature; these bugs live at feature×feature and feature×adapter **intersections**, and at degenerate shapes (zero params, colliding names) no curated fixture hits. → **M-T9.29** (pairwise corpus) below, complemented by **M-T9.22** (generative fuzzing) for the degenerate-shape tail.

### D. Vacuous or unbooted gates — the meta-class keeps recurring
The render-degradation gate's phoenixLiveView leg tested a system the validator rejects (#2489); a construction test asserted a value the emitter itself passed in (#2455); the framework-error contract had never been booted (#2485); late-July siblings #2384/#2393/#2410/#2423. R4 covers **new** gates; the existing ~11,700-test stock was never mutation-audited. → mutation-audit lane in **M-T9.31**.

### E. i18n / chrome extraction gaps — high volume, already self-healing
`keyValue` shipped English on 13 of 15 targets *and the gate that couldn't see it* (#2476); interpolated attribute slots (#2474); design-pack chrome (#2478); pager chrome (#2430). No new mission: the "extracted ⇒ rendered" completeness gate (#2395) is the model, and M-T1.11 is draining itself with it. **Exported lesson:** any "every X must reach Y" claim deserves one completeness gate, not per-case tests.

### F. Intra-backend self-disagreement
Already owned by **M-T9.25** (partial, P1) with an ordered round-2 list; every probe run so far yielded a rule. Its 401/403 sweep and M-T9.11's 4xx goldens are both blocked on the same single-identity harness gap — which M-T9.28 fixes, so B unblocks F.

## 4. The plan — ordered by expected yield per unit of effort

1. **M-T9.21 — spec-driven API fuzzing (promote P2 → P1, build now).** Nightly matrix: boot each backend (reuse the obs/tenancy boot recipes), feed its own emitted `openapi.json` to Schemathesis; assert no 500s, schema-conformant responses, honored `required`/`enum`/bounds. Every finding graduates to an RS-rule + wire golden + (if cross-backend) a conformance census. Class A above is its predicted yield, and six of its instances merged *this week*.
2. **M-T9.28 — IR-derived authz surface census + multi-principal harness (new, P1).** See mission entry in T9. One harness fix (an authenticated-but-unauthorized principal) unblocks three gates at once.
3. **M-T9.29 — pairwise feature-combination corpus (new, P1).** Generated, not hand-written; compile + schema-load tiers only (the cheap oracles), so CI cost stays bounded. Kills class C where it lives.
4. **M-T9.25 round 2** (queued, unchanged) — then the 4xx wire-goldens once M-T9.28's harness lands.
5. **M-T9.22 — generative `.ddd` fuzzing (open, P2)** — the degenerate-shape tail of class C (odd names, zero-arity, deep nesting) that a pairwise matrix still misses; every failure ships a seed that graduates into the corpus.
6. **M-T9.30 — flake budget with teeth (new, P2).** Races hide as flakes (#2350 java /ready, the python commit race); today a flaky leg just gets re-run.
7. **M-T9.31 — weekly quality-delta cron + stock mutation audit (new, P3).** Makes the audit's success metric a tracked number and mutation-tests the *existing* suite where bugs fan out widest (`src/generator/_*`, `src/ir/enrich/`).
8. **R1 (merge queue)** — unchanged, blocked on org ownership; revisit on any account move. `pr-gate` remains the substitute.

**Sequencing note:** items 1–3 are independent of each other and of the in-flight lifecycle-guard work (#2487/#2502); they can run as three parallel missions. Item 4's second half depends on item 2.

## 5. Exit criteria — how we know the drain is ahead of the inflow

- **Class C dead where covered:** a month with zero "generated code fails to compile" fixes on intersections the pairwise corpus covers.
- **Class A/B dead:** every IR-enumerable gated surface has a runtime deny probe; Schemathesis finds nothing new for two consecutive weekly runs on all five backends.
- **The audit's ratio flips:** share of bugs discovered by per-PR/nightly gates overtakes bugs discovered by episodic audits (08-02 baseline: ~16% vs ~58%) — tracked by M-T9.31, not reconstructed by hand.
- **Registers only shrink:** M-T9.27's open-gap pin (42) and the wire-waiver count (2) move only down; the flake budget has no leg below threshold.

*Sources: commit-log classification 2026-08-02 → 2026-08-11 (`git log`, 145 merges); [quality-audit-2026-08.md](../audits/quality-audit-2026-08.md); [testing-quality-improvement-plan.md](testing-quality-improvement-plan.md) (the 07-28 predecessor, now largely drained); T9 mission bodies. Related: M-T9.8 (hollow-work), M-T9.11 (wire golden), M-T9.25 (consistency census), M-T9.27 (unsupported register).*
