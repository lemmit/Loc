import type { EventIR, TypeIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import type { BrokerBinding } from "../_channels/bindings.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// Broker transport for Phoenix/Elixir (M-T4.4 slices 6c + 7d — the Elixir
// leg of the Hono reference driver in
// `src/generator/typescript/emit/channels.ts`).  Emitted only when the
// deployable wires a broker-bound channelSource via `channels:` — redis
// `broadcast`/`ephemeral` (Redix, MIT — design §6a) or rabbitmq
// `queue`/`ephemeral`+`work` (hex `amqp`, MIT); channel-less projects stay
// byte-identical.
//
// Phoenix has no listener annotation to drop, so the design-§4 delivery-
// uniformity rule lives in ONE seam: `<App>.Channels.dispatch/2` replaces
// the producer-side `<Ctx>.Dispatcher.dispatch/1` call sites when channels
// are wired — an ephemeral broker-routed event encodes to the CloudEvents
// envelope and publishes inline, never fanning out locally; a durable
// (`work`) event lands in `__loom_outbox` inside the caller's Repo
// transaction and the `OutboxRelay` publishes it on drain with the row id
// as the envelope id (design §5); everything else forwards to the local
// dispatcher (nil for a context without one).  The `<App>.ChannelConsumer`
// GenServer subscribes (Redix.PubSub for redis; a durable competing group
// queue with manual ack + bounded retry + DLX parking for rabbit — §4) and
// feeds decoded events into the LOCAL `<Ctx>.Dispatcher` directly
// (loop-safe: a consumed event never re-enters the tee; reactor re-emits
// DO go through the tee, so choreography chains re-publish — .NET/Java
// parity).
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
  return bindings.filter((b) => {
    if (seen.has(b.csName)) return false;
    seen.add(b.csName);
    return true;
  });
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
  /** M-T4.4 slice 7d: hosted durable events ride a broker-bound
   *  `queue`/`work` channel — the tee records them in `__loom_outbox`
   *  (joining the caller's Repo transaction) and the OutboxRelay publishes
   *  on drain with the row id as the envelope id (design §5).  False on
   *  consumers that don't host the durable channel's context. */
  opts: { durableBroker: boolean } = { durableBroker: false },
): ElixirChannelFiles {
  const unique = uniqueBindings(bindings);
  const hasRedis = unique.some((b) => b.transport === "redis");
  const hasRabbit = unique.some((b) => b.transport === "rabbitmq");
  // event type -> binding, split by durability (design §5): ephemeral events
  // publish inline in the tee; durable (`work`) events ride the outbox relay.
  const routing = new Map<string, BrokerBinding>();
  const durableRouting = new Map<string, BrokerBinding>();
  for (const b of unique) {
    const target = b.retention === "ephemeral" ? routing : durableRouting;
    for (const evName of b.events) {
      if (!target.has(evName)) target.set(evName, b);
    }
  }
  // One named connection process per unique env var (URL): a Redix conn for
  // redis, a ChannelBroker GenServer (holding the AMQP channel) for rabbit.
  const connByEnv = new Map<string, string>();
  const transportByEnv = new Map<string, string>();
  for (const b of unique) {
    if (!connByEnv.has(b.envVar)) {
      connByEnv.set(b.envVar, `:loom_channels_${connByEnv.size}`);
      transportByEnv.set(b.envVar, b.transport);
    }
  }

  const tupleFor = (b: BrokerBinding): string =>
    `{${JSON.stringify(b.address)}, ${JSON.stringify(b.contextName)}, ${connByEnv.get(b.envVar)}, :${b.transport === "rabbitmq" ? "rabbitmq" : "redis"}}`;
  const routingMap = (entries: Map<string, BrokerBinding>): string =>
    entries.size === 0
      ? "%{}"
      : `%{\n${[...entries.entries()]
          .map(([evName, b]) => `    ${JSON.stringify(evName)} => ${tupleFor(b)}`)
          .join(",\n")}\n  }`;

  const carriedRouted = carried.filter(
    ({ ev }) => routing.has(ev.name) || durableRouting.has(ev.name),
  );
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
# PUBLISHED (CloudEvents 1.0 envelope over the wired broker transport) and
# never fanned out locally — co-located consumers receive it through their
# subscription exactly like remote ones.  Everything else forwards to the
# local dispatcher (nil when the context has none).
defmodule ${appModule}.Channels do
  require Logger

  @routing ${routingMap(routing)}
${
  opts.durableBroker
    ? `
  @durable_routing ${routingMap(durableRouting)}
`
    : ""
}
  def dispatch(ev, local_dispatcher) do
    type = ev.__struct__ |> Module.split() |> List.last()
${
  opts.durableBroker
    ? `
    case Map.fetch(@durable_routing, type) do
      {:ok, _} ->
        # Design §5: durable (work) events land in __loom_outbox inside the
        # caller's Repo transaction; the OutboxRelay publishes on drain.
        record_durable(type, ev)

      :error ->
        dispatch_ephemeral(type, ev, local_dispatcher)
    end
  end

  defp dispatch_ephemeral(type, ev, local_dispatcher) do`
    : ""
}
    case Map.fetch(@routing, type) do
      {:ok, {address, context, conn, transport}} ->
        publish(transport, conn, address, context, type, ev)

      :error ->
        if local_dispatcher, do: local_dispatcher.dispatch(ev), else: :ok
    end
  end
${
  opts.durableBroker
    ? `
  defp record_durable(type, ev) do
    %${appModule}.LoomOutbox{
      type: type,
      payload: encode_data(ev),
      occurred_at: DateTime.utc_now()
    }
    |> ${appModule}.Repo.insert!()

    :ok
  end

  @doc """
  Design §5, the relay half of the producer split: a drained durable outbox
  row publishes here, carrying its row id as the envelope id — the stable
  consumer-side idempotency key across broker redeliveries.
  """
  def publish_from_relay(type, data, event_id) do
    case Map.fetch(@durable_routing, type) do
      {:ok, {address, context, conn, transport}} ->
        envelope = envelope_for(address, context, type, event_id, data)
        transmit(transport, conn, address, Jason.encode!(envelope))
        id = event_id
        ${publishedLog}
        :ok

      :error ->
        :unrouted
    end
  end
`
    : ""
}
  defp publish(transport, conn, address, context, type, ev) do
    id =
      Integer.to_string(System.system_time(:millisecond), 16) <>
        "-" <> Integer.to_string(:erlang.unique_integer([:positive]), 16)

    envelope = envelope_for(address, context, type, id, encode_data(ev))
    transmit(transport, conn, address, Jason.encode!(envelope))
    ${publishedLog}
    :ok
  end

  defp envelope_for(address, context, type, id, data) do
    %{
      "specversion" => "1.0",
      "id" => id,
      "type" => context <> "." <> type,
      "source" => "/loom/" <> context,
      "time" => DateTime.to_iso8601(DateTime.utc_now()),
      "datacontenttype" => "application/json",
      "loomchannel" => address,
      "data" => data
    }
  end
${
  hasRedis
    ? `
  defp transmit(:redis, conn, address, json) do
    Redix.command!(conn, ["PUBLISH", address, json])
  end
`
    : ""
}${
  hasRabbit
    ? `
  defp transmit(:rabbitmq, conn, address, json) do
    GenServer.call(conn, {:publish, address, json})
  end
`
    : ""
}
${encodeClauses.join("\n\n")}

${decodeClauses.join("\n\n")}

  def decode(_type, _data), do: nil
end
`,
  );

  const children = [...connByEnv.entries()].map(([envVar, conn]) =>
    transportByEnv.get(envVar) === "rabbitmq"
      ? `      Supervisor.child_spec({${appModule}.ChannelBroker, [env_var: ${JSON.stringify(envVar)}, name: ${conn}]}, id: ${conn})`
      : `      Supervisor.child_spec({Redix, {System.fetch_env!(${JSON.stringify(envVar)}), [name: ${conn}]}}, id: ${conn})`,
  );

  if (hasRabbit) {
    files.set(
      `lib/${appName}/channel_broker.ex`,
      `# Auto-generated.  RabbitMQ publisher process (channels.md; M-T4.4
# design §4) — holds one AMQP connection + channel per broker URL and
# publishes envelopes onto the durable per-address fanout exchange.  The
# hex \`amqp\` client (MIT) wraps the official RabbitMQ Erlang client.
defmodule ${appModule}.ChannelBroker do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, System.fetch_env!(opts[:env_var]), name: opts[:name])
  end

  @impl true
  def init(url), do: {:ok, %{url: url, chan: nil, declared: MapSet.new()}}

  @impl true
  def handle_call({:publish, address, payload}, _from, state) do
    state = ensure_channel(state)

    state =
      if MapSet.member?(state.declared, address) do
        state
      else
        :ok = AMQP.Exchange.declare(state.chan, address, :fanout, durable: true)
        %{state | declared: MapSet.put(state.declared, address)}
      end

    :ok =
      AMQP.Basic.publish(state.chan, address, "", payload,
        persistent: true,
        content_type: "application/json"
      )

    {:reply, :ok, state}
  end

  defp ensure_channel(%{chan: nil, url: url} = state) do
    {:ok, conn} = AMQP.Connection.open(url)
    {:ok, chan} = AMQP.Channel.open(conn)
    %{state | chan: chan}
  end

  defp ensure_channel(state), do: state
end
`,
    );
  }

  if (opts.durableBroker) {
    const deadLetteredLog = renderPhoenixLogCall("eventDeadLettered", [
      { name: "type", valueExpr: "row.type" },
      { name: "attempts", valueExpr: "attempts" },
      { name: "error", valueExpr: "inspect(error)" },
    ]);
    files.set(
      `lib/${appName}/loom_outbox.ex`,
      `# Auto-generated.  One owed durable event (dispatch-delivery-semantics.md):
# written by \`${appModule}.Channels.dispatch/2\` inside the caller's Repo
# transaction, drained by \`${appModule}.OutboxRelay\` (M-T4.4 design §5).
# Maps the shared __loom_outbox table the module migrations own.
defmodule ${appModule}.LoomOutbox do
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "__loom_outbox" do
    field :occurred_at, :utc_datetime_usec
    field :type, :string
    field :payload, :map
    field :dispatched_at, :utc_datetime_usec
    field :attempts, :integer, default: 0
  end
end
`,
    );
    files.set(
      `lib/${appName}/outbox_relay.ex`,
      `# Auto-generated.  Transactional-outbox relay (M-T4.4 design §5):
# drains undispatched __loom_outbox rows in occurred_at order and publishes
# them to the broker at-least-once — the envelope carries the row id, the
# consumer-side idempotency key.  Rows that exhaust the attempt budget stay
# in the table and log event_dead_lettered once.
defmodule ${appModule}.OutboxRelay do
  use GenServer
  import Ecto.Query
  require Logger

  @interval_ms 500
  @max_attempts 5
  @batch 50

  def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
    Process.send_after(self(), :drain, @interval_ms)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:drain, state) do
    drain()
    Process.send_after(self(), :drain, @interval_ms)
    {:noreply, state}
  end

  defp drain do
    ${appModule}.Repo.all(
      from(o in ${appModule}.LoomOutbox,
        where: is_nil(o.dispatched_at) and o.attempts < @max_attempts,
        order_by: [asc: o.occurred_at],
        limit: @batch
      )
    )
    |> Enum.each(&deliver/1)
  end

  defp deliver(row) do
    ${appModule}.Channels.publish_from_relay(row.type, row.payload, row.id)

    ${appModule}.Repo.update_all(
      from(o in ${appModule}.LoomOutbox, where: o.id == ^row.id),
      set: [dispatched_at: DateTime.utc_now()]
    )
  rescue
    error ->
      attempts = row.attempts + 1

      ${appModule}.Repo.update_all(
        from(o in ${appModule}.LoomOutbox, where: o.id == ^row.id),
        set: [attempts: attempts]
      )

      if attempts >= @max_attempts do
        ${deadLetteredLog}
      end
  end
end
`,
    );
    children.push(`      ${appModule}.OutboxRelay`);
  }

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
    // Redis: every wired address is subscribed over one Redix.PubSub per
    // connection URL env var (broadcast — every replica receives).
    const redisEnvSubs = new Map<string, string[]>();
    for (const b of unique) {
      if (b.transport !== "redis") continue;
      const list = redisEnvSubs.get(b.envVar) ?? [];
      if (!list.includes(b.address)) list.push(b.address);
      redisEnvSubs.set(b.envVar, list);
    }
    const redisSubscribeLines = [...redisEnvSubs.entries()].flatMap(([envVar, addresses]) => [
      `    {:ok, pubsub_${connByEnv.get(envVar)?.slice(1)}} = Redix.PubSub.start_link(System.fetch_env!(${JSON.stringify(envVar)}))`,
      ...addresses.map(
        (a) =>
          `    {:ok, _ref} = Redix.PubSub.subscribe(pubsub_${connByEnv.get(envVar)?.slice(1)}, ${JSON.stringify(a)}, self())`,
      ),
    ]);
    // Rabbit: one connection/channel per env var; one durable queue per
    // wired binding — the queue name IS the consumer group (design §4):
    // replicas of this deployable share it and compete, other deployables
    // bind their own queue to the same fanout exchange.
    const rabbitEnvBindings = new Map<string, { address: string; queue: string }[]>();
    for (const b of unique) {
      if (b.transport !== "rabbitmq") continue;
      const list = rabbitEnvBindings.get(b.envVar) ?? [];
      if (!list.some((x) => x.queue === b.group)) list.push({ address: b.address, queue: b.group });
      rabbitEnvBindings.set(b.envVar, list);
    }
    const rabbitConsumeLines = [...rabbitEnvBindings.entries()].flatMap(([envVar, bs]) => {
      const chanVar = `chan_${connByEnv.get(envVar)?.slice(1)}`;
      return [
        `    ${chanVar} = open_rabbit(System.fetch_env!(${JSON.stringify(envVar)}))`,
        ...bs.map(
          (x) =>
            `    state = Map.merge(state, consume(${chanVar}, ${JSON.stringify(x.address)}, ${JSON.stringify(x.queue)}))`,
        ),
      ];
    });
    const hasRabbitConsumer = rabbitEnvBindings.size > 0;
    const hasRedisConsumer = redisEnvSubs.size > 0;
    const initBody = hasRabbitConsumer
      ? ["    state = %{}", ...redisSubscribeLines, ...rabbitConsumeLines, "    {:ok, state}"].join(
          "\n",
        )
      : [...redisSubscribeLines, "    {:ok, %{}}"].join("\n");
    const headerDesc = hasRabbitConsumer
      ? `# Subscribes every wired address (Redix.PubSub for redis broadcast;
# a durable competing queue over the hex \`amqp\` client for rabbitmq —
# design §4: manual ack, bounded \`x-loom-attempts\` retry, DLX \`loom.dlx\`
# → \`loom.dlq.<address>\` parking) and feeds decoded`
      : `# Subscribes every wired address over Redix.PubSub and feeds decoded`;

    const redisClauses = hasRedisConsumer
      ? `  def handle_info({:redix_pubsub, _pid, _ref, :subscribed, _meta}, state), do: {:noreply, state}

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
`
      : "";
    const malformedLog = renderPhoenixLogCall("channelDeadLettered", [
      { name: "address", valueExpr: "address" },
      { name: "error", valueExpr: `"malformed envelope"` },
    ]);
    const parkedLog = renderPhoenixLogCall("channelDeadLettered", [
      { name: "address", valueExpr: "address" },
      { name: "type", valueExpr: `envelope["type"]` },
      { name: "id", valueExpr: `envelope["id"]` },
      { name: "attempts", valueExpr: "attempts" },
      { name: "error", valueExpr: "inspect(error)" },
    ]);
    const rabbitClauses = hasRabbitConsumer
      ? `  def handle_info({:basic_consume_ok, _meta}, state), do: {:noreply, state}

  def handle_info({:basic_deliver, payload, meta}, state) do
    {address, queue, chan} = Map.fetch!(state, meta.consumer_tag)
    handle_delivery(payload, meta, address, queue, chan)
    {:noreply, state}
  end
`
      : "";
    const rabbitHelpers = hasRabbitConsumer
      ? `
  defp open_rabbit(url) do
    {:ok, conn} = AMQP.Connection.open(url)
    {:ok, chan} = AMQP.Channel.open(conn)
    :ok = AMQP.Basic.qos(chan, prefetch_count: 1)
    chan
  end

  # Design §4 topology: durable fanout exchange per address; failed
  # deliveries dead-letter through \`loom.dlx\` into \`loom.dlq.<address>\`
  # (parked, not lost).
  defp consume(chan, address, queue) do
    :ok = AMQP.Exchange.declare(chan, address, :fanout, durable: true)
    :ok = AMQP.Exchange.declare(chan, "loom.dlx", :direct, durable: true)
    {:ok, _} = AMQP.Queue.declare(chan, "loom.dlq." <> address, durable: true)
    :ok = AMQP.Queue.bind(chan, "loom.dlq." <> address, "loom.dlx", routing_key: address)

    {:ok, _} =
      AMQP.Queue.declare(chan, queue,
        durable: true,
        arguments: [
          {"x-dead-letter-exchange", :longstr, "loom.dlx"},
          {"x-dead-letter-routing-key", :longstr, address}
        ]
      )

    :ok = AMQP.Queue.bind(chan, queue, address)
    {:ok, tag} = AMQP.Basic.consume(chan, queue)
    %{tag => {address, queue, chan}}
  end

  defp handle_delivery(payload, meta, address, queue, chan) do
    case decode_payload(payload) do
      {:ok, envelope, ev} ->
        deliver(envelope, ev, meta, address, queue, chan, payload)

      :malformed ->
        # Malformed body: no retry can fix it — reject without requeue
        # routes through the queue's DLX into the DLQ.
        :ok = AMQP.Basic.reject(chan, meta.delivery_tag, requeue: false)
        ${malformedLog}
    end
  end

  defp decode_payload(payload) do
    with {:ok, envelope} <- Jason.decode(payload),
         type when is_binary(type) <- envelope["type"],
         bare = type |> String.split(".") |> List.last(),
         ev when not is_nil(ev) <- ${appModule}.Channels.decode(bare, envelope["data"] || %{}) do
      {:ok, envelope, ev}
    else
      _ -> :malformed
    end
  end

  defp deliver(envelope, ev, meta, address, queue, chan, payload) do
    route(ev)
    ${consumedLog}
    :ok = AMQP.Basic.ack(chan, meta.delivery_tag)
  rescue
    error ->
      attempts = attempts_from(meta.headers)

      if attempts >= @max_attempts do
        # Parked, not lost: the DLX routes it into the DLQ.
        :ok = AMQP.Basic.reject(chan, meta.delivery_tag, requeue: false)
        ${parkedLog}
      else
        # Bounded retry: republish with the attempt header and ack the
        # original (immediate nack-requeue would hot-loop).
        :ok =
          AMQP.Basic.publish(chan, "", queue, payload,
            persistent: true,
            content_type: "application/json",
            headers: retry_headers(meta.headers, attempts)
          )

        :ok = AMQP.Basic.ack(chan, meta.delivery_tag)
      end
  end

  defp attempts_from(:undefined), do: 1

  defp attempts_from(headers) do
    case List.keyfind(headers, "x-loom-attempts", 0) do
      {_, _, n} -> n + 1
      nil -> 1
    end
  end

  defp retry_headers(:undefined, attempts), do: [{"x-loom-attempts", :long, attempts}]

  defp retry_headers(headers, attempts) do
    List.keydelete(headers, "x-loom-attempts", 0) ++ [{"x-loom-attempts", :long, attempts}]
  end
`
      : "";
    files.set(
      `lib/${appName}/channel_consumer.ex`,
      `# Auto-generated.  Broker channel consumer (channels.md; M-T4.4).
#
${headerDesc}
# envelopes into the SAME local \`<Ctx>.Dispatcher\` reactors use for local
# events — never back through the \`Channels\` tee, so a consumed event
# cannot re-publish itself (reactor re-emits still tee, so choreography
# chains re-enter the broker).
defmodule ${appModule}.ChannelConsumer do
  use GenServer
  require Logger
${hasRabbitConsumer ? "\n  @max_attempts 5\n" : ""}
  def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
${initBody}
  end

  @impl true
${redisClauses}${redisClauses && rabbitClauses ? "\n" : ""}${rabbitClauses}
${routeClauses.join("\n\n")}
  defp route(_ev), do: :ok
${rabbitHelpers}end
`,
    );
    children.push(`      ${appModule}.ChannelConsumer`);
  }

  return { files, children };
}
