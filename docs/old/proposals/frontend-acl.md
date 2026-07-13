# Frontend ACL — volatile state ↔ sealed payload, with bidirectional error hydration

> **[2026-06-20 status audit]** Dormancy note is stale — the RFC 7807 §3.2 `errors[]`/`pointer` extension SHIPPED on all five backends (`validation-error-extension.md`; e.g. `src/platform/hono/v4/emit.ts:~162`), so the per-field `applied` path is now live, not dormant.

> Status: **PARTIAL** — Phases 1+2 shipped on `main` as [#769](https://github.com/lemmit/Loc/pull/769) (commit `25dba02`). Three deferred work items tracked in the plan:
> - **Schema restructure** (flat-key inputs + `.transform()` + `.readonly()` so `<Action>FormState` actually diverges from `<Action>Payload`) — gated on a real form needing flat ≠ nested, OR `loom-forms.md` Phase F1.
> - **Per-action `FieldMap` instances** with `satisfies StrictFieldMap<Payload, FormState>` — meaningless until the schema restructure (the constraint is trivial when both types are structurally identical; today the catch block uses `{} as const` identity).
> - **`option`-field rendering** (the "leave unchanged" toggle) — gated on `partial-update.md`.
>
> Implementation plan: [`../plans/frontend-acl-implementation.md`](../plans/frontend-acl-implementation.md). The "Design — what gets emitted" section below describes the FULL architecture; the parts that ship today are the two shared lib files + the catch-block wiring across all 8 pack/versions.
>
> **Dormancy note:** the `applied` per-field error path is wired and tested but stays dormant until backends emit RFC 7807 §3.2 `errors[]`. That extension lives in `exception-less.md` (PROPOSED). Today the loop's `global` (422 with `title` only) and `unhandled` paths fire; the field-routing path waits.
>
> **Sister proposals**:
> - [`loom-forms.md`](./loom-forms.md) — supplies the form-binding model (action ⇒ field list) this proposal builds on top of. This doc fills `loom-forms.md`'s open items #3 (`option` rendering at the form layer) and #4 (RFC 7807 `pointer` → form field mapping) and adds the runtime that makes them work.
> - [`payload-transport-layer.md`](./payload-transport-layer.md) — supplies the `payload` / `command` carriers and `wireShape` projection this proposal consumes. The two shapes here (form state vs command payload) are the on-the-frontend manifestation of the carrier-bounded transport story.
> - [`exception-less.md`](./exception-less.md) — supplies the RFC 7807 ProblemDetails wire shape (with the `errors[]` extension and `pointer` field per error) that the runtime translator decodes back into form-field errors.
> - [`partial-update.md`](./partial-update.md) — `option` carriers; this proposal specifies how they render and round-trip through the volatile form state.
>
> **Scope**: React generator only. Phoenix LiveView has its own validation-and-binding story (Ecto changesets in the LiveView socket); a sibling proposal can lift the same vocabulary there when the time comes. Mobile / native targets are out of scope.

## TL;DR

Today the React generator emits one Zod schema per aggregate / operation / view (`src/generator/react/api-builder.ts`) and wires it into React Hook Form via `zodResolver` (`src/generator/react/walker/primitives/forms.ts`). The schema *is* both the form's input type and the wire payload. That works for round-tripping clean data, but it conflates two roles the backend already keeps separate:

| Role | Today | Should be |
|---|---|---|
| **Volatile UI state** — flat, mutable, tolerates partial / malformed input during typing | Implicit; same shape as the wire schema | First-class `FormState<Action>` shape — flat, mutable, `z.input`-typed |
| **Sealed transport payload** — nested, deeply `readonly`, validated, ready for the wire | The Zod schema's only output | Explicit `CommandPayload<Action>` shape — nested, frozen, `z.output`-typed |
| **Inverse mapping** between the two | None — works by accident when shapes already match | Generated `FieldMap<Action>`: declared bidirectional dictionary, typechecked against both endpoints |
| **Server validation errors** (HTTP 422 ProblemDetails) → form field errors | No mapping — `onError` handlers do not exist on emitted mutations | Auto-generated middleware that maps each `errors[i].pointer` to a flat form-field key via `FieldMap` and calls `setError()` |
| **Tier-2 vs Tier-1 split** (server-driven invariant breach vs local UX precondition) | Tier 1 only (Zod); no Tier 2 path | Both: Zod stays the local gate; the ACL hydrates server-side breaches inline |

**Proposed**: emit a `FormState` / `CommandPayload` / `FieldMap` triple per bound action (colocated with that action's schema), plus two small shared utility modules — one type-only (`StrictFieldMap<P, F>`), one runtime (`applyServerErrors`) — that close the loop with React Hook Form's `setError`. No new DSL syntax. The IR already carries everything needed once `lifecycle-operations` + `payload-transport-layer` are in.

The user-visible result is that any backend validation failure (uniqueness conflict, cross-aggregate invariant, async catch-up rule) lands on the field that caused it, with the message the server wrote, without the page author writing a line of plumbing.

## Background — the conflation that exists today

`src/generator/react/api-builder.ts` emits one Zod schema per aggregate / operation, and the form walker (`src/generator/react/walker/primitives/forms.ts`) feeds that same schema to `useForm({ resolver: zodResolver(...) })`. When the aggregate carries a value object (`price: Money`), the form fields are registered with dot-path keys (`register("price.amount")`, `register("price.currency")`) and the resolver coerces them straight into the nested `{ price: { amount, currency } }` shape via Zod's own walk — see `src/generator/react/templating/preparers/form-fields.ts:102–124` and `field-input-valueobject.hbs`.

This works for the happy path. It breaks down at three seams:

1. **Volatile typing states have no home.** While the user is mid-input, `priceAmount` is a string ("12."), not a `decimal`. The Zod resolver flags this on every keystroke. Today the only workaround is loosening the schema, which also weakens the wire-side guarantee. The right fix is two *types* — a permissive input type and a sealed output type — derivable from the same schema (`z.input<S>` / `z.output<S>`); today the generator only exports one.

2. **Server-side validation errors have no path back to the form.** `src/generator/react/api-builder.ts:159–189` emits `useMutation` with `onSuccess` (cache invalidation) but **no `onError`**. A 422 ProblemDetails from the backend currently surfaces as an unhandled promise rejection in the form's submit handler. The form sits there with stale-but-still-editable state and no indication of what went wrong. The page author can't fix this on a per-page basis either, because the mutation hook is generator-owned.

3. **The flat-form-to-nested-payload mapping exists only implicitly.** The form walker chooses dot-path field keys (`price.amount`); the wire schema nests; nothing names that correspondence. If we ever want to hydrate `{ pointer: "/price/amount", message: "Currency mismatched" }` back onto the right `<input>`, we need a dictionary — and we need it strictly typed against both endpoints so that a rename on either side becomes a compile error.

`loom-forms.md` open items #3 and #4 already flag these. They were left open because resolving them needs a runtime piece, not just a generator change. This proposal supplies the runtime, the IR projection that drives it, and the validator rules that keep it honest.

## Vocabulary — three shapes, one source

For every bound action (a `create` / `operation` / `destroy` from `lifecycle-operations.md`, or a derived `command` payload from `payload-transport-layer.md`), the generator emits three artefacts. They are not three sources of truth — they are three views of the same `ActionIR` projection, generated together, all named after the action.

| Artefact | Shape | Mutability | Origin |
|---|---|---|---|
| **`FormState<A>`** | Flat: one key per primitive leaf of A's params, dot-path-named (`price.amount`, `price.currency`) — but treated as a flat record by RHF, with permissive types matching what HTML inputs actually emit (strings until parsed, undefined while pristine) | 🔄 Mutable; RHF owns it | `z.input<typeof schemaFor(A)>` |
| **`CommandPayload<A>`** | Nested: value objects re-composed, primitives coerced, `option` carriers collapsed, deep `readonly` | 🔒 Frozen | `z.output<typeof schemaFor(A)>` |
| **`FieldMap<A>`** | Strictly-typed dictionary: pointer-on-the-wire → form-state key (and reverse) | 🔒 Const, compile-time-checked | Derived from the same wire projection that emits the Zod transform |

Naming: lowercase action-derived (`updateProductFormState`, `updateProductPayload`, `updateProductFieldMap`). The four exports (schema, FormState, Payload, FieldMap instance) live in **one file per action**: `src/lib/schemas/update-product.schema.ts`. The FieldMap *instance* is per-action and never globalised into a project-wide registry — drift in one action breaks that action's build, in isolation.

Cross-cutting names (no plurals, no `Dto`, no `Model`):
- **State** — never spoken of without an action qualifier (`UpdateProductFormState`, never just "the form state").
- **Payload** — likewise (`UpdateProductPayload`).
- **Command** — synonym for "Payload" at the IR layer where the kind tag matters; the wire object is still the Payload. (`Command` ≅ `Payload` whose `kind = "command"`. See [`payload-transport-layer.md`](./payload-transport-layer.md).)
- **Read Model** — the `query`-kind payload returned by a `find` / `view`; immutable. The form layer's `defaultValues` come from a Read Model flattened through `FieldMap` *in reverse*.

The four cells of the matrix the blueprint draws — State, Payload, Command, Read Model — map cleanly onto the existing `PayloadKind` enum (`src/ir/types/loom-ir.ts:462–475`) plus the new `FormState` shape this proposal adds.

## Topology — the closed loop, in Loom terms

```
            [ Repository.find ]
                    │
                    ▼ (Read Model = response payload, immutable)
        ┌─────────────────────────────┐
        │  ReadModel<View>            │
        └──────────────┬──────────────┘
                       │
                       ▼  (FieldMap reverse:  nested → flat defaults)
            ╔═════════════════════════════════════════════════╗
            ║ FRONTEND ACL (per bound action)                 ║
            ║                                                 ║
            ║   FormState<A>  ◄── useForm({ defaultValues })  ║
            ║       │                                         ║
            ║       │  (keystrokes, RHF-owned)                ║
            ║       ▼                                         ║
            ║   zodResolver(schemaFor(A))                     ║
            ║       │                                         ║
            ║       │  (success → transform → freeze)         ║
            ║       ▼                                         ║
            ║   CommandPayload<A>                             ║
            ║       │                                         ║
            ║       │  (api client method, mutateAsync)       ║
            ║       ▼                                         ║
            ║   <network>                                     ║
            ║       │                                         ║
            ║       ◄── ProblemDetails 422  (errors[].pointer)║
            ║                                                 ║
            ║   applyServerErrors({                           ║
            ║     error, setError,                            ║
            ║     fieldMap: <action>FieldMap                  ║
            ║   })                                            ║
            ║       │                                         ║
            ║       ▼  (pointer → flat key, setError)         ║
            ║   FormState<A>  (errors hydrated)               ║
            ╚═════════════════════════════════════════════════╝
```

Every arrow on this diagram is generator-owned. The page author writes a `CreateForm { of: Order }` and gets the whole loop.

## Design — what gets emitted

### File layout — three locations, three concerns

The React generator emits to three places. Two of them already exist as conventions (`src/lib/schemas/...` and `src/lib/...` are the existing homes for generated Zod schemas and helpers — see `src/generator/react/index.ts`); the third file is new.

```
src/lib/schemas/<action>.schema.ts    — PER ACTION: schema + FormState + Payload + FieldMap instance
src/lib/strict-field-map.ts           — SHARED, TYPES ONLY: StrictFieldMap<P, F>
src/lib/apply-server-errors.ts        — SHARED, RUNTIME: applyServerErrors(error, setError, fieldMap)
```

Each file has one concern. The per-action file owns *its* action's contract; drift breaks that action's build, in isolation. The two shared files are tiny — both Loom-owned, both overwritten on regen.

### Per-action emission

For action `A` (say `Product.update`), `src/lib/schemas/update-product.schema.ts`:

```ts
// Generated from Product.update.
// Do not edit — round-trip via the .ddd source.

import { z } from "zod";
import type { StrictFieldMap } from "../strict-field-map";

// ─── 1. The schema: single source of truth ──────────────────────────────────
export const updateProductSchema = z
  .object({
    "price.amount":    z.number({ invalid_type_error: "A numeric price is required" }).positive(),
    "price.currency":  z.string().length(3, "Currency must be a 3-letter ISO code"),
    "name":            z.string().min(3, "Product name must be at least 3 characters long"),
  })
  .transform((flat) => ({
    name:  flat.name,
    price: { amount: flat["price.amount"], currency: flat["price.currency"] },
  }))
  .readonly();

// ─── 2. Dual type inference ────────────────────────────────────────────────
export type UpdateProductFormState = z.input<typeof updateProductSchema>;
export type UpdateProductPayload   = z.output<typeof updateProductSchema>;

// ─── 3. The FieldMap *instance* for this action, statically pinned to both shapes
export const updateProductFieldMap = {
  "price.amount":   "price.amount",
  "price.currency": "price.currency",
  "name":           "name",
} as const satisfies StrictFieldMap<UpdateProductPayload, UpdateProductFormState>;
```

The four exports stay together because they describe a single contract; renaming a wire field requires editing exactly this file. The `satisfies` clause turns any drift between payload pointers and form-state keys into a TypeScript compile error inside the generated project.

(A flat-key form state means `register("price.amount")` becomes a literal key, not a nested path — this sidesteps RHF's nested-error-object access pattern and the JSON-pointer ↔ dot-path discrepancy in one move. See decision D-FAC-FLAT below.)

### Shared type machinery — `src/lib/strict-field-map.ts`

Pure compile-time types. ~10 lines, no runtime emission, fully tree-shaken out of the bundle. Imported by every `<action>.schema.ts`.

```ts
// Generated — do not edit.

/** Every dot-notation path inside an object type. Internal helper. */
type NestedPaths<T> = T extends Function ? never
  : T extends object ? { [K in keyof T & string]:
        T[K] extends object ? `${K}` | `${K}.${NestedPaths<T[K]>}` : `${K}`
    }[keyof T & string] : never;

/** Strictly typed bidirectional pin between a payload shape and a form-state shape. */
export type StrictFieldMap<TPayload, TFormState> = {
  readonly [K in NestedPaths<TPayload>]?: keyof TFormState & string;
};
```

`NestedPaths<T>` stays unexported — only `StrictFieldMap` is part of the surface. One concept per file, one export.

### Shared runtime helper — `src/lib/apply-server-errors.ts`

Pure logic, no pack-specific bits, no toast — that's the caller's concern. ~25 lines.

```ts
// Generated — do not edit.

import type { UseFormSetError, FieldValues, Path } from "react-hook-form";
import type { StrictFieldMap } from "./strict-field-map";

interface ProblemDetails {
  title?: string;
  errors?: { pointer: string; message: string }[];
}

export interface ApplyServerErrorsArgs<TPayload, TFormState extends FieldValues> {
  readonly error: unknown;
  readonly setError: UseFormSetError<TFormState>;
  readonly fieldMap: StrictFieldMap<TPayload, TFormState>;
}

/** Result of decoding: which path the caller should take on its own (toast / silent / rethrow). */
export type ServerErrorOutcome =
  | { kind: "applied" }                                    // field errors were set; render inline
  | { kind: "global"; title: string }                      // 422 with a title only; caller should toast
  | { kind: "unhandled" };                                 // not a 422 we can decode; caller decides

export function applyServerErrors<TPayload, TFormState extends FieldValues>(
  { error, setError, fieldMap }: ApplyServerErrorsArgs<TPayload, TFormState>
): ServerErrorOutcome {
  const r = (error as { response?: { status?: number; data?: ProblemDetails } }).response;
  if (r?.status !== 422 || !r.data) return { kind: "unhandled" };

  const pd = r.data;
  if (Array.isArray(pd.errors) && pd.errors.length > 0) {
    for (const { pointer, message } of pd.errors) {
      const flatKey = pointerToFlat(pointer);
      const target  = (fieldMap as Record<string, string | undefined>)[flatKey] ?? flatKey;
      setError(target as Path<TFormState>, { type: "server", message });
    }
    return { kind: "applied" };
  }
  return pd.title ? { kind: "global", title: pd.title } : { kind: "unhandled" };
}

const pointerToFlat = (p: string) =>
  p.startsWith("/") ? p.slice(1).split("/").map(decodeURIComponent).join(".") : p;
```

Note the shape: the helper *applies* the field errors but **returns** an outcome rather than calling a `fallbackToast` callback. The caller (the form walker's emitted catch block) decides whether to toast, snackbar, log, or rethrow — using the pack-native primitive emitted inline. This keeps `apply-server-errors.ts` pack-agnostic and gives every call site full control over the global-error path without a callback dance.

### Form-walker rewrite — three new things at the submit boundary

The body walker (`src/generator/react/body-walker.ts`) already wires `useForm` + `zodResolver`. Three additions:

1. **Type the `useForm` call against `<Action>FormState`** (not the schema directly).
   ```ts
   const { register, handleSubmit, setError, formState: { errors } }
     = useForm<UpdateProductFormState>({ resolver: zodResolver(updateProductSchema) });
   ```

2. **Wrap the submit handler in `applyServerErrors`, then emit a pack-native toast inline for the non-field-error paths.**

   Example for the Mantine pack:
   ```ts
   const onSubmit = handleSubmit(async (payload /* : UpdateProductPayload */) => {
     try {
       await updateProductMutation.mutateAsync(payload);
     } catch (e) {
       const outcome = applyServerErrors({ error: e, setError, fieldMap: updateProductFieldMap });
       if (outcome.kind === "global") {
         notifications.show({ message: outcome.title, color: "red" });
       } else if (outcome.kind === "unhandled") {
         notifications.show({ message: "Network failure — please retry.", color: "red" });
       }
       // outcome.kind === "applied" → errors are already on the form fields; nothing else to do.
     }
   });
   ```

   The shadcn version of that same catch block emits `toast.error(outcome.title)` instead; the MUI version emits `enqueueSnackbar(outcome.title, { variant: "error" })`; the Chakra version emits the `useToast()`-bound call. Each pack's emit lives in its design pack (`designs/<pack>/forms/form-error-toast.hbs` or analogous), the same way field rendering already does. There is **no shared `toast.ts` runtime file** — the call is one line, idiomatic to the pack, emitted directly at the catch block.

   The page body never sees `setError`, `applyServerErrors`, or the mutation.

3. **Generate default values from the Read Model** when the form is `OperationForm { for: instance.update }` (i.e. the page has loaded an instance via `find`). The flattening reverses `FieldMap` and walks the Read Model with the same wire projection (`forApiRead`). `defaultValues` becomes a flat record of strings/numbers — the bottom of the loop closes.

### Mutation hook gets `onError` paths

`src/generator/react/api-builder.ts:159–189` currently emits:

```ts
useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries(...) });
```

Becomes:

```ts
useMutation({
  mutationFn,
  onSuccess: () => qc.invalidateQueries(...),
  // onError stays absent here — the form's submit handler owns translation
  // so the page can decide between toast / inline / silent.
});
```

(We keep `onError` off the mutation itself so the form's submit handler stays the one decoder. Two decoders racing each other is exactly the kind of accidental complexity the form-vs-API layering bug from `loom-forms.md` was about.)

## IR — what the projection looks like

No new top-level IR node is needed. The frontend ACL is a *projection* off shapes the IR already grows once `loom-forms.md` + `payload-transport-layer.md` land:

- `FormBindingIR` (from `loom-forms.md`) already pins the bound action and its param list in declared order.
- `PayloadIR` (from `payload-transport-layer.md`) carries `kind: "command" | "query" | …` and the nested field tree.
- `wireShape` (already shipped: `src/ir/enrich/enrichments.ts:114–120`) already carries `WireField` with `source` and `access` roles.

We add **one enrichment** at the end of phase ⑥ (in `src/ir/enrich/enrichments.ts`):

```ts
interface FormStateProjection {
  readonly action:       ActionRef;
  readonly flatFields:   FlatField[];   // ordered, declared-order, dot-path key + leaf type + UX-permissive Zod fragment
  readonly fieldMap:     FieldMap;      // dot-path-on-wire → flat-key (and reverse via fieldMap entry's key === flat key in the all-flat representation)
}

interface FlatField {
  readonly key:        string;          // "price.amount"
  readonly nestedPath: string[];        // ["price", "amount"] — the JSON pointer minus "/"
  readonly leafType:   PrimitiveType;   // 'string' | 'int' | 'decimal' | 'bool' | 'date' | 'datetime' | enumRef
  readonly nullable:   boolean;
  readonly option:     boolean;         // ML-postfix carrier — drives the three-state input
  readonly access:     AccessRole;      // editable | immutable | secret …
  readonly invariants: SingleFieldInvariantIR[];   // already shipped; lowered to .min/.length/etc
}
```

Computed once per bound action, attached to `FormBindingIR.formStateProjection`. Downstream renderers (the body walker, the schema emitter) read it. The flattening rule is a pure walk over `PayloadIR` parameters with `wire-projection.ts:forCreateInput()` / `forUpdateInput()` semantics already in place — it isn't a new policy.

## Read Models, queries, and the reverse direction

For `OperationForm { for: order.update }`, the page has loaded `order: Product` via a generated `useQuery`. That query returns `Product` (nested). The form's `defaultValues` need to be `UpdateProductFormState` (flat). The generator emits a `flattenForUpdate(product)` helper *next to the schema*:

```ts
export function flattenForUpdate(p: UpdateProductReadModel): UpdateProductFormState {
  return {
    name:            p.name,
    "price.amount":  p.price.amount,
    "price.currency":p.price.currency,
  };
}
```

This is the only direction-asymmetric piece. The Zod schema can flatten-to-nested on submit; it can't nested-to-flatten on load. The helper is one-line-per-field and shares the `FieldMap` table for its key list, so a rename of a wire field becomes a compile error at the helper site too.

(The blueprint's Appendix D — "Schema-Payload Duality" — sits naturally here. We don't need a separate "read schema" — the same Zod schema, applied via `.parse(rawJson)` at the API client boundary, already certifies the inbound Read Model. We just add the inverse-flatten helper for the form-init use case.)

## Validator additions

| Code | Rule |
|---|---|
| `loom.acl-fieldmap-drift` | (generator-internal, fires at codegen) — `StrictFieldMap`'s `satisfies` would fail at TSC time. Generator pre-validates and refuses to emit if drift is detected, with a pointer to the wire change that broke it. |
| `loom.acl-pointer-collision` | Two action params flatten to the same dot-path key. Almost impossible (it would require two value objects with the same field name at the same depth), but catchable. |
| `loom.acl-secret-on-read` | A `secret`-access field appears in a Read Model. Reads should never expose secret-access fields (already covered by `forApiRead`); this is the form-side counterpart. |

No new rules at the language layer — every check is structural over the IR projection.

## Three things this proposal explicitly does **not** do

1. **Does not introduce a `state` block in the DSL.** The page-metamodel `state { … }` already exists for reactive locals. Form state lives inside RHF, scoped to the form component, exactly per the blueprint's "State Engine — Buffer" responsibility. No DSL surface change.

2. **Does not introduce XState or a Process Coordinator yet.** The blueprint's §7 (XState for multi-step wizards) is a *future* primitive (`WizardForm`, sketched in `loom-forms.md` open item #7). This proposal sets up the per-step ACL such that wizard composition becomes trivial later: each step is a fully sealed `CommandPayload<Step_i>`; the wizard machine's context is a tuple of those, all immutable. No coupling, no premature surface.

3. **Does not change the wire shape or the backend.** The Zod schema's *transform* output equals today's wire object byte-for-byte. The 422 ProblemDetails shape required is already what `exception-less.md` specifies (and what `.NET`'s `Microsoft.AspNetCore.Mvc.ProblemDetails` already produces). Backends are untouched.

## Decisions and rationale

### D-FAC-FLAT — Form state keys are flat dot-strings, not nested objects

The blueprint's Appendix C example uses RHF's native nested form-state shape (`errors.price?.amount?.message`). We deliberately invert this: `register("price.amount")` becomes a literal-flat key (RHF supports both with the same `Path<T>` machinery, but the *form-state type* we infer treats it as flat).

Reasons:
- The JSON pointer in ProblemDetails (`/price/amount`) maps 1:1 to a dot-path key with a single `split("/")`. With nested RHF state, we'd round-trip through `_.set` semantics and lose type safety.
- Flat keys make `StrictFieldMap` a single-level `Record<string, string>` instead of a recursive type. Tooling speed up, error messages stay legible.
- It matches how today's `form-fields.ts` already calls `register("price.amount")` — we are *codifying* the convention, not changing it.

The cost is unfamiliarity for hand-writing JSX against the generated form state — but the form *is* generated, so this is a generator-internal trade.

### D-FAC-SINGLE-SCHEMA-FILE — Schema + types + FieldMap instance colocate, one file per action

The four exports that describe a single action's contract (schema, FormState, Payload, FieldMap instance) live in one file. A rename of the action's params requires editing exactly one file in the generated tree (and one operation declaration in the `.ddd`). FieldMap instances are deliberately **not** lifted into a project-wide registry: drift in one action breaks that action's build, not the whole project.

### D-FAC-SPLIT-SHARED — Type machinery and runtime helper live in separate files

`StrictFieldMap<P, F>` is a compile-time type erased from the bundle; `applyServerErrors` is a runtime function. They share zero implementation — only a type-parameter reference. Putting them in the same file because they share that reference would bury two distinct concerns (a recursive type definition; a 422-decoding state machine) under one filename that names neither. They sit in `src/lib/strict-field-map.ts` and `src/lib/apply-server-errors.ts` respectively, in the existing `src/lib/` neighbourhood where the React generator already emits `schemas.ts` and `format.tsx`.

### D-FAC-NO-TOAST-RUNTIME — No shared toast indirection

The form-error toast is one pack-native line (`notifications.show(...)` / `toast.error(...)` / `enqueueSnackbar(...)` / `useToast()(...)`). The body walker already dispatches per pack for every other rendering decision; it emits the toast call inline at the catch block, sourced from a pack template (`designs/<pack>/forms/form-error-toast.hbs`). A shared `toast.ts` re-export would be a wrapper around a one-liner — pure indirection.

### D-FAC-NO-NEW-DSL — Zero `.ddd`-level surface changes

Adopting the blueprint without language surface is a deliberate constraint. The IR enrichment is computed from `FormBindingIR` (which has `lifecycle-operations.md` as a prerequisite) plus `wireShape` (shipped). No DSL keyword for "state" / "payload" / "read model" at the page layer — those are emitted vocabulary, not authored vocabulary.

Page authors keep writing:

```
page EditOrderPage(order: Order) {
  OperationForm { for: order.update }
}
```

…and get the full ACL loop. If the DSL ever needs to express *page-level Read Model projection* (a UI-only flattening that the wire doesn't have — e.g. `displayPrice: string` derived from `price.amount` + `price.currency`), that's a separate proposal (`projection` keyword on `page`, analogous to `view` on `aggregate`).

### D-FAC-TIER-OWNERSHIP — Tier 1 errors and Tier 2 errors share one error bag

Per the blueprint's B.4 rule #2: don't store server-validation state in a parallel `useState`. The ACL writes server errors into RHF's `formState.errors` via `setError({ type: "server", message })` so the rendering layer is one path. Templates already show `errors.price?.amount?.message` (or, under D-FAC-FLAT, `errors["price.amount"]?.message`) — that single render path works for both tiers.

The `type: "server"` discriminator lets a pack (or a future code-review tool) style server-side errors differently if desired, but the default is one rendering.

### D-FAC-MUTATION-NO-ONERROR — Translation happens in the form, not the hook

`useMutation`'s `onError` is tempting (it would centralize translation in one place) but it forces *every* call site of the hook to share the same translation policy. A form binding wants `setError` + toast-fallback; a background sync job wants logging + retry; a quick-action button wants a snackbar. Putting the translator inside the form's submit handler lets each call site decide. The runtime helper (`applyServerErrors`) is shared; the *policy* (which pack-native toast / snackbar / silent path to take on the `global` and `unhandled` outcomes) is not — it's emitted inline at each call site by the design pack.

## Open items

1. **Async refines.** Zod `.refine(async …)` for "does this slug already exist on the server?" is a known pattern. It overlaps with Tier 2 (the answer is server-driven), but the user-facing semantics are different (debounced precheck on blur, not at submit). Out of scope for v1; a separate proposal can spec `find ... { unique }`-derived async refines.

2. **Optimistic updates / cache-snap-then-rollback.** TanStack's `onMutate` / `onError(ctx → rollback)` story. Today the generator does invalidate-and-refetch; optimistic UI is a future enhancement and orthogonal to error mapping.

3. **`option`-field round-trip.** A `string option` lowering in `FormState` needs the "leave unchanged" toggle (per `loom-forms.md` open item #3). Concretely: the flat key is `firstName`, but its `FormState` type is `{ firstName: string; firstName$unchanged: boolean }` and the transform omits the field when `$unchanged === true`. Sketch lives in the partial-update proposal; the ACL projection should consume it directly.

4. **Read Models with computed fields.** `displayName = firstName + " " + lastName` belongs in the Read Model but doesn't round-trip on submit. The flattener emits read-only fields with a sentinel in the projection (`access: "derived"`) and the form walker either omits them or renders them as `<output>` elements. Decide on render before shipping.

5. **Wizard machine integration.** A future `WizardForm { steps: [ A, B, C ] }` primitive composes per-step `CommandPayload<Step_i>`s into an immutable XState context. This proposal sets up the per-step contract; the wizard is a sister proposal once `loom-forms.md` Phase F3 lands.

6. **Phoenix LiveView counterpart.** Ecto changesets already do State/Payload split via the changeset's "params vs attrs" duality and `Ecto.Changeset` already carries per-field error pointers. A sibling proposal can lift the *vocabulary* (Read Model / Payload / State) into the Phoenix generator; the *mechanism* will be Ecto-shaped, not Zod-shaped. Out of scope here. (`platform: elixir` is plain Ecto/Phoenix only — the Ash foundation was removed.)

7. **Tests.** Per-pack walker fixtures for: (a) plain field, (b) nested VO, (c) `option` field, (d) 422 round-trip with `setError`, (e) FieldMap drift surfacing as TSC error. Pattern matches the existing `test/walker/walker-*.test.ts` shape — ~5 new tests.

## Phased delivery

### Phase 1 — Schema + dual-type emission (~2 days)

- Emit the per-action `src/lib/schemas/<action>.schema.ts` file with the schema, `z.input` / `z.output` types, and the FieldMap instance.
- Lock the `satisfies StrictFieldMap` clause so any drift surfaces as a TSC error in the generated project.
- Emit `src/lib/strict-field-map.ts` (type-only, ~10 lines).
- Emit `src/lib/apply-server-errors.ts` (runtime helper, ~25 lines).

Depends on: `loom-forms.md` Phase F1 (FormBindingIR), `payload-transport-layer.md` Phase 1 (PayloadIR scaffolding). Can land alongside the existing schema emission as a parallel-emit, opt-in path until `loom-forms.md` ships.

### Phase 2 — Form walker rewiring + mutation translation (~2 days)

- Type `useForm` against `<Action>FormState`.
- Wrap `handleSubmit`'s submit handler with `try { … } catch { applyServerErrors(…) }` plus a per-pack inline toast emit for the `global` / `unhandled` outcomes (`designs/<pack>/forms/form-error-toast.hbs`).
- Emit per-action `flattenFor<Action>(readModel)` helper next to the schema.
- Wire `defaultValues` from the Read Model through the flattener.

Depends on: Phase 1, `loom-forms.md` Phase F2 (api-client integration).

### Phase 3 — Pack-specific polish + tests (~2 days)

- Server-side error styling: `type: "server"` errors render with the same template as Zod errors by default; per-pack opt-in to a distinct treatment via `field-error.hbs`.
- `option`-field flattening (consume `partial-update.md`).
- Walker tests + per-pack fixtures.

Total: ~5 days serialised; ~3 days with parallelism. Carries the same dependency cone as `loom-forms.md` Phase F3.

## Relationship to companion proposals

- [`loom-forms.md`](./loom-forms.md) — **required dependency**. This proposal turns its open items #3 and #4 into shipped behaviour. The form-walker changes in §"Form-walker rewrite" land *inside* `loom-forms.md`'s Phase F2 step "form layer dispatches through the generated API client" — they are the *implementation* of `loom-forms.md`'s "On error" paragraph.
- [`payload-transport-layer.md`](./payload-transport-layer.md) — **required dependency**. `CommandPayload<A>` is a typed view of an action's `PayloadIR` with `kind: "command"`. `ReadModel<V>` is a typed view of a `view`'s `PayloadIR` with `kind: "query"`.
- [`exception-less.md`](./exception-less.md) — **wire-shape dependency**. The 422 ProblemDetails body shape this proposal decodes is precisely what its API-edge translator emits. The `errors[].pointer` field is the contract.
- [`partial-update.md`](./partial-update.md) — `option` carriers feed directly into the `option: boolean` flag on `FlatField`. Round-trip semantics share the wire encoding spec'd there.
- [`criterion.md`](./criterion.md) — when criteria gate operations (`when <Criterion>`), the auto-exposed `can-<op>` endpoint can drive form-button enable/disable state. That wiring is downstream of this proposal and lives with criterion's open items.
- `docs/page-metamodel.md` — update once Phase 2 lands: the "Form state" section gains the State / Payload / Read Model vocabulary, and the rendering examples switch to flat-key `register` calls.

---

*Conversation thread that produced this proposal: a reader-supplied architectural blueprint ("Unified Data Flow for Domain-Driven Frontends") proposed an explicit State / Payload / Command / Read Model vocabulary with Zod `z.input` ↔ `z.output` duality, a strictly-typed `FieldMap` for bidirectional pointer↔field translation, and an Anti-Corruption Layer that decodes RFC 7807 ProblemDetails into RHF `setError` calls. Loom already has the wire-shape spine, the Zod emission, RHF wiring, and the ProblemDetails contract (via `exception-less.md`). The missing pieces are the dual-type emission, the per-action FieldMap projection, and the shared decoder — collected here as a single, terminating proposal that finishes the frontend story `loom-forms.md` started. Three rounds of review trimmed earlier drafts: a per-pack toast shim and a fabricated `_runtime/` directory convention were both removed; the shared code was split into a compile-time types file and a runtime helper file in the existing `src/lib/` neighbourhood; per-action FieldMaps stay colocated with their schemas and are never globalised.*
