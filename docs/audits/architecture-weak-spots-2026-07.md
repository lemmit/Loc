# Architecture weak-spot review — where to put maintainer effort

*Snapshot: 2026-07-13, `main` @ b066245. Method: six parallel code-grounded audits (cross-target parity, schema evolution, language core/DX, UI layer, production-readiness of generated apps, maintenance economics), each verified against source rather than docs. This is a ranked risk register, not a feature inventory — the completeness inventory lives in `completeness-audit-2026-07.md`.*

## Framing

Loom's pitch has four legs: (1) architecturally correct business apps from concise `.ddd`, (2) no-code feel with scaffolded UI, (3) customization escape hatches, (4) backend/frontend targets picked in config. The review question: which leg buckles first, and where should effort go?

**Verdict in one line:** the compiler core and the target-parity machinery are the *strong* parts; the existential risks are (a) the **customization cliff** at the UI ceiling, (b) the **schema/data evolution** story past month one, and (c) the **security/production defaults** of generated apps — all three sit on the *product* side of the line, while most current effort (judging by the last ~40 PRs) goes into widening the target matrix, which *multiplies* every one of these gaps.

---

## Ranked weak spots

### 1. The customization cliff (UI ceiling) — highest product risk

The scaffold→primitives path produces a polished v1 admin console, then drops the user off a cliff the day they need anything the closed set (33+2 primitives, `src/generator/_walker/registry.ts`) can't say:

- **Tables are display-only** — no sort, no interactive filter, no pagination (`src/generator/_walker/primitives/table.ts`); the wire `paged` carrier exists but no frontend consumes it. A real admin UI dies at a few hundred rows.
- **No file upload, no charts** (`Stat` is a number tile), no repeatable dynamic sub-forms, no optimistic updates, in-memory-only `state`, SSE-toast-only realtime, **no i18n at all** (`docs/proposals/i18n.md` unadopted), and `A11yContract` is declared but almost nothing emits ARIA (64 `aria-` attrs across all 17 packs, zero in the primitive emitters).
- **The escape hatch is asymmetric and total:** `component extern` exists on React/Vue/Svelte only — **no Angular, no HEEx hatch**. And it's all-or-nothing: no way to partially edit a generated page and keep regenerating it; `unfold` ejects domain macros, explicitly not UI (`unfold-macro.ts:190-191`).

Why this ranks #1: every user of the "no-code feel" hits this ceiling on their first real app, and the exit is hand-written framework code — the exact thing the product exists to avoid.

**Effort:** (i) paged/sorted/filtered `Table` — cheapest highest-ROI item in the repo, the carrier is already on the wire; (ii) a `FileUpload` field primitive; (iii) `component extern` for Angular + HEEx; (iv) a region-level customization story (named override slots or UI-level unfold) so customization stops being one-way ejection.

### 2. Schema & data evolution — highest "business runs on this for months" risk

The structural diff engine is genuinely good (prev→next diff, FK-ordered, destructive-gate, monotonic versions — `src/system/migrations-builder.ts`). What's missing is exactly what a live database needs:

- **No data migrations** — the only concession is a `-- TODO backfill` comment. Any rename that isn't the exact one-drop-one-add-same-type heuristic (`migrations-builder.ts:787-805`) silently degrades to drop+add = **data loss behind a flag**. There's no rename *intent* in the DSL, so the compiler can't know better.
- **No down migrations**, no brownfield adoption (can't point Loom at an existing schema), and saving-shape or inheritance-strategy changes reshape the table with no data-move story.
- **The correctness model silently depends on git hygiene:** if `.loom/snapshots/<module>.snapshot.json` is absent (fresh checkout, gitignored), the builder re-emits a full `Initial` and resets the version chain against a live DB — indistinguishable from first run, unguarded (`snapshot.ts` guards only the *corrupt* case). Nothing verifies on-disk migration files against `migrationHistory` either.

**Effort:** (i) an explicit `renamed from` annotation in the DSL — small grammar change, eliminates the worst silent-data-loss class; (ii) a baseline-sanity guard (refuse to emit `Initial` when `migrationHistory` says deltas exist / files present but snapshot missing); (iii) verify delta files against `migrationHistory` at generate time; (iv) a minimal data-migration surface (even just "emit a stub the user fills, tracked in history"). Brownfield adoption can wait; the first three cannot.

### 3. Security & production defaults of generated apps

The tactical-DDD core is production-grade (typed IDs, invariants, tenancy enforced by construction, outbox, RFC7807). The *defaults* are demo-grade:

- **Authz is default-open** (`enforcement: opt`), repository `find`s have **no `requires` surface at all** (`docs/auth.md:38-41`), and the accept-all `x-loom-dev-claims` stub is what ships until a verifier is registered.
- **OIDC session is shallow:** raw access token in a cookie, no refresh rotation, no PKCE, no password reset / local accounts.
- **`versioned` (optimistic concurrency) is opt-in**, so the advertised "aggregate = consistency boundary" is last-writer-wins by default; no HTTP idempotency keys, so a retried `POST` duplicates.
- **Observability is logs-only** (good catalog, zero metrics/traces); update-path DTOs carry no wire validation (SYS-1, open since 2026-06-30).

**Effort:** flip the defaults — `denyByDefault`, `versioned`-on, PKCE+refresh — and add find-gating. These are finite slices with existing seams, and "secure by default" is table stakes for the claim "architecturally perfect business apps."

### 4. The temporal hole — no timers, jobs, or deadlines

Nothing in the language or any backend schedules work: no cron, no delayed commands, no saga timeouts/escalation, no email/notification adapter. "Cancel unpaid orders after 48h" — the shape of half of all business processes — has no in-language answer. This is the largest genuinely *hard* backend gap (durable timer runtime × 5 backends), which is exactly why it should be designed now, before backend #6 makes it × 6.

### 5. Maintenance economics — where the model buckles as targets multiply

Numbers: ~221k LOC src, 165k test, **10 target generators + 13 pack families / 1,170 `.hbs`**, 42 CI workflows, one human author, and the matrix is still growing (Feliz landing this week).

- **The persistence-emit axis has no seam.** `ExprTarget`/`WalkerTarget`/`_stmt/leaves` genuinely collapsed their axes — but entity/schema/repository/routes emission is hand-written per backend (elixir 70 files / dotnet 61 / java 51 / python 37). Every storage feature re-lands N times by hand (part-in-part: 36 files across 4 backends), gated per-PR only by *compile*.
- **Runtime feedback is nightly.** Per-PR gates are compile-only; compose-boot/conformance-full/k8s-e2e are label/schedule gated. The repo institutionalizes the failure mode with skills (`generated-stack-verifier`, `dependency-upgrade`) that exist *because* authors ship green PRs that fail the nightly boot.
- **Version strategy forks, never rolls forward** (`backend-hono-v4`+`v5`, `stacks/{v1,v3,sv1,vue1,ng1}`) — maintained surface grows monotonically.
- **Langium pinned at 3.3** while 4.2 is out; the pin is load-bearing for 8 open `npm audit` findings (3 high) that cannot clear without the migration.
- **Doc rot is a first-class failure mode** — 118 proposals / 71 plans, multiple self-declared-stale audits, and stale claims in *code comments* too (registry.ts still claims HEEx primitive gaps that `heex-parity.test.ts` proves closed; several docs still reference the removed `ashPhoenix` pack).

**Effort:** (i) **pause target growth** until a persistence-emit seam exists (the `MigrationsIR`/`sql-pg.ts` sharing shows the shape — a `PersistenceTarget` analogous to `ExprTarget`); (ii) promote one cheap boot gate to per-PR for every backend (the PGlite `behavioral-e2e` pattern generalized); (iii) land Langium 4; (iv) migrate-don't-fork the next stack version.

### 6. Parity residuals — small list, wrong failure modes

The core matrix (CRUD/relational/ES/inheritance/audit/tenancy) is genuinely all-5 converged, and `backend-parity-gates.test.ts` is the strongest anti-rot seam in the repo. The residue (~10 items) is fine *except* the failure modes:

- **Silent:** Phoenix host + SPA frontend generates a **UI-less project with no error** — the largest silent hole; Phoenix wire-shape runtime tail (snake_case leaks in workflow/audit serializers) invisible because Elixir never boots per-PR.
- **Crash:** 3 ungated `throw new Error` sites in the Java generator (view `follows`, non-id saga/projection fields) — valid `.ddd` passes validation, then stack-traces codegen. They survive because they're outside the enumerated capability×backend set the parity gate checks.

**Effort:** add `loom.*` validator gates for the 3 Java crashes and the Phoenix SPA-embed combination (an afternoon each — converting silent/crash into honest), and get Elixir into the per-PR parity boot.

### 7. Compiler-internal fragility (lower priority — well-contained but worth knowing)

- `lower-expr.ts` (2,292 LOC) and `type-system.ts` (1,729) must stay in lock-step; adding a bindable type requires touching two parallel walkers (`stepInto` + `typeAfterSuffix`) where only one is exhaustiveness-checked (`experience_gathered.md` §unknown).
- The `unknown`-cascade suppression silently disables all operand checks downstream of any placeholder type — a validation hole shaped like "missing validation."
- Interactive debugging is essentially absent: the DAP server is a 221-LOC remap shim (no stepping, no variables, no editor `debuggers` contribution), and known parameter-property emitter gaps still break type-stripped full-server boot. Counterweight: diagnostics (123 stable codes + machine-applyable `fix-hints.ts`) and the LSP (rename, unfold, semantic tokens) are best-in-class — the *agentic* DX story is stronger than the human-debugger one, which matches the roadmap.

---

## What's pulling its weight (don't touch, do imitate)

- The one-directional pipeline with **test-enforced layering**, `wireShape` as the single wire truth, `ExprTarget`/`WalkerTarget` single-dispatch seams, the completeness-pin family, and `backend-parity-gates.test.ts` ("gated xor emitted") — these are the reasons 10 targets are survivable at all. The recommendation in §5 is precisely to *extend this pattern* to the last un-abstracted axis (persistence emit).
- The backend `extern` story (scaffold-once, fail-loud, all 5 backends) is the healthiest customization surface in the product — the UI hatch should be brought up to its standard, not the other way round.

## Priority order, condensed

| # | Investment | Why first |
|---|---|---|
| 1 | Paged/sorted/filtered Table + FileUpload; extern for Angular/HEEx; region-level UI customization | Every user hits it; cheapest ROI (wire already supports paged) |
| 2 | `renamed from` intent + baseline-sanity guards + data-migration stub surface | Silent data loss is the one unforgivable bug class |
| 3 | Secure defaults: denyByDefault, find-gating, PKCE/refresh, `versioned`-on, idempotency keys | "Business apps" claim requires it; all finite slices |
| 4 | Persistence-emit seam + per-PR boot gate; **freeze target growth meanwhile** | Every new target multiplies gaps 1–3 |
| 5 | Timer/scheduled-work primitive (design now, ship incrementally) | Hardest gap; cost grows with each new backend |
| 6 | Gate the 3 Java crashes + Phoenix SPA embed; Langium 4 | Small, converts silent→honest; unblocks security audit debt |
