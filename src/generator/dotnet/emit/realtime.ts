// ---------------------------------------------------------------------------
// Realtime SSE wire — `Infrastructure/Realtime/RealtimeHub.cs` +
// `Infrastructure/Events/RealtimeDomainEventDispatcher.cs` (channels.md,
// Part I).  Events carried by a `delivery: broadcast` channel stream to
// connected browsers at GET /api/realtime/events; the frontend `EventSource`
// client consumes the SAME wire the Hono backend serves — `event: <EventType>`
// frames + camelCase JSON data, a 15s keep-alive ping.
//
//   - `RealtimeHub` — a singleton with a thread-safe subscriber registry
//     (`ConcurrentDictionary<Guid, Channel<string>>`) and `Publish`, which
//     serializes a carried event to the Hono wire shape (camelCase, ids
//     unwrapped, canonical instants) and fans the frame out.
//   - `RealtimeDomainEventDispatcher` — the `IDomainEventDispatcher` decorator
//     Program.cs wraps the real dispatcher with, so every dispatched event also
//     reaches the wire (mirrors Hono's `realtimeTee`).
//   - The SSE endpoint itself is a minimal-API `MapGet` in Program.cs.
//
// Two topologies (channels.md "Realtime topology" — rooms + policy-derived
// routing v1), mirroring the Hono backend:
//
//   - Untenanted context (no `tenantOwned` aggregate): single-hop
//     broadcast-to-all, byte-identical to the pre-rooms wire.
//   - Tenant-owned context: delivery is scoped by the tenant DataKey
//     (`currentUser.<claim>`, the equality part of the `tenantOwned` read
//     policy — the claim `tenancy by user.<claim>` bound, NOT the row column
//     `tenantId`).  A tenant-scoped event reaches only subscribers in the
//     emitter's tenant room — never cross-tenant.  A connection derives its
//     room from the verified principal at connect (never a client value); an
//     unauthenticated connection joins no room.
//
// The authorized read stays the gate either way — clients refetch through
// the API.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../../ir/util/channels.js";
import { type RealtimeRoomPlan, realtimeRoomPlan } from "../../../ir/util/realtime-rooms.js";
import { upperFirst } from "../../../util/naming.js";

/** The broadcast-carried (UI-observable) event names of a context, sorted. */
export function realtimeTypesOf(ctx: BoundedContextIR): string[] {
  return [...realtimeEventTypes(ctx)].sort();
}

/** The realtime room plan for a context — `tenantScoped` when it hosts a
 *  `tenantOwned` aggregate whose events reach the broadcast wire.  The .NET
 *  emitter reads it exactly like the Hono one (shared derivation core). */
export function realtimeRoomPlanOf(
  ctx: BoundedContextIR,
  sys: Pick<SystemIR, "tenancy"> | undefined,
): RealtimeRoomPlan {
  return realtimeRoomPlan(ctx, sys);
}

/** The `User` record property carrying the tenant room key — the bound
 *  `tenancy by user.<claim>`, Pascal-cased exactly as `auth-emit.ts` declares
 *  the principal's properties (`upperFirst(f.name)`).  Never `TenantId` unless
 *  that is the declared claim: that name is the ROW column. */
export function realtimeTenantClaimProperty(plan: RealtimeRoomPlan): string {
  return upperFirst(plan.tenantClaimField);
}

/** The subscriber hub + wire serializer.  Registered as a singleton so the
 *  scoped dispatcher decorator AND the SSE endpoint share one registry.  A
 *  tenant-scoped plan emits the room-keyed variant; otherwise the v1
 *  broadcast-to-all hub (byte-identical). */
export function renderRealtimeHub(ns: string, types: string[], plan: RealtimeRoomPlan): string {
  return plan.tenantScoped ? renderRoomScopedHub(ns, types, plan) : renderBroadcastHub(ns, types);
}

/** v1 broadcast-to-all hub — kept byte-identical for untenanted contexts. */
function renderBroadcastHub(ns: string, types: string[]): string {
  const typeList = types.map((t) => `"${t}"`).join(", ");
  return `// Auto-generated.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using ${ns}.Domain.Events;

namespace ${ns}.Infrastructure.Realtime;

/// <summary>Realtime SSE hub (channels.md Part I): a thread-safe registry of
/// connected browser streams, and the fan-out that serializes a carried event
/// to the Hono wire shape and pushes it to each.</summary>
public sealed class RealtimeHub
{
    /// <summary>Events carried by a broadcast channel — the UI-observable set.</summary>
    public static readonly IReadOnlySet<string> EventTypes = new HashSet<string> { ${typeList} };

    private static readonly JsonSerializerOptions JsonOptions = BuildOptions();
    private readonly ConcurrentDictionary<Guid, Channel<string>> _subscribers = new();

    private static JsonSerializerOptions BuildOptions()
    {
        // camelCase + string enums + canonical instants — the SAME wire the MVC
        // controllers serialize (Program.cs AddJsonOptions), so the SSE payload
        // matches the frontend's expectations.
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        options.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
        options.Converters.Add(new global::${ns}.Serialization.CanonicalInstantJsonConverter());
        options.Converters.Add(new global::${ns}.Serialization.CanonicalInstantOffsetJsonConverter());
        return options;
    }

    /// <summary>Register a new browser stream; returns its id + frame reader.</summary>
    public (Guid Id, ChannelReader<string> Reader) Subscribe()
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<string>();
        _subscribers[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var channel)) channel.Writer.TryComplete();
    }

    /// <summary>Fan a carried event out to every connected SSE subscriber as an
    /// <c>event: &lt;Type&gt;</c> frame + camelCase JSON data.</summary>
    public void Publish(IDomainEvent domainEvent)
    {
        var type = domainEvent.GetType().Name;
        if (!EventTypes.Contains(type)) return;
        var node = JsonSerializer.SerializeToNode(domainEvent, domainEvent.GetType(), JsonOptions)?.AsObject()
            ?? new JsonObject();
        Unwrap(node);
        node["type"] = type;
        var frame = $"event: {type}\\ndata: {node.ToJsonString(JsonOptions)}\\n\\n";
        foreach (var channel in _subscribers.Values) channel.Writer.TryWrite(frame);
    }

    /// <summary>Strongly-typed ids serialize as <c>{ "value": ... }</c>; unwrap
    /// them to the bare value so the wire matches Hono's erased string ids.</summary>
    private static void Unwrap(JsonObject obj)
    {
        foreach (var key in obj.Select(kv => kv.Key).ToList())
        {
            if (obj[key] is JsonObject nested)
            {
                if (nested.Count == 1 && nested["value"] is JsonValue value)
                {
                    obj[key] = value.DeepClone();
                }
                else
                {
                    Unwrap(nested);
                }
            }
        }
    }
}
`;
}

/** Tenant-scoped hub (channels.md rooms + policy-derived routing v1): the
 *  subscriber registry is keyed by the tenant DataKey; tenant-scoped events
 *  reach only the emitter's tenant room, never cross-tenant. */
function renderRoomScopedHub(ns: string, types: string[], plan: RealtimeRoomPlan): string {
  const typeList = types.map((t) => `"${t}"`).join(", ");
  const tenantTypes = [...plan.tenantEventTypes].sort();
  const tenantList = tenantTypes.map((t) => `"${t}"`).join(", ");
  const claimProp = realtimeTenantClaimProperty(plan);
  const idFieldEntries = tenantTypes
    .map((t) => {
      const fields = plan.eventIdFields.get(t) ?? [];
      // `new[] { }` is CS0826 (no best type) — an id-less tenant-scoped event
      // (the fail-closed classification) needs the explicit empty array.
      const arr =
        fields.length > 0
          ? `new[] { ${fields.map((f) => `"${f}"`).join(", ")} }`
          : "System.Array.Empty<string>()";
      return `        { "${t}", ${arr} },`;
    })
    .join("\n");
  return `// Auto-generated.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;

namespace ${ns}.Infrastructure.Realtime;

/// <summary>Realtime SSE hub (channels.md rooms + policy-derived routing v1):
/// this context hosts tenant-owned aggregates, so delivery is scoped by the
/// tenant DataKey (<c>currentUser.${plan.tenantClaimField}</c>, the equality part of the
/// <c>tenantOwned</c> read policy).  A tenant-scoped event reaches only
/// subscribers in the emitter's tenant room — never cross-tenant; the
/// authorized read remains the gate.</summary>
public sealed class RealtimeHub
{
    /// <summary>Events carried by a broadcast channel — the UI-observable set.</summary>
    public static readonly IReadOnlySet<string> EventTypes = new HashSet<string> { ${typeList} };

    /// <summary>Events this tenant-owned context routes to the emitter's tenant
    /// room only, never broadcast cross-tenant — everything it carries except the
    /// events provably about <c>crossTenant</c> (shared) data.</summary>
    private static readonly HashSet<string> TenantScopedEventTypes = new() { ${tenantList} };

    /// <summary>Id-reference (<c>&lt;Agg&gt; id</c>) fields kept when a
    /// tenant-scoped event can't be tenant-routed (dispatched with no ambient
    /// request — outbox relay drain / timer scheduler): it degrades to a refetch
    /// ticket (type + ids, no scalar payload) and the authorized read re-gates.</summary>
    private static readonly Dictionary<string, string[]> EventIdFields = new()
    {
${idFieldEntries}
    };

    private static readonly JsonSerializerOptions JsonOptions = BuildOptions();
    /// <summary>Every live connection — receives tenant-agnostic (global)
    /// events and any broadcast refetch ticket.</summary>
    private readonly ConcurrentDictionary<Guid, Channel<string>> _subscribers = new();
    /// <summary>Per-tenant rooms (key = <c>currentUser.${plan.tenantClaimField}</c>, the
    /// bound tenancy claim) — a connection joins its own tenant's room at
    /// connect.</summary>
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Channel<string>>> _rooms = new();
    /// <summary>Each connection's joined tenant, so Unsubscribe can leave the
    /// room without scanning.</summary>
    private readonly ConcurrentDictionary<Guid, string> _subscriberTenant = new();

    private static JsonSerializerOptions BuildOptions()
    {
        // camelCase + string enums + canonical instants — the SAME wire the MVC
        // controllers serialize (Program.cs AddJsonOptions), so the SSE payload
        // matches the frontend's expectations.
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        options.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
        options.Converters.Add(new global::${ns}.Serialization.CanonicalInstantJsonConverter());
        options.Converters.Add(new global::${ns}.Serialization.CanonicalInstantOffsetJsonConverter());
        return options;
    }

    /// <summary>Register a new browser stream, joining <paramref name="tenant"/>'s
    /// room when the connecting principal carries one (null ⇒ global only, no
    /// room — an unauthenticated connection never receives tenant payloads).</summary>
    public (Guid Id, ChannelReader<string> Reader) Subscribe(string? tenant)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<string>();
        _subscribers[id] = channel;
        if (tenant is not null)
        {
            _rooms.GetOrAdd(tenant, _ => new()).TryAdd(id, channel);
            _subscriberTenant[id] = tenant;
        }
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var channel)) channel.Writer.TryComplete();
        if (_subscriberTenant.TryRemove(id, out var tenant) && _rooms.TryGetValue(tenant, out var room))
        {
            room.TryRemove(id, out _);
        }
    }

    /// <summary>Fan a carried event out to the subscribers its policy admits.  A
    /// global event goes to every connection; a tenant-scoped event goes to the
    /// emitter's tenant room only (full payload).  With no ambient tenant the
    /// subset can't be proven, so it degrades to a refetch ticket broadcast
    /// (over-delivery of a ticket is harmless — the authorized refetch re-gates).</summary>
    public void Publish(IDomainEvent domainEvent)
    {
        var type = domainEvent.GetType().Name;
        if (!EventTypes.Contains(type)) return;
        var node = JsonSerializer.SerializeToNode(domainEvent, domainEvent.GetType(), JsonOptions)?.AsObject()
            ?? new JsonObject();
        Unwrap(node);
        node["type"] = type;
        if (!TenantScopedEventTypes.Contains(type))
        {
            var frame = Frame(type, node);
            foreach (var channel in _subscribers.Values) channel.Writer.TryWrite(frame);
            return;
        }
        // The writing request's tenant, off the ambient RequestContext — present
        // for inline-dispatched events (the write that caused them), null outside
        // a request (outbox relay drain / timer scheduler).
        var tenant = RequestContext.Current?.CurrentUser is { } user ? user.${claimProp}.ToString() : null;
        if (tenant is not null)
        {
            if (_rooms.TryGetValue(tenant, out var room))
            {
                var frame = Frame(type, node);
                foreach (var channel in room.Values) channel.Writer.TryWrite(frame);
            }
            return;
        }
        var ticket = Ticket(type, node);
        var ticketFrame = Frame(type, ticket);
        foreach (var channel in _subscribers.Values) channel.Writer.TryWrite(ticketFrame);
    }

    private static string Frame(string type, JsonObject payload)
        => $"event: {type}\\ndata: {payload.ToJsonString(JsonOptions)}\\n\\n";

    /// <summary>Strip a tenant-scoped event to a refetch ticket — its type plus
    /// the <c>&lt;Agg&gt; id</c> reference fields, no other payload.</summary>
    private static JsonObject Ticket(string type, JsonObject node)
    {
        var ticket = new JsonObject { ["type"] = type };
        if (EventIdFields.TryGetValue(type, out var fields))
        {
            foreach (var field in fields)
            {
                var key = JsonNamingPolicy.CamelCase.ConvertName(field);
                if (node[key] is { } value) ticket[key] = value.DeepClone();
            }
        }
        return ticket;
    }

    /// <summary>Strongly-typed ids serialize as <c>{ "value": ... }</c>; unwrap
    /// them to the bare value so the wire matches Hono's erased string ids.</summary>
    private static void Unwrap(JsonObject obj)
    {
        foreach (var key in obj.Select(kv => kv.Key).ToList())
        {
            if (obj[key] is JsonObject nested)
            {
                if (nested.Count == 1 && nested["value"] is JsonValue value)
                {
                    obj[key] = value.DeepClone();
                }
                else
                {
                    Unwrap(nested);
                }
            }
        }
    }
}
`;
}

/** The `IDomainEventDispatcher` decorator — publishes each dispatched event to
 *  the SSE hub, then delegates.  Program.cs wraps whichever real dispatcher
 *  (no-op / in-process / outbox) with this. */
export function renderRealtimeDispatcher(ns: string): string {
  return `// Auto-generated.
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
using ${ns}.Infrastructure.Realtime;

namespace ${ns}.Infrastructure.Events;

/// <summary>Dispatcher decorator (channels.md Part I): every dispatched event
/// also reaches the SSE wire, then delegates to the wrapped dispatcher — so
/// durable (relayed) and ephemeral (inline) events both stream.</summary>
public sealed class RealtimeDomainEventDispatcher : IDomainEventDispatcher
{
    private readonly IDomainEventDispatcher _inner;
    private readonly RealtimeHub _hub;

    public RealtimeDomainEventDispatcher(IDomainEventDispatcher inner, RealtimeHub hub)
    {
        _inner = inner;
        _hub = hub;
    }

    public Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default)
    {
        _hub.Publish(ev);
        return _inner.DispatchAsync(ev, cancellationToken);
    }

    /// <summary>The write-tx outbox capture (design §1): the repository calls
    /// it inside its save transaction and the wrapped dispatcher stages the row
    /// there.  Without this forward the interface default would swallow it and
    /// silently demote the durable path back to a second, post-commit
    /// transaction.
    ///
    /// It ALSO tees the CAPTURED events to the SSE hub, because this is the
    /// only place a durable event passes through the decorator: a durable
    /// (retention log / work) event is swallowed here by the outbox and the
    /// relay drains it through the RAW inner dispatcher, so it never reaches
    /// <see cref="DispatchAsync"/> and would otherwise produce no SSE frame at
    /// all.  Only the captured ones are teed — the deferred (ephemeral) events
    /// come straight back to the repository, which dispatches them through
    /// <see cref="DispatchAsync"/>, and teeing them here too would emit the
    /// frame twice.</summary>
    public async Task<IReadOnlyList<IDomainEvent>> RecordDurableAsync(
        IReadOnlyList<IDomainEvent> events,
        System.Data.Common.DbTransaction? transaction = null,
        CancellationToken cancellationToken = default)
    {
        var deferred = await _inner.RecordDurableAsync(events, transaction, cancellationToken);
        foreach (var ev in events)
        {
            var captured = true;
            foreach (var pending in deferred)
            {
                if (ReferenceEquals(pending, ev)) { captured = false; break; }
            }
            if (captured) _hub.Publish(ev);
        }
        return deferred;
    }
}
`;
}
