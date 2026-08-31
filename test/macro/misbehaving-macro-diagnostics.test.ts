// The macro-authoring ERROR surface (M-T9.33 / M-T9.18).
//
// `src/macros/expander.ts` carries three diagnostics that no `.ddd` source can
// reach, because none of them is a defect in the SOURCE — each is a defect in a
// registered MACRO:
//
//   loom.macro-threw            — `expand()` raised
//   loom.macro-non-ast-result   — `expand()` returned a non-object member
//   loom.macro-escapes-host     — a returned member is tagged for a destination
//                                 outside the host subtree
//
// The diagnostic-firing census (`test/system/diagnostic-firing-census.test.ts`)
// drives every other `loom.*` code from a minimal `.ddd`, and these three are
// exactly the codes it cannot express: its fixtures are source text, and the
// only way to trip these is to register a macro that misbehaves.  So they are
// driven HERE instead, and the census points at this file by name.
//
// WHY THIS MATTERS RATHER THAN BEING A FORMALITY.  This is the whole
// macro-authoring error surface — the messages a macro author sees when their
// macro is wrong — and nothing exercised any of it.  A refactor that made
// `expand()` swallow its own exception, or dropped the `isHostOrDescendant`
// guard, would have left the expander silently accepting a broken macro with
// every other test green.
//
// Registration is process-global and has no `unregister`, so each macro below
// uses a name no other test or stdlib macro can collide with, and registers
// once (guarded on `lookupMacro`) so a re-run inside one worker cannot throw
// the registry's duplicate error.

import { describe, expect, it } from "vitest";
import { validate } from "../../src/api/index.js";
import type { MacroDefinition } from "../../src/macros/api/define.js";
import { lookupMacro, registerMacro } from "../../src/macros/registry.js";

/** Register once — the registry is process-global and throws on a duplicate. */
function ensure(def: MacroDefinition): string {
  if (!lookupMacro(def.name)) registerMacro(def);
  return def.name;
}

const THROWS = ensure({
  name: "loomTestMacroThatThrows",
  target: "aggregate",
  apiVersion: 1,
  expand() {
    throw new Error("deliberate failure from a test macro");
  },
} as MacroDefinition);

const NON_AST = ensure({
  name: "loomTestMacroReturningNonAst",
  target: "aggregate",
  apiVersion: 1,
  // A macro that returns primitives instead of AST members.  `42` is the
  // interesting shape: `typeof 42` is what the diagnostic reports back.
  expand: () => [42 as unknown] as never[],
} as unknown as MacroDefinition);

const ESCAPES = ensure({
  name: "loomTestMacroEscapingHost",
  target: "aggregate",
  apiVersion: 1,
  // A member tagged for a destination that is NOT the host or one of its
  // descendants — the "inside-out" splice the expander refuses.  The tag
  // property is read off the returned object by the expander; an unrelated
  // object literal as the destination is never a descendant of the host.
  expand: (ctx: { host?: unknown }) => {
    const stranger = { $type: "Subdomain", name: "NotTheHost", contexts: [] };
    const member = {
      $type: "Property",
      name: "smuggled",
      // `DEST_PROP` in `expander.ts`.  Spelled literally rather than imported
      // because it is module-private there; if it is ever renamed this test
      // fails loudly, which is the correct outcome — the guard it drives would
      // be reading a tag nothing sets.
      $destination: stranger,
    };
    void ctx;
    return [member as unknown] as never[];
  },
} as unknown as MacroDefinition);

const withMacro = (macro: string) => `
system S {
  subdomain Sub {
    context C {
      aggregate Thing with ${macro} {
        name: string
      }
    }
  }
}`;

/** Every `loom.*` code `validate()` reports for a source. */
async function codesFor(source: string): Promise<string[]> {
  return (await validate(source)).diagnostics.map((d) => d.code);
}

describe("the macro-authoring error surface", () => {
  // A control, and the reason the three assertions below mean anything: the
  // same source shape with a WELL-BEHAVED stdlib macro raises none of these
  // codes, so a failure downstream is the macro's misbehaviour and not the
  // fixture's shape.
  it("a well-behaved macro raises none of the three", async () => {
    const codes = await codesFor(`
system S {
  user { id: string  role: string }
  subdomain Sub {
    context C {
      aggregate Thing with auditable {
        name: string
      }
    }
  }
}`);
    expect(codes).not.toContain("loom.macro-threw");
    expect(codes).not.toContain("loom.macro-non-ast-result");
    expect(codes).not.toContain("loom.macro-escapes-host");
  });

  it("loom.macro-threw — an `expand()` that raises is reported, not swallowed", async () => {
    const codes = await codesFor(withMacro(THROWS));
    expect(
      codes,
      `a throwing macro must surface as a diagnostic rather than crashing the ` +
        `build or being silently dropped.  Raised: ${[...new Set(codes)].join(", ") || "(nothing)"}`,
    ).toContain("loom.macro-threw");
  });

  it("loom.macro-non-ast-result — a non-object member is refused", async () => {
    const codes = await codesFor(withMacro(NON_AST));
    expect(codes, `Raised: ${[...new Set(codes)].join(", ") || "(nothing)"}`).toContain(
      "loom.macro-non-ast-result",
    );
  });

  it("loom.macro-escapes-host — a member aimed outside the host subtree is refused", async () => {
    const codes = await codesFor(withMacro(ESCAPES));
    expect(
      codes,
      `the inside-out guard must reject a splice into a node that is neither the ` +
        `host nor its descendant.  Raised: ${[...new Set(codes)].join(", ") || "(nothing)"}`,
    ).toContain("loom.macro-escapes-host");
  });
});
