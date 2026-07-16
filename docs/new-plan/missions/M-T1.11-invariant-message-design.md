# M-T1.11 (slice) — Custom validation messages on `invariant` / `check` / `precondition` (design)

> **Status: design draft (no code).** The *authoring surface + i18n-ready
> plumbing* for user-facing validation messages — the extractable foundation of
> M-T1.11's open "invariant `message:` keys" phase. Ships **ahead of** the full
> i18n epic with literal English text; i18n later swaps text → catalog key with
> zero IR-shape or wire-contract churn.
>
> Binding context (do not contradict): **[D-I18N-KEY](../../decisions.md)**
> (content-hash / named-entity key stability), **[i18n.md](../../old/proposals/i18n.md)**
> §"Zod / runtime validation — message-as-key" + §"Keys", and the shipped Angular
> client-validator work (PR #1951, `src/generator/angular/form-validators.ts`).

## Problem

A rule's message today **is** the predicate source. `zod-refine.ts` emits
`message: \`Invariant violated: ${inv.source}\``; the shipped Angular path emits
a generic `"<Field> is invalid"`. Both leak DSL text or say nothing useful, and
there is **no grammar surface** to author a human message:

```ddd
invariant name.length >= 2 && name.length <= 120   // no way to say "Name must be 2–120 characters"
```

Two things are missing, and the second must not be built in a way that fights
i18n (which is coming — M-T1.11, XL):

1. **An authoring surface** for a per-rule message on `invariant` / `check` /
   `precondition`.
2. **i18n-readiness** so the surface, the IR, and — most importantly — the
   **wire contract** don't have to change when catalogs land.

## What's already decided (align, don't reinvent)

- **i18n.md** already sketches the surface as a **named invariant with a
  `message:` slot** and **message-as-key** on the wire:
  ```ddd
  invariant totalPositive {
    total > 0
    message: "Order total must be at least {minTotal, number, ::currency/USD}"
  }
  ```
  → zod `refine(..., { message: "invariant.Order.totalPositive", path: [...] })`;
  server `DomainError` carries the same `{ code, params }`; React renders
  `<FormattedMessage id={error.message} values={error.params} />`.
- **D-I18N-KEY** pins key stability: **named** entities get true stable keys
  (`invariant.<Agg>.<name>`); inline literals get content-hash keys. A *named*
  invariant is therefore the i18n-preferred shape — its key survives a message
  rephrase.
- **i18n.md non-goal for v1:** validator messages stay inline English; catalog
  centralisation is deferred. So the message *text* ships literally first.

The gap this slice fills: the surface + IR + **full cross-target fan-out** of the
literal text, plus the two forward-compat hooks (descriptor + wire `code`) that
make the eventual key swap additive.

## Surface

A **messaged invariant is named** (the name is its stable i18n key); the
anonymous `invariant <expr>` form is unchanged and message-less.

```ddd
aggregate Product {
  name: string
  invariant nameLength {
    name.length >= 2 && name.length <= 120
    message: "Name must be 2–120 characters"
  }
}
```

Field `check` and `precondition` take a trailing `message "…"` (they have no
natural name; their key is content-hashed per D-I18N-KEY):

```ddd
sku: string check sku.length > 0 message "SKU is required"
...
precondition amount >= 1 message "Amount must be positive"
```

- Anonymous message-less invariants keep parsing exactly as today.
- `message:` value is a `StringLit` with `userVisible = true` (rides the same
  extraction pipeline as `Heading` text when i18n lands).

## IR — a descriptor, not a string

```ts
// InvariantIR.message?:
interface MessageIR {
  text: string;                    // v1: the authored literal
  key?: string;                    // i18n: invariant.<Agg>.<name> | content-hash
  args?: Record<string, ExprIR>;   // i18n: ICU placeholder bindings (deferred)
}
```

v1 populates only `text`. Every emitter reads the descriptor; i18n fills
`key`/`args` with **no shape change**. This is the cheap-now / expensive-later
hook #1.

## Wire contract — per-error `code` (hook #2, the load-bearing one)

The 400/422 ProblemDetails `errors[]` entry gains a stable **`code`** beside
`message` (RFC-7807 extension member), for every backend:

```json
{ "errors": [ { "pointer": "/name",
                "code": "invariant.Product.nameLength",
                "message": "Name must be 2–120 characters" } ] }
```

This is the single hardest thing to add after clients integrate. With `code`
present from day one, any client localises by `code` while `message` is the
default text — the i18n frontend swap needs no wire change. `DomainError`
carries the same `{ code }` so the domain floor and the wire agree.

## Fan-out — one carrier principle

**A *messaged* rule renders through the refine / custom-validator carrier**
(which every layer already has a message slot for), *bypassing* the native-chain
optimisation. A *message-less* rule keeps its native chain (`z.number().min(1)`,
`Validators.min(1)`, …) **byte-identical to today.** Only messaged rules take the
new path, so nothing existing regresses.

| Layer | Message-less (today, unchanged) | Messaged (new) |
|---|---|---|
| zod (React/Vue/Svelte) | `z.string().min(2)` | `.refine(d => …, { path, message: text })` |
| Angular | `Validators.minLength(2)` | `loomRule(fn, { code, text })` custom `ValidatorFn`; template shows `text` |
| .NET FluentValidation | `.MinimumLength(2)` | `.Must(...).WithMessage(text)` |
| Python Pydantic | `Field(min_length=2)` | `@model_validator` raising with `text` |
| Java validator | imperative length check | check + `text` |
| Elixir Ecto | `validate_length(min: 2)` | `validate_change` with `text` |
| Domain floor (all 5) | `DomainError("Invariant violated: <src>")` | `DomainError({ code, message: text })` |

### Angular specifics (why the carrier matters here)

Built-in `Validators.min/pattern` write **fixed** error keys (`min`, `pattern`),
so two messaged rules on one field would collide on the same key with no way to
show distinct messages. A per-rule custom `ValidatorFn` returning
`{ loom: { code, text } }` gives each rule its own error entry; the inline error
template renders `text` (v1) and switches to `code | translate`-style resolution
under i18n — the shipped `form-validators.ts` error block is the seam.

## v1 vs i18n boundary

- **v1 (this slice):** literal `text`, full fan-out, wire `code` derived stably
  (`invariant.<Agg>.<name>` for named; content-hash for `check`/`precondition`).
  **No** catalog, **no** locale resolution, **no** interpolation.
- **Deferred to M-T1.11 proper:** ICU placeholders (`{minTotal, …}`) bound via
  `args` (the natural first i18n add — extract bounds from the
  `SingleFieldPattern`), catalog extraction/sync (`ddd i18n sync`), per-locale
  resolution, and `zod-i18n-map` for zod's own `required`/`too_small` errors.

## Open decisions

1. **`check` / `precondition` syntax** — trailing `message "…"` (proposed) vs a
   block form. Trailing keeps them one-liners; a block would match the named-
   invariant shape. Recommend trailing.
2. **Mission placement** — ship as an extracted **T5 language-core** foundation
   mission (independent of the i18n epic) or keep inside M-T1.11? It compiles and
   ships standalone; recommend extracting so it isn't gated on XL i18n.
3. **`code` derivation for anonymous-but-messaged** — n/a under the "messaged ⟹
   named" rule for invariants; `check`/`precondition` use content-hash. Confirm
   the hash input (predicate source vs message text) — predicate source matches
   D-I18N-KEY's inline-literal rule.

## Non-goals

Interpolation/ICU, catalogs, locale switching, translating zod's built-in error
strings, and message support on `unique(...)` (already 409 via a different
mechanism) — all belong to M-T1.11 proper or are out of scope.

## Test placement (when built)

- Parsing: named messaged invariant + `check`/`precondition message`.
- Negative validator: `message:` on an anonymous invariant (must name it);
  non-string message.
- Per-backend generator test: messaged rule → carrier + `text`; message-less →
  unchanged native chain (byte-identical pin).
- Wire: ProblemDetails `errors[].code` present across all five backends.
- `ng build` / `tsc` / `mix compile` on a messaged-rule project.
- `print-completeness` arm for the new grammar node.
