# Supplementary note for the authorization-policy design

> **Audience:** the agent designing Loom's authorization model
> (`DataKey`, `dataPolicy`, `operationPolicy`, relation-based sharing —
> the `policies.txt` line of work).
>
> **Why this exists:** the provenance/traceability conversations that
> produced the [proposals in this folder](./README.md) contained a
> large amount of authorization material — including an *entire alternate
> policy DSL* and several integration seams with audit/sensitivity/load
> aspects. This note hands that material over and flags the decisions
> where the two visions must be reconciled so they stay complementary.

---

## 1. There is a second, independent policy DSL in the source threads

One conversation converged (after much back-and-forth) on an
**aggregate-centric, function-style** authorization model that is
*different in shape* from the Salesforce/Dataverse-style
`dataPolicy`/`operationPolicy` model in `policies.txt`. It is worth
reading because it solves the *fine-grained predicate* problem that the
record-reachability model doesn't fully cover. Its final form:

**Policy as a typed boolean function** (the last and most-preferred
form in the thread — earlier `context {}` / `parameters {}` /
`allow when {}` block forms were superseded):

```
policy CanAssignPatientToWard(
  actor: Actor,
  patient: Patient by command.patientId,
  ward: Ward by command.wardId,
  clinic: Clinic by ward.clinicId,
  isUrgent: bool
): bool {
  return actor.hasRole("Coordinator")
      && patient.status == Admitted
      && ward.isActive
      && clinic.id == patient.clinicId
}
```

**Attachment matrix** (how policies bind to constructs):

```
field     — read(PolicyX), write(PolicyY)
aggregate — requires(AggregatePolicy)   // applies to all its operations
operation — requires(OperationPolicy)
workflow  — requires(WorkflowPolicy)
view      — requires(ViewPolicy)        // drives UI capabilities, same engine
```

**Inline (local) policies** for the common `actor + currentAggregate`
case:

```
aggregate Patient {
  policy IsOwner           = Actor.Id == this.id
  policy IsAttendingDoctor = Actor.Id == this.doctorId
  policy CanEditProfile    = IsOwner || Actor.HasRole("Admin")

  pesel: string  read(CanEditProfile) write(IsAdmin)
}
```

**Resolver inference** — the thread's most useful conclusion: the
*context* (which aggregates/queries to load before evaluating a policy)
should be **inferred from the `requires(...)` call site**, not
hand-written. A `resolver` block exists as a fallback, but the
preferred path is:

```
operation assignPatientToWard {
  requires CanAssignPatientToWard(
    actor:   currentActor,
    patient: repository.Patient.get(patientId),
    ward:    repository.Ward.get(wardId)
  )
}
```

…from which the compiler derives the load plan.

### How this relates to `dataPolicy` / `operationPolicy`

They are **complementary layers, not competitors** — recommend keeping
both and layering them:

| Concern | `policies.txt` model | Function-style model | Suggested role |
|---|---|---|---|
| Which records are reachable | `dataPolicy` + `DataKey` (`Ancestors`/`Descendants`/`Related`) | — | **Structural reachability** — keep as is |
| Which operations may run | `operationPolicy` `allow execute … for permissions …` | `requires(OpPolicy)` boolean fn | operationPolicy = the *catalogue*; the boolean fn = the *rule body* |
| Fine-grained per-record predicate | `criteria { where … }` | the `policy … : bool { return … }` function | the function form is a typed, analysable spelling of `criteria` |
| Field behaviour in an operation | `operationPolicy` field rules (`allow read/update`, `mask`, `readonly where`) | field `read(P)` / `write(P)` | same intent; reconcile spelling (below) |

In other words: `DataKey`/`dataPolicy` answers *reachability*;
`operationPolicy` answers *what's executable*; the typed `policy`
function is a good **implementation shape for both the criteria
predicates and the per-operation rule bodies**, because it is typed,
composable, and its load plan is inferable.

---

## 2. Spelling reconciliations (please unify)

The threads produced **three different spellings** for "attach an
authorization gate", and Loom **already ships one** of them. Please
converge on the existing one:

| Source | Spelling | Recommendation |
|---|---|---|
| `docs/auth.md` (shipped) | `requires <expr>` — a typed bool expression, maps to **HTTP 403** | **This is the canonical gate.** Build on it. |
| function-style policy thread | `requires(PolicyName)` / `@requires` / `@require` (typed identifier) | Fold into `requires <expr>` where the expr is a policy call/reference |
| sensitivity-lint thread | `@requiresPolicy("StringName")` (string name) | **Drop the string form** — string policy names lose type-checking, go-to-def, rename |

Likewise, the brainstorm's **`Actor` / `Actor.HasRole(...)` /
`Actor.Id`** is the *same concept Loom already ships as*
**`currentUser` / `currentUser.permissions.contains(...)` /
`currentUser.id`** (see `docs/auth.md`). Recommend **reusing
`currentUser`** rather than introducing a parallel `Actor` identifier —
otherwise expression bodies would have two different "who is calling"
roots.

Net recommendation: a `policy` is a named, typed boolean expression
over `currentUser` + resolved resources; attaching it is
`requires <policyRef>`; the existing 400/403 split (`precondition` vs
`requires`) is preserved.

---

## 3. Integration seams from the other proposals

These are the points where the provenance/audit/sensitivity/load
aspects *depend on* the policy engine. Each is a place to keep the
contracts aligned.

### 3a. Audit ↔ policy (`policy decision id`, `approval id`)
The strict-tier audit record
([audit-and-logging.md](./audit-and-logging.md)) is specified to carry
a **`policyDecisionId`** and an **`approvalId`**. For this to work, the
policy engine should expose a stable id for each decision it makes (and
each approval it consumes), so an audit entry can reference *which
policy decision authorised this action*. Please surface a decision-id
from the evaluator.

### 3b. Sensitivity ↔ policy (the compliance lint)
[sensitivity-and-compliance.md](./sensitivity-and-compliance.md)
proposes a compile-time lint: *a `view`/command that exposes a
`sensitive(...)` field but has no authorization gate → warning*. The
lint only checks **presence** of a `requires` gate; it never evaluates
policy semantics. Two asks of the policy design:
- make "is there a gate on this view/command?" cheaply inspectable in
  the IR;
- the `sensitive(<category>)` category (`pii`/`phi`/`cred`/…) is also
  intended to *feed* policy (e.g. "phi fields require a policy of class
  X"); if you want category-aware policy rules, the tag is already
  there to read.

### 3c. Field write policy ↔ `Optional.isSet`
[optional-and-partial-update.md](./optional-and-partial-update.md):
field-level **write** policies should be enforced only for fields that
were actually supplied in a partial update — gated by `Optional.isSet`.
Recommend the generated handler shape:
`if cmd.field.isSet then ensureWritable(field-policy)`.

### 3d. Data-policy filtering ↔ load-spec inference (both wrap `Repo.load`)
[load-specifications.md](./load-specifications.md) infers *what shape*
must be loaded and synthesises the `Repo.load(...)` include plan.
`dataPolicy` row/field filtering *also* wraps `Repo.load`. These two
must compose coherently: the shape-inferred load decides *which parts*
are fetched; the data-policy decides *which rows/fields* of that shape
the caller may see. Suggest: load-spec runs first (determines the
fetch plan), data-policy filters the result — and the **provenance
trace records both** (requested shape vs policy-filtered realised
access). Keep them as orthogonal wrappers on the same call.

### 3e. View capabilities (UI affordances)
The function-style thread had `view` policies compute a
**`fieldCapabilities`** map (`readable` / `editable`) using the *same*
policy engine, returned alongside the data so the UI hides/disables
fields, with the backend re-checking on write. This is a clean fit for
Loom's existing React/`ui` layer — worth designing the view-policy
output as a capabilities map, not just an allow/deny.

### 3f. Refinement/shape overlap (`Authenticated<User>`)
The load-spec thread floated refinement witnesses like
`Authenticated<User>` alongside `Loaded<Order, Spec>`. To avoid two
type-system mechanisms, recommend: **loadedness** is the shape-typing
concern (load-spec doc), **authorization** stays a `requires`-gate
concern. Don't model "authenticated/authorized" as a refinement type if
the `requires` gate already covers it — keep the two layers orthogonal.

---

## 4. One-paragraph summary

Loom already has `user`/`currentUser`, module `permissions`, and a
`requires <expr>` 403 gate. The cleanest unification: keep
`DataKey`/`dataPolicy` for **structural record reachability** and
`operationPolicy` for the **operation/field catalogue**; express the
fine-grained rule bodies (criteria, per-operation predicates) as
**typed `policy` boolean functions over `currentUser` + resolved
resources** whose load plan the compiler infers from the `requires`
call site; attach everything through the **existing `requires` gate**
(not `@requires`/`@requiresPolicy("string")`/`Actor`); and expose a
**policy decision id** plus **view field-capabilities** so audit,
sensitivity-lint, partial-update write checks, load-spec composition,
and the UI all plug into one engine.
