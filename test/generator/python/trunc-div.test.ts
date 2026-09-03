import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// F2-EXPR-6 — cross-backend `divTrunc` semantics on Python.
//
// `divTrunc` exists to give a DETERMINISTIC truncating division on every
// backend: java/.NET divide two primitive integers (`a / b`), elixir emits
// `div(a, b)`.  Python used to emit `int(a / b)`, which round-trips through an
// IEEE double — exact only below 2**53.  Python is the one backend whose ints
// are arbitrary precision, so that loss is real and silent:
//
//     a = 10**18 + 7, b = 3
//     int(a / b) == 333333333333333312       ← what python answered
//     exact      == 333333333333333335       ← what every other backend answers
//
// `//` is NOT the fix either: it FLOORS, so `-10 // 3 == -4` while every other
// backend truncates to `-3`.  Both rows now render the emitted `trunc_div`
// helper, which is exact AND truncating.  The helper's own arithmetic is
// asserted here by executing the emitted Python semantics in TS — a helper that
// is wired everywhere but computes the wrong number is the same bug.
// ---------------------------------------------------------------------------

const SOURCE = `
system DivProbe {
  subdomain Ops {
    context Ops {

      valueobject Slot {
        offset: long
        derived half: long = offset.divTrunc(2)
      }

      aggregate Job with crudish {
        seq: int
        big: long
        bay: Slot
        derived pairs: int = seq.divTrunc(2)
        derived thirds: long = big.divTrunc(3)
        invariant seq.divTrunc(2) >= 0

        operation advance(by: int) {
          let next = (seq + by).divTrunc(24)
          seq := next
        }
      }

      repository Jobs for Job { }

      domainService Sharding {
        operation shardOf(n: int): int {
          return n.divTrunc(16)
        }
      }
    }
  }

  api DivApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: python
    contexts: [Ops]
    dataSources: [opsState]
    serves: DivApi
    port: 4000
  }
}
`;

const IMPORT = "from app.domain.numeric import trunc_div";

const build = (): Promise<Map<string, string>> => generateSystemFiles(SOURCE);

describe("python `divTrunc` is exact and truncates towards zero (cross-backend parity)", () => {
  it("lowers divTrunc to trunc_div, never the lossy `int(a / b)` float round-trip", async () => {
    const files = await build();
    const domain = files.get("svc/app/domain/job.py");
    expect(domain).toContain("trunc_div(self._seq, 2)");
    expect(domain).toContain("trunc_div(self._big, 3)");
    expect(files.get("svc/app/domain/value_objects.py")).toContain("trunc_div(self.offset, 2)");
    expect(files.get("svc/app/domain/services/sharding.py")).toContain("trunc_div(n, 16)");
    // The lossy spelling is gone from every emitted module.  (numeric.py is
    // excluded: `trunc_div`'s own docstring NAMES the spelling it replaced.)
    for (const [path, content] of files) {
      if (!path.startsWith("svc/") || path === "svc/app/domain/numeric.py") continue;
      expect(content, `${path} still emits the float round-trip int(a / b)`).not.toMatch(
        /\bint\([^)]*\s\/\s[^)]*\)/,
      );
    }
  });

  it("emits the helper and imports it in every module that calls it", async () => {
    const files = await build();
    const helper = files.get("svc/app/domain/numeric.py");
    expect(helper).toBeDefined();
    expect(helper).toContain("def trunc_div(a: _N, b: _N) -> _N:");
    // Exact + truncating, NOT the flooring `a // b` alone.
    expect(helper).toContain("if (a < 0) != (b < 0):");
    expect(helper).toContain("return -(-a // b)");

    for (const [path, content] of files) {
      if (!path.startsWith("svc/") || !/\btrunc_div\(/.test(content)) continue;
      if (path === "svc/app/domain/numeric.py") continue;
      expect(content, `${path} calls trunc_div without importing it`).toContain(IMPORT);
    }
  });

  it("does not emit the helper for a project with no divTrunc", async () => {
    const files = await generateSystemFiles(SOURCE.replace(/\.divTrunc\(\d+\)/g, " + 1"));
    for (const [, content] of files) expect(content).not.toContain(IMPORT);
  });

  it("the emitted helper's arithmetic matches the other backends, past 2**53", () => {
    // The emitted body, transcribed: `-(-a // b)` when the signs differ, else
    // `a // b`.  BigInt models python's arbitrary-precision int; the `int(a / b)`
    // spelling this row replaced is modelled with Number to show the drift.
    const floorDiv = (a: bigint, b: bigint): bigint => {
      const q = a / b; // BigInt division already truncates
      return (a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q) as bigint;
    };
    const truncDiv = (a: bigint, b: bigint): bigint =>
      a < 0n !== b < 0n ? -floorDiv(-a, b) : floorDiv(a, b);

    const a = 10n ** 18n + 7n;
    expect(truncDiv(a, 3n)).toBe(333333333333333335n);
    // …the value the OLD emission produced, kept as the contrast.
    expect(BigInt(Math.trunc(Number(a) / 3))).toBe(333333333333333312n);

    // Truncation towards zero on every sign combination (`//` alone floors,
    // which would give -334 / -334 for the two mixed-sign rows below).
    expect(truncDiv(-1000n, 3n)).toBe(-333n);
    expect(truncDiv(1000n, -3n)).toBe(-333n);
    expect(truncDiv(-1000n, -3n)).toBe(333n);
    expect(truncDiv(1000n, 3n)).toBe(333n);
    // Exact division keeps the sign, no off-by-one.
    expect(truncDiv(-9n, 3n)).toBe(-3n);
  });
});
