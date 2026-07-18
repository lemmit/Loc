// Shared channel-transport vocabulary (M-T4.4 slice 1) — pins the broker
// naming scheme + the CloudEvents envelope attribute set every backend's
// envelope builder/parser must derive from.  A Hono producer's envelope must
// parse in a Python consumer, so the field list is a cross-backend contract:
// changing it is a wire-breaking change and must be deliberate.

import { describe, expect, it } from "vitest";
import {
  CHANNEL_COMPATIBILITY,
  CHANNEL_TRANSPORT_TYPES,
  channelAddress,
  channelSourceEnvVar,
  consumerGroup,
  LOOM_ENVELOPE_OPTIONAL,
  LOOM_ENVELOPE_REQUIRED,
} from "../../src/util/channels.js";

describe("channel transport vocabulary", () => {
  it("pins the broker line-up: redis/rabbitmq/kafka (+ inMemory), no nats", () => {
    expect([...CHANNEL_TRANSPORT_TYPES].sort()).toEqual(["inMemory", "kafka", "rabbitmq", "redis"]);
  });

  it("pins the post-NATS compatibility matrix", () => {
    expect(
      Object.fromEntries(Object.entries(CHANNEL_COMPATIBILITY).map(([k, v]) => [k, [...v].sort()])),
    ).toEqual({
      "broadcast/ephemeral": ["inMemory", "redis"],
      "broadcast/log": ["kafka"],
      "queue/ephemeral": ["rabbitmq", "redis"],
      "queue/work": ["kafka", "rabbitmq"],
    });
  });

  it("every matrix entry names only known transports", () => {
    for (const types of Object.values(CHANNEL_COMPATIBILITY)) {
      for (const t of types) expect(CHANNEL_TRANSPORT_TYPES.has(t)).toBe(true);
    }
  });

  it("derives dot-hierarchical addresses and per-deployable consumer groups", () => {
    const addr = channelAddress("Orders", "Lifecycle");
    expect(addr).toBe("loom.Orders.Lifecycle");
    expect(consumerGroup(addr, "shipApi")).toBe("loom.Orders.Lifecycle.shipApi");
  });

  it("derives the per-binding env var", () => {
    expect(channelSourceEnvVar("lifecycleBus")).toBe("LOOM_CHANNEL_LIFECYCLE_BUS_URL");
  });

  it("pins the CloudEvents 1.0 envelope attribute set (wire contract)", () => {
    expect([...LOOM_ENVELOPE_REQUIRED]).toEqual([
      "specversion",
      "id",
      "type",
      "source",
      "time",
      "datacontenttype",
      "loomchannel",
      "data",
    ]);
    expect([...LOOM_ENVELOPE_OPTIONAL]).toEqual([
      "loomkey",
      "correlationid",
      "scopeid",
      "tenantid",
    ]);
  });
});
