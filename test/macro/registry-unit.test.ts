// Direct unit coverage of the macro REGISTRY (M-T9.18).
//
// `src/macros/registry.ts` is four functions and a `Map`, and every one of its
// contracts is relied on somewhere that cannot see it fail:
//
//   - `allMacros()` order IS the stdlib registration order — the expander's
//     "unknown macro `X`; registered macros are: …" hint lists it, and the
//     doc-comment promises it ("in registration order") without anything
//     asserting it.
//   - `registerMacro` REFUSES a duplicate name loudly, naming BOTH targets:
//     stdlib loads first, so a project-local `.loom/macros/*.js` that collides
//     must error instead of silently overriding a shipped macro.
//   - `lookupMacro` returns `undefined` for an unknown name — the validator's
//     whole unknown-macro diagnostic hangs off that, and a thrown error there
//     would take down expansion instead of reporting.
//   - `_resetRegistryForTests()` actually empties it.
//
// Registration is process-global with no `unregister`, so — exactly as
// `misbehaving-macro-diagnostics.test.ts` does — every macro registered here
// uses a globally unique `__unitTest_` name behind a `lookupMacro` guard, so a
// re-run inside one worker cannot trip the duplicate error.
//
// The reset test below WIPES the shared registry.  That is safe because vitest
// isolates each test FILE's module graph (`isolate: true`, the default), so the
// registry this file mutates is its own instance — and it is restored from a
// snapshot in `afterAll` regardless, with the following `describe` asserting
// the restoration actually happened.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MacroDefinition } from "../../src/macros/api/define.js";
import {
  _resetRegistryForTests,
  allMacros,
  lookupMacro,
  registerMacro,
} from "../../src/macros/registry.js";
import { _resetStdlibLoadFlag, loadStdlibMacros } from "../../src/macros/stdlib/index.js";

// The registry is only populated as a side effect of booting the language
// services; load it explicitly so this file does not depend on import order.
loadStdlibMacros();

const macro = (name: string, target: MacroDefinition["target"] = "aggregate"): MacroDefinition =>
  ({ name, target, apiVersion: 1, expand: () => [] }) as unknown as MacroDefinition;

/** Register once — the registry is process-global and throws on a duplicate. */
function ensure(def: MacroDefinition): MacroDefinition {
  if (!lookupMacro(def.name)) registerMacro(def);
  return lookupMacro(def.name)!;
}

const names = (): string[] => allMacros().map((m) => m.name);

// The first three `registerMacro(...)` calls in `src/macros/stdlib/index.ts`,
// in source order.  Asserted as a PREFIX rather than the whole list so adding
// a stdlib macro doesn't churn this test — reordering the head still fails.
const STDLIB_HEAD = ["softDelete", "softDeleteByDefault", "crudish"];

describe("macro registry", () => {
  it("keeps registration order in `allMacros()`", () => {
    expect(names().slice(0, STDLIB_HEAD.length)).toEqual(STDLIB_HEAD);

    // Two fresh registrations land at the END, in the order they were made —
    // a `Map` preserves insertion order and `allMacros()` must not sort.
    const first = ensure(macro("__unitTest_orderA"));
    const second = ensure(macro("__unitTest_orderB", "ui"));
    const listed = names();
    expect(listed.indexOf(first.name)).toBeGreaterThan(listed.indexOf(STDLIB_HEAD[2]!));
    expect(listed.indexOf(second.name)).toBe(listed.indexOf(first.name) + 1);
  });

  it("hands back a fresh array each call, not a live view of the map", () => {
    const snapshot = allMacros();
    const before = snapshot.length;
    expect(allMacros()).not.toBe(snapshot); // a new array per call
    (snapshot as MacroDefinition[]).length = 0; // mutating the copy is harmless
    expect(allMacros()).toHaveLength(before);

    // …but the NEXT call does see a registration made after the snapshot.
    ensure(macro("__unitTest_freshArray"));
    expect(names()).toContain("__unitTest_freshArray");
  });

  it("refuses a duplicate name, naming the existing AND the offending target", () => {
    const existing = ensure(macro("__unitTest_duplicate", "aggregate"));
    expect(existing.target).toBe("aggregate");

    // A project-local macro colliding with a shipped one: it must be told which
    // macro it collided with and what each side targets, not silently win.
    let thrown: Error | undefined;
    try {
      registerMacro(macro("__unitTest_duplicate", "ui"));
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("__unitTest_duplicate");
    expect(thrown?.message).toContain("target=aggregate"); // the incumbent
    expect(thrown?.message).toContain("target=ui"); // the rejected one

    // The incumbent is untouched — a refused registration is not a partial one.
    expect(lookupMacro("__unitTest_duplicate")).toBe(existing);
    expect(names().filter((n) => n === "__unitTest_duplicate")).toHaveLength(1);
  });

  it("`lookupMacro` returns undefined for an unknown name — the validator contract", () => {
    // `expandOneCall` does `const macro = lookupMacro(name)` and reports
    // `loom.unknown-macro` on the undefined; a throw would abort expansion.
    expect(lookupMacro("__unitTest_neverRegistered")).toBeUndefined();
    expect(lookupMacro("")).toBeUndefined();
    expect(() => lookupMacro("__unitTest_neverRegistered")).not.toThrow();

    // And it returns the very object that was registered, not a copy.
    const def = ensure(macro("__unitTest_identity"));
    expect(lookupMacro("__unitTest_identity")).toBe(def);
  });
});

// ---------------------------------------------------------------------------
// The reset hook.  Wipes and restores the shared registry — see the file header
// for why that is safe here.
// ---------------------------------------------------------------------------

let saved: readonly MacroDefinition[] = [];

describe("_resetRegistryForTests", () => {
  beforeAll(() => {
    saved = allMacros();
    expect(saved.length).toBeGreaterThan(0);
  });
  afterAll(() => {
    // Restore the exact pre-test registry — contents AND order.
    _resetRegistryForTests();
    for (const m of saved) registerMacro(m);
  });

  it("empties the registry — and the stdlib does NOT come back by itself", () => {
    expect(lookupMacro("scaffold")).toBeDefined();

    _resetRegistryForTests();
    expect(allMacros()).toEqual([]);
    expect(lookupMacro("scaffold")).toBeUndefined();
    expect(lookupMacro("__unitTest_identity")).toBeUndefined();

    // Its doc-comment claims "Stdlib re-registers itself on next import".  It
    // does not: `loadStdlibMacros()` latches on a module-level `_loaded` flag,
    // so calling it after a reset is a no-op.  DEFECT (doc-only) handed off.
    loadStdlibMacros();
    expect(allMacros()).toEqual([]);

    // The working recipe is the sibling hook `_resetStdlibLoadFlag()`, which
    // clears that latch — after which the stdlib reloads in its original order.
    _resetStdlibLoadFlag();
    loadStdlibMacros();
    expect(names().slice(0, STDLIB_HEAD.length)).toEqual(STDLIB_HEAD);
    // Only the stdlib is back; macros registered by this file are not.
    expect(lookupMacro("__unitTest_identity")).toBeUndefined();
  });
});

describe("registry after the reset round-trip", () => {
  it("is whole again — same macros, same order (so sibling test files are unaffected)", () => {
    // Proves the `afterAll` restore above actually ran: the wipe is contained
    // to that one test, and `test/macro`'s other suites still see the stdlib.
    expect(names()).toEqual(saved.map((m) => m.name));
    expect(lookupMacro("scaffold")).toBeDefined();
    expect(lookupMacro("__unitTest_identity")).toBeDefined();
  });
});
