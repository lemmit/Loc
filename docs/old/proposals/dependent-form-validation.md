# Dependent / cross-field form validation

**Status: RESOLVED — no new language construct.** The capability already
exists; this doc records *why*, and the one ergonomic delta that shipped
alongside it.

> An earlier draft of this proposal argued for hosting invariants on
> `payload`/`command` records. That was wrong at the root (see §3) and has
> been retracted. The conclusion below is the accurate one.

## 1. The three shapes, and where each already lives

"Dependent form validation" is three different problems with three different
homes — and none of them needs a new construct:

| Shape | Example | Home | Status |
|---|---|---|---|
| Cross-field over **wire** fields | `endDate > startDate` | aggregate / operation `invariant … (when …)` | ✅ ships |
| Conditional-required over a **wire** field | `vatId required when kind == company` (`vatId` is stored) | guarded aggregate invariant + `match` visibility | ✅ ships |
| Rule over a **client-only** field | `confirmPassword == password`, repeat-email, un-stored consent | page `state` + `derived` + `match` + `error:` | ✅ ships |

The first two are contract concerns. Loom already classifies each aggregate /
value-object / operation invariant (`src/ir/validate/invariant-classify.ts`)
and lowers the wire-translatable ones to a zod `.refine((data) => …, { path,
message })` on the form's request schema, to every backend validator (.NET
FluentValidation, Java, Pydantic, Ecto, Hono), and to the live RFC-7807
`errors[]` surface consumed by `applyServerErrors`. A `CreateForm { of: T }`
therefore shows a cross-field error inline with zero per-form wiring. See
[`validation-error-extension.md`](./validation-error-extension.md) (SHIPPED).

The third is a **page** concern, and `state` already carries it — see
[page-metamodel.md §8.2](../../page-metamodel.md) for the worked `confirmPassword`
example.

## 2. What shipped with this doc — the `error:` slot

The only gap was ergonomic: the bindable inputs had no inline error slot, so a
`state`-composed form had to render the message as a sibling `Text` gated by
`match`. The inputs (`Field` / `NumberField` / `PasswordField` /
`MultilineField` / `SelectField` / `Toggle`) now accept an optional **`error:`**
expression, walked in page scope (so it reads `state`/`derived`) and rendered
in the pack's native error slot:

```ddd
PasswordField { "Confirm", bind: confirmPassword,
                error: passwordsMatch ? "" : "Passwords must match" }
```

```tsx
<PasswordInput label="Confirm" value={confirmPassword}
               onChange={(e) => setConfirmPassword(e.currentTarget.value)}
               error={ passwordsMatch ? "" : "Passwords must match" } />
```

Wiring: `inputErrorExpr` in `src/generator/_walker/primitives/inputs.ts`
(one `error`/`hasError` pair threaded through all six input emitters).
Rendered across **every pack**, each in its own error idiom: Mantine
`error=` prop, MUI `error`/`helperText`, Chakra `FormErrorMessage` (v2) /
`Field.ErrorText` (v3), shadcn/shadcnVue destructive `<p>`, Vuetify
`:error-messages`, shadcnSvelte/flowbite `{#if}` `<span>`/`<p>`, Angular
(Material/Spartan/PrimeNG) an `@if`-gated error span. The expression is
walked in page scope, so per-framework state access is correct out of the
box (React plain, Vue unwrapped, Svelte plain, Angular signal `()` calls).

## 3. Why the payload-invariant idea was wrong (retained as the reasoning trail)

The retracted draft proposed adding `invariants` to `PayloadIR` so forms could
carry cross-field rules. Two facts kill it:

1. **No form binds to a bare payload.** Every form primitive binds to an
   aggregate (`CreateForm`/`DestroyForm of:`), an operation (`OperationForm`),
   or a workflow (`WorkflowForm runs:`) — field lists come from
   `createInputFields(agg)` / `op.params` / `workflow.params`, never a
   `PayloadIR` (`src/generator/_walker/primitives/forms.ts`). Payload
   invariants would emit into `<Payload>Request` schemas no form consumes.
2. **The motivating field never touches the wire.** `confirmPassword` isn't a
   domain field, an op param, or a workflow param — you don't *send* it. A
   wire-contract invariant (aggregate **or** payload) is the wrong home
   because it forces the field onto the request. It belongs on the page, as a
   `state` field (§1, row 3).

Payload-hosted invariants remain conceivable as a *separate* feature — API-DTO
validation for a `command` posted by a hand-written `call`, unrelated to
forms — but that is not this, and is not scheduled.

## 4. Not in scope

- Async / round-trip validators (uniqueness "is this email taken?") — a
  `criterion` / `can-<op>` concern ([`criterion.md`](./criterion.md)).
- A dedicated `email`/`url` format vocabulary — expressed today as
  `matches("…")` regex invariants.
