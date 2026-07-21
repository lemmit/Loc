# Realtime tenant-room parity — scope SSE broadcasts per tenant on .NET / Java / Python

> Status: **PROPOSAL (2026-07-21).** Found by the post-cycle integrity audit
> (channels/realtime, M-T4.4 / M-T1.10). Realtime SSE ships on four backends
> (node/dotnet/java/python) + native LiveView on elixir, but **only node scopes
> broadcasts per tenant** — .NET, Java, and Python broadcast every realtime event
> to *every* subscriber. On a `tenantOwned` context this puts one tenant's
> mutations on another tenant's wire. Today it's an **honest** gap (a validator
> warning fires), not silent — but it's the single most material realtime
> integrity gap. This doc is the port plan.
>
> Feature reference: [`docs/channels.md`](../../channels.md) → Part I (realtime).
> Missions: [`docs/new-plan/T1-ui-frontend.md`](../../new-plan/T1-ui-frontend.md) (M-T1.10, lines ~62-63).
> Gate: `loom.realtime-tenant-broadcast` (warning), `src/ir/validate/checks/system-checks.ts:773-796`.

## Why this doc exists

`realtimeEventTypes()` (`src/ir/util/channels.ts:39`) turns a `delivery: broadcast`
channel into an SSE wire; `backendServesRealtime()` (`channels.ts:14`) returns
true for `{node, dotnet, java, python}` (elixir does realtime natively via
LiveView PubSub, `src/generator/elixir/realtime-liveview.ts`, and re-renders
through the authorized read — it has no cross-tenant wire and is out of scope).

**Only node implements tenant rooms.** The node emitter keys subscribers by tenant
(`src/platform/hono/v4/realtime-builder.ts:38` + the room plan in
`src/ir/util/realtime-rooms.ts:52`), so a broadcast reaches only same-tenant
listeners. The other three emit a single-hop broadcast-to-all with an explicit
"no rooms" comment:

- `.NET` — `src/generator/dotnet/emit/realtime.ts:17-19` (`RealtimeHub` fan-out)
- `Java` — `src/generator/java/emit/realtime.ts:19-21` (`SseEmitter` registry)
- `Python` — `src/generator/python/realtime-builder.ts:24-26` (`RealtimeDispatcher` tee)

On a `tenancy by …` system with a `tenantOwned` aggregate whose events feed a
broadcast channel, a create/update in tenant A is delivered to tenant B's open
SSE stream. The payload is the wire DTO (ids, changed fields) — a real
cross-tenant disclosure on the transport, even though the REST read path is
correctly scoped.

The validator already knows: `validateRealtimeTenantScope` raises
**`loom.realtime-tenant-broadcast` (warning)** for every non-node backend serving
a broadcast channel on a tenant-scoped context (`system-checks.ts:773-796`, node
skipped at :777). So this is *honest* — a user is warned — but a warning on a
turnkey feature that silently over-delivers PII is a weak stance; parity means
the room scoping exists on every backend that serves the wire, and the warning
narrows to zero.

## Proposed change

Port the node tenant-room registry to the three backends. The shape is identical
across them: a `Map<tenantKey, Set<Subscriber>>` populated at subscribe time from
the same per-request tenant resolution the REST scope filter already uses (the
`authz-filter` `scope` decision, `src/ir/util/tenant-stance.ts`), and a publish
that fans out only to the resolving tenant's set.

| Backend | Registry home | Subscribe keys on | Publish scopes by |
|---|---|---|---|
| node (done) | `realtime-builder.ts` | `req` tenant claim | tenant room |
| .NET | `RealtimeHub` (`dotnet/emit/realtime.ts`) | `HttpContext` tenant claim | tenant room |
| Java | `SseEmitter` registry (`java/emit/realtime.ts`) | request tenant claim | tenant room |
| Python | `app/realtime.py` (`python/realtime-builder.ts`) | request tenant claim | tenant room |

Non-tenant systems keep the existing broadcast-to-all path (gated on the same
tenancy detection the REST filter uses), so byte-identical output where no
tenancy is declared.

## Validator + gate change

`loom.realtime-tenant-broadcast` narrows as each backend gains rooms: remove the
backend from the warned set (`system-checks.ts:773-796`) in the same PR that
lands its room registry. When all four are done the warning is dead code and the
check is deleted — the parity invariant restored (every SSE backend scopes, or
there's no SSE backend to scope).

## Tests

- **Per-backend emit** — extend `test/generator/{dotnet,java,python}/realtime-emission.test.ts`
  to assert the tenant-room registry + scoped publish (mirror the node assertions
  in `test/generator/typescript/realtime-emission.test.ts:236,287` and the plan in
  `test/ir/realtime-rooms.test.ts`).
- **Runtime isolation** — a `realtime-tenancy-e2e` leg (sibling of `tenancy-e2e.yml`):
  boot the backend, open two SSE streams as two tenants, mutate as tenant A, assert
  tenant B's stream receives nothing. This is the assertion the emit tests can't make
  and the reason the gap survived (all current realtime coverage is string-tier).

## Open questions

1. **Room key for hierarchical tenancy** (`tenantRegistry` TREE) — does a subtree
   read imply a subtree *room* (ancestor sees descendant broadcasts)? Node's flat
   rooms don't answer this; align with the `orgPath` descendant-or-self predicate
   the REST path uses (`docs/tenancy.md`).
2. **Cross-tenant channels** (`crossTenant`) — a channel explicitly marked
   cross-tenant should keep broadcast-to-all; the room scoping must respect that
   opt-out.

## Related

- Deferred from the 2026-07-21 integrity audit; sibling findings in
  [`integrity-audit-2026-07-residue.md`](./integrity-audit-2026-07-residue.md).
- Realtime emit parity itself is honest and complete (no silent gaps) — only the
  tenant-room scoping is node-only.
