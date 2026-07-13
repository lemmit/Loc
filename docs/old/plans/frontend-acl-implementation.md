# Frontend ACL — implementation plan

> Tracks: [`../proposals/frontend-acl.md`](../proposals/frontend-acl.md) — SEALED.
> Branch: `claude/magical-johnson-7XnzR`.
>
> **Phase 1.1+1.2 shipped** (commit `f341d4b`): `src/lib/strict-field-map.ts` + `src/lib/apply-server-errors.ts` emitted into every React deployable, behaviourally inert. Baseline fixture refreshed. Dedicated emission + content tests added.
>
> **Phase 2 shipped** (commit `aa86ced`): ACL loop wired into every generated form's catch block across all 8 pack/version combinations (mantine v7+v9, shadcn v3+v4, mui v5+v7, chakra v2+v3) — for both create/workflow forms (`form-default-onsubmit.hbs`) and operation-modal forms (`form-op-module.hbs`). `setError` plumbed through the `useForm()` destructure where the pack uses that pattern (mantine/mui/chakra); shadcn uses `form.setError` directly. Pack `pack.json` imports updated. Walker's op-form computed destructure unconditionally includes `setError`. 5 baseline-fixture pages refreshed. 4 new wiring-assertion tests added.
>
> **Phase 2 hardening shipped** (commit `ab73700`): 7 behavioural tests for the emitted `applyServerErrors` runtime — transpiles the emitted TS in-test via `ts.transpileModule` (no extra dep), executes the live function against synthetic ProblemDetails / network-error inputs, and asserts the actual semantics (pointer→flat translation, per-pointer `setError` dispatch, outcome branching, URI-encoded segment handling, identity-fallback when fieldMap is empty). The runtime is now fully covered at the unit level.
>
> **Status:** Phase 1 + Phase 2 + Phase 2 hardening complete. Full fast suite 3002 / 3022 tests passing (20 skipped); Biome clean. The end-to-end ACL loop is live in every generated React project. Any backend that returns RFC 7807 ProblemDetails 422 with `errors[].pointer` will surface those errors inline on the corresponding form fields without page-author plumbing.
>
> **Codebase reality discovered during 1.1/1.2 work that revised the rest of the plan:** schemas are NOT in a central `src/lib/schemas.ts` — they're emitted inline inside each `src/api/<agg>.ts` by `buildApiModule` (`src/generator/react/api-builder.ts:40`). The central `src/lib/schemas.ts` exists only conditionally for the shared `moneySchema` helper. This collapsed the original Steps 1.3+1.4 into Phase 3 below.

## What's NOT done (deferred — see "Why deferred" below)

### Phase 3 — Schema restructure: flat-key inputs + transform + dual types

> **RESOLVED 2026-06-12 (maintainer decision: "keep nested, transform only").**
> The flat-dot-key half of this spec is unimplementable as written:
> react-hook-form **always interprets dots in field names as nesting**, so
> `register("price.amount")` produces nested runtime values that a
> flat-keyed schema (`{ "price.amount": z.number() }`) would reject at
> validation.  Instead of flat keys, the shipped slice keeps today's
> nested (RHF-native) form state and emits the dual
> `<Action>FormState = z.input` / `<Action>Payload = z.output` aliases
> **only for actions whose request schema carries a real transform** —
> today exactly the `money` primitive (`moneySchema`: decimal string →
> Decimal), reached directly or through array/optional/value-object
> nesting.  Transform-less actions keep the single `<Action>Request`
> type (structurally identical aliases are the noise this plan's own
> deferral note warned about).  Per-action FieldMaps stay deferred with
> the flat-key restructure; `pointerToFlat` + RHF's nested `setError`
> paths already route server errors without them.  Gated by
> `test/generator/react/dual-form-types.test.ts`.

**Goal:** make `<Action>FormState` (`z.input`) and `<Action>Payload` (`z.output`) diverge meaningfully. Today they're identical because there's no `.transform()` in the schema chain. The proposal's vocabulary distinction only becomes real after this.

**Concretely:** restructure each `Create<Agg>Request` / `<Op>Request` in `src/api/<agg>.ts` so that:
- Value-object fields flatten to dot-keys at the input side (`{ "price.amount": z.number(), "price.currency": z.string() }` instead of `{ price: MoneySchema }`)
- A `.transform(flat → nested)` step reconstitutes the nested shape on the output
- `.readonly()` seals the output type
- Three exports per action: `<action>Schema` (unchanged identifier, new shape), `<Action>FormState = z.input<typeof ...>`, `<Action>Payload = z.output<typeof ...>`
- Per-action FieldMap constant emitted alongside, with `satisfies StrictFieldMap<Payload, FormState>` providing real type-level constraint
- Form walker switches to `useForm<FormState>`, error access changes from `errors.price?.amount?.message` (nested) to `errors["price.amount"]?.message` (flat)

**Why deferred from this branch:**
- The user explicitly pushed back on emitting things with no current value (toast shim, empty FieldMap exports, fabricated `_runtime/` directory). Emitting `<Action>FormState` and `<Action>Payload` as separate type aliases that are STRUCTURALLY IDENTICAL — because the schema has no transform — falls in the same category. Empty exports for "future use" generate noise.
- The schema restructure is a meaningful architectural change. It changes the form-state TYPE that consumers see, the error access pattern in JSX, and the form walker's typing. Doing it half-way (emit new types alongside, retire old) doubles the surface during transition.
- It's also not blocking the ACL loop. The current setup works because (a) RHF's `setError` accepts dot-paths into nested state, (b) `pointerToFlat("/price/amount") → "price.amount"`, and (c) RHF's `Path<T>` machinery handles both flat and nested registration uniformly.

**When to do it:** when there's a concrete user-visible requirement that flat ≠ nested — e.g., a form field whose label / order / grouping differs from the wire shape, or when `loom-forms.md` lands and forms bind to action params (which may explicitly flatten in ways the wire shape doesn't).

### Phase 4 — `option` field rendering (the "leave unchanged" toggle)

Gated on [`partial-update.md`](../proposals/partial-update.md) defining the wire encoding for `T option`. Out of scope until that lands.

## What's done — summary table

| Phase | Status | Commit | Files | Tests |
|---|---|---|---|---|
| 1.1 — `strict-field-map.ts` emit | Shipped | `f341d4b` | 2 (src + fixture) | 2 (emission, content) |
| 1.2 — `apply-server-errors.ts` emit | Shipped | `f341d4b` | 2 (src + fixture) | 3 (emission, content, pack-agnostic) |
| 2 — Catch-block wiring across all 8 packs | Shipped | `aa86ced` | 43 (16 templates + 8 pack.json + 12 decls + 1 walker + 5 fixtures + 1 test) | 4 (form-of, form-op×2 forms, form-runs, toast preservation) |
| 2 hardening — runtime behavioural tests | Shipped | `ab73700` | 1 (test only) | 7 (applied, fieldMap routing, global, unhandled×2, URI decode, identity fallback) |

**Total: 49 files changed across 4 commits, 16 dedicated ACL tests, full fast suite green (3002 / 3022).**

## Validation gates passed

- `npm test` — 3002 / 3022 passed (0 failed)
- `npx vitest run test/generator/react/` + `page-emitter-equivalence` — 311 / 311 passed
- `npx biome ci --diagnostic-level=error .` — clean
- `npm run build` — clean (composite tsc)

Pending in CI (long-running):
- `LOOM_REACT_BUILD=1 npm run test:tsc-react` — generated React projects × all packs tsc-clean
- `LOOM_BIOME=1 npm run test:biome-gen` — Biome lint against emitted TSX (catches output drift)
- `LOOM_TS_BUILD=1 npm run test:tsc` — TS backend tsc-clean (catches wire-shape regressions)
- `LOOM_E2E=1 npm run test:e2e` — full stack 422 round-trip via Playwright

## Context

The proposal converged on a small surface: per-action `schema + FormState + Payload + FieldMap instance` colocated in `src/lib/schemas/<action>.schema.ts`, two shared utility files in `src/lib/` (`strict-field-map.ts` for the type, `apply-server-errors.ts` for the runtime decoder), and a per-pack inline toast emit at the form's catch block.

Implementation is smaller than the proposal's prose suggests because two seams already exist:

1. **Per-pack toast emission in `form-default-onsubmit.hbs`** — each pack template (`designs/<pack>/<v>/form-default-onsubmit.hbs`) already wraps the mutation in `try { … } catch { notifications.show(...) }` (or pack equivalent). The work is amending those templates to call `applyServerErrors` inside the catch *before* the existing toast.
2. **`src/lib/schemas.ts` emission** — `src/generator/react/api-builder.ts:52` already writes all aggregate/operation schemas to a single `src/lib/schemas.ts`. The work is splitting it into per-action files under `src/lib/schemas/` and adding the four exports per file.

Backend, IR, validators, and Phoenix generator are untouched.

## Dependency cone

| Proposal | Required by | Status today |
|---|---|---|
| [`loom-forms.md`](../proposals/loom-forms.md) Phase F1 (`FormBindingIR`) | Phase 2 below — the per-action FieldMap projection keys off the bound action's param list | PROPOSED |
| [`payload-transport-layer.md`](../proposals/payload-transport-layer.md) Phase 1 (`PayloadIR` + `command` kind) | Phase 2 — `CommandPayload<A>` is a typed view of an action's `PayloadIR` | PROPOSED |
| [`exception-less.md`](../proposals/exception-less.md) (RFC 7807 422 wire shape) | Phase 1 runtime decoder consumes `{ errors: [{ pointer, message }] }` | PROPOSED |
| [`partial-update.md`](../proposals/partial-update.md) (`option` carrier round-trip) | Phase 3 only (`option` form field rendering) | PROPOSED |

**None of these need to fully ship for Phase 1 of this plan.** Phase 1 emits the shared utility files and per-aggregate `<action>.schema.ts` files derived from today's `wireShape` projection, behind a generator flag. Phase 2 is gated on `loom-forms.md` Phase F1 landing.

## Architecture (locked from the proposal)

```
src/lib/schemas/<action>.schema.ts        — PER ACTION (4 exports + flatten helper)
src/lib/strict-field-map.ts               — SHARED, type-only (~12 lines)
src/lib/apply-server-errors.ts            — SHARED, runtime (~30 lines)
designs/<pack>/<v>/form-default-onsubmit.hbs  — AMENDED (insert applyServerErrors call before toast)
```

Per-action file exports: `<action>Schema`, `<Action>FormState`, `<Action>Payload`, `<action>FieldMap`, `flattenFor<Action>(readModel)`. FieldMap is per-action — never globalised.

`applyServerErrors` returns `ServerErrorOutcome` (`applied | global | unhandled`). The pack template switches on it inline; no callback.

---

## Step 0 — Update branch to latest main

```bash
git fetch origin main
git rebase origin/main
npm install          # re-runs prepare lifecycle (langium:generate + build)
npm test             # green-line baseline
```

Current branch: `claude/magical-johnson-7XnzR`. Two commits ahead (the proposal commits). Should rebase cleanly — the proposal touches only `docs/`.

---

## Phase 1 — Shared utility files + per-action schema split (~2 days)

**Goal:** emit the two shared files into every generated React project, and split today's monolithic `src/lib/schemas.ts` into per-action files with the four-export shape. Behaviourally inert — the new files are written, but the form walker doesn't yet call them.

### Step 1.1 — Emit `src/lib/strict-field-map.ts`

**File:** `src/generator/react/api-builder.ts` (or a new sibling `strict-field-map-emitter.ts` if `api-builder.ts` gets too large)

Add a function `emitStrictFieldMapModule(): string` returning the 12-line type-only module:

```ts
// src/lib/strict-field-map.ts
// Generated — do not edit.

type NestedPaths<T> = T extends object
  ? { [K in keyof T & string]:
        T[K] extends object ? `${K}.${NestedPaths<T[K]>}` : `${K}`
    }[keyof T & string]
  : never;

export type StrictFieldMap<TPayload, TFormState> = {
  readonly [K in NestedPaths<TPayload>]?: keyof TFormState & string;
};
```

Wire into `generateReactForContexts` in `src/generator/react/index.ts`:

```ts
out.set("src/lib/strict-field-map.ts", emitStrictFieldMapModule());
```

Pure constant emit — no IR input needed. Test: snapshot test verifying byte-identical output across runs.

### Step 1.2 — Emit `src/lib/apply-server-errors.ts`

Same pattern. Add `emitApplyServerErrorsModule(): string` returning:

```ts
// src/lib/apply-server-errors.ts
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

export type ServerErrorOutcome =
  | { kind: "applied" }
  | { kind: "global"; title: string }
  | { kind: "unhandled" };

export function applyServerErrors<TPayload, TFormState extends FieldValues>(
  { error, setError, fieldMap }: ApplyServerErrorsArgs<TPayload, TFormState>,
): ServerErrorOutcome {
  const r = (error as { response?: { status?: number; data?: ProblemDetails } }).response;
  if (r?.status !== 422 || !r.data) return { kind: "unhandled" };

  const pd = r.data;
  if (Array.isArray(pd.errors) && pd.errors.length > 0) {
    for (const { pointer, message } of pd.errors) {
      const flatKey = pointerToFlat(pointer);
      const target = (fieldMap as Record<string, string | undefined>)[flatKey] ?? flatKey;
      setError(target as Path<TFormState>, { type: "server", message });
    }
    return { kind: "applied" };
  }
  return pd.title ? { kind: "global", title: pd.title } : { kind: "unhandled" };
}

const pointerToFlat = (p: string) =>
  p.startsWith("/") ? p.slice(1).split("/").map(decodeURIComponent).join(".") : p;
```

Wire into `index.ts`. Snapshot test.

### Step 1.3 — Split `src/lib/schemas.ts` into per-action files

**Current state:** `src/generator/react/api-builder.ts:40–221` emits one consolidated `src/lib/schemas.ts` containing all aggregate / operation schemas.

**Target state:** one file per action under `src/lib/schemas/`:

```
src/lib/schemas/create-product.schema.ts
src/lib/schemas/update-product.schema.ts
src/lib/schemas/cancel-order.schema.ts
…
```

**Action inventory for Phase 1** (before `loom-forms.md` lands): we don't yet have first-class action IR. The right interim move is to derive per-action shape from what `api-builder.ts` already projects via `wire-projection.ts`:

- `forCreateInput(agg)` → `create-<agg>.schema.ts`
- `forUpdateInput(agg)` → `update-<agg>.schema.ts`
- per existing `operation` → `<op>-<agg>.schema.ts`

This keeps Phase 1 unblocked by the proposal cone. When `loom-forms.md` lands, the projection input swaps from `forCreateInput(agg)` to `actionParams(action)` — same output shape, different source.

**Per-file content** (Phase 1 — no FieldMap instance yet; that lands in Step 1.4):

```ts
// src/lib/schemas/update-product.schema.ts
// Generated from Product update wire shape.
// Do not edit — round-trip via the .ddd source.

import { z } from "zod";

export const updateProductSchema = z.object({
  "price.amount":   z.number({ invalid_type_error: "..." }).positive(),
  "price.currency": z.string().length(3, "..."),
  "name":           z.string().min(3, "..."),
})
.transform((flat) => ({
  name: flat.name,
  price: { amount: flat["price.amount"], currency: flat["price.currency"] },
}))
.readonly();

export type UpdateProductFormState = z.input<typeof updateProductSchema>;
export type UpdateProductPayload   = z.output<typeof updateProductSchema>;
```

**Key change in `api-builder.ts`:**

- Refactor the per-aggregate schema emit (currently a single `lines(...)` call into one consolidated file) into a per-action `lines(...)` call returning `[path, content]` pairs.
- The schema builder logic stays mostly intact — `renderObjectSchema(fields)`, `renderTransform(fields)`, `renderReadonly()` — but each call site now writes its own file.
- The flat dot-key shape (`"price.amount"` instead of nested `price.amount`) is **new**. Today the schema is nested. The transform step (flat→nested) is also new.

This is the largest single change in Phase 1. Estimate: ~6 hours including tests.

**Migration of consumers of `src/lib/schemas.ts`:** today, the form walker (`src/generator/react/walker/primitives/forms.ts`) and the API client (`src/generator/react/api-builder.ts`) both import from this consolidated file. Phase 1 keeps `src/lib/schemas.ts` as a barrel re-export:

```ts
// src/lib/schemas.ts (barrel — generated)
export * from "./schemas/create-product.schema";
export * from "./schemas/update-product.schema";
// …
```

Zero call-site changes needed. Behaviourally inert.

### Step 1.4 — Emit per-action `FieldMap` instance + `flattenFor<Action>` helper

Append to each `<action>.schema.ts` file:

```ts
import type { StrictFieldMap } from "../strict-field-map";

export const updateProductFieldMap = {
  "price.amount":   "price.amount",
  "price.currency": "price.currency",
  "name":           "name",
} as const satisfies StrictFieldMap<UpdateProductPayload, UpdateProductFormState>;

export function flattenForUpdateProduct(p: UpdateProductReadModel): UpdateProductFormState {
  return {
    "price.amount":   p.price.amount,
    "price.currency": p.price.currency,
    "name":           p.name,
  };
}
```

**Where does `UpdateProductReadModel` come from?** For Phase 1, we type the flattener parameter against the nested wire-read shape that `api-builder.ts` already emits (the `<Agg>Response` Zod schema's output). The import is a regular type import from elsewhere in `src/lib/schemas/`.

**Generator code:** in `api-builder.ts`, alongside the schema emit, add a `renderFieldMap(flatFields)` and a `renderFlattener(flatFields)` helper. Both walk the same `WireField[]` list — no new IR needed for Phase 1.

### Step 1.5 — Tests for Phase 1

| Test | Location | What it verifies |
|---|---|---|
| `react-strict-field-map-emit.test.ts` | `test/generator/react/` | `emitStrictFieldMapModule()` returns byte-identical output |
| `react-apply-server-errors-emit.test.ts` | `test/generator/react/` | Same for `applyServerErrors` |
| `react-per-action-schema-emit.test.ts` | `test/generator/react/` | Given a simple aggregate `Product { name, price: Money }`, generates 4 expected files under `src/lib/schemas/` with the right exports |
| `react-fieldmap-satisfies.test.ts` | `test/generator/react/` | Inject a deliberate FieldMap drift (rename one key) and assert generated project's `tsc --noEmit` fails. Real TSC gate via tmpdir. |
| Existing `LOOM_REACT_BUILD=1` | CI matrix | Every example × pack still tsc-clean after the split |

Phase 1 ships when all five gates are green.

### Phase 1 risks

| Risk | Mitigation |
|---|---|
| Flat-key schema shape breaks today's form walker which still expects nested schemas | Phase 1 emits the flat shape but the barrel re-export keeps the *consolidated* `src/lib/schemas.ts` exporting the legacy nested schemas under the same names. Form walker still imports the nested schema name; the new flat schemas live alongside, unused. Phase 2 is when we switch the form walker to import the new flat schema. |
| Per-action file explosion in `src/lib/schemas/` for big domains | Cosmetic. ~50 files for a non-trivial app. Manageable. |
| Two schemas per action (nested legacy + flat new) during Phase 1 → Phase 2 transition | Yes — explicit migration cost. Total bundle bloat is small (Zod compiles tightly); we delete the nested ones at the end of Phase 2. |

---

## Phase 2 — Form walker rewire (~2 days)

**Goal:** the body walker's emitted form components consume the new flat schemas, type `useForm<FormState>`, and run `applyServerErrors` in the catch block.

**Gated on:** `loom-forms.md` Phase F1 (`FormBindingIR`). Without it, we can't cleanly distinguish per-action forms from the today's `Form(of: X)` field-walking fallback.

### Step 2.1 — Amend pack templates: `form-default-onsubmit.hbs`

Five pack/version pairs (per the inventory in Step 0's grep): `designs/mantine/v7`, `mantine/v9`, `shadcn/v3`, `shadcn/v4`, `mui/v5`, `mui/v7`, `chakra/v2`, `chakra/v3`.

Current shape (mantine/v7):

```hbs
{
              try {
                {{{mutationCall}}}
                notifications.show({ color: "green", message: "{{successMessage}}" });
                {{{redirectStmt}}};
              } catch (e) {
                notifications.show({ color: "red", message: (e as Error).message });
              }
            }
```

New shape:

```hbs
{
              try {
                {{{mutationCall}}}
                notifications.show({ color: "green", message: "{{successMessage}}" });
                {{{redirectStmt}}};
              } catch (e) {
                const outcome = applyServerErrors({ error: e, setError, fieldMap: {{fieldMapName}} });
                if (outcome.kind === "global") {
                  notifications.show({ color: "red", message: outcome.title });
                } else if (outcome.kind === "unhandled") {
                  notifications.show({ color: "red", message: (e as Error).message });
                }
              }
            }
```

shadcn/v4 version uses `toast.error(...)` calls; MUI uses `enqueueSnackbar(...)`; Chakra uses the bound `useToast()` callback. One template per pack, six templates total to amend.

`{{fieldMapName}}` is a new template variable supplied by the walker — the per-action constant name (`updateProductFieldMap`).

### Step 2.2 — Walker passes `fieldMapName` and `setError` into the template

**File:** `src/generator/react/walker/primitives/forms.ts:252` (`renderFormOfPrimitive`)

Two changes:

1. Add `fieldMapName: string` to the `FormSubmitConfig` interface and thread it through `cfg`.
2. Ensure the form shell (`primitive-form-of`) emits `setError` in the destructured `useForm()` return.

The shell template is in `designs/<pack>/<v>/primitive-form-of.hbs` — verify `setError` is exposed:

```bash
grep -l "setError" designs/*/*/primitive-form-of.hbs
```

If absent in any pack, add to the destructure in that pack's shell template.

### Step 2.3 — Walker imports `applyServerErrors`

Pack-level import registration: each pack declares the import once via the existing `addImportsForPrimitive(ctx, "form-default-onsubmit")` path in `forms.ts:267`. Update each pack's `imports["form-default-onsubmit"]` entry to add:

```ts
{ from: "../lib/apply-server-errors", names: ["applyServerErrors"] }
```

(Path resolved per the pack's shell location.)

### Step 2.4 — Switch the form walker to per-action schemas

In `forms.ts`, where it currently looks up the schema name from the consolidated `src/lib/schemas.ts`, point it at the per-action file path:

```ts
// Before
import { createProductSchema } from "../lib/schemas";
// After
import { createProductSchema, createProductFieldMap, type CreateProductFormState }
  from "../lib/schemas/create-product.schema";
```

The walker computes the file path from the action name. The `defaultValues` typing flips from inferred to explicit:

```ts
const { register, handleSubmit, setError, formState: { errors, isSubmitting } }
  = useForm<CreateProductFormState>({ resolver: zodResolver(createProductSchema) });
```

For `OperationForm { for: order.update }` (loaded from a `useQuery`), the `defaultValues` is `flattenForUpdateOrder(orderQuery.data)`.

### Step 2.5 — Update `form-fields.ts` register paths

**File:** `src/generator/react/templating/preparers/form-fields.ts:102–124`

Currently emits `register("price.amount")` with the *path* interpreted nested. After Phase 2, the schema is flat — `register("price.amount")` now means the literal key. RHF's `Path<T>` machinery handles both, but the `errors` access pattern changes:

```ts
// Before (nested errors)
{errors.price?.amount?.message && <span>{errors.price.amount.message}</span>}
// After (flat errors)
{errors["price.amount"]?.message && <span>{errors["price.amount"].message}</span>}
```

Update `field-input-valueobject.hbs` and `form-fields.ts:133–138` to emit the flat-key access.

### Step 2.6 — Tests for Phase 2

| Test | Location | What it verifies |
|---|---|---|
| `walker-create-form-acl.test.ts` | `test/walker/` | `CreateForm` emits `applyServerErrors` in the catch, with the right FieldMap name |
| `walker-operation-form-acl.test.ts` | `test/walker/` | `OperationForm` emits the flattener call in `defaultValues` |
| `walker-form-422-roundtrip.test.ts` | `test/walker/` | Render a form, fire a fake mutation that throws a ProblemDetails 422, assert `setError` was called with the right field key. JSdom + react-testing-library. |
| `walker-form-network-error.test.ts` | Same | Throw a non-422 network error, assert the pack's toast was called (`notifications.show` spy) |
| Existing per-pack walker snapshots | `test/walker/walker-*.test.ts` | Update byte-identical expectations to include the new catch shape |
| Existing `LOOM_REACT_BUILD=1` matrix | CI | tsc-clean across examples × packs after walker rewire |

### Phase 2 risks

| Risk | Mitigation |
|---|---|
| ~30 `walker-*.test.ts` snapshot tests all need regen | Run `npm test -- --update` once; manually diff each snapshot for the expected catch-block change before committing |
| Flat-key `errors` access pattern changes the rendered JSX | Same snapshot regen path; visual smoke via `playground-e2e.yml` after merge |
| `loom-forms.md` Phase F1 not landed → can't distinguish action-bound forms from legacy `Form(of: X)` | Keep both paths during transition: action-bound forms get the new emit; legacy `Form(of: X)` keeps the old emit. Cut the legacy path in a follow-up after `loom-forms.md` ships. |
| `setError` not yet destructured in some pack's shell | Step 2.2 audit catches this before walker rewire |

---

## Phase 3 — `option` field rendering + tests (~1.5 days)

**Goal:** close `loom-forms.md` open item #3 (the "leave unchanged" toggle for `T option` fields).

**Gated on:** `partial-update.md` having defined wire encoding for `option`.

### Step 3.1 — Extend the per-action schema with `option` shape

For a command field `firstName: string option`, the schema emits:

```ts
"firstName": z.string().min(3).optional(),
"firstName$unchanged": z.boolean().default(true),
```

The transform omits the field when `$unchanged === true`:

```ts
.transform((flat) => ({
  ...(flat["firstName$unchanged"] ? {} : { firstName: flat.firstName }),
  // …
}))
```

Wire encoding for `option`: field omission ≡ `none`, per [`partial-update.md`](../proposals/partial-update.md).

### Step 3.2 — Pack template `field-option.hbs`

New per-pack template — toggle + input. Mantine version:

```hbs
<Switch label="Leave unchanged" {...register("{{name}}$unchanged")} />
<TextInput {...register("{{name}}")} disabled={watch("{{name}}$unchanged")} />
```

Per-pack variants. Walker dispatches to this template when the field is `option`-typed.

### Step 3.3 — Tests

| Test | Location | What it verifies |
|---|---|---|
| `walker-option-field.test.ts` | `test/walker/` | `option` field renders the toggle + input pair |
| `walker-option-roundtrip.test.ts` | Same | Toggling "leave unchanged" omits the field from the submitted payload |
| Per-pack fixture | `test/walker/walker-*.test.ts` | Visual snapshot of the option-field render in each pack |

### Phase 3 risks

| Risk | Mitigation |
|---|---|
| `$unchanged` suffix collision with a domain field named `unchanged` | Pick a less-likely prefix (e.g., `__loomOption__firstName`). Decide before Step 3.1. |
| Toggle UX inconsistent across packs | Document the default semantics in `docs/page-metamodel.md` once Phase 3 lands; packs MAY override per their idiom. |

---

## Delivery summary

| Phase | Effort | Depends on | Ships |
|---|---|---|---|
| Phase 1 — shared files + per-action schema split | ~2 days | None (uses existing `wireShape`) | Behavioural no-op; new files emitted, old files retained |
| Phase 2 — form walker rewire | ~2 days | `loom-forms.md` Phase F1 | Live ACL loop: 422 → `setError`, network → toast |
| Phase 3 — `option` field rendering | ~1.5 days | `partial-update.md` | "Leave unchanged" toggle in forms |

**Total: ~5.5 days serialised; ~3 days with parallel pack work.**

Phase 1 can land ahead of `loom-forms.md` and `payload-transport-layer.md` — it's purely additive emission. Phase 2 and Phase 3 are gated.

## Open items deferred to follow-ups

1. **Async refines** (`unique` constraint precheck) — separate proposal.
2. **Optimistic updates / `onMutate` snapshots** — out of scope.
3. **Read Models with computed fields** (`displayName = first + last`) — needs IR projection extension for `access: "derived"` rendering decision.
4. **Wizard machine integration** — sister proposal once Phase 3 lands.
5. **Phoenix LiveView counterpart** — sibling proposal; Ecto changesets carry the same State/Payload duality natively.

## Validation gates (per phase, before merging)

Each phase must pass before the next starts:

```bash
npm test                                          # fast suite
LOOM_REACT_BUILD=1 npm run test:tsc-react         # generated React tsc gate (matrix: examples × packs)
LOOM_BIOME=1 npm run test:biome-gen               # Biome lint on emitted TSX
LOOM_TS_BUILD=1 npm run test:tsc                  # TS backend tsc gate (catches schema-shape regressions on the wire)
```

Phase 2 additionally:

```bash
LOOM_E2E=1 npm run test:e2e                       # full stack — verifies the 422 round-trip end-to-end via Playwright
```

Phase 3 needs no new gate beyond the matrix.
