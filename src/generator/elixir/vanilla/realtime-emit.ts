// ---------------------------------------------------------------------------
// Realtime SSE wire — vanilla (plain Ecto/Phoenix), `channels.md` Part I.
//
// Events carried by a `delivery: broadcast` channel stream to connected
// browsers at `GET /api/realtime/events`.  The wire is the SAME one the Hono /
// .NET / Java / Python backends serve and the frontends' `EventSource` client
// (`src/generator/_frontend/realtime.ts`) consumes:
//
//     event: <EventType>\n
//     data: {"type":"<EventType>", …camelCase fields}\n
//     \n
//
// plus an `event: ping` keep-alive every 15s so proxies don't idle the
// connection out.
//
// THE TEE IS FREE ON PHOENIX.  Every domain `emit` already lowers to
// `Phoenix.PubSub.broadcast(<App>.PubSub, "events", %<Ctx>.Events.<E>{…})`
// (`workflow-execution-emit.ts` / `operation-returns-emit.ts` /
// `eventsourced-emit.ts`), so the SSE controller simply subscribes to that
// topic — no dispatcher decorator (Hono's `realtimeTee`, python's
// `RealtimeDispatcher`, .NET's hosted service) is needed, and the choreography
// path (direct `<Ctx>.Dispatcher.dispatch/1` calls) is untouched.  This is the
// same topic the realtime LiveView path subscribes to (`realtime-liveview.ts`),
// so a Phoenix deployable that hosts BOTH a LiveView ui and an SPA gets one
// broadcast feeding both.
//
// Two topologies (channels.md "Realtime topology" — rooms + policy-derived
// routing v1):
//
//   - Untenanted context: broadcast-to-all with the full payload, matching the
//     other four backends' v1 wire.  The authorized read stays the gate.
//   - Tenant-owned context: a tenant-scoped event (one whose payload references
//     a `tenantOwned` aggregate) degrades to a REFETCH TICKET — its `type` plus
//     its `<Agg> id` reference fields only, no scalar payload.  This is exactly
//     the degrade path the other four backends specify for a dispatch with no
//     ambient tenant, and here it is the standing behaviour: Phoenix's shared
//     `"events"` broadcast carries the event struct and nothing else, so the
//     EMITTER's tenant is not observable at the subscriber (the emitter-room hop
//     would require changing the broadcast shape, which the LiveView
//     `handle_info` heads pattern-match on).  Over-delivery of a ticket is
//     harmless — the authorized refetch re-gates — and no cross-tenant PAYLOAD
//     ever reaches the wire.  Global (non-tenant-scoped) events keep the full
//     payload.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, EventIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../../ir/util/channels.js";
import { realtimeRoomPlan } from "../../../ir/util/realtime-rooms.js";
import { API_BASE_PATH } from "../../../util/api-base.js";
import { lines } from "../../../util/code-builder.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { numericEncode } from "../../_numeric/target.js";
import type { ApiRoute } from "../api-emit.js";
import { ELIXIR_NUMERIC } from "./numeric-codec.js";

/** The SSE endpoint, spelled from the router ROOT (the `:sse` pipeline sits
 *  outside `scope "/api"`, so the prefix is explicit here).  `API_BASE_PATH` +
 *  `/realtime/events` is exactly what the frontend client opens
 *  (`${API_BASE_URL}/realtime/events`), so every backend serves the same URL. */
const REALTIME_SSE_PATH = `${API_BASE_PATH}/realtime/events`;

/** One carried event, resolved against its owning context (the event struct
 *  module is `<App>.<Ctx>.Events.<Event>`, so a multi-context deployable needs
 *  the owner to qualify the match head). */
interface CarriedEvent {
  readonly ev: EventIR;
  readonly ctxName: string;
  /** Tenant-scoped (channels.md rooms v1) — only the id-reference fields below
   *  reach the wire, as a refetch ticket. */
  readonly ticket: boolean;
  /** `<Agg> id` field names kept for a ticket frame. */
  readonly idFields: readonly string[];
}

/** Collect the UI-observable events across every hosted context, ordered by
 *  event name so the emitted clause order is deterministic. */
function collectRealtimeEvents(
  contexts: readonly BoundedContextIR[],
  sys: Pick<SystemIR, "tenancy"> | undefined,
): CarriedEvent[] {
  const out: CarriedEvent[] = [];
  for (const ctx of contexts) {
    const carried = realtimeEventTypes(ctx);
    if (carried.size === 0) continue;
    const plan = realtimeRoomPlan(ctx, sys);
    for (const ev of ctx.events) {
      if (!carried.has(ev.name)) continue;
      const ticket = plan.tenantEventTypes.has(ev.name);
      out.push({
        ev,
        ctxName: ctx.name,
        ticket,
        idFields: ticket ? (plan.eventIdFields.get(ev.name) ?? []) : [],
      });
    }
  }
  return out.sort((a, b) => a.ev.name.localeCompare(b.ev.name));
}

/** Unwrap `optional`. */
function inner(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** The Elixir expression putting one event-struct field on the wire.  Ids are
 *  bare strings and Jason renders `DateTime` as ISO-8601 natively, so only the
 *  two Decimal-backed scalars need a coercion — the SAME ones the REST
 *  serializer applies (`wire-serialize.ts`): money to the fixed wire scale
 *  (RS-12, a JSON string), a plain `decimal` to a JSON number (RS-24). */
function wireValue(access: string, t: TypeIR): { expr: string; money: boolean; dec: boolean } {
  const i = inner(t);
  if (i.kind === "primitive" && i.name === "money")
    return { expr: `__money_round(${access})`, money: true, dec: false };
  if (i.kind === "primitive" && i.name === "decimal")
    return { expr: `__decimal_num(${access})`, money: false, dec: true };
  return { expr: access, money: false, dec: false };
}

/** The `frame/1` clause for one carried event. */
function frameClause(
  c: CarriedEvent,
  appModule: string,
): { lines: string[]; money: boolean; dec: boolean } {
  const eventModule = `${appModule}.${upperFirst(c.ctxName)}.Events.${upperFirst(c.ev.name)}`;
  const fields = c.ticket ? c.ev.fields.filter((f) => c.idFields.includes(f.name)) : c.ev.fields;
  let money = false;
  let dec = false;
  const entries = fields.map((f) => {
    const v = wireValue(`event.${snake(f.name)}`, f.type);
    money = money || v.money;
    dec = dec || v.dec;
    return `"${f.name}" => ${v.expr}`;
  });
  // No projected field ⇒ nothing reads the struct, so don't bind it (an unused
  // variable fails `mix compile --warnings-as-errors`).
  const head = entries.length > 0 ? `%${eventModule}{} = event` : `%${eventModule}{}`;
  const doc = c.ticket
    ? `  # Tenant-scoped (channels.md rooms v1) — a refetch ticket: type + \`<Agg> id\`\n  # references only, never a cross-tenant payload.  The authorized read re-gates.`
    : undefined;
  // One line for a small payload; a wide event wraps one field per line so the
  // emitted module stays readable (and diffs per field).
  const body =
    entries.length <= 2
      ? [`    encode("${c.ev.name}", %{${entries.join(", ")}})`]
      : [
          `    encode("${c.ev.name}", %{`,
          ...entries.map((e, i) => `      ${e}${i === entries.length - 1 ? "" : ","}`),
          `    })`,
        ];
  return {
    lines: [...(doc ? [doc] : []), `  defp frame(${head}) do`, ...body, `  end`],
    money,
    dec,
  };
}

/**
 * The `<App>Web.RealtimeController` — a chunked `text/event-stream` response
 * fed by `Phoenix.PubSub`.  Returns `null` when no hosted context declares a
 * `delivery: broadcast` channel (byte-identical wire-free output).
 */
function renderVanillaRealtimeController(
  appModule: string,
  contexts: readonly BoundedContextIR[],
  sys: Pick<SystemIR, "tenancy"> | undefined,
): string | null {
  const carried = collectRealtimeEvents(contexts, sys);
  if (carried.length === 0) return null;
  const webModule = `${appModule}Web`;
  const typeList = carried.map((c) => `"${c.ev.name}"`).join(", ");

  let money = false;
  let dec = false;
  const clauses: string[] = [];
  for (const c of carried) {
    const r = frameClause(c, appModule);
    money = money || r.money;
    dec = dec || r.dec;
    clauses.push(...r.lines, "");
  }

  const helpers: string[] = [];
  if (money) {
    // RS-12 — the FIXED money wire scale, same coercion the REST serializer
    // applies (`Decimal.round/2` is `:half_up` and keeps trailing zeros).
    helpers.push(
      "",
      "  defp __money_round(nil), do: nil",
      "",
      `  defp __money_round(%Decimal{} = dec), do: ${numericEncode(ELIXIR_NUMERIC, "money", "dto-map", "dec")}`,
      "",
      "  defp __money_round(other), do: other",
    );
  }
  if (dec) {
    // RS-24 — a plain `decimal` is a JSON NUMBER on every other backend, but
    // Jason encodes a bare `%Decimal{}` as a STRING.
    helpers.push(
      "",
      "  defp __decimal_num(nil), do: nil",
      "",
      `  defp __decimal_num(%Decimal{} = dec), do: ${numericEncode(ELIXIR_NUMERIC, "decimal", "dto-map", "dec")}`,
      "",
      "  defp __decimal_num(other), do: other",
    );
  }

  return lines(
    "# Auto-generated.",
    `defmodule ${webModule}.RealtimeController do`,
    '  @moduledoc """',
    "  Realtime SSE wire (channels.md Part I).",
    "",
    "  Events carried by a `delivery: broadcast` channel stream to connected",
    `  browsers at \`GET ${REALTIME_SSE_PATH}\` — \`event: <Type>\` frames + camelCase`,
    "  JSON `data:`, the same wire the Hono / .NET / Java / Python backends serve",
    "  and the frontends' `EventSource` client consumes.",
    "",
    "  The tee is Phoenix's own PubSub: every domain `emit` already broadcasts",
    '  `%<Ctx>.Events.<E>{}` on the shared "events" topic, so this controller',
    "  subscribes there instead of decorating the dispatcher.  The authorized read",
    "  remains the gate — clients refetch through the API rather than trust",
    "  payloads.",
    '  """',
    "",
    `  use ${webModule}, :controller`,
    "",
    "  # Events carried by a broadcast channel — the UI-observable set.",
    `  @realtime_event_types [${typeList}]`,
    "",
    "  # Keep-alive cadence: a comment-free `event: ping` frame so proxies don't",
    "  # idle the stream out (matches the other four backends).",
    "  @keepalive_ms 15_000",
    "",
    '  @doc "The UI-observable event types this deployable streams."',
    "  def realtime_event_types, do: @realtime_event_types",
    "",
    `  @doc "GET ${REALTIME_SSE_PATH} — one long-lived SSE stream per browser connection."`,
    "  def events(conn, _params) do",
    `    Phoenix.PubSub.subscribe(${appModule}.PubSub, "events")`,
    "",
    "    conn",
    '    |> put_resp_header("content-type", "text/event-stream")',
    '    |> put_resp_header("cache-control", "no-cache")',
    // nginx (the generated frontend host) buffers proxied responses by default,
    // which holds SSE frames until the buffer fills.
    '    |> put_resp_header("x-accel-buffering", "no")',
    "    |> send_chunked(200)",
    "    |> stream()",
    "  end",
    "",
    "  # Blocking receive loop over the subscribed topic.  A message that is not a",
    "  # carried event frames to nil and is skipped; the timeout emits the ping.",
    "  defp stream(conn) do",
    "    receive do",
    "      message ->",
    "        case frame(message) do",
    "          nil -> stream(conn)",
    "          data -> send_frame(conn, data)",
    "        end",
    "    after",
    '      @keepalive_ms -> send_frame(conn, "event: ping\\ndata: \\n\\n")',
    "    end",
    "  end",
    "",
    "  # A closed connection ends the loop — `chunk/2` reports the disconnect, and",
    "  # returning the conn lets Phoenix finish the (already-sent) response.",
    "  defp send_frame(conn, data) do",
    "    case chunk(conn, data) do",
    "      {:ok, conn} -> stream(conn)",
    "      {:error, _reason} -> conn",
    "    end",
    "  end",
    "",
    ...clauses,
    "  # Anything else on the topic (a non-carried event, a system message) is not",
    "  # UI-observable.",
    "  defp frame(_other), do: nil",
    "",
    "  defp encode(type, fields) do",
    '    "event: " <> type <> "\\ndata: " <> Jason.encode!(Map.put(fields, "type", type)) <> "\\n\\n"',
    "  end",
    ...helpers,
    "end",
    "",
  );
}

/**
 * Emit the realtime controller + its router route.  No-op (empty route list)
 * when no hosted context declares a `delivery: broadcast` channel.
 *
 * The route carries the `!sse:` sentinel: the router's `:api` pipeline runs
 * `plug :accepts, ["json"]`, which answers a `406` to the
 * `Accept: text/event-stream` an `EventSource` sends — so `renderVanillaRouter`
 * splices these into their own `:sse` pipeline instead.
 */
export function emitVanillaRealtime(
  appName: string,
  appModule: string,
  contexts: readonly BoundedContextIR[],
  out: Map<string, string>,
  sys: Pick<SystemIR, "tenancy"> | undefined,
): ApiRoute[] {
  const content = renderVanillaRealtimeController(appModule, contexts, sys);
  if (!content) return [];
  out.set(`lib/${appName}_web/controllers/realtime_controller.ex`, content);
  return [
    {
      method: "get",
      path: `!sse:${REALTIME_SSE_PATH}`,
      controller: "RealtimeController",
      action: ":events",
    },
  ];
}
