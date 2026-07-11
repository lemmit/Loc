# Tenancy / authorization / dataKey — final reconciled surface

**Status:** PROPOSED (synthesis — pins the reconciled target across
[`expressible-builtins.md`](./expressible-builtins.md),
[`organization-context.md`](./organization-context.md), and the
recommended reconciliations of `authorization.md` / the multi-tenancy
plans flagged in
[`../audits/proposal-surface-stability-review-2026-07.md`](../audits/proposal-surface-stability-review-2026-07.md)
Part C).

This is the **settled surface**, not a derivation — the reasoning lives in
the source proposals. Owner decisions still gate the parts that supersede
`authorization.md` (the `DataKey` type) and re-root the multi-tenancy stamp.

## The seven decisions (pinned)

1. **`dataKey` is an ordinary `string internal` field** — **not** a
   first-class `DataKey` type, and there are **no** magic member ops
   (`isAncestorOf`/`depth`/…). Supersedes `authorization.md` §2/§10.
2. **Subtree scope is a `startsWith` filter operator**, lowering to
   `LIKE 'prefix.%'` — the one genuinely-new operator. Replaces the
   internal `__loomDeepScope__` sentinel; matches the SQL already in
   `tenant-stance.ts:159-160`.
3. **`organizationContext` (operating scope) is split from `currentUser`
   (principal).** The *write* stamp reads `organizationContext.orgPath`.
4. **Reads stay principal-anchored by default.** The tenant read `filter`
   and the `deep`/`global` ladder anchor on `currentUser`; a validated
   context switch is an *explicit widening*, never a blanket repoint.
5. **The context-switch authorization gate is a hard prerequisite** —
   fail-closed, per-backend, parity-tested — before `organizationContext`
   is settable. It reuses the write-scope ladder.
6. **`crossTenant` is fail-closed under `tenancy by`** — a `crossTenant`
   aggregate *requires* an explicit read policy, independent of the global
   `enforcement` default.
7. **No dedicated authz "current row" pronoun** — drop `authorization.md`'s
   `resource` (which collides with the `resource {}` storage-binding
   keyword) *and* the `record` rename. Reference the row with what already
   exists: **`this`** (or a bare field ref) in an operation gate, a **typed
   param** in a named policy, an explicit **`as`-binding** in a bare
   policy-block predicate. Nothing ambient ⇒ no param-vs-field ambiguity.

## Surface — piece by piece

### System declaration

```ddd
system Shop {
  user { id: guid  tenantId: guid  orgPath: string  permissions: string[] }
  auth { provider: keycloak, enforcement: denyByDefault }   // fail-closed
  tenancy by user.tenantId of Organization                  // claim + registry
}
```

`currentUser.tenantId` / `.orgPath` come from the JWT claim (the
*principal's* home). `organizationContext.orgPath` defaults to the same and
is settable, gated.

### A tenant-owned aggregate — the common case

```ddd
capability tenantOwned {
  tenantId: Organization id internal
  dataKey:  string internal
  stamp onCreate {
    tenantId := currentUser.tenantId          // constant within a tenant
    dataKey  := organizationContext.orgPath   // OPERATING scope (decision 3)
  }
  filter this.tenantId == currentUser.tenantId // local read (principal-anchored, decision 4)
}

context Sales {
  aggregate Order implements tenantOwned {
    total: money
    // create/read/update inherit the capability's stamp + filter — no per-aggregate wiring
  }
}
```

Generated write (relational; the framework's residue is only the atomic
part — decision keyed on the *shape*, not the capability name):

```sql
INSERT INTO orders (id, total, tenant_id, data_key) VALUES ($1, $2, $tenant, $orgPath);
-- reads scoped by:  WHERE tenant_id = $currentUser.tenantId
```

### Reads — the local/deep/global ladder (authorization policy)

```ddd
context Sales {
  policy {
    allow deep on Order          // read: caller's org + all descendants
    allow write local on Order   // write: caller's own node only (write global not offered)
  }
}
```

`deep`/`global` lower to a **`startsWith`** filter, principal-anchored:

```ddd
// what `allow deep on Order` compiles to (conceptually):
filter this.dataKey == currentUser.orgPath
    || this.dataKey startsWith currentUser.orgPath + "."
```
```sql
WHERE data_key = $orgPath OR data_key LIKE $orgPath || '.%'   -- + a btree index on data_key
```

The `data_key` prefix **btree index** is the sole framework residue — and it
is *shape-triggered* (a field used in `startsWith` filters gets a btree
index, exactly like `unique(...)` → a unique index), not keyed on a name.

### The registry — building the org tree

The registry is stance `"registry"` (no tenant stamp/filter); its `dataKey`
is the tree path, computed in the create factory because it derives from the
*parent* row:

```ddd
context Identity {
  aggregate Organization ids guid implements tenantRegistry {
    name: string

    // signUp reads the parent's path to build the child's — a create factory
    // (a create body may read the referenced parent):
    create signUp(name: string, parent: Organization id?) {
      // dataKey := (parent is null) ? id            // root org = tenant root
      //                             : parent.dataKey + "." + id
    }
  }
}
```
```ddd
capability tenantRegistry {
  parent:  Self id? immutable    // frozen after create — immutable paths make `deep` a cheap prefix scan
  dataKey: string? managed       // the tree path; value written by the factory above
}
```

### Cross-scope write — no workflow, no override (decision 3 + 5)

Creating a record anchored to a *different* org is just "switch context,
create normally" — the stamp picks up `organizationContext.orgPath`:

```
1. Middleware establishes organizationContext = child-org
   — GATED: child-org must be within the principal's write-scope subtree (decision 5).
2. Order.create({ total: … })
   — the tenantOwned stamp writes dataKey := organizationContext.orgPath (the child's path).
```

No repo-let, no cross-scope workflow, no stamp override. If the switch is
outside the write-scope, the gate rejects it (fail-closed).

### Shared / cross-tenant data — fail-closed (decision 6)

```ddd
aggregate ExchangeRate crossTenant {   // opts OUT of the tenant filter (shared reference data)
  pair: string
  rate: decimal
}

// REQUIRED under `tenancy by`, or it is a validation error (loom.crosstenant-needs-policy):
context Reference {
  policy { allow global on ExchangeRate }   // must be explicit — no silent world-readable default
}
```

### Referencing the row — no pronoun needed (decision 7)

There is no ambient "current row" identifier. Use what exists:

```ddd
// 1. operation gate → `this` (or bare field ref, like an invariant):
operation cancel() requires this.ownerId == currentUser.id { … }
operation cancel() requires ownerId == currentUser.id { … }        // bare = this.field

// 2. reusable named policy → a typed PARAM names the row:
policy CanCancel(o: Order): bool = o.ownerId == currentUser.id
//                ^ param (declared)          ^ field access — unambiguous

// 3. bare policy-block predicate → bind explicitly with `as`:
policy { allow read on Order as o where o.ownerId == currentUser.id }
```

Params are declared in the signature; fields are `.`-accessed; `this` is
Loom's existing instance pronoun (`ThisRef`). Because nothing is ambient,
there is no param-vs-field ambiguity — which is exactly the problem
`authorization.md`'s `resource` pronoun introduced.

## What this supersedes / reconciles

| Existing surface | Final decision |
|---|---|
| `authorization.md` `DataKey` **type** + 6 magic ops | **dropped** → `string` field + `startsWith` operator |
| `authorization.md` / multi-tenancy stamp on `currentUser.orgPath` | **re-rooted** → write stamp reads `organizationContext.orgPath`; reads stay on `currentUser` |
| `authorization.md` `resource` pronoun | **dropped** → `this` / typed param / `as`-binding (no ambient pronoun) |
| `crossTenant` fail-open (relies on global `enforcement`) | **fail-closed** → explicit read policy required |
| `__loomDeepScope__` internal sentinel | **surfaced** → an ordinary `startsWith` filter |

## The only genuinely-new language surface

Everything above reuses existing constructs (`capability`, `stamp`,
`filter`, `create` factory, `policy`, `internal` field-role) except **one**
addition: the **`startsWith` (prefix-match) filter operator**. No `DataKey`
type, no magic ops, no name-gated framework behavior — the sole framework
residue is the shape-triggered prefix index.

## Open (owner) questions carried over

1. `organizationContext` set-surface (header / "act as" / path) + the
   fail-closed gate mechanism (`organization-context` OQ 1–2).
2. `currentUser.orgPath` disposition once `organizationContext` exists —
   keep as the principal's home path (recommended) vs deprecate.
3. Two flat accessors vs a unified `context.*` root (recommend flat now).
