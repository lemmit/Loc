// Read-bearing primitives are declared ONCE, in the walker registry.
//
// Feliz and Flutter are the two targets that MATERIALISE a read rather than
// hoisting it inline: Feliz into a Model field + `Msg` + init `Cmd` + update
// arm, Flutter into a Riverpod provider.  Both walk the page body up front to
// find the reads, and both used to enumerate the read-bearing primitives by
// name (`e.name === "QueryView"`).  `Chart` was the second such primitive ever
// added, and it was missed by both — a chart-only page named a Model field
// nothing declared, and watched a provider nothing wrote.
//
// The fact now lives on the registry entry (`readsOf`) and both collectors ask
// `isOfReadCall`.  The test that matters is therefore not "is Chart handled"
// (the per-frontend chart suites already pin that) but "does the REGISTRY
// drive the collectors" — so the last test registers a primitive the
// collectors have never heard of and watches both pick it up.

import { afterEach, describe, expect, it } from "vitest";
import { isOfReadCall, isOfReadPrimitive, ofArgOf } from "../../src/generator/_walker/of-reads.js";
import { WALKER_PRIMITIVES } from "../../src/generator/_walker/registry.js";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";

/** A minimal `<Name>(of: <ref>)` call IR — enough for the predicate, which is
 *  all these cases exercise. */
function call(name: string, ofArg?: ExprIR): ExprIR {
  return {
    kind: "call",
    name,
    args: ofArg ? [ofArg] : [],
    argNames: ofArg ? ["of"] : [],
  } as ExprIR;
}

const REF: ExprIR = { kind: "ref", name: "Sales", refKind: "param" } as ExprIR;

describe("read-bearing primitives come from the registry", () => {
  it("agrees exactly with the registry's `readsOf` flag", () => {
    const flagged = Object.entries(WALKER_PRIMITIVES)
      .filter(([, def]) => def.readsOf)
      .map(([name]) => name)
      .sort();
    // Both of today's read-bearing primitives, and nothing else.  A new one
    // shows up here the moment it is declared — which is the point.
    expect(flagged).toEqual(["Chart", "QueryView"]);
    for (const name of flagged) expect(isOfReadPrimitive(name)).toBe(true);
  });

  it("is false for a primitive that takes no read", () => {
    // `Table` has an `of:` too — but it binds ROWS the page already holds, not
    // a read to materialise.  The distinction is exactly what the flag records.
    expect(isOfReadPrimitive("Table")).toBe(false);
    expect(isOfReadPrimitive("Stack")).toBe(false);
    expect(isOfReadCall(call("Table", REF))).toBe(false);
  });

  it("unwraps the `of:` argument, and stays total without one", () => {
    expect(ofArgOf(call("QueryView", REF))).toBe(REF);
    expect(ofArgOf(call("QueryView"))).toBeUndefined();
    expect(ofArgOf(call("Stack", REF))).toBeUndefined();
  });
});

describe("the collectors follow the registry, not a list of their own", () => {
  const FAKE = "TotallyNewReadPrimitive";

  afterEach(() => {
    delete (WALKER_PRIMITIVES as Record<string, unknown>)[FAKE];
  });

  it("picks up a primitive registered after the collectors were written", () => {
    // The mutation proof.  Nothing in `feliz/wire.ts` or `flutter/reads-emit.ts`
    // has ever heard of this name; if either still hard-coded its own list, the
    // predicate they call would answer `false` here.  The lookup is deliberately
    // lazy (a registry read per call, not a Set frozen at module load) so this
    // is observable at all.
    expect(isOfReadCall(call(FAKE, REF))).toBe(false);

    (WALKER_PRIMITIVES as Record<string, unknown>)[FAKE] = {
      group: "layout",
      admissibleInSource: true,
      readsOf: true,
    };

    expect(isOfReadCall(call(FAKE, REF))).toBe(true);
    expect(ofArgOf(call(FAKE, REF))).toBe(REF);
  });
});
