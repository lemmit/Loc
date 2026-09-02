// node/Hono — the CANONICAL `datetime` wire form (RS-4, F2-W-05).
//
// RS-4 (docs/conformance-semantics.md) pins the canonical wire spelling of an
// instant as `…T00:00:00Z` — trailing zero fractional seconds trimmed.  Node
// was the one backend that did NOT do that: `Date.toISOString()` always pads
// the fraction to three digits, so every datetime field on every read route
// shipped `…T00:00:00.000Z` while .NET trimmed with this same regex, java's
// `Instant.toString()` and python's `isoformat()` omit a zero fraction, and
// elixir's `:utc_datetime` carries no fraction at all — four against one.
//
// Structurally invisible to the differential harness: `test/_helpers/
// response-diff.ts` normalises `.000Z` and the no-fraction form to one
// `<timestamp>` token by design, and the OpenAPI dimension only compares
// `format: date-time`.  Hence a direct pin on the emitted expression.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = `
system W {
  subdomain S {
    context C {
      aggregate Widget with crudish {
        name: string
        releasedAt: datetime
        retiredAt: datetime?
      }
      repository Widgets for Widget { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

// The exact suffix the emitted expression carries — trailing zero fractional
// seconds trimmed.  Written out here so a change to the trim is a change to
// this literal, not a silent re-spelling of every timestamp on the wire.
const TRIM = '.toISOString().replace(/\\.?0+Z$/, "Z")';

describe("node datetime wire form", () => {
  it("trims the zero fraction on required and optional datetime fields", async () => {
    const repo = (await generateSystemFiles(SOURCE)).get("d/db/repositories/widget-repository.ts")!;
    expect(repo).toContain(`releasedAt: (root.releasedAt as Date)${TRIM}`);
    expect(repo).toContain(
      `retiredAt: (root.retiredAt == null ? null : (root.retiredAt == null ? null : (root.retiredAt as Date)${TRIM}))`,
    );
    // No bare `.toISOString()` survives on the wire path — that spelling is
    // precisely the `.000Z` divergence.
    expect(repo).not.toMatch(/toISOString\(\)(?!\.replace)/);
  });

  it("produces the canonical form the other four backends agree on", () => {
    // The emitted trim, evaluated: a whole-second instant loses its fraction
    // (the RS-4 observable), a real sub-second one keeps its digits, and the
    // SECONDS field is never eaten — `toISOString()` always supplies the `.mmm`
    // group the regex anchors on.
    const canonical = (iso: string): string => new Date(iso).toISOString().replace(/\.?0+Z$/, "Z");
    expect(canonical("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(canonical("2026-01-01T00:00:20Z")).toBe("2026-01-01T00:00:20Z");
    expect(canonical("2026-01-01T10:20:30Z")).toBe("2026-01-01T10:20:30Z");
    expect(canonical("2026-01-01T00:00:10.123Z")).toBe("2026-01-01T00:00:10.123Z");
  });
});
