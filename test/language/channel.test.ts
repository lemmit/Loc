// Channel + channelSource — parse + validation (channels.md, Slice 1).
//
// Surface-only slice: the declaration parses, the key-field and
// channel<->storage compatibility validators fire. No runtime.

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

const VALID = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order { customerId: string }
      event OrderPlaced  { order: string, at: string }
      event OrderShipped { order: string, at: string }
      channel Lifecycle {
        carries: OrderPlaced, OrderShipped
        delivery: broadcast
        retention: log
        key: order
      }
    }
  }
  storage eventLog { type: kafka }
  channelSource lifecycleBus { for: Lifecycle, use: eventLog }
}
`;

describe("channel + channelSource — parse / validation", () => {
  it("parses a valid channel and channelSource with no errors", async () => {
    const { errors } = await parseString(VALID);
    expect(errors).toEqual([]);
  });

  it("rejects a `key:` that is not a field of a carried event", async () => {
    const src = `
      system S { subdomain M { context C {
        event E { order: string }
        channel Ch { carries: E  key: nope }
      }}}
    `;
    const { errors } = await parseString(src);
    expect(errors.some((e) => /is not a field of carried event/.test(e))).toBe(true);
  });

  it("rejects a channelSource binding an incompatible storage type", async () => {
    // broadcast/log needs kafka; redis can't realise it.
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E  delivery: broadcast  retention: log }
        }}
        storage cache { type: redis }
        channelSource bus { for: Ch, use: cache }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors.some((e) => /can't realise it/.test(e))).toBe(true);
  });

  it("accepts a compatible channelSource (broadcast/log -> kafka)", async () => {
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E  delivery: broadcast  retention: log }
        }}
        storage durable { type: kafka }
        channelSource bus { for: Ch, use: durable }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
  });

  // M-T4.4 pinned decision: the broker line-up is redis/rabbitmq/kafka —
  // `nats` parses as a storage type but is not a channel transport.
  it("rejects nats as a channel transport (loom.channelsource-unsupported-transport)", async () => {
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E }
        }}
        storage bus { type: nats }
        channelSource b { for: Ch, use: bus }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors.some((e) => /is not a channel transport/.test(e))).toBe(true);
  });

  it("rejects redis for queue/work (post-NATS matrix: rabbitmq or kafka)", async () => {
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E  delivery: queue  retention: work }
        }}
        storage cache { type: redis }
        channelSource b { for: Ch, use: cache }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors.some((e) => /can't realise it.*rabbitmq, kafka/.test(e))).toBe(true);
  });

  // Compatible-but-not-yet-shipped gate (loom.channelsource-not-yet-shipped):
  // redis is COMPATIBLE with queue/ephemeral (the compat matrix), but the
  // shipped redis driver only provisions broadcast/ephemeral — the generator
  // would silently skip the unshipped combo and fall back to in-process.
  it("rejects queue/ephemeral on redis (compatible but not yet shipped)", async () => {
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E  delivery: queue  retention: ephemeral }
        }}
        storage cache { type: redis }
        channelSource b { for: Ch, use: cache }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors.some((e) => /not yet provisioned by a shipped redis driver/.test(e))).toBe(true);
    // It is NOT the incompatible diagnostic — redis IS compatible with the combo.
    expect(errors.some((e) => /can't realise it/.test(e))).toBe(false);
  });

  it("accepts queue/ephemeral on rabbitmq (a shipped combo)", async () => {
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E  delivery: queue  retention: ephemeral }
        }}
        storage mq { type: rabbitmq }
        channelSource b { for: Ch, use: mq }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
  });

  // M-T4.4 slice 1: the deployable `channels:` wiring clause.
  it("parses a deployable channels: clause referencing a channelSource", async () => {
    const src = `
      system S {
        subdomain M { context C {
          event E { order: string }
          channel Ch { carries: E }
        }}
        storage bus { type: redis }
        channelSource chBus { for: Ch, use: bus }
        deployable api { platform: node contexts: [C] channels: [chBus] port: 3000 }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
  });
});
