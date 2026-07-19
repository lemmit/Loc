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
// v1 topology is single-hop broadcast-to-all: no rooms, no edge relay, no
// policy-derived router (channels.md "Realtime topology").  The authorized
// read stays the gate — clients refetch through the API.
// ---------------------------------------------------------------------------

import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../../ir/util/channels.js";

/** The broadcast-carried (UI-observable) event names of a context, sorted. */
export function realtimeTypesOf(ctx: BoundedContextIR): string[] {
  return [...realtimeEventTypes(ctx)].sort();
}

/** The subscriber hub + wire serializer.  Registered as a singleton so the
 *  scoped dispatcher decorator AND the SSE endpoint share one registry. */
export function renderRealtimeHub(ns: string, types: string[]): string {
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
        options.Converters.Add(new ${ns}.Serialization.CanonicalInstantJsonConverter());
        options.Converters.Add(new ${ns}.Serialization.CanonicalInstantOffsetJsonConverter());
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

/** The `IDomainEventDispatcher` decorator — publishes each dispatched event to
 *  the SSE hub, then delegates.  Program.cs wraps whichever real dispatcher
 *  (no-op / in-process / outbox) with this. */
export function renderRealtimeDispatcher(ns: string): string {
  return `// Auto-generated.
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
}
`;
}
