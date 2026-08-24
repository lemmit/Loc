# M-T6.20 — Elixir (vanilla Phoenix) `precondition` custom messages + wire `code`

**Status:** `done` · **M** (down from L) · P3 · ⭐ cross-backend parity gap (one backend, one construct)

> **[2026-08-23] CLOSED by [#2655](https://github.com/lemmit/Loc/pull/2655) — this brief is now HISTORY, not a work order.** Path 2 (the raise path) landed as the typed-exception reshape §2 predicted: `<App>.GuardError`, `defexception [:message, :kind]`, at `lib/<app>/guard_error.ex`, rescued BY TYPE with the rung read off `guard_error.kind`. `requires` was typed alongside `precondition`, so the message-prefix contract is deleted rather than halved, and the `reraise` arm went with the `cond`. The wire-`code` question in §3 is settled without reshape (a): the other four put a `code` only on the WIRE-VALIDATION rung, which elixir already produces via `deniesAtWire` / `wireValidationTerm`; their DOMAIN-FLOOR 422 carries no `code` and no `errors[]`, and a pure body has no request slot to point into. See the M-T6.20 row in [`../T6-backend-parity.md`](../T6-backend-parity.md) for the closing note.

> **[2026-07-29] Path 1 landed early, unplanned — read this before picking the mission up.** The `ensure` → 422 path below is **DONE** (#2300). It was not scheduled: the M-T9.11 wire-golden gate needed an error-envelope assertion, the golden is byte-exact, and elixir's bare `:precondition_failed` atom made the `detail` generic — so this mission's ensure-path message half became the blocking dependency for closing that gate's last coverage hole, and was done there. The reshape is exactly the one predicted below (2-tuple reason, `ensure/2` itself unchanged); the protocol now has a single owner, `src/generator/elixir/vanilla/denial.ts`, which both producers and consumers go through. `denialMessage` honours the author `message "…"`.
>
> **What is left:** (1) the **`raise` path** — and the warning in §2 turned out to be the load-bearing constraint, see the note there; (2) the wire **`code`**, untouched. The producer/consumer site maps in §1 are now HISTORICAL — grep before trusting them.

**Context:** the custom-validation-messages feature (`message "..."` on `invariant` / `check` / `precondition`, plus the per-error wire `code`) shipped end-to-end on all five backends **except** this one construct on this one backend: a **`precondition`** carries neither its author **message** nor a wire **`code`** on the vanilla Phoenix/Ecto backend. Everything else is done:

- Message clause + carriers: Hono #1965, .NET #1991, Python #1995, Java #1996, Elixir #1999.
- Wire `code`: Hono #1982, .NET #2008, Python #2011, Java #2012, Elixir cross-field #2013 + single-field #2099.
- `loom.blank-message` validator: #2000.

On the other four backends, an op `precondition` flows through `preconditionsAsInvariants(op)` into the **same wire validator** the invariants use, so it gets its message + code (in `errors[]` with a `pickErrorPath` pointer) for free. **Elixir is different**: preconditions do NOT go through the changeset validator — they use a separate control-flow-error path (the `ensure/2` chain / `raise`), which currently carries only a bare atom / a fixed-prefix string, with no slot for the author message or code. Closing this means reshaping that path.

## The two denial paths (both need work)

### 1. The `ensure` path → 422 (HTTP-boundary ops, event-sourced, workflows)

A `precondition` on an HTTP op lowers to a `with :ok <- ensure(<pred>, :precondition_failed)` clause; a false predicate short-circuits to `{:error, :precondition_failed}`, which a controller maps to **422**. The `ensure/2` helper is `defp ensure(true, _), do: :ok; defp ensure(false, reason), do: {:error, reason}` — it already wraps ANY reason, so the reason atom can become a tuple `{:precondition_failed, detail, code}` with **no change to `ensure/2` itself**; every producer and consumer of the atom must change in lockstep.

**Producers** (emit `:precondition_failed` / `{:error, :precondition_failed}`) — all have the `precondition` StmtIR `s` in scope, so `s.message` (a `MessageIR | undefined`) and `messageCode(s.message.text)` are available:
- `src/generator/elixir/vanilla/operation-returns-emit.ts` — `renderOpGuardClause` (`:ok <- ensure(<pred>, :precondition_failed)`). NOTE `requires` shares this fn with `:forbidden` — leave `requires` alone (no message in scope for it).
- `src/generator/elixir/vanilla/eventsourced-emit.ts:~719` — ES command runners (`ensure(<pred>, :precondition_failed)`).
- `src/generator/elixir/vanilla/workflow-execution-emit.ts` — THREE inline sites (~280, ~555, ~839): `:ok <- (if <cond>, do: :ok, else: {:error, :precondition_failed})`.

**Consumers** (pattern-match `{:error, :precondition_failed}` → build the 422) — must match the new tuple and use `detail`/`code`:
- `src/generator/elixir/vanilla/explicit-handlers-emit.ts:~594` — `def respond(conn, {:error, :precondition_failed}), do: ...`
- `src/generator/elixir/vanilla/workflow-execution-emit.ts:~1591` — `def respond(conn, {:error, :precondition_failed})`
- `src/generator/elixir/vanilla/eventsourced-emit.ts` — `command_error(conn, :precondition_failed)` (~601 area).

Grep the invariant to find them all: `grep -rn "precondition_failed" src/generator/elixir/`.

### 2. The `raise` path → 400 (pure-core / document / function / domain-service)

Reached only by NON-HTTP bodies. Currently `raise(ArgumentError, "Precondition failed: <source>")`, and the **`GUARD_RESCUE`** clause (`operation-returns-emit.ts:~989`) routes it by **message prefix**: `String.starts_with?(guard_msg, "Precondition failed: ") -> 400`. You **cannot** just swap in the author text — it would no longer match the prefix and would fall through to `reraise` → **500**. The clean fix is a **typed exception** (`defexception`) instead of the prefix hack, rescued by type.

Raise sites:
- `operation-returns-emit.ts:~802` (the `renderStatement` `precondition` arm).
- `src/generator/elixir/vanilla/function-emit.ts:~74`.
- `src/generator/elixir/vanilla/domain-service-emit.ts:~475`.
- `src/generator/elixir/vanilla/dispatch-emit.ts:~850` — note this one `throw({:error, "Precondition failed: <source>"})` (throw, not raise) — different mechanism, check its catch site.

`GUARD_RESCUE` also routes `requires` by the `"Forbidden: "` prefix — you can leave that as-is and only type preconditions, or type both. Typing only preconditions keeps blast radius smaller.

## Wire `code` — the extra reshape (only if going for FULL parity)

Message-only is the moderate version. For the wire **`code`** too (true parity with the other four backends), the 422 body must carry the code. But Elixir's precondition denial produces a **bare** 422 problem (no `errors[]`, no pointer) — unlike the changeset path (`errors[]` with pointers, see `problem-details-emit.ts:render_changeset_error` + its `loom_code` handling from #2013). Options:
- **(a)** reshape the precondition 422 into an `errors[]`-with-pointer body (pointer from `pickErrorPath` of the precondition-as-invariant, `message`, `code`) so it matches the other backends' shape exactly — largest.
- **(b)** put `code` as a top-level extension on the bare 422 — smaller but a divergent shape from the other backends' `errors[].code`.

The `messageCode(text)` helper (`src/util/message-code.ts`, shared FNV-1a) is the SAME hash all backends use — identical message text ⇒ identical `msg.<hash>` code. Reuse it so the Elixir code matches.

## Recommended sequencing

1. ~~**Message-only, the ensure path**~~ — **done** (#2300), see the status note at the top.
2. **Message-only, the raise path** — the remaining message work, and the reason this mission is still open. Introduce a typed exception (a domain-layer `defexception`, NOT a `<App>Web.*` one — `function-emit` / `domain-service-emit` live under `lib/<app>/` and must not reference the Web namespace) and rescue it **by type** in `GUARD_RESCUE`, replacing the prefix `cond`. Only then can the raise sites carry `denialMessage(s)`; today they deliberately emit the derived form, each with a comment saying why. Verify with a fixture whose authored-message precondition sits on a `function` — it must answer **422**, not the 500 the prefix miss would produce.
3. **Then the code** as a third PR: pick reshape option (a) or (b); (a) is truer parity.

## Verification (the gate)

The whole **vanilla-\* Phoenix matrix** exercises preconditions across ops, event-sourcing, workflows, functions, and domain services — this is the regression gate, and the reason the refactor is **L / risky**. Minimum:
- `LOOM_PHOENIX_VANILLA_BUILD=1 LOOM_HEX_MIRROR=1 npm run test:phoenix` (or the docker recipe in CLAUDE.md) → `mix compile --warnings-as-errors` clean on a fixture with a precondition on: a plain op, an event-sourced op, a workflow step, a function, and a domain service.
- `npx vitest run test/generator/elixir/` (currently ~720 tests) green.
- Add a generator test asserting the messaged precondition surfaces its text (and, for step 2, its code) on both the 422 and 400 paths.
- Watch for `page-emitter-equivalence.test.ts` baseline drift **only if** `examples/acme.ddd` gains an elixir deployable (today it has none, so no drift — but any always-emitted file change would need `node scripts/capture-baseline-fixture.mjs`; see the #2008 lesson in `experience_gathered.md`).

## Why it was deferred

A disproportionately large/risky refactor of the vanilla backend's error control-flow core (~8 producer sites + ~3 consumers + a typed exception + ProblemDetails reshape) for a narrow benefit (precondition text/code on one backend, one construct). Workaround: authors get the derived default message; the predicate is still enforced (correct 403/422), just without the custom string/key. P3.

**[2026-07-29] Re-pricing after the partial landing.** The deferral reasoning held up, but the split turned out to be uneven: the ensure path (the ~6 producers + 4 consumers — the bulk of the "8 + 3") carried the risk and is now paid, gated, and green on the whole vanilla-\* matrix. What remains is 3 raise sites + one `cond` + one exception module — **M, not L**. Whoever picks this up inherits a smaller and better-understood job than the original estimate; the risk that made it L is spent.
