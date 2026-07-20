// Broker-binding resolution (M-T4.4 slices 2–3 — design §4/§5).
//
// The one decision tree every consumer of a deployable's `channels:` wiring
// shares: which of the deployable's channelSource bindings target a broker
// transport a shipped slice provisions (redis, rabbitmq), which
// channel/context each binds, the derived broker address + consumer group,
// and the carried event types.  Consumed by the Hono emitter (producer tee +
// consumer loop + package deps), the Python emitter, and the system compose
// renderer (sidecars + `LOOM_CHANNEL_*_URL` env).  Lives under
// `src/generator/_channels/` (the `_`-shared-home convention); the system
// layer may import downward from `generator/` (the `sql-pg.ts` precedent).

import type { DeployableIR, SystemIR } from "../../ir/types/loom-ir.js";
import { channelAddress, channelSourceEnvVar, consumerGroup } from "../../util/channels.js";

/** The transports a shipped slice provisions. */
export type BrokerTransport = "redis" | "rabbitmq" | "kafka";

/** One broker-bound channel wiring on a deployable. */
export interface BrokerBinding {
  /** The `channelSource` declaration's name (the `channels:` list entry). */
  csName: string;
  /** Bare channel name (`cs.channelName`). */
  channelName: string;
  /** The channel's owning bounded context. */
  contextName: string;
  /** The bound `storage` instance name (the compose service). */
  storageName: string;
  /** Which driver realises the binding (from the storage's type). */
  transport: BrokerTransport;
  /** The channel's declared delivery semantics — the binding only picks the
   *  machinery that enforces them (design §4). */
  delivery: "broadcast" | "queue";
  retention: "ephemeral" | "log" | "work";
  /** Derived broker address — `loom.<context>.<channel>`. */
  address: string;
  /** The consumer group this deployable's replicas share on the channel —
   *  `<address>.<deployable>`.  Replicas compete within the group (`queue`);
   *  distinct deployables get distinct groups. */
  group: string;
  /** `LOOM_CHANNEL_<NAME>_URL` — the env var carrying the broker URL. */
  envVar: string;
  /** Carried event type names (the channel's `carries:` list). */
  events: string[];
  /** The channel's declared partition/ordering key field (`key:`) — a
   *  field common to the carried events.  Kafka partitions by its value
   *  (`loomkey` ?? envelope id, design §4); other transports ignore it. */
  key?: string;
}

/** delivery/retention combos each shipped transport realises.  Narrower than
 *  the language-level compat matrix (`src/util/channels.ts`) on purpose: the
 *  matrix says what a storage type COULD realise; this says what the shipped
 *  drivers DO realise (redis streams for `queue/ephemeral`-on-redis and the
 *  kafka combos are later slices). */
const SHIPPED_COMBOS: Record<BrokerTransport, ReadonlySet<string>> = {
  redis: new Set(["broadcast/ephemeral"]),
  rabbitmq: new Set(["queue/ephemeral", "queue/work"]),
  // Kafka (slice 4): the log — per-partition ordering keyed by
  // `loomkey` ?? envelope id; one consumer group per deployable (a
  // `broadcast` deployable's group sees every record, `queue` replicas
  // compete within their group — design §4).
  kafka: new Set(["broadcast/log", "queue/work"]),
};

/** The deployable's broker-bound channel wirings across every shipped
 *  transport.  Unresolved names, non-broker storages, and not-yet-shipped
 *  delivery combos are skipped silently here: the slice-1 validators
 *  (`loom.channelsource-*`) already surface them as diagnostics, and
 *  generation must not throw on a model that only carries warnings. */
export function brokerChannelBindings(deployable: DeployableIR, sys: SystemIR): BrokerBinding[] {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const out: BrokerBinding[] = [];
  for (const csName of deployable.channelSourceNames ?? []) {
    const cs = sys.channelSources.find((c) => c.name === csName);
    if (!cs) continue;
    const type = storageType.get(cs.storageName);
    if (type !== "redis" && type !== "rabbitmq" && type !== "kafka") continue;
    const transport: BrokerTransport = type;
    for (const sub of sys.subdomains) {
      for (const ctx of sub.contexts) {
        const ch = (ctx.channels ?? []).find((c) => c.name === cs.channelName);
        if (!ch) continue;
        if (!SHIPPED_COMBOS[transport].has(`${ch.delivery}/${ch.retention}`)) continue;
        const address = channelAddress(ctx.name, ch.name);
        out.push({
          csName: cs.name,
          channelName: ch.name,
          contextName: ctx.name,
          storageName: cs.storageName,
          transport,
          delivery: ch.delivery,
          retention: ch.retention,
          address,
          group: consumerGroup(address, deployable.name),
          envVar: channelSourceEnvVar(cs.name),
          events: [...ch.carries],
          key: ch.key,
        });
      }
    }
  }
  return out;
}

/** The redis (Valkey) subset — slice 2's scope; the Python leg (slice 2b)
 *  still consumes exactly this view. */
export function redisChannelBindings(deployable: DeployableIR, sys: SystemIR): BrokerBinding[] {
  return brokerChannelBindings(deployable, sys).filter((b) => b.transport === "redis");
}

/** Names of broker-type storages that back a channelSource some deployable
 *  actually wires — exactly the set the compose renderer provisions a
 *  sidecar for (design §6a: `valkey/valkey` for redis, the official
 *  `rabbitmq:` image (MPL 2.0) for rabbitmq; never the relicensed `redis:`
 *  images). */
export function channelTransportStorageNames(sys: SystemIR): Set<string> {
  const out = new Set<string>();
  for (const d of sys.deployables) {
    for (const b of brokerChannelBindings(d, sys)) out.add(b.storageName);
  }
  return out;
}
