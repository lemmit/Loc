# M-T3.16 — the canonical `create` / `destroy` body: what is left, and in what order

> **STATUS: PLAN.** Written after #2446 landed (the honest gap + the check) and #2450 was pulled back to draft (`[needs redesign]`). Every claim below is code-verified against `main` @ `25f7f78`; this repo's statuses rot, so **re-verify before picking anything up.**

---

## 0. TL;DR

#2446 closed the *silence*: a canonical `create` / `destroy` body that no backend renders is now a named error (`loom.lifecycle-body-dropped`) instead of a shrug. It did **not** close the gap — the bodies still are not rendered.

Getting from here to "a guarded create is actually gated" is **six independent pieces**, and the sequencing matters because two of them are security-shaped and one of them is a *precondition for trusting any of the others*. In particular: the first attempt at the emission (#2450) shipped a regression **and** a gate that passed four seeded mutations, so "write the emission" is not the next step. "Make the emission checkable" is.

Along the way, closing the drop surfaced **three pre-existing emitter bugs** in constructs that had never reached an emitter before. One is still open (§2). That is not incidental — it is the strongest argument for finishing this track, and §6 draws the general lesson.

---

## 1. What #2446 established, and what it did not

**Established.** The IR is correct and always was: `canonicalCreate.statements` / `canonicalDestroy.statements` carry the full body. `canonicalCreate` is consumed as a *marker* (its existence gates `POST /<aggs>` and the `static create` factory) plus `params` / `audited`; `.statements` is read **nowhere** across the five backends. The check names that, with four exemptions that are the design rather than an afterthought (event-sourced creates, `field := <same-named param>`, a restated field default, and — after review — a structural rather than string-literal comparison for that last one).

**Not established.** Nothing is rendered. A `requires` in a create still does not gate; it is merely refused at compile time. `loom.lifecycle-guard-unreadable` (#2487) adds the contract that makes rendering *possible*, and stops there deliberately.

---

## 2. OPEN BUG — a value-object field default emits non-compiling code

Found while correcting the #2446 fixtures; **not fixed**, and the highest-value standalone item here because it is a live emitter defect on `main` reachable from ordinary Loom.

```ddd
total: Money = Money { amount: 0, currency: "USD" }
```

The default renders as the **domain** class into the **wire** request DTO.

| backend | result |
|---|---|
| Python | `Incompatible types in assignment (expression has type "app.domain.value_objects.Money", variable has type "app.http.wire_models.Money")` — `mypy --strict` |
| .NET | `CS0246: The type or namespace name 'Money' could not be found` — the domain type is not in scope in the request file |
| TS | **compiles**, by structural typing only: `MoneySchema.default(new Money(0, "USD"))` type-checks because the class happens to carry matching public fields |
| Java / Elixir | not yet measured — Java null-coalesces in the factory rather than defaulting the record, Elixir has no separate wire DTO |

The python site is `src/generator/python/routes-builder.ts:663` — `if (defaultExpr) return \`${base} = ${renderPyExpr(defaultExpr)}\`` — which renders the DOMAIN expression into a field typed as the WIRE model. The other backends have the structurally identical line.

**Fix:** render a VO-typed default in the **wire** shape (`MoneyRequest(0, "USD")` / `MoneyModel(amount=0, currency="USD")`), on every backend with a distinct wire DTO. **Gate:** a corpus fixture carrying a VO-typed field default, on the compile tier — there is none today, which is why this survived.

**Interim state:** the five `scaffold-handlers.ddd` fixtures declare `total: Money` with **no** default. That is not a workaround masking the bug — before #2446 they said `total := money(...)` in the create body, which was dropped, so `total` was *already* a required field with no default. Same wire contract, minus the statement that lied about it. The scalar and enum defaults (`status`, `priority`) still exercise the create-input path.

**Do not** bundle this into the lifecycle emission. It is a wire-projection bug; the coupling is coincidental.

---

## 3. The #2450 findings, triaged

From an adversarial review of the withdrawn emission. Full detail on #2450; this is the disposition.

### 3.1 Blockers for any re-emission

| # | finding | why it blocks |
|---|---|---|
| **B1** | A create guard reading a **field** was accepted and emitted an unbound receiver on all five backends (`this._quantity` in a module-scope handler, `cannot find symbol`, CS1061, `F821 Undefined name self`, undefined `record`) | **Fixed by #2487.** The contract is a check now. Any emission must sit on top of it. |
| **B2** | The enforcement gate **passed four seeded mutations** — polarity inversion on Elixir ×2, Hono + Python, and .NET's destroy gate moved *after* the delete | Until the gate can fail, "the emission works" is unfalsifiable. **This is the real next step**, not the emission. |

### 3.2 Security-shaped, must be answered by the design

| # | finding | disposition |
|---|---|---|
| **S1** | Elixir's scaffolded **LiveView** calls `<Ctx>.create_<agg>(params)` directly, around any controller-level gate; `destroy_<agg>!/1` is a documented separate path for `DestroyForm` | The gate belongs in the **context**, not the controller. Phoenix is the only backend whose frontend is in-process, so it is the only one with a second front door — and it ships LiveView pages by default. |
| **S2** | An event-sourced create's guard renders into the domain `_init`, which **cannot reach a principal** — `currentUser` is a free identifier there. It does not raise; it does not compile | The ES exclusion in `lifecycleRouteGuards` rests on a false premise. Either reject an ES lifecycle guard with a named diagnostic, or thread a principal into `_init`. **Rejecting is honest and cheap; do that first.** |
| **S3** | A guarded lifecycle on a deployable with **no `auth:`** references an auth module that is never generated, on all five | Pre-existing class — a find/operation `requires` does the same on `main` — so fixing it *only* for lifecycle would be inconsistent. Worth its own small validator item covering all three sites. |

### 3.3 Correctness / consistency, not blocking

- **C1** Elixir `mix compile --warnings-as-errors` breaks on a *principal-only* destroy guard: the wrapper binds `{:ok, record}`, unused when the guard does not read the row. Needs `_record`. Note the corpus fixture **cannot** catch it — its destroy guard reads `this.quantity`, so `record` is always used. A gate needs both shapes.
- **C2** A guarded create with an invalid body answers **403 on Elixir vs 422 elsewhere** (Elixir gates before the changeset; everyone else validates first). No golden covers it.
- **C3** Hono's denial detail is `"Forbidden"` where the other four embed `Forbidden: create <Agg>`. House style, but wire-visible and ungoldened.
- **C4** `errorStatuses("destroy", true)` returns `[403, 404, referencedInUse]` — unsorted if `httpStatus` remaps `ReferencedInUse` below 403.
- **C5** The create-guard param rejection is over-broad for the repo's dominant idiom (a param that shadows a field, where `body.<field>` *does* exist). Deliberate in #2487; revisit only with evidence that anyone writes it.

### 3.4 Scope gap, unowned

- **G1** ✅ **closed by #2532** (`loom.named-lifecycle-dropped`). A **named** `create open(...)` / `destroy` on a state-based aggregate is dropped just as hard, and no check looked at it — `validateLifecycleBodyDropped` reads only `canonicalCreate` / `canonicalDestroy`. Re-measured on `main` @ `c8185c2` before the fix: `ddd parse` reported `0 error(s)`, and the emitted API carried **two GET routes, no POST and no DELETE** with the factory synthesized from the field set. Which action each backend renders was then read off the five emitters rather than assumed — an event-sourced create is `agg.creates[0]` **by index** (so a named `create open(...)` on an event stream *is* emitted, and every named create in this repo's `.ddd` corpus is exactly that), everything else is the canonical action. The probe also found that a named lifecycle makes two elixir artifacts appear carrying none of its body: a dead `change_<name>` changeset, and — via a `destroys.length > 0` gate, the last survivor of the `destroys.length > 0` vs `canonicalDestroy` divergence the route-surface unification removed elsewhere — the `destroy_<agg>!` DestroyForm seam, which hard-deletes with the author's `requires` gone. Refusing the declaration makes both unreachable, so the check is the whole fix; *rendering* named lifecycle actions as real commands remains unowned.

---

## 4. What #2443 changed, and why it helps

`src/ir/util/op-gates.ts` landed on `main` (`splitLeadingGates` / `operationGates` / `operationBody` / `operationGatesUseCurrentUser`). Operation `requires` is now **hoisted out of the domain entity into the handler** — the same conclusion the lifecycle work reached independently, from a different direction.

Two consequences:

1. **The lifecycle gate must reuse `op-gates.ts`,** not invent a parallel spelling. Two emissions of "evaluate a `requires`, deny with 403" sitting next to each other is exactly the two-truths problem this track exists to remove.
2. **The route-builder unification** (#2459–#2462) means every backend renders its route surface from `deriveContextOperations`. The **declaration** half of the lifecycle 403 therefore collapses from five per-backend edits to **one**: `errorStatuses("create", …)` / `errorStatuses("destroy", …)` in `src/ir/util/api-surface.ts`, both still hardcoded `false` today. The **enforcement** half stays per-backend, because it is body-shaped (before the factory / after the load), not route-shaped.

---

## 5. Sequencing

Ordered so that nothing lands on an unchecked assumption, and so each step is independently revertible.

| step | item | why here |
|---|---|---|
| **1** | #2487 — the readable-surface contract | In flight. Everything downstream assumes it. |
| **2** | **A gate that can fail** (B2) | Polarity probes *and* a destroy ordering probe (deny precedes the delete, not merely follows the load). Mutation-prove it against all four seeded defects from #2450 **before** writing any emission. |
| **3** | S2 — reject an ES lifecycle guard | Cheap, honest, removes a false premise the design would otherwise inherit. |
| **4** | §2 — the VO wire default | Independent of the rest; unblocks nothing but is a live `main` defect. Can run in parallel by a different agent. |
| **5** | The emission, one backend per PR | Elixir **in the context** (S1), the rest at the route through `op-gates.ts`. Declaration flips in `api-surface.ts` with the last one, or the derivation publishes a 403 nobody answers. |
| **6** | C1–C4, G1, S3 | Follow-ups; each small and independently gateable. |

**Steps 2 and 4 are parallelisable.** Steps 3 and 5 are not — 5 depends on 1, 2, 3.

---

## 6. The lesson worth keeping

Closing this drop surfaced **three** pre-existing emitter bugs, none of which the silence itself caused:

1. an `int` literal in a decimal VO slot → Java `int cannot be converted to BigDecimal`;
2. a `money` slot → Python passed a float where `Decimal` was required — and a **test pinned that output**, so the gate agreed with the bug;
3. a VO-typed field default → §2, still open.

Each was invisible for the same reason: **the construct never reached an emitter**, because the body carrying it was dropped. A silent drop does not only lose the author's intent — it hides every downstream bug on the path that intent would have taken. That is a stronger argument for closing a drop than "the source says something untrue," and it generalises to every other place this toolchain quietly ignores a declaration.

Two corollaries, both earned the hard way in this track:

- **A green compile tier says nothing about the other four.** `build-generated-ts` was green while Python and .NET could not compile the same fixture — TypeScript's *structural* typing makes it the weakest oracle for wire/domain confusion, not the strongest. Java and Python are the strict ones; check those first.
- **A check that never reaches the thing it names is indistinguishable from no check** (`experience_gathered.md` §59/§63). #2450's enforcement gate deleted whole gates and passed; inverting a gate's polarity also passed. The mutation must be the *plausible* defect, not the convenient one.
