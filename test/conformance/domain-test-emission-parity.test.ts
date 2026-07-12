// Cross-backend emission parity for domain `test "…"` blocks — the conformance
// gate that closes F2 of docs/audits/test-parity-generated-backends.md (the
// "silent drop" detection gap).
//
// The original parity break (F1): a `.ddd` that declares `test` blocks on an
// aggregate and is generated to a backend with no test emitter produced ZERO
// test files — the assertions vanished without a diagnostic. F1 is fixed (every
// domain-logic backend now emits), but nothing PINNED that invariant, so a
// future emitter regression (or a new backend that forgets the wiring) could
// silently reintroduce the drop. The compile/runtime tiers can't catch it: a
// missing test file is green-but-empty, not a build error.
//
// This fast (no-docker) gate asserts, for an aggregate that declares `test`
// blocks, that EVERY domain-logic backend emits a non-trivial test artefact —
// a full port where every declared test is runnable (no skip marker in the
// emitted file): node / dotnet / java / python / elixir (vanilla — plain
// Ecto/Phoenix, the only Elixir foundation).
//
// Frontends (react/vue/svelte/angular) run no domain logic and are n/a — they
// are out of scope here by construction (no backend test emitter).
//
// Lives in the always-on `test` gate (like findall-parity / union-find-absence).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** A single aggregate carrying two domain `test` blocks (an invariant-rejection
 *  and a value-object field read) — the minimal shape every backend's test
 *  emitter must handle. Only the platform varies. */
function system(platform: string): string {
  return `
system S {
  subdomain Sales {
    context Selling {
      valueobject Money { amount: money  currency: string  invariant amount >= 0.0 }
      aggregate Order {
        customer: string
        status: string = "open"
        invariant customer.length > 0
        operation confirm() { precondition status == "open"  status := "confirmed" }
        test "blank customer rejected" {
          expect(Order.create({ customer: "" })).toThrow()
        }
        test "money builds" {
          let m = Money { amount: 1.0, currency: "USD" }
          expect(m.currency).toBe("USD")
        }
        // A happy-path post-operation STATE assertion — runnable on every
        // full-port backend (no skip marker).
        test "confirming an open order" {
          let o = Order.create({ customer: "acme" })
          o.confirm()
          expect(o.status).toBe("confirmed")
        }
      }
      repository Orders for Order { }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Selling, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [Selling]
    dataSources: [s]
    serves: A
    port: 4000
  }
}`;
}

/** Classification of the emitted suite:
 *  - "full"  — every declared test is runnable (no skip marker). */
type Shape = "full";

interface Case {
  readonly platform: string;
  /** Matches the aggregate's emitted domain-test file. */
  readonly file: RegExp;
  readonly shape: Shape;
}

const CASES: readonly Case[] = [
  { platform: "node", file: /\/domain\/order\.test\.ts$/, shape: "full" },
  { platform: "dotnet", file: /\/Orders\/OrderTests\.cs$/, shape: "full" },
  { platform: "java", file: /\/OrderTests\.java$/, shape: "full" },
  { platform: "python", file: /\/tests\/test_order\.py$/, shape: "full" },
  // Elixir (vanilla — plain Ecto/Phoenix) — full port via the pure domain
  // core; nothing skips.
  {
    platform: "elixir",
    file: /\/test\/selling\/order_test\.exs$/,
    shape: "full",
  },
];

/** Skip markers across the five target languages. The full-port backends emit
 *  none of these. */
const SKIP_MARKERS = [
  "@tag :skip", // ExUnit
  "it.skip", // vitest
  "test.skip", // vitest
  "describe.skip", // vitest
  "(Skip =", // xUnit  [Fact(Skip = "…")]
  "(Skip=", // xUnit (no-space)
  "@pytest.mark.skip", // pytest
  "pytest.skip", // pytest
  "@Disabled", // JUnit 5
] as const;

/** Separator-insensitive, case-insensitive match of a test description against
 *  emitted content — tolerant of each backend's casing of the description into
 *  an identifier (`moneyBuilds`, `money_builds`, `MoneyBuilds`, "money builds"). */
function mentions(content: string, phrase: string): boolean {
  const re = new RegExp(phrase.split(" ").join("[\\s_]?"), "i");
  return re.test(content);
}

describe('domain `test "…"` blocks — cross-backend emission parity', () => {
  for (const { platform, file, shape } of CASES) {
    it(`${platform}: emits a domain-test artefact (${shape})`, async () => {
      const files = await generateSystemFiles(system(platform));
      const matches = [...files.entries()].filter(([k]) => file.test(k));

      // F2: exactly one test artefact for the test-bearing aggregate — not zero
      // (silent drop) and not a duplicate.
      expect(
        matches.length,
        `${platform}: expected one file matching ${file}; got ${matches.length}\n${[
          ...files.keys(),
        ].join("\n")}`,
      ).toBe(1);

      const content = matches[0][1];

      // Non-trivial: both declared tests reached the emitted suite (run OR
      // skipped — but present). A green-but-empty file would fail here.
      expect(mentions(content, "blank customer rejected"), `${platform}: missing first test`).toBe(
        true,
      );
      expect(mentions(content, "money builds"), `${platform}: missing second test`).toBe(true);

      // Classification pin: every full-port backend carries no skip marker at
      // all.
      const skips = SKIP_MARKERS.filter((m) => content.includes(m));
      expect(shape, "only the full-port classification remains").toBe("full");
      expect(skips, `${platform}: full-port suite should carry no skip marker`).toEqual([]);
    });
  }
});
