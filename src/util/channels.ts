// Shared channel-transport vocabulary (channels.md, M-T4.4 slice 1).
//
// Single source of truth for the delivery×retention → storage-type
// compatibility matrix, the set of storage types that have (or will have) a
// broker driver, and the derived broker naming scheme.  Lives in `src/util/`
// because both the language validator (`validators/channel.ts`) and the
// generator/system layers consume it — the same layering rationale as
// pack-identity metadata (CLAUDE.md §Architecture).
//
// Pinned decision (M-T4.4 design §2, 2026-07-18): the broker line-up is
// redis → rabbitmq → kafka; **NATS is not a channel transport** (it stays a
// parseable storage type for other roles and is rejected by
// `loom.channelsource-unsupported-transport`).

/** Storage types that are (or are slated to become) channel transports.
 *  `inMemory` is the degenerate in-process transport — compatible only with
 *  the profile the in-process dispatcher already realises. */
export const CHANNEL_TRANSPORT_TYPES: ReadonlySet<string> = new Set([
  "inMemory",
  "redis",
  "rabbitmq",
  "kafka",
]);

/** delivery×retention → the storage types that can realise it.
 *  Mirrors the post-NATS matrix in M-T4.4 design §2 / channels.md
 *  §"Transport compatibility matrix". */
export const CHANNEL_COMPATIBILITY: Record<string, ReadonlySet<string>> = {
  "broadcast/ephemeral": new Set(["inMemory", "redis"]),
  "broadcast/log": new Set(["kafka"]),
  "queue/ephemeral": new Set(["redis", "rabbitmq"]),
  "queue/work": new Set(["rabbitmq", "kafka"]),
};

/** delivery/retention combos each SHIPPED broker driver actually realises,
 *  keyed by broker transport → set of `"<delivery>/<retention>"`.  Narrower
 *  than `CHANNEL_COMPATIBILITY` on purpose: the matrix says what a storage type
 *  COULD realise; this says what the shipped drivers DO realise (redis streams
 *  for `queue/ephemeral`-on-redis and the extra kafka combos are later slices).
 *
 *  Lives here (not in `src/generator/_channels/`) so the language validator can
 *  gate a compatible-but-not-yet-shipped binding
 *  (`loom.channelsource-not-yet-shipped`) without importing downward into the
 *  generator layer.  The generator's binding resolver imports it too, so the
 *  validator's gate and the emitter's silent-skip stay driven by ONE list. */
export const SHIPPED_COMBOS: Record<string, ReadonlySet<string>> = {
  redis: new Set(["broadcast/ephemeral"]),
  rabbitmq: new Set(["queue/ephemeral", "queue/work"]),
  // Kafka (slice 4): the log — per-partition ordering keyed by `loomkey` ??
  // envelope id; one consumer group per deployable (a `broadcast` deployable's
  // group sees every record, `queue` replicas compete within their group).
  kafka: new Set(["broadcast/log", "queue/work"]),
};

/** The broker address of a channel — dot-hierarchical, deliberately leaving
 *  suffix room for the realtime room segments (M-T1.10):
 *  `loom.<context>.<channel>`. */
export function channelAddress(contextName: string, channelName: string): string {
  return `loom.${contextName}.${channelName}`;
}

/** The consumer-group name a deployable's replicas share on a channel:
 *  `<address>.<deployable>`.  Replicas of one deployable compete within the
 *  group (`queue`); distinct deployables get distinct groups (`broadcast`
 *  fan-out across deployables). */
export function consumerGroup(address: string, deployableName: string): string {
  return `${address}.${deployableName}`;
}

/** The per-binding env var carrying the broker URL into a wired deployable:
 *  `LOOM_CHANNEL_<NAME>_URL` (name upper-snaked). */
export function channelSourceEnvVar(channelSourceName: string): string {
  const snake = channelSourceName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
  return `LOOM_CHANNEL_${snake}_URL`;
}

/** The CloudEvents 1.0 envelope attribute set every broker-published Loom
 *  event carries (M-T4.4 design §3).  Pinned here (and by the conformance
 *  test) so every backend's envelope builder/parser derives from one list —
 *  a Hono producer's envelope must parse in a Python consumer byte-for-byte.
 *
 *  `data` is the event's existing wire-shape JSON; `id` is the outbox row id
 *  and doubles as the consumer-side idempotency key. */
export const LOOM_ENVELOPE_REQUIRED = [
  "specversion", // literal "1.0"
  "id",
  "type", // `<Context>.<EventName>`
  "source", // `/loom/<deployable>/<context>`
  "time",
  "datacontenttype", // literal "application/json"
  "loomchannel", // `<Context>.<Channel>`
  "data",
] as const;

export const LOOM_ENVELOPE_OPTIONAL = [
  "loomkey", // value of the channel's `key:` field, if declared
  "correlationid",
  "scopeid",
  "tenantid", // observability + partition affinity — never authorization
] as const;
