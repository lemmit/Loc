# Sensitivity tagging & compliance lint — `sensitive`, policy-presence check

> Status: proposal. Not in `ddd.langium`. Touches the authorization
> model at the seams — see
> [`policies-supplementary-note.md`](./policies-supplementary-note.md).

## Problem

Two things that classic "audit" conflates are actually distinct:

- **operation/access audit** — *who did what* (covered by
  [`audited`](./audit-and-logging.md));
- **field-level concerns** — *which fields are sensitive*, *what
  changed* on write, and *was sensitive data read*.

We need a way to mark sensitive fields once and have the toolchain (a)
tag change events as sensitive, (b) flag reads of those fields, and (c)
warn at compile time when a sensitive field is exposed with no
authorization policy attached. GDPR data-minimisation rules out
mechanically logging the *values* of sensitive reads.

## Field sensitivity

A trailing field modifier, in the same slot as the existing `display`
and `check` modifiers on a property:

```ddd
aggregate Patient {
  id: Id<Patient>
  firstName: string sensitive(pii)
  lastName:  string sensitive(pii)
  pesel:     string sensitive(pii)
  diagnosis: string sensitive(phi)
  status:    PatientStatus            // not sensitive
}
```

`sensitive(<category>)` is the general form; categories are an open set
(`pii`, `spi`, `phi`, `cred`, plus custom). The conversation's `@pii`
shorthand maps to `sensitive(pii)`; whether to keep a bare `pii`
alias is an open question (Loom tends to prefer one spelling).

These tags are **metadata only** — they force no mechanism by
themselves. They drive three downstream behaviours:

1. emitted change events get `containsPii: true` / `sensitivity: high`;
2. views returning such fields are PII-bearing in the read audit
   (`audited(access, containsPii)`);
3. the compliance lint below.

## Field-change audit (write side)

Change audit is **event-driven**, not a separate diff system. An
`audited(events)` aggregate (see
[audit-and-logging.md](./audit-and-logging.md)) emits change events
that carry the sensitivity flag derived from the field tags:

```ddd
event PatientPersonalDataChanged {
  patientId: Id<Patient>
  changedFields: string[]
  changedAt: datetime
  changedBy: Id<User>
  pii: bool
}
```

Reads are **not** field-audited mechanically: a read records only
*who / when / which view / contains-PII / row-count*, never the field
values.

## Compliance lint — sensitive field exposed without a policy

A design-time check over the metamodel: if a `view` exposes — or a
command modifies — a field tagged `sensitive(...)` and **no
authorization policy is attached** to that view/command, the compiler
warns (configurable to error in "hard mode"):

```
[warn] view 'PatientMedicalDetails' exposes 'diagnosis' marked
       sensitive(phi), but no authorization policy is attached.
       Consider gating it (e.g. `requires <policy>`).
```

The lint is **structural only** — it checks *presence* of a gate, never
evaluates policy semantics. It is the natural bridge between this
sensitivity layer and the authorization model.

> **Spelling to reconcile with the policies work.** The source thread
> wrote the gate as `@requiresPolicy("PhiAccessPolicy")` (a *string*
> policy name). Loom already has a `requires <expr>` authorization gate
> (see `docs/auth.md`) that takes a *typed* expression. The lint should
> be satisfied by Loom's existing `requires` gate rather than a new
> string-named annotation. This is called out for the policies agent in
> [`policies-supplementary-note.md`](./policies-supplementary-note.md).

## Language additions

| Addition | Form |
|---|---|
| `sensitive(<category>)` field modifier | `Property` gains `('sensitive' '(' category=SensitivityCat ')')?` after the existing `check` slot |
| sensitivity categories | open set: `pii` \| `spi` \| `phi` \| `cred` \| STRING |
| compliance lint | validator pass: every sensitive field reachable through a `view`/command must have a `requires` gate; warn (or error) otherwise |

## Lowering & generation

- The sensitivity tag rides on the field in the IR and is read by the
  audit emitter (event flags), the view read-audit, and the validator
  lint.
- No runtime mechanism is generated *from the tag alone* — it
  parameterises the audit/policy machinery rather than acting on its
  own.

## Open questions

- Keep a bare `pii` alias, or only `sensitive(pii)`?
- Whether `cred`-tagged fields should default to *never logged / never
  returned* rather than merely flagged.
- Hard-mode default (warn vs error) per project.
