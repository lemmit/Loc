// Broker-binding resolution (M-T4.4 slice 2 — design §4/§5).
//
// The one decision tree every consumer of a deployable's `channels:` wiring
// shares: which of the deployable's channelSource bindings target a broker
// transport this slice provisions (redis), which channel/context each binds,
// the derived broker address, and the carried event types.  Consumed by the
// Hono emitter (producer tee + consumer loop + package deps), by the system
// compose renderer (valkey sidecar + `LOOM_CHANNEL_*_URL` env), and — as
// later slices land drivers — by the other backends.  Lives under
// `src/generator/_channels/` (the `_`-shared-home convention); the system
// layer may import downward from `generator/` (the `sql-pg.ts` precedent).

import type { DeployableIR, SystemIR } from "../../ir/types/loom-ir.js";
import { channelAddress, channelSourceEnvVar } from "../../util/channels.js";

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
  /** Derived broker address — `loom.<context>.<channel>`. */
  address: string;
  /** `LOOM_CHANNEL_<NAME>_URL` — the env var carrying the broker URL. */
  envVar: string;
  /** Carried event type names (the channel's `carries:` list). */
  events: string[];
}

/** The deployable's redis-bound `broadcast`/`ephemeral` channel wirings —
 *  slice 2's transport scope.  Unresolved names and non-redis storages are
 *  skipped silently here: the slice-1 validators (`loom.channelsource-*`)
 *  already surface them as diagnostics, and generation must not throw on a
 *  model that only carries warnings. */
export function redisChannelBindings(deployable: DeployableIR, sys: SystemIR): BrokerBinding[] {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const out: BrokerBinding[] = [];
  for (const csName of deployable.channelSourceNames ?? []) {
    const cs = sys.channelSources.find((c) => c.name === csName);
    if (!cs) continue;
    if (storageType.get(cs.storageName) !== "redis") continue;
    for (const sub of sys.subdomains) {
      for (const ctx of sub.contexts) {
        const ch = (ctx.channels ?? []).find((c) => c.name === cs.channelName);
        if (!ch) continue;
        if (ch.delivery !== "broadcast" || ch.retention !== "ephemeral") continue;
        out.push({
          csName: cs.name,
          channelName: ch.name,
          contextName: ctx.name,
          storageName: cs.storageName,
          address: channelAddress(ctx.name, ch.name),
          envVar: channelSourceEnvVar(cs.name),
          events: [...ch.carries],
        });
      }
    }
  }
  return out;
}

/** Names of redis-type storages that back a channelSource some deployable
 *  actually wires — exactly the set the compose renderer provisions a
 *  Valkey sidecar for (design §6a: `valkey/valkey`, BSD-3, redis-wire-
 *  compatible; never the relicensed `redis:` images). */
export function channelTransportStorageNames(sys: SystemIR): Set<string> {
  const out = new Set<string>();
  for (const d of sys.deployables) {
    for (const b of redisChannelBindings(d, sys)) out.add(b.storageName);
  }
  return out;
}
