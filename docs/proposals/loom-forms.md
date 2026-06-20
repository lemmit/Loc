# Loom forms — declarative form generation from aggregate actions

> **[2026-06-20 status audit]** Same as frontend-acl: the `errors[]` extension shipped (`validation-error-extension.md`), so the field-routing 'dormant until backends grow errors[]' note no longer holds.

> Status: **PARTIAL** — the named-leaf trio is live in the walker registry
> (code-verified 2026-06-10): `CreateForm { of: }` and
> `OperationForm { of:, op: | <inst>.<op> }` shipped post-#512 (delegating
> to the shared form machinery), `WorkflowForm { runs: }` alongside, and
> **`DestroyForm { of: <Agg> }` shipped 2026-06-10** — the
> confirmation-only canonical-destroy form (window.confirm →
> `useDelete<Agg>` with the route id → navigate to the aggregate's list;
> `then: navigate(<Page>)` override).  Remaining: named destroys
> (`for: <inst>.<destroyName>`), F2 binding-validation codes
> (`loom.form-binding-*`), and the field-derivation alignment this
> proposal designs.  **Depends on**
> [`lifecycle-operations.md`](./lifecycle-operations.md) — forms bind to
> typed actions (create / operation / destroy) defined there (Phase 1
> kind-tags shipped #722).

## Background — why this proposal exists

This proposal exists because of a layering bug we discovered in the React-side form generation, while trying to implement a "Phase 0" cleanup of the form walker.

### The Phase 0 plan that triggered the redesign

The original task was modest: extend the form walker (`src/generator/react/body-walker.ts`) so that `CreateForm { of: Order }` derives its field list from the aggregate's writable-on-create fields, in a way that matched what the API generators were doing. The plan was:

1. Extend `crudish` (the macro that adds standard CRUD operations) to emit a `create` operation alongside the existing `update`. Add a `writableCreateFields` factory parallel to the existing `writableUpdateFields`.
2. Have the form walker resolve `CreateForm { of: X }` by looking up the `create` operation on `X` and reading its parameter list.
3. Have the form walker resolve `OperationForm { for: X.someOp }` similarly.

Step (1) was implemented and tested (6 tests passing). Then we stopped. The reason: putting `create` on the aggregate as an ordinary `operation` is **semantically wrong**. In DDD, creation is not an instance operation — there's no `this` yet; the action makes the instance. Modelling it as a regular `operation` flattens a real categorical distinction.

That discovery redirected the entire design. See [`lifecycle-operations.md`](./lifecycle-operations.md) for the full redesign — the upshot is that aggregates gain three keywords (`create`, `operation`, `destroy`) with kind tags carrying the lifecycle semantics, and the framework owns persistence based on the kind. Forms then bind to these typed actions.

### The layering bug being fixed

Three places in today's codebase reach into `aggregate.fields` to synthesise the create contract:

1. **React form walker** (`src/generator/react/body-walker.ts`) — `CreateForm { of: Order }` walks `Order.fields`, filters to writable-on-create, renders one field per filtered property.
2. **React API client emitter** (`src/generator/react/api-builder.ts`) — emits `POST /orders` taking a body shaped by walking the same field list.
3. **Backend API generators** (`src/generator/ts/...`, `src/generator/dotnet/...`, `src/generator/phoenix-live-view/...`) — each emits the same `POST /orders` route handler, each independently re-derives the body shape from `aggregate.fields`.

Five separate code paths, all implementing the same "what fields go on create" decision, all liable to drift. There is no IR shape that captures this decision; each consumer invents it.

The form layer and the API layer can disagree right now. Once the codebase grows a few more backends or design packs, that disagreement becomes inevitable.

### Why fix it at the forms layer

The forms layer is the most visible consumer of the create contract: it's user-facing, it surfaces every field, and any mismatch with the API layer presents as broken form submissions. Fixing forms forces us to identify the canonical IR source for the create contract — once we have it, the API generators can consume the same source.

## Design — forms bind to typed actions

Under [`lifecycle-operations.md`](./lifecycle-operations.md), every aggregate-resident behaviour is a typed action with a declared parameter list. Forms gain a real binding target: the action IR node. The form walker reads the action's parameter list (not `aggregate.fields`) to build the field set.

### Form primitives

Three primitives in the walker stdlib (`src/language/walker-stdlib.ts`):

| Primitive | Binds to | Field source |
|---|---|---|
| `CreateForm { of: Aggregate }` | Canonical (unnamed) `create` action | Action's params |
| `CreateForm { for: Aggregate.createName }` | Named `create` action | Action's params |
| `OperationForm { for: instance.opName }` | Named `operation` action | Action's params |
| `DestroyForm { for: instance.destroyName }` | Named `destroy` action | Action's params (often empty → confirmation only) |

Two shapes of reference:
- `{ of: Order }` — by aggregate type only; resolves to the canonical action of that kind.
- `{ for: Order.place }` (page-level state) or `{ for: order.cancel }` (instance variable) — by aggregate + action name; resolves to the specific named action.

Both shapes lower to the same IR node — `FormBindingIR` — with `aggregate`, `kind`, and `actionName` fields.

### Examples

```
page NewOrderPage {
  CreateForm { of: Order }                          # binds to canonical Order.create
}

page ImportOrderPage {
  CreateForm { for: Order.import }                  # binds to Order's named create 'import'
}

page EditOrderPage(order: Order) {
  OperationForm { for: order.update }               # binds to the crudish-emitted update operation
}

page CancelOrderPage(order: Order) {
  OperationForm { for: order.cancel }               # binds to the named cancel operation
}

page ArchiveOrderPage(order: Order) {
  DestroyForm { for: order.archive }                # binds to the named archive destroy
}

page DeleteOrderPage(order: Order) {
  DestroyForm { of: Order }                         # binds to canonical Order.destroy (no params → confirmation only)
}
```

### Source-of-truth rules

These rules govern how every form primitive resolves and renders. They are strict — there are no fallback paths to "walk the fields" or "guess the shape."

1. **The action's param list is the form's field list, in declared order.** No reordering, no auto-grouping, no field omission. If the user wants different fields, they declare a different action.

2. **Form binding is name-driven, not shape-driven.** `CreateForm { of: Order }` resolves the canonical create action on `Order`. If that action doesn't exist, validator error (`loom.form-binding-not-found`). No "walk `Order.fields` as a fallback" path.

3. **Strict-or-error.** If a form binds to a non-existent action, validator error. If it binds to an action of the wrong kind for the form primitive (e.g., `OperationForm` bound to a `create`), validator error. The form layer never invents anything.

4. **Forms never call the API directly — they call the generated API client.** The API client is emitted by the api-builder, which reads the same action IR. Form → API client → server: three layers, one source of truth (the action IR), no field-walking anywhere.

### Field rendering

For each parameter of the bound action, the walker emits one form field. The mapping from param type to field type:

| Param type | Rendered as |
|---|---|
| `string` | text input |
| `string?` (nullable) | text input + clear / null toggle |
| `string option` (partial-update three-state) | text input + "leave unchanged" toggle (defaults to absence) |
| `int` / `long` | integer input with step controls |
| `decimal` | decimal input |
| `bool` | checkbox |
| `date` | date picker |
| `datetime` | datetime picker |
| Enum reference | select / radio group; choices from enum's declared values |
| `X id` (foreign-key reference) | select populated by `X.findAll()` (or typeahead if the FK target is large — see open items) |
| `string` with `secret` access modifier | password input (write-only field) |
| Embedded value object | nested field group (one field per VO property, recursively) |

The design pack (`designs/mantine`, `designs/shadcn`, `designs/mui`, `designs/chakra`) controls the visual rendering of each field type via per-type templates in `designs/<pack>/forms/`. The walker controls the field selection and ordering; the pack controls the visual presentation.

### Labels and defaults

**Labels** default to the param name in title-case (`subject` → "Subject", `externalId` → "External Id"). Future per-param attribute syntax can override:

```
operation cancel(reason: string [label: "Cancellation reason"]) { ... }
```

(Per-param attributes are out of scope for this proposal; they can be added in a separate label/i18n proposal.)

**Defaults** come from the param's default value if declared:

```
create create(subject: string, amount: decimal = 0) { ... }
```

renders an amount field pre-filled with `0`.

**Required vs. optional**: every param is required by default. Optional params are declared with `?` on the type (`subject: string?`) or with the `option` carrier (`subject: string option`); the form layer renders them accordingly.

### Submission flow

A submitted form dispatches to the appropriate generated API call:

| Form | API call | URL (under `urlStyle: literal`) |
|---|---|---|
| `CreateForm { of: Order }` | `POST` with body | `/orders` |
| `CreateForm { for: Order.import }` | `POST` with body | `/orders/import` |
| `OperationForm { for: order.cancel }` | `POST` with body | `/orders/:id/cancel` |
| `OperationForm { for: order.update }` | `POST` with body | `/orders/:id/update` |
| `DestroyForm { for: order.archive }` | `POST` with body (or empty) | `/orders/:id/archive` |
| `DestroyForm { of: Order }` (canonical, no params) | `DELETE` (no body) | `/orders/:id` |

Under `urlStyle: resource`, the URL slugs pluralise — see [`lifecycle-operations.md`](./lifecycle-operations.md) for the URL rules.

**On success**: navigate to the affected aggregate's detail page (or a route specified on the form), invalidate React Query keys for the aggregate's collection. Default navigation:

- `CreateForm` → navigate to the detail page of the newly created instance.
- `OperationForm` → stay on the current page; refetch the instance.
- `DestroyForm` → navigate to the aggregate's list page.

Overridable via a `then:` clause on the form (out of scope for v1; default navigation only).

**On error**: per the future [`exception-less.md`](./exception-less.md) model, errors come back as RFC 7807 ProblemDetails-shaped `error` payloads. The form layer maps the `errors[]` array's `pointer` field to the form field that caused it, renders inline error messages, and leaves the form in an editable state. Validation errors from preconditions / criteria are surfaced the same way.

## Mechanical IR + lowering

### AST shape

The form primitives are walker-stdlib registered as `Component`-shaped AST nodes with two parameter shapes:

```
CreateForm:
  'CreateForm' '{' bindings+=Binding* '}'

Binding:
  ('of' ':' aggregate=[Aggregate])
  | ('for' ':' actionRef=ActionRef)

ActionRef:
  receiver=ID ('.' name=ID)?       # Order.import (type-level) or order.cancel (instance-level)
```

Same for `OperationForm`, `DestroyForm`. Existing primitives in `src/language/walker-stdlib.ts` set the precedent for this shape.

### IR shape (`src/ir/loom-ir.ts`)

A new node type:

```ts
interface FormBindingIR {
  kind: 'create' | 'operation' | 'destroy';
  aggregate: AggregateRef;
  actionName: string | null;        // null for canonical (only valid for create/destroy, with appropriate primitive)
  receiverExpr: ExprIR | null;      // null for type-level CreateForm { of: X }; non-null for instance-level OperationForm { for: x.op }
}
```

Used by the form walker to dispatch into per-kind rendering logic.

### Lowering (`src/ir/lower-expr.ts`)

The `for:` / `of:` reference is resolved at lowering time:

- `{ of: Aggregate }` — look up the aggregate by name; check that a canonical action of the appropriate kind exists.
- `{ for: Aggregate.name }` — look up the aggregate; look up the named action of the appropriate kind.
- `{ for: instance.name }` — type-check the instance variable; look up the named action on its type.

Failures become validator errors with codes from the table below. On success, the action's resolved parameter list is attached to the `FormBindingIR` so downstream renderers don't have to re-resolve.

### Validator (`src/language/ddd-validator.ts`)

| Code | Rule |
|---|---|
| `loom.form-binding-not-found` | The action referenced by `for:` / `of:` does not exist on the target aggregate. |
| `loom.form-binding-kind-mismatch` | The form primitive's expected kind doesn't match the bound action's kind. E.g., `OperationForm { for: order.archive }` where `archive` is a destroy. |
| `loom.form-binding-canonical-missing` | `CreateForm { of: X }` (or `DestroyForm { of: X }`) when X has no canonical action of that kind. |
| `loom.form-binding-canonical-not-applicable` | `OperationForm { of: X }` — operations are always named, so the canonical-only form is invalid. |
| `loom.form-on-empty-action` | (Warning only.) Form bound to an action with no params. Valid for `DestroyForm` (confirmation only) but probably an error for `CreateForm` / `OperationForm`. |

### Body walker (`src/generator/react/body-walker.ts`)

Three new dispatch arms in the walker, one per form primitive. Each:

1. Resolves the bound action via the `FormBindingIR.aggregate` + `actionName`.
2. Iterates the action's params (in declared order).
3. Emits one field-row per param using the design pack's per-type field templates (`designs/<pack>/forms/field-<type>.hbs`).
4. Emits the submit button + form-level wiring (loading state, error rendering, navigation).

The existing field-walking logic for `Form` (the legacy generic primitive) is **deprecated** but stays as an alias for `CreateForm` for backward compatibility. Removed in a follow-up.

### API client emitter (`src/generator/react/api-builder.ts`)

Already changed by [`lifecycle-operations.md`](./lifecycle-operations.md) to emit per-action client methods. Form layer calls into these methods. The form layer itself does not emit URLs, HTTP verbs, or request bodies — it dispatches through the api-client.

### Design packs (`designs/<pack>/forms/`)

Each pack provides per-field-type templates:

```
designs/mantine/forms/
  field-string.hbs
  field-int.hbs
  field-decimal.hbs
  field-bool.hbs
  field-date.hbs
  field-datetime.hbs
  field-enum.hbs
  field-fk.hbs
  field-option.hbs
  form-submit.hbs
  form-error.hbs
```

The walker dispatches to these templates per param-type. Pack-specific concerns (which Mantine input component, which CSS classes, how validation states render) live in the templates.

Existing pack templates for the legacy `Form` primitive are repurposed.

## Decisions and their rationale

### F1 — Strict binding, no field-walking fallback

`CreateForm { of: X }` requires X to have a canonical create action. No fallback to "walk the fields." This is the strictest possible binding model and intentional:

- Eliminates the drift between form layer and API layer (both consume the same action IR).
- Forces honest modelling: a project that wants a form must declare an action; the action's params ARE the form fields.
- Removes the field-walking code path entirely — cleaner separation of layers.

The cost: a freshly-declared aggregate with no actions has no forms. Either declare actions explicitly or apply `with crudish` to get the canonical trio for free.

### F2 — Form primitives are kind-specific (CreateForm, OperationForm, DestroyForm)

We considered a single generic `Form { for: ... }` primitive. Rejected:

- Kind-specific primitives give the validator clear semantics (`OperationForm` bound to a create is an obvious error).
- The submission flow differs by kind (where to navigate on success, what HTTP verb to use, how to handle "destroy with no params" → confirmation only).
- The current legacy `Form` becomes `CreateForm` (alias) for backward compatibility.

### F3 — `of:` for canonical-by-type; `for:` for named-by-name

| Shape | Semantics |
|---|---|
| `CreateForm { of: Order }` | Canonical (unnamed) create on Order |
| `CreateForm { for: Order.import }` | Named create 'import' on Order |
| `OperationForm { for: order.cancel }` | Named operation 'cancel' on the instance |
| `DestroyForm { of: Order }` | Canonical destroy on Order |
| `DestroyForm { for: order.archive }` | Named destroy 'archive' on the instance |

This distinction is small but meaningful:
- `of:` always resolves to a type-level reference (canonical action on a type).
- `for:` always resolves to a name-qualified reference.

Symmetric across the three form primitives.

### F4 — No per-form field overrides

We considered allowing `CreateForm { of: Order, hide: [externalId], reorder: [...] }`. Rejected:

- The action's param list IS the contract. If the form needs different fields, declare a different action.
- Per-form overrides duplicate the modelling work and create drift between "what the action accepts" and "what the form shows."
- Multiple-creates-per-aggregate (`create create(...)`, `create import(...)`) already handles the "I need a different shape" case.

The escape hatch: declare another create action.

### F5 — Submission goes through generated API client, not direct fetch

The form layer never calls `fetch` directly. It calls the generated API client methods. This:

- Centralises authentication, base URL, error parsing, tracing in the API client.
- Means the form layer doesn't need to know about URLs, verbs, or body shapes — those live in the api-client emit.
- Lets `urlStyle: literal | resource` and any future URL conventions be picked up automatically.

### F6 — Default success navigation is sensible-defaults, not configured

Out of scope for v1: the `then: <route>` clause on forms. v1 ships with hardcoded defaults (create → detail, operation → stay, destroy → list).

## Open items

1. **FK fields with large target sets.** `customer: Customer id` rendered as `<select>` doesn't scale past a few hundred options. Add a per-FK-field annotation that triggers a typeahead search input instead. Or auto-detect based on `findAll` performance hints.

2. **Embedded value objects.** `create place(address: Address) { ... }` — does the form render Address as a nested field group? Probably yes; recursive walking of VO properties. Worth a test fixture per design pack.

3. **`option` field rendering.** `string option` (partial-update three-state) renders as text input + "leave unchanged" toggle. The toggle's UX is design-pack-specific; needs templates.

4. **Validation error mapping.** ~~RFC 7807 ProblemDetails has a `pointer` field (JSON pointer into the body). Mapping that to a specific form field requires the form to know its own field-to-pointer correspondence. Mostly mechanical but needs spelling out.~~ **Addressed by [`frontend-acl.md`](./frontend-acl.md) Phases 1+2** (shipped in [#769](https://github.com/lemmit/Loc/pull/769), commit `25dba02`): every generated form's catch block calls `applyServerErrors({ error, setError, fieldMap })` which decodes `errors[].pointer` → flat dot-key → `setError`. The per-form `fieldMap` is an empty `{} as const` identity today (RHF's `Path<T>` accepts dot-paths directly); a populated FieldMap becomes meaningful only when the schema restructure lands (see frontend-acl's PARTIAL status). The runtime is fully wired across all 8 pack/versions; the per-field path stays dormant until backends grow the RFC 7807 §3.2 `errors[]` extension from `exception-less.md`.

5. **Loading / pending states.** Default rendering shows a spinner on the submit button. Custom rendering (skeleton states, optimistic UI) is per-pack.

6. **Optimistic updates.** v1 uses invalidate-and-refetch unconditionally. Optimistic UI is a follow-up.

7. **Multi-step / wizard forms.** Not v1. A future `WizardForm { steps: [...] }` chaining multiple actions can layer on top.

8. **Inline editing.** Forms today are full-page. Inline editing (edit one field on a detail page) is a separate primitive (`InlineEditForm` or similar). Out of scope for v1.

9. **`DestroyForm { of: Order }`** for a canonical destroy with no params — renders as just a confirmation button (no form fields). Whether this should require a separate `ConfirmDestroyButton` primitive or fold into `DestroyForm` is a small UX choice. Recommended: fold into `DestroyForm` (the body is empty; user sees a "Are you sure?" confirm).

10. **Tests.** Add `test/walker/walker-create-form.test.ts`, `walker-operation-form.test.ts`, `walker-destroy-form.test.ts`. Plus one fixture per design pack rendering each form kind. The `walker-*.test.ts` pattern in `test/walker/` already covers ~30 walker primitives.

11. **Phase 0 stash.** The `phase-0-crudish-create — pending design decision` stash on the development branch contains the original attempt at adding a `create` operation to `crudish`. Under the new model, that work is superseded — `crudish` emits a typed `create` action, not an `operation`. The stash should be dropped after this proposal lands and the new `crudish` is implemented.

## Phased delivery

This proposal can ship in two passes, each consuming part of the [`lifecycle-operations.md`](./lifecycle-operations.md) work as a dependency.

### Phase F1 — Form primitives + strict binding (~3 days)

- Walker-stdlib registration of `CreateForm`, `OperationForm`, `DestroyForm`.
- AST shape (Langium grammar additions).
- `FormBindingIR` IR node + lowering.
- Validator rules (`loom.form-binding-*`).
- Walker dispatch arms in `body-walker.ts` that resolve the action and iterate its params.
- Per-pack form-field template adoption (existing legacy `Form` templates carry over).

Depends on: [`lifecycle-operations.md`](./lifecycle-operations.md) Phase 1 (grammar + IR foundation) for the typed-action IR.

### Phase F2 — API client integration + submission flow (~2 days)

- Form layer dispatches through the generated API client (no direct `fetch`).
- Success navigation defaults.
- Error rendering against form fields.

Depends on: [`lifecycle-operations.md`](./lifecycle-operations.md) Phase 3 (backend route emission) for the api-client method shapes.

### Phase F3 — Design-pack polish + tests (~3 days)

- Field type rendering for all primitive types per pack.
- FK rendering with `findAll` integration.
- Embedded VO recursion.
- `option`-field "leave unchanged" toggle.
- Walker tests + design-pack fixtures.

Can run in parallel with F2.

Total: ~5 days serialised; ~3 days with parallelism.

## Relationship to companion proposals

- [`lifecycle-operations.md`](./lifecycle-operations.md) — required dependency. Forms bind to typed actions; this proposal supplies the binding semantics. Phase F1 cannot land until Phase 1 of lifecycle-operations is in.

- [`partial-update.md`](./partial-update.md) — `option`-typed fields in operations. The form layer needs to render the three-state field correctly (absent / cleared / value). Open item #3 above tracks this.

- [`exception-less.md`](./exception-less.md) — RFC 7807 ProblemDetails-shaped errors. The form layer maps the `errors[]` array to fields via [`frontend-acl.md`](./frontend-acl.md)'s `applyServerErrors` runtime (shipped #769). The frontend ACL is wired and tested; the per-field path goes live the moment backends emit the `errors[]` extension from this proposal.

- [`frontend-acl.md`](./frontend-acl.md) — supplies the runtime that closes the loop on this proposal's "On error" semantics. Phases 1+2 shipped; per-action `FieldMap` instances + schema restructure deferred.

- [`criterion.md`](./criterion.md) — `when <Criterion>` guards generating `can-<op>` endpoints. Forms can use the can-op endpoint to disable the submit button when the criterion would reject the action. Out of scope for this proposal but worth coordinating in the criterion proposal's open items.

- [`authorization.md`](./authorization.md) — policy gates on operations. Forms should be hidden / disabled when the current user lacks the policy permission for the bound action. v1 punt; defer to a follow-up that wires policy decisions to form visibility.

- [`pagination-design-note.md`](./pagination-design-note.md) — `Paged<T>` responses. Affects FK-field rendering when the FK target list is paged. Coordinate in open item #1.

- `page-metamodel.md` (reference doc) — describes the page DSL surface and walker primitives. Update once Phase F1 lands.

---

*Conversation thread that produced this proposal: starts with the Phase 0 plan for extending crudish + form walker, pivots when we identify that create-as-operation is semantically wrong, derives the lifecycle-operations design, and lands on this strict-binding form model. See [`lifecycle-operations.md`](./lifecycle-operations.md) for the lifecycle-side details.*
