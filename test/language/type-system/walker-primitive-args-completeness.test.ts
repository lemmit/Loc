// Completeness guard for the walker primitives' NAMED-ARGUMENT vocabulary.
//
// `src/util/walker-primitive-args.ts` is what `loom.page-primitive-unknown-arg`
// (src/ir/validate/checks/ui-checks.ts) rejects against.  A gate that rejects
// an argument an emitter actually honours would be worse than the silent drop
// it replaces, so the table is not trusted on its own — it is pinned here,
// mechanically, against three independent sources:
//
//   1. the REGISTRY (src/generator/_walker/registry.ts) — one row per
//      primitive, so a new primitive cannot land without declaring what it
//      accepts;
//   2. `USER_VISIBLE_SLOTS` — every NAMED slot must be accepted, else the gate
//      would reject an argument the i18n extraction pass still harvests,
//      leaving translators an orphan catalog key for content nothing renders;
//   3. the EMITTERS THEMSELVES — every named argument read out of a primitive
//      call anywhere in the walker sources must appear in some row.
//
// (3) is the safety-critical direction and is derived from source rather than
// asserted: the scan below reads the emitter files and collects every
// `<reader>(<call>, "<name>")` literal.  The REVERSE is deliberately not
// pinned — a row may list a name no emitter reads yet (that direction is
// permissive, and is how a per-target divergence is recorded: `Button`'s
// `type:` reaches Phoenix's `<.button>` and nothing else).
//
// If a new reader HELPER appears (something other than the ones listed in
// `ARG_READERS`), add it here — otherwise this test silently stops covering
// the arguments it reads.  `HARDCODED_READS` carries the handful of readers
// that bake the argument name in rather than taking it as a parameter.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WALKER_PRIMITIVES } from "../../../src/generator/_walker/registry.js";
import { USER_VISIBLE_SLOTS } from "../../../src/util/user-visible-slots.js";
import {
  UNIVERSAL_PRIMITIVE_NAMED_ARGS,
  WALKER_PRIMITIVE_NAMED_ARGS,
  walkerPrimitiveNamedArgs,
} from "../../../src/util/walker-primitive-args.js";

const ROOT = join(import.meta.dirname, "../../..");

/** Every helper that reads a named argument BY NAME off a primitive call.
 *  Each takes the call as its first parameter and the argument name as a
 *  string literal second parameter — the shape the scan below matches. */
const ARG_READERS = [
  "namedArgValue",
  "stringNamed",
  "stringNamedLit",
  "boolNamed",
  "numericNamed",
  "namedArg",
  "lambdaArg",
  "actionRefArg",
  "stateBindArg",
  "stateRefArg",
  "stateNameArg",
  "refArgName",
  "stringOrRefArgValue",
  "anyNamedArgExpr",
  "navArgValue",
  "findPascalArg",
] as const;

/** Readers that bake the name in instead of taking it as a parameter, and the
 *  name each one reads.  (`styleAttr` reads the `style` IR field that
 *  `hoistStyleArg` lifted off the call — see the universal set.) */
const HARDCODED_READS: Record<string, string> = {
  gridCols: "cols",
  testidAttr: "testid",
  styleAttr: "style",
};

/** The emitter sources the scan covers: the shared walker primitive table, the
 *  walker core, and the Phoenix/HEEx twin (which runs its own engine). */
const EMITTER_FILES = [
  "src/generator/_walker/walker-core.ts",
  "src/generator/elixir/heex-primitives.ts",
  ...[
    "chart",
    "code-block",
    "controls",
    "data-grid",
    "data-grid-shape",
    "display",
    "file-link",
    "for",
    "forms",
    "icon",
    "inputs",
    "layout",
    "provenance-info",
    "table",
    "text",
    "timeline",
  ].map((f) => `src/generator/_walker/primitives/${f}.ts`),
];

function namedArgsReadByEmitters(): Map<string, string[]> {
  const readerAlt = ARG_READERS.join("|");
  const re = new RegExp(
    `\\b(?:${readerAlt})\\(\\s*[A-Za-z_][A-Za-z0-9_]*\\s*,\\s*"([a-zA-Z][a-zA-Z0-9_]*)"`,
    "g",
  );
  const found = new Map<string, string[]>();
  for (const rel of EMITTER_FILES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const m of src.matchAll(re)) {
      const name = m[1]!;
      (found.get(name) ?? found.set(name, []).get(name)!).push(rel);
    }
    for (const [reader, name] of Object.entries(HARDCODED_READS)) {
      if (new RegExp(`\\b${reader}\\(`).test(src)) {
        (found.get(name) ?? found.set(name, []).get(name)!).push(rel);
      }
    }
  }
  return found;
}

describe("walker primitive named-argument vocabulary", () => {
  it("declares exactly the registry's primitives", () => {
    expect(Object.keys(WALKER_PRIMITIVE_NAMED_ARGS).sort()).toEqual(
      Object.keys(WALKER_PRIMITIVES).sort(),
    );
  });

  it("accepts every NAMED user-visible slot, so no gated argument orphans a catalog key", () => {
    const missing: string[] = [];
    for (const [primitive, slots] of Object.entries(USER_VISIBLE_SLOTS)) {
      const accepted = walkerPrimitiveNamedArgs(primitive);
      if (accepted === undefined) continue; // not a walker primitive
      for (const slot of slots) {
        if (slot.kind === "named" && !accepted.has(slot.name)) {
          missing.push(`${primitive}.${slot.name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("accepts every named argument the walker emitters actually read", () => {
    const universe = new Set<string>(UNIVERSAL_PRIMITIVE_NAMED_ARGS);
    for (const args of Object.values(WALKER_PRIMITIVE_NAMED_ARGS)) {
      for (const a of args) universe.add(a);
    }
    const unaccepted: string[] = [];
    for (const [name, files] of namedArgsReadByEmitters()) {
      if (!universe.has(name))
        unaccepted.push(`${name} (read in ${[...new Set(files)].join(", ")})`);
    }
    expect(unaccepted).toEqual([]);
  });

  it("scans emitter sources that exist and finds a plausible number of reads", () => {
    // Guards the scan itself: a renamed helper or a moved emitter file would
    // otherwise turn the assertion above into a vacuous pass.
    const found = namedArgsReadByEmitters();
    expect(found.size).toBeGreaterThan(40);
    for (const known of ["of", "bind", "trigger", "rows", "cols", "testid"]) {
      expect([...found.keys()]).toContain(known);
    }
  });
});
