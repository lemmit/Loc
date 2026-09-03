// ---------------------------------------------------------------------------
// `Slot { }` — the JSX token was the SILENT default.
//
// `emitSlot` ended in `ctx.target.renderChildrenSlot?.() ?? "{children}"`.  That
// fallback is a React idiom, and it is not inert where it is wrong: `{children}`
// parses in F# (an anonymous record over an unbound name) and in Dart (a set
// literal), so Feliz and Flutter emitted code that read fine and did not
// compile — the failure only surfaced in the SDK build gate, if at all.
//
// Both targets now implement the seam, so the fallback has exactly ONE
// legitimate consumer left (React), and reaching it from anywhere else throws.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { emitSlot } from "../../../src/generator/_walker/primitives/display.js";
import type { WalkContext } from "../../../src/generator/_walker/walker-core.js";
import { angularTarget } from "../../../src/generator/angular/walker/angular-target.js";
import { felizTarget } from "../../../src/generator/feliz/feliz-target.js";
import { flutterTarget } from "../../../src/generator/flutter/flutter-target.js";
import { tsxTarget } from "../../../src/generator/react/walker/tsx-target.js";
import { svelteTarget } from "../../../src/generator/svelte/walker/svelte-target.js";
import { vueTarget } from "../../../src/generator/vue/walker/vue-target.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

const SLOT_CALL: ExprIR & { kind: "call" } = { kind: "call", name: "Slot", args: [] };

/** The two fields `emitSlot` touches — enough to drive it in isolation. */
const ctxFor = (target: unknown): WalkContext =>
  ({ target, usesChildren: false }) as unknown as WalkContext;

describe("every frontend spells its own children slot", () => {
  const CASES: ReadonlyArray<[string, unknown, string]> = [
    ["react", tsxTarget, "{children}"], // the JSX-prop idiom — the one default
    ["vue", vueTarget, "<slot />"],
    ["svelte", svelteTarget, "{@render children?.()}"],
    ["angular", angularTarget, "<ng-content></ng-content>"],
    // Paren-wrapped so `pack.ts`'s `isRenderedElement` prefix test stays sound:
    // every element the Feliz walk produces starts with `Html.` or `(`, so a
    // slot read landing in a text-OR-markup slot is never mistaken for raw text
    // and wrapped as `Html.text "props.children"`.  (Flutter parenthesises its
    // own slot read for the analogous reason.)
    ["feliz", felizTarget, "(props.children)"],
    ["flutter", flutterTarget, "(child ?? const SizedBox.shrink())"],
  ];

  for (const [name, target, expected] of CASES) {
    it(`${name} renders ${expected}`, () => {
      const ctx = ctxFor(target);
      expect(emitSlot(SLOT_CALL, ctx, 0)).toBe(expected);
      // Either way, the shell is told to declare the children parameter.
      expect(ctx.usesChildren).toBe(true);
    });
  }

  it("react is the ONLY target still taking the shared fallback", () => {
    expect(tsxTarget.renderChildrenSlot).toBeUndefined();
    for (const t of [vueTarget, svelteTarget, angularTarget, felizTarget, flutterTarget]) {
      expect(t.renderChildrenSlot).toBeDefined();
    }
  });
});

describe("a seamless non-JSX target fails loudly instead of emitting {children}", () => {
  it("throws, naming the framework and the seam to implement", () => {
    // What Feliz and Flutter looked like before this change: a target with no
    // `renderChildrenSlot`, whose embedded language is not JSX.
    const seamless = { ...felizTarget, framework: "someNewFrontend" };
    seamless.renderChildrenSlot = undefined;
    expect(() => emitSlot(SLOT_CALL, ctxFor(seamless), 0)).toThrow(
      /frontend 'someNewFrontend' has no renderChildrenSlot seam/,
    );
    expect(() => emitSlot(SLOT_CALL, ctxFor(seamless), 0)).toThrow(/renderChildrenSlot/);
  });

  it("does not throw for react, which the fallback is correct for", () => {
    expect(() => emitSlot(SLOT_CALL, ctxFor(tsxTarget), 0)).not.toThrow();
  });
});
