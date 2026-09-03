// The `event_dispatched` log line must name the EVENT, not its constructor.
//
// It used to read `(event as object).constructor.name`, on the premise — stated
// in a comment — that this "is the emitted DomainEvent subclass name".  It is
// not.  `events.ts` emits each event as an INTERFACE with a literal `type`
// discriminator, and aggregates raise plain object literals, so every node
// repository logged `"event_type":"Object"` while its own dispatcher switched
// correctly on `event.type`.
//
// NO COMPILE TIER CAN SEE THIS: the wrong value is still a `string`, so tsc,
// the corpus gates and the wire goldens are all satisfied by it.  It surfaced
// only when a workflow subscriber was driven at runtime for the first time.
// Hence this gate — and hence it asserts the emitted SOURCE rather than a type.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SOURCE = `system Shipping {
  subdomain Ops {
    context Depot {
      event ParcelSent { parcel: Parcel id }
      aggregate Parcel {
        code: string
        operation send() {
          emit ParcelSent { parcel: id }
        }
      }
      repository Parcels for Parcel { }
    }
  }

  api DepotApi from Ops
  storage primary { type: postgres }
  resource depotState { for: Depot, kind: state, use: primary }

  deployable d {
    platform: node
    contexts: [Depot]
    dataSources: [depotState]
    serves: DepotApi
    port: 4000
  }
}`;

describe("event_dispatched logs the event's own type discriminator", () => {
  it("emits `.type`, never `constructor.name`, in every node repository", async () => {
    const files = await generateSystemFiles(SOURCE);
    const repos = [...files.entries()].filter(([p]) => /repositories\/.*-repository\.ts$/.test(p));
    // A silently-empty population is how a census gate passes without reaching
    // anything (`experience_gathered.md` §63) — so pin that we found one.
    expect(repos.length, "no repository files were emitted").toBeGreaterThan(0);

    for (const [path, body] of repos) {
      if (!body.includes("event_dispatched")) continue;
      expect(body, `${path} still logs the constructor name`).not.toContain("constructor.name");
      expect(body, `${path} does not read the event's type discriminator`).toContain(
        "event_type: (event as { type: string }).type",
      );
    }
  });

  it("emits events as interfaces carrying that discriminator — the reason the old form was wrong", async () => {
    const files = await generateSystemFiles(SOURCE);
    const events = [...files.entries()].find(([p]) => p.endsWith("domain/events.ts"));
    expect(events, "no domain/events.ts emitted").toBeDefined();
    // An `interface` has no constructor: this is the fact that makes
    // `constructor.name` read "Object" rather than "ParcelSent".
    expect(events![1]).toContain("export interface ParcelSent");
    expect(events![1]).toContain('readonly type: "ParcelSent"');
  });
});
