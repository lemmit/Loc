// No-silent-skip gate for the vanilla (Ecto/Phoenix) domain-`test` emitter.
//
// The emitter degrades any shape it can't lower to the pure domain core into an
// `@tag :skip` stub (src/generator/elixir/vanilla/tests-emit.ts). That safety
// valve has a failure mode the runtime tier is BLIND to: `behavioral-e2e-elixir`
// boots the generated backend and runs `mix test`, but a skipped test is green,
// so the domain suite can silently shrink — a `.ddd` shape (or an emitter
// regression) that starts skipping passes every per-PR gate while covering
// nothing. `docs/audits/test-parity-generated-backends.md` flags exactly this.
//
// This fast (no-docker) gate ratchets the skip count to ZERO over a broad idiom
// corpus AND the real on-disk examples that carry a `platform: elixir`
// deployable. A regression that reintroduces a skip fails here per-PR, naming
// the test and the concrete reason the emitter recorded in the skip comment —
// converting a silent runtime gap into a loud toolchain signal.
//
// Companion to domain-test-emission-parity.test.ts (which pins that every
// backend emits a NON-EMPTY suite for one toy fixture); this pins that the
// Elixir port stays FULL across real, varied shapes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Every declared domain test the emitter degraded to a skip, with the reason it
 *  recorded in the `# … Reason: …` comment line. */
interface SilentSkip {
  readonly file: string;
  readonly reason: string;
}

function findSilentSkips(files: Map<string, string>): SilentSkip[] {
  const skips: SilentSkip[] = [];
  for (const [path, content] of files) {
    if (!path.endsWith("_test.exs")) continue;
    if (!content.includes("@tag :skip")) continue;
    // Pull the recorded reason(s) so the failure message is actionable.
    for (const m of content.matchAll(/#\s*Reason:\s*(.+)/g)) {
      skips.push({ file: path, reason: m[1].trim() });
    }
    // A skip with no reason line (shouldn't happen post-fix) still counts.
    if (!/#\s*Reason:/.test(content)) skips.push({ file: path, reason: "(no reason recorded)" });
  }
  return skips;
}

function assertNoSkips(label: string, files: Map<string, string>): void {
  const skips = findSilentSkips(files);
  expect(
    skips,
    `${label}: the vanilla Elixir domain-test emitter silently skipped ${skips.length} ` +
      `test(s) instead of a full port — behavioral-e2e-elixir would stay green while ` +
      `covering nothing.\n${skips.map((s) => `  • ${s.file}: ${s.reason}`).join("\n")}`,
  ).toEqual([]);
}

/** Wrap an aggregate body in a minimal single-context `platform: elixir` system. */
function elixirSystem(members: string): string {
  return `
system S {
  subdomain Sales {
    context Selling {
${members}
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Selling, kind: state, use: pg }
  deployable d {
    platform: elixir
    contexts: [Selling]
    dataSources: [s]
    serves: A
    port: 4000
  }
}`;
}

describe("vanilla Elixir domain-test emitter — no silent skips", () => {
  // A single aggregate exercising the breadth of the supported test idiom: a
  // create-invariant rejection, state-threading op calls, every value matcher
  // (==, >, >=, <, <=) over both scalars and money/Decimal, a `.not` negation,
  // string.length / array.count member reads, a boolean field, and a
  // value-object construction invariant (`toThrow` over a validatable VO). If
  // any of these regresses into a skip, the gate fails naming the reason.
  it("full-ports the breadth of the domain-test idiom (inline corpus)", async () => {
    const files = await generateSystemFiles(
      elixirSystem(`
      valueobject Money { amount: money  currency: string  invariant amount >= 0.0 }
      aggregate Order {
        customer: string
        total: money
        priority: int = 1
        active: bool = true
        tags: string[]
        status: string = "open"
        invariant customer.length > 0
        operation confirm() { precondition status == "open"  status := "confirmed" }
        operation bump() { priority := priority + 1 }
        test "blank customer rejected" {
          expect(Order.create({ customer: "" })).toThrow()
        }
        test "money invariant rejects negative" {
          expect(Money { amount: -1.0, currency: "USD" }).toThrow()
        }
        test "scalar and money matchers" {
          let o = Order.create({ customer: "acme", total: 10.0 })
          expect(o.priority).toBe(1)
          expect(o.priority).toBeGreaterThanOrEqual(1)
          expect(o.priority).toBeLessThan(5)
          expect(o.total).toBeGreaterThan(0.0)
          expect(o.customer.length).toBeGreaterThan(0)
          expect(o.active).toBe(true)
        }
        test "state threading through ops" {
          let o = Order.create({ customer: "acme" })
          o.confirm()
          o.bump()
          expect(o.status).toBe("confirmed")
          expect(o.priority).toBe(2)
          expect(o.status).not.toBe("open")
        }
      }
      repository Orders for Order { }`),
    );
    assertNoSkips("inline idiom corpus", files);
    // Sanity: the suite is actually non-empty (guards against a silent
    // whole-file drop masking a passing no-skip assertion).
    const suite = [...files].find(([k]) => k.endsWith("/selling/order_test.exs"));
    expect(suite, "expected an emitted order_test.exs").toBeDefined();
    expect(suite?.[1]).not.toContain("@tag :skip");
  });

  // The real corpus: every checked-in example carrying a `platform: elixir`
  // deployable. These are the shapes users actually write; a full port here is
  // the invariant behavioral-e2e-elixir depends on but can't itself verify.
  const REAL_EXAMPLES = [
    "examples/showcase.ddd",
    "examples/tasks-vanilla.ddd",
    "web/src/examples/store-showcase-elixir.ddd",
    "web/src/examples/storefront-elixir.ddd",
  ] as const;

  for (const rel of REAL_EXAMPLES) {
    it(`full-ports every domain test in ${rel}`, async () => {
      const src = readFileSync(rel, "utf8");
      const files = await generateSystemFiles(src);
      assertNoSkips(rel, files);
    });
  }
});
