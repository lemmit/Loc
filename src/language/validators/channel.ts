// Channel + channelSource validation (channels.md, Slice 1; M-T4.4 slice 1).
//
// Three checks, mirroring the dataSource matrix validator:
//
//   - `loom.channel-key-missing-field` — a channel's `key:` must name a field
//     that exists on *every* carried event; otherwise the broker can't form a
//     stable partition/ordering key.
//   - `loom.channelsource-unsupported-transport` — the bound storage type is
//     not a channel transport at all (no broker driver exists or is planned).
//     `nats` lands here permanently (M-T4.4 pinned decision: the broker
//     line-up is redis/rabbitmq/kafka), as do non-messaging types.
//   - `loom.channelsource-incompatible` — the storage type is a transport,
//     but can't realise the channel's `delivery` x `retention` profile (the
//     transport compatibility matrix).
//   - `loom.channelsource-not-yet-shipped` — the storage type is a COMPATIBLE
//     transport, but no shipped broker driver provisions this delivery x
//     retention combo yet (`SHIPPED_COMBOS` is narrower than the compat matrix,
//     e.g. redis ships broadcast/ephemeral but not queue/ephemeral). Without
//     this gate the generator silently skips the unshipped combo and falls back
//     to the in-process dispatcher, breaking the delivery guarantee.
//
// All are AST-level checks (no IR needed) — the references resolve at parse
// time, so the diagnostics land on a fresh `.ddd` edit.  The cross-file
// deployable-wiring checks live in `ir/validate/checks/system-checks.ts`.

import { AstUtils, type ValidationAcceptor } from "langium";
import {
  CHANNEL_COMPATIBILITY,
  CHANNEL_TRANSPORT_TYPES,
  SHIPPED_COMBOS,
} from "../../util/channels.js";
import { type Channel, isChannel, isChannelSource, type Model } from "../generated/ast.js";

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
    const ok = CHANNEL_COMPATIBILITY[`${delivery}/${retention}`];
    if (!CHANNEL_TRANSPORT_TYPES.has(storageType)) {
      accept(
        "error",
        `channelSource '${cs.name}' binds channel '${ch.name}' to storage '${cs.use?.ref?.name}' of type '${storageType}', which is not a channel transport. Supported transports${ok ? ` for ${delivery}/${retention}` : ""}: ${[...(ok ?? CHANNEL_TRANSPORT_TYPES)].join(", ")}.`,
        { node: cs, property: "use", code: "loom.channelsource-unsupported-transport" },
      );
    } else if (ok && !ok.has(storageType)) {
      accept(
        "error",
        `channelSource '${cs.name}' binds channel '${ch.name}' (${delivery}/${retention}) to storage '${cs.use?.ref?.name}' of type '${storageType}', which can't realise it. Compatible: ${[...ok].join(", ")}.`,
        { node: cs, property: "use", code: "loom.channelsource-incompatible" },
      );
    } else if (
      // The type-level compatibility check above passed, but the SHIPPED broker
      // drivers realise a NARROWER set of combos than the compat matrix allows
      // (e.g. redis is compatible with queue/ephemeral but only ships
      // broadcast/ephemeral).  Without this gate a compatible-but-unshipped
      // binding parses clean, then the generator silently `continue`s on the
      // unshipped combo (`SHIPPED_COMBOS` in `bindings.ts`) → no driver → silent
      // fallback to the in-process dispatcher, breaking the delivery guarantee.
      // `inMemory` is the in-process transport (no broker driver / SHIPPED_COMBOS
      // key), so it is exempt.
      storageType !== "inMemory" &&
      !SHIPPED_COMBOS[storageType]?.has(`${delivery}/${retention}`)
    ) {
      const shipped = [...(SHIPPED_COMBOS[storageType] ?? [])];
      const alternatives = Object.entries(SHIPPED_COMBOS)
        .filter(([t, combos]) => t !== storageType && combos.has(`${delivery}/${retention}`))
        .map(([t]) => t);
      accept(
        "error",
        `channelSource '${cs.name}' binds channel '${ch.name}' (${delivery}/${retention}) to storage '${cs.use?.ref?.name}' of type '${storageType}'. That combination is compatible but not yet provisioned by a shipped ${storageType} driver.${alternatives.length ? ` Use ${alternatives.join(" or ")} instead,` : ""} or pick a combo ${storageType} does ship (${shipped.length ? shipped.join(", ") : "none"}).`,
        { node: cs, property: "use", code: "loom.channelsource-not-yet-shipped" },
      );
    }
  }
}
