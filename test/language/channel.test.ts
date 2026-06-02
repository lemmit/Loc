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
    // broadcast/log needs kafka or nats; redis can't realise it.
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
});
