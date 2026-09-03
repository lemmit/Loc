# Language-docs audit 2026-09-03 — the code-side findings register

*Scope: the defects surfaced while re-verifying every claim in the language surface docs
(`docs/language.md`, `docs/page-metamodel.md`, `docs/language-reference/**`) against the code
on `main` @ `651388d`. The audit itself was docs-only, so **nothing here is fixed** — this is
the hand-off list. Snapshot-in-time; re-verify on fresh `main` before picking one up.*

Twelve auditors each walked one doc packet, tracing every claim to the file that proves it.
When a doc and the code disagreed, the doc was corrected — **unless the code was the thing
that was wrong**, in which case the behaviour was documented honestly and the defect landed
here. That boundary is why this register exists: 47 findings, none of them speculative, each
with a file:line anchor and a reproduction.

**What makes this list unusual:** the docs were the instrument. Reading a chapter forces you
to exercise the *surface* — every keyword, every argument spelling, every backend tab — rather
than the paths the test suite already covers. Most of these are shapes that parse clean,
validate clean, and then break at emission; the compile-tier gates never see them because no
fixture writes them.

## The shape of the list

| Class | Count | What it means |
|---|---|---|
| **P0 — silent miscompile or crash** | 9 | Valid `.ddd`, zero diagnostics, then a crash or output that cannot compile. |
| **P1 — silent drop** | 8 | Valid `.ddd`, zero diagnostics, and a declared thing is missing from the output. |
| **P2 — cross-backend divergence** | 7 | The same source means different things on different targets, undeclared. |
| **P3 — diagnostic-catalog hygiene** | 11 | Codes raised but uncatalogued, messages that contradict the gate, dead gates. |
| **P4 — per-feature doc drift** | 12 | Docs outside this audit's scope that contradict the code. |

The dividing line that matters is P0/P1 versus P2. A P2 is a *decision the docs can carry*:
Phoenix maps a value object to a `:map` column, and the reference can say so. A P0/P1 is not
documentable — it is the "silent gap" shape `parity-auditor` exists to convert into an honest
`loom.*` gate or a fix.

---

## P0 — validates clean, then crashes or emits code that cannot compile

**F1. `match` over a union in a domain body crashes codegen on all five backends.**
`src/generator/_stmt/target.ts:160` throws `variant-match statement is frontend-only; it must
not reach the <X> backend`. No IR check covers `variant-match` outside a page —
`src/ir/validate/checks/store-checks.ts` only handles the page case. `ddd parse` reports
`0 error(s)`; `ddd generate system` throws on node, dotnet, java, python and elixir alike.
Non-exhaustive arms are likewise unchecked. *Either the statement lowers on the backends or a
`loom.*` gate rejects it; an internal throw is neither.*

**F2. A guarded optional receiver loses its lowering on four of five backends.**
`src/language/validators/types.ts:281` explicitly sanctions `x != null ? x.trim() : …` as *the
fix* for `loom.intrinsic-nullable-receiver` — and then the guarded call is emitted verbatim
instead of through the host idiom. From `note2: string?`, `derived safeNote = note2 != null ?
note2.toUpper() : "none"` emits `this._note2.toUpper()` (node), `this.note2.toUpper()` (java),
`self._note2.to_upper()` (python), `record.note2.to_upper()` (elixir) — none compile. .NET
emits `ToUpper()`, which compiles but is culture-sensitive where an unguarded receiver gets
`ToUpperInvariant()`. The optional receiver is not unwrapped in the intrinsic arms of
`src/ir/lower/lower-expr.ts` the way `checkIntrinsicCalls` unwraps it. *The validator
recommends a form that does not work.*

**F3. `toast(...)` emits an undefined symbol on React.** An action body or `Action { …, then:
toast("x") }` renders `toast("Draft saved");` into the page or component TSX with no import and
no definition anywhere in the generated project. Svelte emits `src/lib/toast.svelte.ts`;
elixir maps to `put_flash`; React has no handling in `src/generator/react/**`. The generated
app does not type-check.

**F4. `for` / `if let` in an aggregate body is ungated and emits garbage.**
`src/ir/lower/lower-stmt.ts` has no arm for `ForStmt`/`IfLetStmt` outside a workflow and no
validator rejects them: `operation touch() { for n in notes { owner := n } }` reports
`0 error(s), 0 warning(s)` and emits `this.<unknown>();`.

**F5. `seed <AbstractBase> { … }` outside a dataset block crashes the lowerer.**
`seed Party { name: "x" }` dies with `TypeError: Cannot read properties of undefined (reading
'fields')` in `lowerSeed` (`src/ir/lower/lower.ts`) before `loom.seed-abstract-aggregate` can
fire. The same model written as `seed default { Party { … } }` reports the diagnostic
correctly.

**F6. `generate system` crashes on a valid ui-e2e body.**
`expect(<create-result>.<field>).toHaveText("…")` inside `test e2e … against <frontend>`
validates clean, then throws `expect requires a matcher` from `renderExpectStmt`
(`src/system/expect-stmt.ts:21`, via `src/system/ui-e2e-render.ts:217`). Binding the read with
`getById` first works.

**F7. The python typed api-client emits an invalid annotation for a `File?` field.**
`src/generator/python/api-client.ts:88` appends `| None` to an already-optional rendered type
and never imports `FileRef`: the generated `app/resources/api_clients.py` contains
`spec: FileRef | None | None` inside a `pydantic.BaseModel` — an undefined name at import time.

**F8. A block-form Elixir function whose parameter is used only inside a `let` does not
compile.** `bodyUsesParam` (`src/generator/elixir/vanilla/function-emit.ts:162`) underscores
the head parameter (`def fee(%Order{} = record, _q)`) while the body reads `q`.

**F9. A `derived` that reads a store field emits an unbound identifier on React and Flutter.**
`store Cart persist: local { state { count: int = 0 } }` + `derived count: int = Cart.count`
emits `const count = useMemo(() => count, []);` (`src/generator/react/walker/page-shell.ts:248`
and the component twin at `:979`) — the store receiver is dropped and no subscription is
hoisted. Renaming the derived proves it is a drop, not shadowing: `derived itemCount = Cart.count`
emits `const itemCount = useMemo(() => count, []);` with `count` undeclared. Flutter interpolates
the same bare identifier. `loom.unresolved-page-ref` covers refs in rendered slots only, not
`derived` initialisers.

---

## P1 — a declared thing silently vanishes from the output

**F10. A page whose `body:` is a bare `match` is dropped entirely on React and Svelte.**
No file, no route, no diagnostic. `isWalkableLayoutBody`
(`src/generator/_walker/walker-core.ts:367`) admits only `call` and `ternary`, though the walker
has full `match` arms. **Vue emits the same page correctly** — so one `.ddd` renders differently
per frontend. Wrapping in `Stack { match { … } }` emits it. Found independently by three
auditors; `page-metamodel.md` §7/§12 documented `body: match` as the wizard pattern.

**F11. `DestroyForm { of: <record> }` degrades to a comment on every target with no
diagnostic.** `of:` is resolved through `ctx.aggregatesByName`
(`src/generator/_walker/primitives/forms.ts:137`), so a `QueryView` binding renders
`DestroyForm(of: p): aggregate not found`. The delete button silently disappears.

**F12. A method call in a `KeyValueRow` value slot silently degrades.**
`KeyValueRow { "Note", note.toUpper() }` emits `{/* unsupported expr: method-call */}` — the
value vanishes — while `Text { note.toUpper() }` emits `note.toUpperCase()`. `emitKeyValueRow`
(`src/generator/_walker/primitives/text.ts:299-338`) routes the value through element-position
`walk`, which has no method-call arm.

**F13. `handle` and named `create` are lowered but no backend emits an entry point.**
`src/ir/lower/lower-workflow.ts:124-174` fills `WorkflowIR.handlers`/`.creates`,
`test/ir/workflow-handle.test.ts` pins the lowering, and `loom.duplicate-handler`
(`messages.ts:310`) promises a `route -> Ctx.<handle>` is meaningful — but no emitter reads
`wf.handlers` for an entry point. A workflow with `handle retry(...)` plus
`api { route POST "/fulfil/retry" -> C.retry }` produces no route on node or dotnet, and no
routes file at all.

**F14. Elixir drops a part-level `check`.** `entity Line { qty: int check qty > 0 }` produces a
`changeset/2` that only `cast`s `[:sku, :qty]` — no `validate_number`. Root-level
`check`/`invariant` do emit one; node/dotnet/java/python all enforce the part-level form.

**F15. Elixir drops a guarded single-field invariant from the changeset entirely.**
`residualInvariants` (`src/generator/elixir/vanilla/changeset-invariant-emit.ts`) and the native
path in `changeset-emit.ts` both exclude it, so nothing enforces it. Silent under-enforcement.

**F16. Elixir drops a `derived` that reads another `derived` from the wire.**
`derivedRenderable` (`src/generator/elixir/vanilla/wire-serialize.ts`) omits it from
`serialize/1` while the other four backends ship it — a wire-shape divergence with no gate.

**F17. Flutter silently drops `extern` components.** Renders
`const SizedBox.shrink() /* unknown layout component: X */` with no validator, where the other
frontends have an extern hatch.

---

## P2 — undeclared cross-backend divergence

**F18. Java ignores `ignoring` for principal filters.** `jpqlWhere`
(`src/generator/java/emit/repository.ts:361-392`) ANDs `principalClause` unconditionally with no
`bypassAll`/`bypassCaps` check (`bypassAll` appears only at `:637`, the impl-side Hibernate
wrapper). Both `find allRows(): Order[] ignoring *` and `ignoring tenantScoped` still emit
`where (e.tenantId = :#{@currentUserAccessor.user()?.tenantId()})`. node/python/elixir drop the
conjunct; dotnet emits `IgnoreQueryFilters`. Contradicts the comment at
`src/generator/java/capability-filter.ts:26-29`, which claims parity with node. The
fail-direction is safe — Java over-restricts rather than leaking — but the same `.ddd` returns
a different row set on Java than on the other four backends, and an operator reading the docs
would conclude the bypass took effect.

**F19. Java renders a guarded invariant on the wire without its guard.** `buildChecks`
(`src/generator/java/emit/validator.ts:366-395`) calls `renderJavaExpr(inv.expr, …)` with no
`!(guard) ||` implication, which node/.NET/python all emit. `invariant note.length > 0 when
taxRate > 0` becomes an unconditional check, so Java 422-rejects a request that is legal when
`taxRate == 0`.

**F20. Elixir maps a value object to a `:map` column while every other backend splits it.**
`total: Money` produces `total_amount` + `total_currency` on node/dotnet/java/python and
`add :total, :map` on Ecto — contradicting the "one DDL for everyone" invariant.

**F21. `envelope` is five-way inconsistent.** The repository layer has `Envelope<T>` on dotnet
and java, node/dotnet/java/python routes return the bare response, and elixir's controller
returns a JSON array.

**F22. HEEx `Image` and `Icon` read only a named `src:` / a `svg:` literal.**
`renderImage` (`src/generator/elixir/heex-primitives.ts:1510`) and `renderIcon` (`:2151`)
ignore the positional spelling every other target renders: `Image { "/logo.png", alt: … }`
emits `<img alt>` with no `src`, and `Icon { name: "check" }` an empty span.

**F23. The HEEx `WorkflowForm` emits a placeholder instead of the workflow's params.**
A single `<.input field={@form[:_placeholder]}>` (`heex-primitives.ts:388`) where React emits
the real field set.

**F24. Elixir drops a private-operation call with only a comment.** `confirm` renders
`_ = nil  # vanilla: bare call to 'recompute' (no callable target); record unchanged` — compile-clean,
behaviourally absent, and the only signal is a comment in generated code.

---

## P3 — diagnostic catalog hygiene

The catalog gate (`test/system/diagnostic-catalog.test.ts`) fails on an inline literal, a
mis-keyed message and an orphan entry — but it evidently does not reach the IR check leaves,
which is how F25 and F26 survive.

| # | Finding | Anchor |
|---|---|---|
| **F25** | `loom.function-block-impure` is raised live with an inline message and has **no catalog entry**. | `src/ir/validate/checks/structural-checks.ts:1243`; referenced from `validators/structural.ts:327`, `types.ts:809` |
| **F26** | The `when`-gate-references-op-param check raises an inline message with **no `code` at all**. | `src/language/validators/statements.ts:110-118` |
| **F27** | `loom.scaffold-filter-param-unsupported`'s text contradicts its own gate: it says the bar renders `string`, `int`, `long`, `<X> id` and that `bool`/`datetime`/`guid` "have no input at all". Since #2699 all three render. The gate reads the correct set; only the message lies — and its stale twin sits in a comment. | `messages.ts:2308-2315`; `ui-checks.ts:1097-1099` |
| **F28** | `loom.flutter-primitive-unsupported`'s text names FileUpload as "the one deferred primitive", but `FLUTTER_UNRENDERED_PRIMITIVES` is now **empty**, so the gate can never fire and the message names a primitive that renders. | `messages.ts:1624`; `src/util/flutter-deferred-primitives.ts` |
| **F29** | `loom.filter-bypass-unsupported` is unreachable — `FILTER_BYPASS_FAMILIES` holds all five families — and its text still names three backends as "the honoring backends". Dead gate or a missing family; the wording is wrong either way. | `system-checks.ts:2712`; `messages.ts:1832-1842` |
| **F30** | `loom.projection-event-unkeyed` interpolates `proj.correlationField`, which is `undefined` for the keyless case it fires on: *"…has no 'undefined' field to route by."* | `projection-checks.ts` `validateHandlers` ~:90 |
| **F31** | `loom.scaffold-unexpanded`'s message blames "walker-primitive-expander", a pass that no longer exists, and names `view` as a resolvable target. | `messages.ts:783` |
| **F32** | Grammar and IR comments name `loom.workflow-function-block-body` as the gate for block-bodied workflow functions. The code does not exist, nothing raises it, and such helpers generate correctly on all five backends. | `ddd.langium:1456`; `loom-ir.ts:1311` |
| **F33** | A comment cites `loom.intrinsic-not-queryable`, which does not exist. | `src/util/intrinsics.ts:57` |
| **F34** | A comment says `loom.spurious-effect-marker` is raised by the validator. No such code exists; a stray `await` is a parse error instead. | `src/ir/lower/lower-expr.ts:1080` |
| **F35** | `extern_handlers_registered` is in the observability catalog but no backend emits it — an orphan entry. | `src/generator/_obs/log-events.ts` |

**F36. Two `system` blocks with no top-level members pass validation.**
`composition.ts:120-137` only fires when a top-level member must fold; there is no direct
"exactly one system" gate, and `generate system` writes only root artefacts.

---

## P4 — per-feature docs that contradict the code

Outside this audit's scope (it covered the language surface docs only), found in passing and
each verified:

| # | Doc | Drift |
|---|---|---|
| **F37** | `docs/capabilities.md` | Lists four built-ins (no `tenantRegistry`), presents `versioned` as opt-in when the expander applies it by default, and names the **removed** per-backend codes `loom.node-stamp-unsupported` / `-python-` / `-elixir-`. |
| **F38** | `docs/inheritance.md` | Claims Java and .NET emit a polymorphic base reader (neither does) and that the base emits no Ecto schema (under TPH it does); uses the legacy `phoenix` platform literal; omits five shipped codes. |
| **F39** | `docs/auth.md` | The dev-stub note says only Hono carries an array claim and that a permission gate "fails closed on four of five backends" — #2717 fixed the emitters and the prose was never corrected. Its `curl` example sends raw JSON where every stub base64-decodes. Its named-policy example puts `permissions { … }` in a `context`; the block is a `Subdomain` member (proven parse error). |
| **F40** | `docs/tenancy.md` | Writes `crossTenant aggregate Plan` (prefix); the grammar puts `crossTenant` in the header region after the name — proven parse error. |
| **F41** | `docs/actions.md` | Says `loom.missing-effect-marker` is "a warning during the Stage-2 ramp"; the check raises `severity: "error"` (`ui-checks.ts:2320`). |
| **F42** | `docs/observability.md:20` | States the emitted JSON `level` is `"warn"` on every backend; the generated Elixir `LogFormatter` stringifies `:warning` (`elixir/shell/runtime.ts:136`). |
| **F43** | `docs/resources.md` | Names `loom.resource-unknown-verb`; the catalog ships `loom.resource-verb-invalid`. |
| **F44** | `docs/macro-api.md` | Lists the stdlib path as `stdlib/<name>/*.macro.ts` (most are flat or under `scaffold/`); missing the `api` target and `apiVersion`. |
| **F45** | `docs/scaffold-macros.md` | No `scaffoldHandlers` / `scaffoldApi` / `scaffoldPaged` / `scaffoldPagedApi` sections, though chapter 22 now cross-links it as authoritative. |
| **F46** | `CLAUDE.md` | Says "~55 primitives"; `WALKER_LAYOUT_PRIMITIVES` holds 56. |
| **F47** | `docs/build.mjs` | Uses `marked` with no heading-id slugger, so `<h2>`s render without `id`s and **every** `](#…)` in every chapter is dead on the Pages build. They work on GitHub's renderer, which is why nobody noticed. |

---

## Cross-cutting reading

Three patterns account for most of the P0/P1 list, and each suggests a gate rather than 17
individual fixes:

1. **The walker's dispatch predicates fail open.** `isWalkableLayoutBody` (F10),
   `emitKeyValueRow`'s element-position `walk` (F12), `DestroyForm`'s aggregate lookup (F11),
   Flutter's extern hatch (F17) — each returns a comment or `false` on a shape it does not
   recognise, and nothing downstream notices a page or element never got emitted. A
   "the walker declined to render this" signal, raised once, would convert all four into
   honest diagnostics.

2. **Lowering has arms the validators assume exist.** `variant-match` off a page (F1),
   `for`/`if let` off a workflow (F4), the optional-receiver unwrap (F2), the store receiver in
   a `derived` (F9). The IR admits a node the emitters cannot consume, and the layering means
   nobody owns the check.

3. **The catalog gate does not reach the IR check leaves.** F25 and F26 are exactly the
   defect class `test/system/diagnostic-catalog.test.ts` was written to prevent, surviving
   because the test does not walk `src/ir/validate/checks/`. Extending its reach retires
   F25–F35 as a class and prevents the next one.

Per `CLAUDE.md`: mutation-prove each gate before trusting it — revert the fix with a file copy,
never `git checkout -- <path>`, and confirm the assertion that fails is the one under test.
