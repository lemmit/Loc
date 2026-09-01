// ---------------------------------------------------------------------------
// `propagateChildFlags` is the ONE place a child WalkContext's boolean sink
// flags are OR'd back into its parent (G2667 §D7).
//
// It used to have a near-copy — `propagateSinkFlags`, called from
// `emitVariantMatch`'s arm contexts — that had drifted FIVE entries behind:
// `usesTableSort`, `usesTableFilter`, `usesDataGrid`, `tabsDefault` and the
// `formOfs` list.  Nothing a statement ARM can write reaches those today (the
// page-statement vocabulary is assign/add/remove/let/expression/call/
// variant-match, none of which renders markup), which is precisely why the
// drift survived: the copy stayed correct while the original grew, and no test
// could tell.  The copy is gone; both call sites use `propagateChildFlags`.
//
// Two ratchets keep it from happening again:
//   1. a BEHAVIOURAL test that every boolean flag actually propagates;
//   2. a SOURCE pin that every `uses*` flag declared on `Sink` is named in the
//      propagator's body — the thing a hand-listed copy-back always forgets.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  propagateChildFlags,
  type WalkContext,
} from "../../../src/generator/_walker/walker-core.js";

const CORE = new URL("../../../src/generator/_walker/walker-core.ts", import.meta.url).pathname;

/** The boolean flags the propagator must carry, with the value a child sets. */
const BOOL_FLAGS = [
  "usesNavigate",
  "usesRouterLink",
  "usesRouteId",
  "usesTableSort",
  "usesTableFilter",
  "usesDataGrid",
  "usesState",
  "usesCurrentUser",
  "usesChildren",
  "usesCodeBlock",
  "usesFileUpload",
  "usesFragment",
] as const;

function blankCtx(): WalkContext {
  // Only the sink half is exercised; the rest of the walk context is irrelevant
  // to a pure flag copy-back, so an object literal cast is honest here.
  return {
    imports: new Map(),
    usedParams: new Set(),
    usedUserComponents: new Set(),
    usedApiHooks: new Map(),
    collectedTestids: new Set(),
    formOfs: [],
    actionMutations: [],
    usesNavigate: false,
    usesState: false,
    usesCurrentUser: false,
    usesRouterLink: false,
    usesRouteId: false,
    usesChildren: false,
    usesCodeBlock: false,
    usesFileUpload: false,
  } as unknown as WalkContext;
}

describe("propagateChildFlags — the one copy-back", () => {
  it.each(BOOL_FLAGS)("carries %s from child to parent", (flag) => {
    const parent = blankCtx();
    const child = blankCtx();
    (child as unknown as Record<string, unknown>)[flag] = true;
    propagateChildFlags(parent, child);
    expect(
      (parent as unknown as Record<string, unknown>)[flag],
      `${flag} set on the child never reached the parent — the page shell would skip whatever it gates`,
    ).toBe(true);
  });

  it("carries tabsDefault, and the FIRST one wins", () => {
    const parent = blankCtx();
    const a = blankCtx();
    a.tabsDefault = "overview";
    propagateChildFlags(parent, a);
    expect(parent.tabsDefault).toBe("overview");
    const b = blankCtx();
    b.tabsDefault = "settings";
    propagateChildFlags(parent, b);
    expect(parent.tabsDefault, "a second tab group must not steal the model").toBe("overview");
  });

  it("carries formOfs without duplicating a shared entry", () => {
    const parent = blankCtx();
    const child = blankCtx();
    const state = { kind: "create" } as unknown as (typeof parent.formOfs)[number];
    child.formOfs.push(state);
    propagateChildFlags(parent, child);
    propagateChildFlags(parent, child);
    expect(parent.formOfs).toEqual([state]);
  });

  it("never clears a flag the parent already set", () => {
    const parent = blankCtx();
    parent.usesState = true;
    propagateChildFlags(parent, blankCtx());
    expect(parent.usesState).toBe(true);
  });

  it("SOURCE PIN: every `uses*` flag on Sink is named in the propagator", () => {
    const src = readFileSync(CORE, "utf8");
    const sink = src.slice(src.indexOf("export interface Sink {"));
    const sinkBody = sink.slice(0, sink.indexOf("\n}\n"));
    const declared = [...sinkBody.matchAll(/^\s{2}(uses\w+)\??:/gm)].map((m) => m[1]!);
    expect(
      declared.length,
      "the Sink interface scan found nothing — the regex is stale",
    ).toBeGreaterThan(5);

    const fn = src.slice(src.indexOf("export function propagateChildFlags"));
    const fnBody = fn.slice(0, fn.indexOf("\n}\n"));
    const missing = declared.filter((f) => !fnBody.includes(f));
    expect(
      missing,
      "these Sink flags are declared but never copied back from a child context, so a body write " +
        "inside a lambda / match arm is lost and the page shell skips what the flag gates — " +
        "add them to propagateChildFlags in src/generator/_walker/walker-core.ts",
    ).toEqual([]);
  });

  it("SOURCE PIN: there is only ONE copy-back function", () => {
    const src = readFileSync(CORE, "utf8");
    // A DECLARATION or a CALL — the prose mention in the fold's own comment is
    // the historical record and must stay readable.
    expect(
      /propagateSinkFlags\s*\(/.test(src),
      "`propagateSinkFlags` is back — it was a near-copy of `propagateChildFlags` that drifted " +
        "five entries behind it.  Call `propagateChildFlags` instead.",
    ).toBe(false);
  });
});
