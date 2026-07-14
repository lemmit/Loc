# Diagnostic catalog — the `loom.*` code registry

> Convention spec. Status: ~9 codes attached today via the validator
> `code:` property; many checks still emit codeless diagnostics. This
> doc pins the naming + severity convention so new checks register a
> stable code from day one, and seeds the registry with the codes the
> in-flight proposals introduce.

## Why codes

A stable diagnostic code is the contract between a validator and
everything that consumes its output: the LSP (quick-fix targeting),
test assertions (`expect(diagnostics).toContainCode("loom.…")`), docs,
and users who search an error string. Free-text messages drift; codes
don't. **Every diagnostic Loom raises — parser, AST validator, IR
validator, system check — carries a `loom.<area>-<symptom>` code.**

## Naming

```
loom.<area>-<symptom>
```

- **`area`** — the feature/phase the check belongs to, lower-kebab:
  `storage`, `datasource`, `payload`, `error`, `criterion`, `lifecycle`,
  `policy`, `tenancy`, `i18n`, `sensitive`, `audit`, `provenance`,
  `deployable`, `react`, `slot`, `derived`.
- **`symptom`** — what is wrong, lower-kebab, phrased as the problem not
  the fix: `bare-aggregate-in-type`, `unmapped-error-status`,
  `findAll-no-page`, `unnamed-placeholder`.

One code per distinct condition. Do not reuse a code across two
unrelated checks; do not mint two codes for one condition.

## Severity policy

| Severity | Use |
|---|---|
| **error** | the model cannot lower / generate correctly |
| **warning** | legal but suspect; a sharper form exists |
| **hint/info** | style nudge; LSP-only, never fails CI |

**Staged promotion.** A new constraint that would break existing
sources lands as a **warning**, then promotes to **error** in a later,
coordinated phase — keeping the *same code* across the promotion. This
is the exception-less D10 pattern (`loom.throw-outside-domain`: warning
A1–A3, error after A4) and is the default migration path for any
tightening rule. Document the promotion phase in the registry row.

## Registry

### Shipped (attached via `code:`)

| Code | Severity | Meaning |
|---|---|---|
| `loom.framework-mismatch` | error | deployable platform/framework combination invalid |
| `loom.react-deployable-missing-ui` | error | react deployable with no `ui:` (post-#606) |
| `loom.provenanced-never-written` | warning | `provenanced` field never assigned |
| `loom.token-nullable` | error | nullable token field |
| `loom.slot-member-access` / `loom.slot-out-of-position` | error | component slot misuse |
| `loom.legacy-part-call` / `loom.legacy-vo-call` | warning | legacy call form |
| `loom.unknown-builder-type` | error | unrecognised builder kind |
| `loom.bare-aggregate-in-type` | error | cross-aggregate ref not spelled `X id` (scope provider) |
| `loom.migration-duplicate-name` | error | two `migration` blocks share a name (M-T2.1) |
| `loom.rename-to-self` | error | `rename Agg.x -> x` names the same field on both sides (M-T2.1) |
| `loom.rename-duplicate-source` | error | one aggregate column is renamed FROM more than once (M-T2.1) |
| `loom.rename-duplicate-target` | error | two renames collide ON one target column (M-T2.1) |

### Reserved by in-flight proposals

| Code | Severity | Source | Phase |
|---|---|---|---|
| `loom.unmapped-error-status` | warning | exception-less D8 | A3 |
| `loom.throw-outside-domain` | warning → **error** | exception-less D10 | A1 → A4 |
| `loom.findAll-no-page` | warning | criterion D33 | Crit4 |
| `loom.bound-not-met` | error | payload-transport (carrier bound) | P3 |
| `loom.unnamed-placeholder` | warning | i18n-strings | i18n |
| `loom.datasource-missing-kind` | error | D-STORAGE-SPLIT validator rules | (storage F2) |
| `loom.datasource-aggregate-for` | error | D-GRANULARITY (`for:` must be a context) | (storage F2) |
| `loom.policy-missing` | warning | sensitivity → authorization (sensitive field w/o policy) | 3.2 |

When a proposal mints a new code, add its row here in the same PR that
adds the check — the registry is the index, the validator is the source
of truth, and they must not drift.

## Mechanics

Codes attach via Langium's diagnostic `code` property on the
`ValidationAcceptor` call:

```ts
accept("error", "Cross-aggregate reference must use `X id`.", {
  node, property: "type", code: "loom.bare-aggregate-in-type",
});
```

A small `test/language/diagnostic-codes.test.ts` (to add) can assert
every `accept(...)` site passes a `code:` and that every code matches
`loom.<area>-<symptom>` — turning this convention into a gate.
