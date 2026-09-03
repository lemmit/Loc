### 1c node-ts — claude/wave-1-node-ts @ 58a5b48

> Branch naming: `claude/wave-1/node-ts` is unusable — git refuses a ref under an
> existing branch ref (`claude/wave-1` exists), so the sub-branch is
> `claude/wave-1-node-ts`, matching 1b/1g.

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `F2-ADP-5` (P0) | already-done-verified + **gate added** | `test/generator/typescript/write-scope-shapes-node.test.ts` — "document: the blob command load refuses without loading" and "event-sourced: same refusal on the folded stream" fail on the missing `// policy { deny write on Doc } — no row is in write scope.` when `blobGetByIdLines`'s deny arm is disabled; "embedded: the queryable root gets the same pre-guard the relational root has" / "embedded: the predicate is pushed into the pre-guard query" fail on the missing `const inScope = await this.db` / `requireCurrentUser().tenantId` when the embedded builder's `writeScopeGuardLines` spread is emptied | The emitters were already at parity on this base (fixed inside #2668 itself): embedded routes through `writeScopeGuardLines`, document + event-sourced through `blobGetByIdLines`. Verified by generating `deny write` × 4 shapes × 2 adapters and a narrowing (`allow deep`) variant, and diffing the eight `getById` bodies. Nothing on the node side PINNED it — `policy-write-scope-shapes.test.ts` asserts python + java, `policy-write-scope.test.ts` asserts node RELATIONAL only — so a regression on any blob shape was an authorization hole that type-checks. 16 cases added, per adapter × per shape, asserting the REFUSAL inside the sliced `getById` body. |
| `F2-ADP-6` | already-done-verified | `test/generator/typescript/mikroorm-reserved-identifiers.test.ts` — "quotes the receiver column of every queryable intrinsic" fails on `raw("starts_with(\"end\", ?)", [p])` when `mikroIdent` returns the bare name | `mikroColumnSql` routes through `mikroIdent` (`isReservedIdent` → `"…"`), gate already present. No residue. |
| `F2-CB-C8-domainservice-op-body-node-import` | already-done-verified | `test/generator/hono/domain-service-op-body-import.test.ts` — "imports exactly the service namespaces the operation bodies call" fails on `import { Rules } from "./services";` when `serviceImport` is forced null | `emit/aggregate.ts` body-scans `ctx.domainServices` for `\bName\.\w`, same narrowing as the VO/enum imports. |
| `F2-EXPR-4` | already-done-verified | `test/generator/typescript/render-expr-kinds.test.ts` — "dedupes a value-object collection through the VO's own `equals`", "tests value-object membership through `equals`, not `.includes`" and "computes the right answers at runtime" (`expected 3 to be 2`) all fail when `receiverElementEqMethod` stops returning `"equals"` | The runtime case is the good part: it EVALUATES the rendered expression against a stand-in VO class, so it asserts the answer, not the source text. |
| `M-T6.51` | already-done-verified | `test/generator/typescript/nonrelational-filter-bypass.test.ts` — "`ignoring <Cap>` drops the bypassed conjunct from THAT find only", "`ignoring *` drops every capability conjunct" and "a query-time projection's read is synthesised at all, and honours its own `ignoring`" fail when `documentFindMethod` drops the `{bypassAll, bypassCaps}` argument | Landed in W1b node-ts (#2705), wider than the mission: document/drizzle, document/mikroorm and embedded all shared the reuse, and the synthesised query-time-projection reads inherit the bypass through their own `FindIR`. |
| `F2-W-05` | already-done-verified + **residue fixed** (`8d16521`) | `test/generator/audit-history-node.test.ts` — "renders the trail's `at` in the canonical RS-4 form, not `.000Z`" fails on `expect(atLine).toContain('row.at.toISOString().replace(/\.?0+Z$/, "Z")')` when the mapper line reverts to a bare `toISOString()` | The ROW is closed: `canonicalIsoExpr` trims on the aggregate `toWire` path and the query-time projection routes. One wire datetime was missed — the `audited` trail's own `at` on `GET /{id}/history`. Generated the same audited aggregate on four backends: node `row.at.toISOString()` → `…00.000Z`, .NET regex-trims, java `Instant.toString()`, python `iso()` → `…00Z`. Now routed through `canonicalIsoExpr`. The test also evaluates the rendered expression, so it pins the string the endpoint answers. |
| `F2-CB-C1-paged-nonrelational` | already-done-verified | `test/generator/typescript/paged-nonrelational.test.ts` — "emits a paged repository method the paged route can actually call" (`async inRegion(region: string, page: …`) and "pages the BLOB shapes in memory over the `?sort=` whitelist" (`const matched = all.filter((x) => x.r…`) fail when `documentFindMethod`'s `pagedReturn` branch is disabled | **The coordinator's relay that "the paged fix landed on node RELATIONAL only" is stale.** On this base all four node shapes carry the paged arm — `repository-document-builder.ts:501`, `repository-embedded-builder.ts:376`, `repository-eventsourced-builder.ts:259`, `emit/mikroorm.ts:2182` — and the gate covers document/embedded/eventLog × both adapters (5 cases). The `dotnet` / `python` / `elixir` arms of the row are untouched and still open. |
| `G2667-C2-money-array-no-roundtrip` | already-done-verified | `test/generator/typescript/scalar-collection-roundtrip.test.ts` — "hydrates money[]/decimal[] elements and leaves int[]/string[] bare" fails on `prices: (root.prices ?? []).map((__v) => new Decimal(__v))` when `arrayElementHydrate` stops matching `money` | `hydrateValueExpr` has the `array` arm the row said was missing, with the symmetric dehydrate on the save path. Incidental finding: `money[]` on `persistence: mikroorm` is an HONEST gate (`loom.mikroorm-unsupported#scalar-array`), so the round-trip only has to hold on drizzle. |
| `M-T5.14-reading-service-readport-not-threaded` (node arm) | already-done-verified | `test/generator/typescript/handler-reading-service.test.ts` — "the reading call gets its read-port handle, ahead of the user args" (`Registration.isHolderFree(accounts, h…`) and "the reading call is awaited" fail when `explicit-handlers-builder.ts` drops `readPortArgs` from the handler's `return` render | Landed in W1b node-ts (#2705). The four other arms are handed off below with their exact shapes, re-derived on this base. |
| `static-subpath-405-node-only` | handed-off (no code — node is correct) | n/a | Guard + the four backends that lack it, below. |
| `G2667-C4-mikroorm-save-no-transaction` | already-done-verified + **residue fixed** (`4a02c3f`) | `test/adapters/node-mikroorm-save-transaction.test.ts` — "drains the events before the tx and records the durable ones on its handle" fails on `recordDurable is called: expected -1 to be greater than or equal to 0` when `MIKRO_OUTBOX_RECORD_LINE` is dropped from the save's tx body; "the mikro outbox dispatcher exposes the transactional capture hook" fails on the missing `async recordDurable(events: readonly Events.DomainEvent[], tx: unknown)` when that arm is renamed | The ROW is closed — all three transactional mikro saves wrap in `em.transactional(...)`, pinned per shape. The atomicity question the row told me to cross-check (#2667 register item 5) was still open on mikro: the outbox insert happened in the dispatcher's `dispatch` arm on a `keepTransactionContext` fork, which only JOINS an AMBIENT transaction — and an ordinary mutation route opens none. So the durable outbox row committed SEPARATELY, after the aggregate's transaction had closed; a crash in that window lost the event silently. Answered the way drizzle already answers it (`recordDurable(pendingEvents, tx)` inside the write transaction). |
| `G2667-D3-projection-join-unguarded-index` (node arm — coordinator addition) | **fixed** (`40202d9`) | `test/generator/typescript/query-projection-join-missing.test.ts` — per adapter, "never reads through a non-null assertion on the join map" (`expected … not to match /customerById\.get\([^)]*\)!/`), "binds the lookup once per row and guards its presence" (missing `__j0 === undefined ? null :`) and "keeps every wire wrap INSIDE the guarded branch" (`expected [] to have a length of 4`) all fail when `renderProjectionSelect` restores `<map>.get(<id>)!.<member>` and `joinBindFor` returns null | Matches the .NET arm's LEFT-JOIN ruling (`b75ce2c`): source row survives, joined field carries the absent value, wire wrap inside the guard. Node binds one per-row const per join ALIAS (`const __j0 = …get(…)`) rather than .NET's one `out var` per joined SELECT. Asserted on BOTH node adapters — the repository-sourced shape is adapter-neutral. |
| `G2646-open-projection-on-event-no-channel` | handed-off (B20 question below) | n/a | Node's arm was already settled in W1b node-ts (#2705) by DEGRADING node to the other four: `buildProjectionsFile` now filters by `ctx.eventSubscriptions`, so an uncarried projection emits no fold and the tee degrades to the identity decorator. The differential is gone; the SEMANTICS question is not. |
| `M-T1.11-domain-floor-message-code` | not-reached (L, five backends + catalog) | n/a | Untouched. |

Files outside the fence (handed off): **none edited.** Every change is under
`src/platform/hono/**`, `src/generator/typescript/**` or their tests
(`test/generator/typescript/`, `test/generator/audit-history-node.test.ts`,
`test/adapters/node-mikroorm-save-transaction.test.ts`).

Local gates run + results:
- `npx tsc -b` — clean.
- `npx vitest run test/generator/typescript test/platform test/generator/hono test/system/generated-output-sentinels.test.ts` — 157 files / 1153 tests pass.
- `npx vitest run test/adapters test/generator/typescript/outbox-emission.test.ts test/generator/typescript/generator-ts.test.ts` — 26 files / 382 tests pass.
- `npx vitest run test/generator/audit-history-node.test.ts` — 9 pass.
- Node compile leg `LOOM_TS_BUILD=1 LOOM_CORPUS_TSC_CASE=<id> npx vitest run test/e2e/corpus-tsc-build.test.ts` — `projection-join`, `channels-broker`, `audit-history` all green (npm install + strict `tsc --noEmit` per project).
- Mikro compile, by hand, because no corpus case pins the mikro adapter: `channels-broker.ddd` with `persistence: mikroorm` → `node bin/cli.js generate system` → `npm install` → `npx tsc --noEmit`, exit 0. This is the project my outbox change edits.
- `npx biome ci <changed files>` — clean.

Ledger closes (ids): `F2-ADP-5`, `F2-ADP-6`, `F2-CB-C8-domainservice-op-body-node-import`,
`F2-EXPR-4`, `M-T6.51`, `F2-W-05`, `F2-CB-C1-paged-nonrelational` (node arm only —
dotnet/python/elixir stay open), `G2667-C2-money-array-no-roundtrip`,
`M-T5.14-reading-service-readport-not-threaded` (node arm only),
`G2667-C4-mikroorm-save-no-transaction`,
`G2667-D3-projection-join-unguarded-index` (node arm only).

---

#### Hand-off 1 — `M-T5.14`, the four remaining arms (re-derived on this base)

One fixture, five backends: a `reading`-tier `domainService` called from a
`queryHandler`. Node is correct; the other four emit a module that cannot
compile, each for a slightly different reason, so the fix is NOT one shared
change:

```
domainService Registration { operation isHolderFree(holder: string): bool {
  return Accounts.byHolder(holder) == null } }
queryHandler HolderFree(holder: string): bool { return Registration.isHolderFree(holder) }
```

| backend | service signature emitted | handler emits | what breaks |
|---|---|---|---|
| node ✅ | `async isHolderFree(accounts: AccountRepositoryPort, holder: string)` | `(await Registration.isHolderFree(accounts, holder))` | — |
| python | `async def is_holder_free(accounts: AccountRepositoryPort, holder: str)` | `return is_holder_free(holder)` | arity-short, un-awaited, AND the name is never imported (the handler module's whole import block is `AsyncSession`) → `NameError` |
| java | `public boolean isHolderFree(String holder)` on an `@Service` bean with `AccountRepository` constructor-injected | `return Registration.isHolderFree(holder);` | non-static method referenced from a static context; the handler injects no `Registration` |
| dotnet | `public async Task<bool> IsHolderFreeAsync(string holder, CancellationToken = default)` on a class with `IAccountRepository` ctor-injected | `return Registration.IsHolderFree(command.Holder);` | wrong NAME (`…Async`), static call on an instance class, no injected `Registration`, un-awaited |
| elixir | `Api.C.is_holder_free/1` — emitted into the CONTEXT module (ambient Repo) | `Api.Domain.Services.Registration.is_holder_free(holder)` | that module does not exist → CompileError |

So java/.NET/elixir do NOT need the node/python "thread the read ports through
the call" fix: their ports are constructor-injected (or ambient), and the defect
is that the HANDLER emitter renders a service call as a static call on a name it
neither injects nor resolves. The node fix is the template only for python.

#### Hand-off 2 — `static-subpath-405-node-only`

The guard is `emitStaticSubpathMethodGuard` in
`src/platform/hono/v4/routes-builder.ts:358`, mounted as `app.use("/:__seg", …)`
at the TOP of the aggregate router. It has to be a middleware and it has to be
first: the `@hono/zod-openapi` param validator runs inside the matched route's
own handler chain, so any check inside the `/{id}` handler is already too late —
the 422 has been answered. It answers 405 + a real `Allow` header, and uses
`Object.hasOwn` (a bare index reached `Object.prototype`, so
`/api/items/constructor` 500'd).

`grep -rn 'static sub-path' src/` still returns exactly that one site. **dotnet,
java, python and elixir have no equivalent** — their 405 handling
(`dotnet/emit/program.ts:1078`, `java/emit/api.ts:926`,
`elixir/vanilla/shell-emit.ts:1065`) is the problem-BODY shape for a 405 the
framework already decided to raise, not a guard that stops the sibling `/{id}`
route from swallowing the request first. Each port must sit BEFORE param
binding: .NET a route constraint / endpoint filter over the static segments,
java a `HandlerInterceptor` or explicit method:405 stubs, python a router-level
dependency or explicit 405 registrations, elixir extra `match` clauses in the
aggregate router scope. Each must also fix the `Allow` those paths advertise.
Mirror `test/generator/hono/declared-validation-status-and-method-guard.test.ts`
per backend. No code in my fence — node is already right.

#### Open questions for the coordinator

1. **B20 (`G2646`) — what does `projection … on(Event)` with no channel MEAN?**
   Still unanswered, and now it is answered *by omission on all five*: node was
   degraded to the other four in #2705, so an uncarried projection emits no fold
   anywhere and `loom.projection-event-uncarried` warns that "this fold never
   runs and the read-model row is never written". The two branches from the
   ledger stand: (a) an implicit in-process subscription every backend honours —
   drop the `channels.length === 0` early-return at
   `src/ir/enrich/enrichments.ts:1303` and derive unconditionally; or (b) promote
   the warning to a refusal. Consistency is no longer the argument for either;
   somebody has to decide whether a channel-less `on(Event)` is a legal way to
   write an in-process projection. Enrichment is outside my fence.

2. **The RS rule G2667-D3 needs: what IS "the absent value" on a LEFT JOIN?**
   The two shipped arms already disagree. .NET fills with `default!` — `null` for
   `string`, but `0` for `int`/`decimal`, `false` for `bool`, and
   `DateTime.MinValue` for a joined `datetime`. Node fills with `null` for every
   type (JS has no per-type `default`, and the ledger's own fix line names
   `?? null`). A joined `datetime` therefore reads `null` on node and
   `0001-01-01T00:00:00` on .NET — and the projection Response schema declares
   `z.string()` / a non-nullable C# property either way, so BOTH are outside their
   own declared wire type. Before python/java/elixir port this, the RS rule should
   say (i) which value, and (ii) whether the projection row's wire type for a
   joined field becomes nullable. I implemented the structural half that IS
   settled and left the value question here.

3. **Outbox capture is relational-only, on BOTH node adapters.** My `4a02c3f`
   brings mikro's RELATIONAL save to drizzle's transactional-capture behaviour.
   The `shape: document`, `shape: embedded` and `persistedAs: eventLog` saves
   dispatch straight off `pullEvents()` on *both* adapters — no `recordDurable`,
   so a durable channel on a non-relational aggregate is at-most-once with no
   diagnostic. That is a symmetric gap, not an adapter differential, so I did not
   widen the fix into four more emitters at the tail of the packet. It wants the
   same design ruling as item 5 and is worth a ledger row.

4. **Sub-second datetime wire form still diverges across backends** (noticed
   while closing the F2-W-05 residue, out of scope). `…00.120Z` renders as
   `.12Z` on node and .NET (both trim trailing zeros inside the fraction),
   `.120Z` on java (`Instant.toString()` groups by 3), and `.120000Z` on python
   (`isoformat()` does not trim at all). RS-4 only speaks about trailing-zero
   *fractional seconds* on whole-second instants, which is now uniform. The
   sub-second case has no rule and no gate — `test/_helpers/response-diff.ts`
   normalizes the whole timestamp to one token by design.
