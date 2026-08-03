// Printer coverage for the aggregate-header modifier REGION.
//
// The corpus round-trip (`print-structural-roundtrip.test.ts`) only exercises
// what `examples/` + `web/src/examples/` happen to declare, and neither
// `crossTenant` nor `audited` appears there — so both printer branches were
// unpinned.  A dropped branch is silent: the printer just omits the modifier,
// so `.ddd` source ejected by the LSP "unfold macro" action loses the flag and
// the aggregate quietly stops being cross-tenant / audited.
//
// These pin the emission AND the round-trip (print → re-parse → same flags),
// including the M-T5.17 sort-by-meaning ordering: realization modifiers land in
// the header region after the name, with `abstract` still leading.

import { describe, expect, it } from "vitest";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseRawResult } from "../../_helpers/index.js";

const SRC = (header: string): string => `system S {
  subdomain M {
    context C {
      ${header} {
        label: string
      }
    }
  }
}
`;

/** Print the whole `system` (recursively exercises the aggregate printer). */
function printedFor(header: string): string {
  const res = parseRawResult(SRC(header));
  expect(res.parserErrors, `fixture must parse: ${header}`).toEqual([]);
  const member = (res.value as Model).members[0]!;
  return printStructural(member);
}

function findAggregate(model: Model): Aggregate {
  const stack: unknown[] = [...((model as unknown as { members?: unknown[] }).members ?? [])];
  while (stack.length) {
    const n = stack.pop() as Record<string, unknown> | undefined;
    if (n?.$type === "Aggregate") return n as unknown as Aggregate;
    for (const k of ["members", "contexts", "subdomains"]) {
      const kids = n?.[k];
      if (Array.isArray(kids)) stack.push(...kids);
    }
  }
  throw new Error("no Aggregate found");
}

describe("aggregate-header modifier printing", () => {
  it("prints `crossTenant` in the header region, not the prefix slot", () => {
    const printed = printedFor("aggregate Plan crossTenant");
    expect(printed).toContain("aggregate Plan crossTenant");
    expect(printed).not.toContain("crossTenant aggregate");
  });

  it("prints `audited` in the header region", () => {
    const printed = printedFor("aggregate Cart audited");
    expect(printed).toContain("aggregate Cart audited");
    expect(printed).not.toContain("audited aggregate");
  });

  it("keeps `abstract` leading while the realization modifiers follow the name", () => {
    const printed = printedFor("abstract aggregate Base crossTenant audited");
    expect(printed).toContain("abstract aggregate Base");
    expect(printed.indexOf("abstract")).toBeLessThan(printed.indexOf("aggregate Base"));
    expect(printed.indexOf("aggregate Base")).toBeLessThan(printed.indexOf("crossTenant"));
  });

  // The point of a printer test: what it emits must parse back to the same flags.
  it("round-trips both flags through print → re-parse", () => {
    const printed = printedFor("aggregate Cart crossTenant audited");
    const re = parseRawResult(printed);
    expect(re.parserErrors, `printed source must parse:\n${printed}`).toEqual([]);
    const agg = findAggregate(re.value as Model);
    expect(agg.crossTenant).toBe(true);
    expect(agg.audited).toBe(true);
  });

  it("omits both when unset (off pays nothing in the printed source)", () => {
    const printed = printedFor("aggregate Plain");
    expect(printed).toContain("aggregate Plain");
    expect(printed).not.toContain("crossTenant");
    expect(printed).not.toContain("audited");
  });
});
