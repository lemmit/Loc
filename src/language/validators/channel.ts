// Channel + channelSource validation (channels.md, Slice 1).
//
// Two checks, mirroring the dataSource matrix validator:
//
//   - `loom.channel-key-missing-field` — a channel's `key:` must name a field
//     that exists on *every* carried event; otherwise the broker can't form a
//     stable partition/ordering key.
//   - `loom.channelsource-incompatible` — a `channelSource` may only bind a
//     channel to a `storage` whose type supports the channel's
//     `delivery` x `retention` profile (the transport compatibility matrix).
//
// Both are AST-level checks (no IR needed) — the references resolve at parse
// time, so the diagnostics land on a fresh `.ddd` edit.

import { AstUtils, type ValidationAcceptor } from "langium";
import { type Channel, isChannel, isChannelSource, type Model } from "../generated/ast.js";

/** delivery x retention -> the storage types that can realise it.
 *  Mirrors the matrix in channels.md (Part I, "Transport compatibility"). */
const COMPATIBLE: Record<string, ReadonlySet<string>> = {
  "broadcast/ephemeral": new Set(["inMemory", "redis", "nats"]),
  "broadcast/log": new Set(["kafka", "nats"]),
  "queue/ephemeral": new Set(["redis", "rabbitmq", "nats"]),
  "queue/work": new Set(["redis", "rabbitmq", "kafka", "nats"]),
};

export function checkChannels(model: Model, accept: ValidationAcceptor): void {
  const channels = [...AstUtils.streamAllContents(model)].filter(isChannel);
  const channelByName = new Map<string, Channel>();
  for (const ch of channels) channelByName.set(ch.name, ch);

  // 1. key field must exist on every carried event.
  for (const ch of channels) {
    if (!ch.key) continue;
    for (const ref of ch.carries) {
      const ev = ref.ref;
      if (!ev) continue; // unresolved ref — the linker already reports it
      const has = ev.fields.some((f) => f.name === ch.key);
      if (!has) {
        accept(
          "error",
          `channel '${ch.name}' key '${ch.key}' is not a field of carried event '${ev.name}'.`,
          { node: ch, property: "key", code: "loom.channel-key-missing-field" },
        );
      }
    }
  }

  // 2. channelSource: delivery x retention must be compatible with the storage type.
  const sources = [...AstUtils.streamAllContents(model)].filter(isChannelSource);
  for (const cs of sources) {
    const ch = channelByName.get(cs.channel);
    const storageType = cs.use?.ref?.type;
    if (!ch || !storageType) continue; // unresolved — linker handles it
    const delivery = ch.delivery ?? "broadcast";
    const retention = ch.retention ?? "ephemeral";
    const ok = COMPATIBLE[`${delivery}/${retention}`];
    if (ok && !ok.has(storageType)) {
      accept(
        "error",
        `channelSource '${cs.name}' binds channel '${ch.name}' (${delivery}/${retention}) to storage '${cs.use?.ref?.name}' of type '${storageType}', which can't realise it. Compatible: ${[...ok].join(", ")}.`,
        { node: cs, property: "use", code: "loom.channelsource-incompatible" },
      );
    }
  }
}
