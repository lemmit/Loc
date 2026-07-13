# Node persist-time auditing — paper simulation

Status: **proposed, awaiting sign-off.** Follow-on to the shipped .NET/Java work
(`capability-stamp-dedup-simulation.md`, PR #1540). Do NOT implement before the
open questions in §7 are answered.

## Premise (corrected from the first pass)

The node/Hono backend has **two** selectable persistence adapters
(`deployable … { platform: node { persistence: drizzle | mikroorm } }`), wired in
`src/platform/hono/v4/index.ts`:

- **`drizzle`** (default) — full-surface; supports audit stamping **today**, via
  the operation-time `_stampOnCreate`/`_stampOnUpdate` path (the "ugly" method we
  want gone).
- **`mikroorm`** — minimal v1; audit stamping is **gated off** by
  `validateMikroOrmSupport` (`src/ir/validate/checks/system-checks.ts:1502`,
  `loom.mikroorm-unsupported` → *"uses audit stamping"*). It can't stamp at all
  yet.

So "MikroORM vs Drizzle" is not "swap ORMs" (both already exist) — it's two
different jobs:

1. **Drizzle: a refactor** — relocate stamping from the domain method + handler
   into the persistence layer. Same observable behavior, kills `_stampOn`.
2. **MikroORM: a parity-gap closure** — lift the `contextStamps` clause from the
   gate AND implement persist-time stamping with a flush hook (the true twin of
   the EF interceptor / JPA `AuditingEntityListener`).

Goal for both: the **domain entity is pure** (no stamp method), the **handler
never stamps**, the **persistence layer** stamps, and the principal comes from an
**ambient async-context carrier** — exactly the shape now shipped on .NET and
Java.

## 0. The shared enabler — the ambient actor already exists

The generated Hono app already runs every request inside an `AsyncLocalStorage`
frame (`src/platform/hono/v4/obs/als`, populated by the request-id +
auth middleware). Its `RequestContext` carries the principal id:

```ts
export interface RequestContext {
  correlationId: string;
  currentUser: User | null;   // the verified principal (null before auth)
  actorId: string | null;     // "the principal's id, stamped by auth alongside currentUser"
  // …locale, logger, scopeId/parentId
}
export function requestContext(): RequestContext | undefined { /* ALS getStore */ }
```

`requestContext()?.actorId` is the node twin of .NET's
`RequestContext.Current!.CurrentUser!.Id` and Java's `AuditorAware<UUID>`. The
persistence layer can read it with **zero threading** — no `currentUser` param,
no handler plumbing. This is what makes deleting `_stampOn` possible.

## 1. BEFORE (real output — `persistence: drizzle`)

### 1a. Domain entity carries the infra stamp methods (`api/domain/order.ts`)
```ts
get createdAt(): Date { return this._createdAt; }
// …
_stampOnCreate(currentUser: User): void {
  this._createdAt = new Date();
  this._createdBy = currentUser.id;
}
_stampOnUpdate(currentUser: User): void {
  this._updatedAt = new Date();
  this._updatedBy = currentUser.id;
}
```

### 1b. Handler stamps at OPERATION time (`api/http/order.routes.ts`)
```ts
const created = Order.create({ code: … });
const currentUser = (c as unknown as { get(k: "currentUser"): User }).get("currentUser");
created._stampOnCreate(currentUser);   // domain mutated in the handler, before save
await repo.save(created);
```

### 1c. The Drizzle save choke point (`api/db/repositories/order-repository.ts`)
```ts
async save(aggregate: Order): Promise<void> {
  const rootRow = this.toRow(aggregate);
  await tx.insert(schema.orders).values(rootRow)
    .onConflictDoUpdate({ target: schema.orders.id, set: rootRow });
}
```

On `persistence: mikroorm` the same model fails validation up front
(`loom.mikroorm-unsupported`) — no stamping path exists.

## 2. Drizzle — AFTER (proposed)

Delete 1a + 1b entirely (mirrors the Java deletion). Stamp at the `save()` choke
point, reading the ambient actor. A tiny shared helper keeps the two arms honest:

```ts
// emitted once per project, e.g. api/db/audit-stamp.ts
export function stampInsert<T>(row: T): T {
  const now = new Date();
  const actor = requestContext()?.actorId ?? null;
  return { ...row, createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor };
}
export function stampUpdate<T>(row: T): Partial<T> {
  const now = new Date();
  const actor = requestContext()?.actorId ?? null;
  const { createdAt: _c, createdBy: _cb, ...rest } = row as Record<string, unknown>;
  return { ...rest, updatedAt: now, updatedBy: actor } as Partial<T>;   // createdAt/By NOT re-written ⇒ immutable
}
```
```ts
// generated save() for an auditable aggregate
async save(aggregate: Order): Promise<void> {
  const row = this.toRow(aggregate);
  await tx.insert(schema.orders).values(stampInsert(row))
    .onConflictDoUpdate({ target: schema.orders.id, set: stampUpdate(row) });
}
```
Dropping `createdAt`/`createdBy` from the update `set` is the exact analog of
Java's `@Column(updatable = false)` and the .NET create-only switch arm. The
domain `Order` becomes a pure aggregate; the handler is just
`create → save`.

There is no UoW on Drizzle, so "persist time" = the `save()` statement (right
after the operation body); the `loom.stamp-read-before-flush` guard (§7 of the
shipped work) already forbids reading a stamp earlier, so behavior stays uniform.

## 3. MikroORM — AFTER (proposed; parity-gap closure)

MikroORM **is** a Unit-of-Work ORM with a real flush — the genuine twin of the
EF interceptor and JPA listener. Two emit shapes are possible (entities here are
`EntitySchema`-defined, not decorator classes):

**Option 3-A — global `EventSubscriber` (closest to .NET/Java; one registration):**
```ts
export class AuditSubscriber implements EventSubscriber {
  onFlush(args: FlushEventArgs): void {
    const actor = requestContext()?.actorId ?? null;
    const now = new Date();
    for (const cs of args.getUnitOfWork().getChangeSets()) {
      if (!AUDITED_ROWS.has(cs.entity.constructor)) continue;   // marker-set, like `is IAuditable`
      if (cs.type === ChangeSetType.Create) { cs.entity.createdAt = now; cs.entity.createdBy = actor; }
      cs.entity.updatedAt = now; cs.entity.updatedBy = actor;
    }
  }
}
// registered once in mikro-orm.config: subscribers: [new AuditSubscriber()]
```

**Option 3-B — per-`EntitySchema` hooks (more local, no shared registry):**
```ts
export const OrderRowSchema = new EntitySchema<OrderRow>({
  class: OrderRow,
  tableName: "orders",
  hooks: {
    beforeCreate: [(args) => { const a = requestContext()?.actorId ?? null;
      args.entity.createdAt = args.entity.updatedAt = new Date();
      args.entity.createdBy = args.entity.updatedBy = a; }],
    beforeUpdate: [(args) => { args.entity.updatedAt = new Date();
      args.entity.updatedBy = requestContext()?.actorId ?? null; }],
  },
  properties: { /* … */ },
});
```

Either way: **lift the `contextStamps` rejection** from `validateMikroOrmSupport`
(remove the `system-checks.ts:1502` clause), and the domain entity + handler lose
`_stampOn` just like the Drizzle path. 3-A is recommended — it makes
*one global flush hook reading an ambient actor* the literal cross-backend
pattern.

## 4. The five-backend unification this lands

| backend | where the stamp is written | principal source | mechanism |
|---|---|---|---|
| .NET | `SaveChangesInterceptor` (flush) | `RequestContext.Current` | UoW interceptor |
| Java | `AuditingEntityListener` (`@PrePersist`/`@PreUpdate`) | `AuditorAware<UUID>` | UoW listener |
| node · mikroorm | `EventSubscriber.onFlush` | `requestContext().actorId` | UoW subscriber |
| node · drizzle | generated `save()` (insert/upsert) | `requestContext().actorId` | save-site inject (no UoW) |
| python | *(out of scope here — separate audit)* | — | — |

Four of five become the *same* sentence: a flush/persist hook over change-tracked
rows, reading an ambient async-context actor. Drizzle is the only one without a
UoW and so injects at the emitted `save()` — but reads the same ambient actor.
The domain entity and the route handler carry **no** stamping on any of them.

## 5. IR / emit impact (paper only — do NOT implement yet)

- **No grammar / IR change.** "Is auditable" stays derived from
  `agg.contextStamps` (no new field), as on .NET/Java.
- **Delete:** `_stampOn*` emission in `src/generator/typescript/emit/aggregate.ts`
  (the `stampMethod`/`stampMethods` block) + the handler calls in
  `src/platform/hono/v4/routes-builder.ts` (create + update paths). Drop the now-dead
  `currentUser` locals where the body no longer uses them.
- **Drizzle:** emit `audit-stamp.ts` (the `stampInsert`/`stampUpdate` helper) and
  wrap the `values(...)` / `set:` in the repository `save()` builder
  (`src/generator/typescript/repository-builder.ts`) when the aggregate is auditable.
- **MikroORM:** add the subscriber emit (or `hooks`) in
  `src/generator/typescript/emit/mikroorm.ts`, register it in the config, and
  **remove the `contextStamps` clause** from `validateMikroOrmSupport`
  (`src/ir/validate/checks/system-checks.ts`).
- **Gates:** `behavioral-e2e` (Hono on PGlite — boots the generated app, round-trips
  a create/update and asserts the audit columns populate), `hono-build`
  (`tsc --noEmit`), plus a mikroorm-adapter generator test once the gate lifts.

## 6. Risk ledger + recommendation

| risk | severity | mitigation |
|---|---|---|
| Drizzle `save()` is also hit by non-handler callers (seed, workflow, saga) — stamping everywhere could double-write `updatedAt` on internal saves | med | desired: any persist *is* a modification; `updatedAt` should advance. `createdAt` immutable via the `stampUpdate` omit. Confirm seed wants the stamp (likely yes). |
| `actorId` is null for system/seed/non-authed writes | low | already the semantics today (`currentUser ?? null`); columns are nullable. |
| MikroORM `EventSubscriber` + ALS interaction across `em.fork()` | med | `requestContext()` is request-scoped ALS, independent of the EM fork; verify in the behavioral boot. |
| lifting the mikroorm gate exposes other minimal-adapter gaps under audit models | low | the gate has independent clauses; lifting only `contextStamps` leaves the rest enforced. |

### Recommendation

**Sequence as two slices.** Ship the **Drizzle refactor first** — that's where
auditing actually lives today and where `_stampOn` is ugly; it's a pure,
behavior-preserving cleanup gated by `behavioral-e2e`. Then do **MikroORM
auditing** as a follow-on parity slice (3-A global subscriber + lift the gate
clause) — it's net-new capability, and it's the one that makes the elegant
"global flush hook + ambient actor" pattern literally identical across .NET,
Java, and node. Keep them separate PRs: the first can't regress, the second
widens support and deserves its own review.

## 7. Open questions (answer before building)

1. **Slice order / scope:** Drizzle-only first (recommended), or both adapters in
   one go?
2. **MikroORM hook shape:** global `EventSubscriber` (3-A, recommended) or
   per-`EntitySchema` `hooks` (3-B)?
3. **Marker on node?** .NET dropped its marker (concrete switch); Java kept a
   pure `Auditable` interface. For node 3-A we need *some* "is this row audited?"
   signal — a registered `AUDITED_ROWS` set (no marker) or a row-class marker.
   Preference?
4. **Seed/workflow saves:** should programmatic (non-request) saves stamp too
   (actor null), or only request-scoped saves? (Affects whether the helper is
   unconditional or guarded on `requestContext()` presence.)
