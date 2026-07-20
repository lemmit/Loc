import type { EventIR, SystemIR, TypeIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import type { BrokerBinding } from "../_channels/bindings.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// Broker transport for Phoenix/Elixir (M-T4.4 slice 6c — the Elixir leg of
// the Hono reference driver in `src/generator/typescript/emit/channels.ts`).
// Emitted only when the deployable wires a redis-bound `broadcast`/
// `ephemeral` channelSource via `channels:`; channel-less projects stay
// byte-identical.
//
// Phoenix has no listener annotation to drop, so the design-§4 delivery-
// uniformity rule lives in ONE seam: `<App>.Channels.dispatch/2` replaces
// the producer-side `<Ctx>.Dispatcher.dispatch/1` call sites when channels
// are wired — a broker-routed event encodes to the CloudEvents envelope and
// PUBLISHes via Redix (MIT — design §6a), never fanning out locally;
// everything else forwards to the local dispatcher (nil for a context
// without one).  The `<App>.ChannelConsumer` GenServer subscribes via
// Redix.PubSub and feeds decoded events into the LOCAL `<Ctx>.Dispatcher`
// directly (loop-safe: a consumed event never re-enters the tee; reactor
// re-emits DO go through the tee, so choreography chains re-publish —
// .NET/Java parity).
// ---------------------------------------------------------------------------

/** Per-deployable channels config threaded into the emit sites that render a
 *  `Dispatcher.dispatch` line — presence switches the line to the tee. */
export interface ElixirChannelsCfg {
  appModule: string;
  /** Event type names carried by a wired broker-bound channel. */
  brokerEvents: ReadonlySet<string>;
  /** Event name → owning-context module prefix (`<App>.<Ctx>`) for events
   *  consumed through a wired-but-foreign channel — the dispatcher and
   *  handler pattern-matches qualify the struct with the OWNING context. */
  foreignEventModules: ReadonlyMap<string, string>;
}

/** The dispatch line an emit site renders.  With channels wired, ALL events
 *  route through the tee (which forwards non-broker events to the local
 *  dispatcher); without, the legacy local-dispatcher call (or nothing). */
export function elixirDispatchCall(
  evVar: string,
  contextModule: string,
  hasDispatcher: boolean,
  channels: ElixirChannelsCfg | undefined,
): string | null {
  if (channels) {
    const local = hasDispatcher ? `${contextModule}.Dispatcher` : "nil";
    return `${channels.appModule}.Channels.dispatch(${evVar}, ${local})`;
  }
  return hasDispatcher ? `${contextModule}.Dispatcher.dispatch(${evVar})` : null;
}

function uniqueBindings(bindings: BrokerBinding[]): BrokerBinding[] {
  const seen = new Set<string>();
  return bindings.filter((b) => (seen.has(b.csName) ? false : (seen.add(b.csName), true)));
}

/** Elixir expression serialising one event struct field into its envelope-data
 *  value (DSL-keyed JSON; wire parity with the Hono/Python/.NET/Java codecs:
 *  datetimes as ISO-8601 strings, money as decimal strings, ids as strings). */
function encodeExpr(access: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive" && inner.name === "datetime") {
    return t.kind === "optional"
      ? `${access} && DateTime.to_iso8601(${access})`
      : `DateTime.to_iso8601(${access})`;
  }
  if (inner.kind === "primitive" && (inner.name === "money" || inner.name === "decimal")) {
    // money rides as a decimal STRING (the cross-backend pin); plain decimal
    // stays numeric on other backends, but Elixir's Decimal has no native
    // JSON number form — Jason encodes Decimal via its String.Chars, which
    // matches the string-tolerant decoders on every consumer.
    return t.kind === "optional"
      ? `${access} && Decimal.to_string(${access})`
      : `Decimal.to_string(${access})`;
  }
  return access;
}

/** Elixir expression reconstructing one struct field from the decoded
 *  envelope-data map. */
function decodeExpr(name: string, t: TypeIR): string {
  const get = `data[${JSON.stringify(name)}]`;
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive" && inner.name === "datetime") {
    const conv = `elem(DateTime.from_iso8601(${get}), 1)`;
    return t.kind === "optional" ? `${get} && ${conv}` : conv;
  }
  if (inner.kind === "primitive" && (inner.name === "money" || inner.name === "decimal")) {
    const conv = `Decimal.new(${get})`;
    return t.kind === "optional" ? `${get} && ${conv}` : conv;
  }
  return get;
}

export interface ElixirChannelFiles {
  files: Map<string, string>;
  /** application.ex child-spec lines: the named Redix connections + (when a
   *  consumer route exists) the ChannelConsumer GenServer. */
  children: string[];
}

/** One consumer route: a decoded event fans into each subscribed hosted
 *  context's local dispatcher. */
export interface ElixirConsumerRoute {
  event: string;
  /** Owning-context module prefix (`<App>.<Ctx>`) — the struct's home. */
  eventCtxModule: string;
  /** Hosted-context dispatcher modules to invoke (`<App>.<Ctx>.Dispatcher`). */
  dispatchers: string[];
}

export function emitElixirChannelFiles(
  appName: string,
  appModule: string,
  bindings: BrokerBinding[],
  /** Carried event IRs paired with their owning-context module prefix. */
  carried: { ev: EventIR; ctxModule: string }[],
  routes: ElixirConsumerRoute[],
): ElixirChannelFiles {
  const unique = uniqueBindings(bindings);
  const routing = new Map<string, BrokerBinding>();
  for (const b of unique) {
    for (const evName of b.events) {
      if (!routing.has(evName)) routing.set(evName, b);
    }
  }
  // One named Redix connection per unique env var (URL).
  const connByEnv = new Map<string, string>();
  for (const b of unique) {
    if (!connByEnv.has(b.envVar)) connByEnv.set(b.envVar, `:loom_channels_${connByEnv.size}`);
  }

  const routingLines = [...routing.entries()].map(
    ([evName, b]) =>
      `    ${JSON.stringify(evName)} => {${JSON.stringify(b.address)}, ${JSON.stringify(b.contextName)}, ${connByEnv.get(b.envVar)}}`,
  );

  const carriedRouted = carried.filter(({ ev }) => routing.has(ev.name));
  const encodeClauses = carriedRouted.map(({ ev, ctxModule }) => {
    const pairs = ev.fields.map(
      (f) => `      ${JSON.stringify(f.name)} => ${encodeExpr(`ev.${snake(f.name)}`, f.type)}`,
    );
    return `  def encode_data(%${ctxModule}.Events.${upperFirst(ev.name)}{} = ev) do\n    %{\n${pairs.join(",\n")}\n    }\n  end`;
  });
  const decodeClauses = carriedRouted.map(({ ev, ctxModule }) => {
    const pairs = ev.fields.map((f) => `      ${snake(f.name)}: ${decodeExpr(f.name, f.type)}`);
    return `  def decode(${JSON.stringify(ev.name)}, data) do\n    %${ctxModule}.Events.${upperFirst(ev.name)}{\n${pairs.join(",\n")}\n    }\n  end`;
  });

  const publishedLog = renderPhoenixLogCall("channelPublished", [
    { name: "address", valueExpr: "address" },
    { name: "type", valueExpr: "type" },
    { name: "id", valueExpr: "id" },
  ]);

  const files = new Map<string, string>();
  files.set(
    `lib/${appName}/channels.ex`,
    `# Auto-generated.  Broker channel tee (channels.md; M-T4.4 design §4-5).
#
# \`dispatch/2\` replaces the per-context \`Dispatcher.dispatch/1\` at every
# producer-side emit seam when channels are wired: a broker-routed event is
# PUBLISHED (CloudEvents 1.0 envelope over Redix pub/sub) and never fanned
# out locally — co-located consumers receive it through their subscription
# exactly like remote ones.  Everything else forwards to the local
# dispatcher (nil when the context has none).
defmodule ${appModule}.Channels do
  require Logger

  @routing %{
${routingLines.join(",\n")}
  }

  def dispatch(ev, local_dispatcher) do
    type = ev.__struct__ |> Module.split() |> List.last()

    case Map.fetch(@routing, type) do
      {:ok, {address, context, conn}} ->
        publish(conn, address, context, type, ev)

      :error ->
        if local_dispatcher, do: local_dispatcher.dispatch(ev), else: :ok
    end
  end

  defp publish(conn, address, context, type, ev) do
    id =
      Integer.to_string(System.system_time(:millisecond), 16) <>
        "-" <> Integer.to_string(:erlang.unique_integer([:positive]), 16)

    envelope = %{
      "specversion" => "1.0",
      "id" => id,
      "type" => context <> "." <> type,
      "source" => "/loom/" <> context,
      "time" => DateTime.to_iso8601(DateTime.utc_now()),
      "datacontenttype" => "application/json",
      "loomchannel" => address,
      "data" => encode_data(ev)
    }

    Redix.command!(conn, ["PUBLISH", address, Jason.encode!(envelope)])
    ${publishedLog}
    :ok
  end

${encodeClauses.join("\n\n")}

${decodeClauses.join("\n\n")}

  def decode(_type, _data), do: nil
end
`,
  );

  const children = [...connByEnv.entries()].map(
    ([envVar, conn]) =>
      `      Supervisor.child_spec({Redix, {System.fetch_env!(${JSON.stringify(envVar)}), [name: ${conn}]}}, id: ${conn})`,
  );

  if (routes.length > 0) {
    const consumedLog = renderPhoenixLogCall("channelConsumed", [
      { name: "address", valueExpr: "address" },
      { name: "type", valueExpr: `envelope["type"]` },
      { name: "id", valueExpr: `envelope["id"]` },
    ]);
    const failedLog = renderPhoenixLogCall("channelConsumeFailed", [
      { name: "address", valueExpr: "address" },
      { name: "error", valueExpr: "inspect(error)" },
    ]);
    const routeClauses = routes.map((r) => {
      const calls = r.dispatchers.map((d) => `    ${d}.dispatch(ev)`);
      return `  defp route(%${r.eventCtxModule}.Events.${upperFirst(r.event)}{} = ev) do\n${calls.join("\n")}\n    :ok\n  end`;
    });
    // Every wired address is subscribed, grouped per connection URL env var.
    const subsByEnv = new Map<string, string[]>();
    for (const b of unique) {
      const list = subsByEnv.get(b.envVar) ?? [];
      if (!list.includes(b.address)) list.push(b.address);
      subsByEnv.set(b.envVar, list);
    }
    const subscribeLines = [...subsByEnv.entries()].flatMap(([envVar, addresses]) => [
      `    {:ok, pubsub_${connByEnv.get(envVar)?.slice(1)}} = Redix.PubSub.start_link(System.fetch_env!(${JSON.stringify(envVar)}))`,
      ...addresses.map(
        (a) =>
          `    {:ok, _ref} = Redix.PubSub.subscribe(pubsub_${connByEnv.get(envVar)?.slice(1)}, ${JSON.stringify(a)}, self())`,
      ),
    ]);
    files.set(
      `lib/${appName}/channel_consumer.ex`,
      `# Auto-generated.  Broker channel consumer (channels.md; M-T4.4).
#
# Subscribes every wired address over Redix.PubSub and feeds decoded
# envelopes into the SAME local \`<Ctx>.Dispatcher\` reactors use for local
# events — never back through the \`Channels\` tee, so a consumed event
# cannot re-publish itself (reactor re-emits still tee, so choreography
# chains re-enter the broker).
defmodule ${appModule}.ChannelConsumer do
  use GenServer
  require Logger

  def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
${subscribeLines.join("\n")}
    {:ok, %{}}
  end

  @impl true
  def handle_info({:redix_pubsub, _pid, _ref, :subscribed, _meta}, state), do: {:noreply, state}

  def handle_info(
        {:redix_pubsub, _pid, _ref, :message, %{channel: address, payload: payload}},
        state
      ) do
    with {:ok, envelope} <- Jason.decode(payload),
         bare = envelope["type"] |> String.split(".") |> List.last(),
         ev when not is_nil(ev) <- ${appModule}.Channels.decode(bare, envelope["data"] || %{}) do
      route(ev)
      ${consumedLog}
    end

    {:noreply, state}
  rescue
    error ->
      ${failedLog}
      {:noreply, state}
  end

${routeClauses.join("\n\n")}
  defp route(_ev), do: :ok
end
`,
    );
    children.push(`      ${appModule}.ChannelConsumer`);
  }

  return { files, children };
}
