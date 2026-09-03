import { describe, expect, it } from "vitest";
import {
  elixirRegexBody,
  elixirString,
  plural,
  snake,
  workflowFnCamel,
  workflowFnPascal,
  workflowFnSnake,
} from "../../src/util/naming.js";

// Edge behaviour of `src/util/naming.ts` that `test/util/naming.test.ts` does
// not reach.  Three groups, each pinning something a "helpful" rewrite would
// break silently:
//
//   1. `plural` on inputs the CONSERVATIVE rule was never meant to handle
//      (already-plural words, acronyms, digits, the empty string).  These pins
//      record the ACTUAL current output, which is sometimes wrong English —
//      that is the documented trade (CLAUDE.md § Conventions: "Conservative
//      plural rules: y → ies, s/x/z/ch/sh → +es, else +s").  A pin here is not
//      an endorsement; it is a tripwire so a swap to an inflection library
//      shows up as a CHANGED TABLE NAME rather than a silent migration diff.
//   2. the three `workflowFn*` casings — mutually derivable and collision-free,
//      because the call site (render-expr, `callKind: "workflow-fn"`) and the
//      definition site (each backend's workflow emitter) must agree byte-for-byte.
//   3. `elixirString` / `elixirRegexBody`, the injection funnel: a `.ddd`-sourced
//      string or regex spliced into Elixir source must not interpolate (`#{`)
//      or close its sigil (`/`).

describe("naming — plural on already-plural input (conservative rule, not a bug)", () => {
  // The rule has no "is this already plural?" test by design: it is a pure
  // suffix function so the same aggregate name always yields the same table /
  // route / DTO name.  An already-plural aggregate name therefore double-
  // pluralises.  Pinned as CURRENT BEHAVIOUR, matching the documented rule.
  it("`Statuses` → `Statuseses` (ends in `s`, so +es fires again)", () => {
    expect(plural("Statuses")).toBe("Statuseses");
  });

  it("`Boxes` → `Boxeses` (same: the +es arm cannot tell it already applied)", () => {
    expect(plural("Boxes")).toBe("Boxeses");
  });

  it("is NOT idempotent — plural(plural(x)) ≠ plural(x) for the +es arm", () => {
    expect(plural(plural("Status"))).not.toBe(plural("Status"));
    expect(plural(plural("Box"))).toBe("Boxeses");
  });

  it("IS idempotent-looking for the plain +s arm only by accident", () => {
    // `Orders` ends in `s`, so a second pass takes the +es arm, not +s.
    expect(plural("Order")).toBe("Orders");
    expect(plural("Orders")).toBe("Orderses");
  });
});

describe("naming — plural on acronyms", () => {
  it("`API` → `APIs` (no trailing s/x/z/ch/sh, no trailing y — plain +s)", () => {
    expect(plural("API")).toBe("APIs");
  });

  it("`APIKey` → `APIKeys` — the vowel guard sees `ey`, so NOT `APIKeies`", () => {
    expect(plural("APIKey")).toBe("APIKeys");
  });

  it('snake(plural("APIKey")) is `api_keys` — the acronym boundary survives', () => {
    // This is the actual composition every SQL table name goes through.
    expect(snake(plural("APIKey"))).toBe("api_keys");
  });

  it("an acronym ending in an UPPERCASE S takes the +s arm, not +es", () => {
    // `/(s|x|z|ch|sh)$/` is case-SENSITIVE, so `CMS` misses the +es arm that
    // `cms` would take.  Current behaviour, pinned: `CMSs`, not `CMSes`.
    expect(plural("CMS")).toBe("CMSs");
    expect(plural("cms")).toBe("cmses");
    // Same asymmetry for the other +es triggers.
    expect(plural("BOX")).toBe("BOXs");
    expect(plural("box")).toBe("boxes");
  });

  it("an ALL-CAPS word ending in Y misses the `ies` arm too", () => {
    // `input.endsWith("y")` is likewise case-sensitive.
    expect(plural("CATEGORY")).toBe("CATEGORYs");
    expect(plural("Category")).toBe("Categories");
  });
});

describe("naming — plural with digits", () => {
  it("`Item2` → `Item2s` (a trailing digit takes the default +s arm)", () => {
    expect(plural("Item2")).toBe("Item2s");
  });

  it("a digit-preceded `y` takes the `ies` arm — `Item2y` → `Item2ies`", () => {
    // The guard is `!/[aeiou]y$/`, i.e. "not vowel + y".  A DIGIT is not a
    // vowel, so `2y` is treated exactly like a consonant + y.  Pinned as the
    // documented rule's literal consequence.
    expect(plural("Item2y")).toBe("Item2ies");
  });
});

describe("naming — plural / snake on the empty string", () => {
  it('plural("") is `"s"` — it falls through to the default +s arm', () => {
    // Not a guard-clause case: `""` ends with neither `y` nor s/x/z/ch/sh.
    // Pinned so a future `if (!input) return input` guard is a DELIBERATE change.
    expect(plural("")).toBe("s");
  });

  it('snake("") is `""`', () => {
    expect(snake("")).toBe("");
  });
});

// ---------------------------------------------------------------------------

/** Realistic `(workflow, function)` pairs.  Source identifiers are already
 *  camelCase (the module's own stated assumption), so the table stays
 *  camelCase — including the two ambiguous splits of the same letters
 *  (`("ab","c")` vs `("a","bc")`), which the casings DO tell apart because the
 *  seam letter is cased differently on each side. */
const WF_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ab", "c"],
  ["a", "bc"],
  ["placeOrder", "slaDays"],
  ["apiSync", "doIt"],
  ["fulfil", "isLate"],
  ["onboard", "step1"],
  ["onboardStep", "one"],
];

/** Pairs that differ ONLY in where the workflow/function split falls — the
 *  seam letter is capitalised the same way on both sides.  See the defect
 *  block at the end of this section. */
const WF_AMBIGUOUS_SPLITS: ReadonlyArray<
  readonly [readonly [string, string], readonly [string, string]]
> = [
  [
    ["placeOrder", "slaDays"],
    ["placeOrderSla", "days"],
  ],
  [
    ["fulfil", "isLate"],
    ["fulfilIs", "late"],
  ],
];

describe("naming — workflowFn* casings are collision-free", () => {
  it("camel form is injective over the pair table", () => {
    const seen = new Map<string, string>();
    for (const [wf, fn] of WF_PAIRS) {
      const name = workflowFnCamel(wf, fn);
      expect(seen.has(name), `collision on ${name}: (${seen.get(name)}) vs (${wf},${fn})`).toBe(
        false,
      );
      seen.set(name, `${wf},${fn}`);
    }
  });

  it("pascal form is injective over the pair table", () => {
    const names = WF_PAIRS.map(([wf, fn]) => workflowFnPascal(wf, fn));
    expect([...new Set(names)]).toHaveLength(names.length);
  });

  it("snake form is injective over the pair table", () => {
    const names = WF_PAIRS.map(([wf, fn]) => workflowFnSnake(wf, fn));
    expect([...new Set(names)]).toHaveLength(names.length);
  });

  it("distinguishes the ambiguous split `(ab,c)` from `(a,bc)` in all three casings", () => {
    expect(workflowFnCamel("ab", "c")).not.toBe(workflowFnCamel("a", "bc"));
    expect(workflowFnPascal("ab", "c")).not.toBe(workflowFnPascal("a", "bc"));
    expect(workflowFnSnake("ab", "c")).not.toBe(workflowFnSnake("a", "bc"));
    expect(workflowFnCamel("ab", "c")).toBe("abC");
    expect(workflowFnCamel("a", "bc")).toBe("aBc");
    expect(workflowFnSnake("ab", "c")).toBe("ab_c");
    expect(workflowFnSnake("a", "bc")).toBe("a_bc");
  });

  // DEFECT (handed off, not fixed here — this packet is test-only).
  //
  //   src/util/naming.ts:40-48 — `workflowFnCamel` / `workflowFnPascal` /
  //   `workflowFnSnake` concatenate `<workflow><Function>` with NO separator, so
  //   the split point is not recoverable and two different `(workflow,
  //   function)` pairs can produce the SAME emitted helper name:
  //
  //       workflowFnCamel("placeOrder", "slaDays")  === "placeOrderSlaDays"
  //       workflowFnCamel("placeOrderSla", "days")  === "placeOrderSlaDays"
  //       workflowFnSnake("placeOrder", "slaDays")  === "place_order_sla_days"
  //       workflowFnSnake("placeOrderSla", "days")  === "place_order_sla_days"
  //
  // The whole point of the per-workflow namespacing (src/util/naming.ts:32-39)
  // is that "workflows share a generated file", so two colliding helpers are two
  // definitions of the same name in one module: a redeclaration error on
  // TS/C#/Java, and a SILENT last-wins shadow on Elixir/Python.  Nothing gates
  // it — there is no `loom.*` code for a workflow-helper name collision.
  //
  // PROPOSED PATCH: do NOT change these helpers (that would move every existing
  // generated name).  Add an IR-level check instead, alongside the other
  // per-deployable uniqueness checks in
  // `src/ir/validate/checks/system-checks.ts`:
  //
  //     // for each deployable, over every workflow × its declared functions
  //     const byName = new Map<string, string[]>();
  //     for (const wf of workflowsOf(dep))
  //       for (const fn of wf.functions)
  //         push(byName, workflowFnCamel(wf.name, fn.name), `${wf.name}.${fn.name}`);
  //     // report every entry with >1 owner as `loom.workflow-fn-name-collision`
  //
  // …with the message text added to `src/diagnostics/messages.ts` under that
  // code.  Flip these two `it.fails` to `it` once the gate exists (they would
  // then belong beside it, and this file keeps only the casing properties).
  it.fails("distinguishes pairs that differ only in where the split falls", () => {
    for (const [left, right] of WF_AMBIGUOUS_SPLITS) {
      expect(workflowFnCamel(...left), `${left} vs ${right}`).not.toBe(workflowFnCamel(...right));
      expect(workflowFnPascal(...left)).not.toBe(workflowFnPascal(...right));
      expect(workflowFnSnake(...left)).not.toBe(workflowFnSnake(...right));
    }
  });

  it("records the current collision explicitly", () => {
    expect(workflowFnCamel("placeOrder", "slaDays")).toBe("placeOrderSlaDays");
    expect(workflowFnCamel("placeOrderSla", "days")).toBe("placeOrderSlaDays");
    expect(workflowFnPascal("placeOrder", "slaDays")).toBe("PlaceOrderSlaDays");
    expect(workflowFnPascal("placeOrderSla", "days")).toBe("PlaceOrderSlaDays");
    expect(workflowFnSnake("placeOrder", "slaDays")).toBe("place_order_sla_days");
    expect(workflowFnSnake("placeOrderSla", "days")).toBe("place_order_sla_days");
  });
});

describe("naming — workflowFn* casings are mutually derivable", () => {
  it("camel and pascal differ only in the first character", () => {
    for (const [wf, fn] of WF_PAIRS) {
      const camel = workflowFnCamel(wf, fn);
      const pascal = workflowFnPascal(wf, fn);
      expect(pascal[0]).toBe(camel[0]!.toUpperCase());
      expect(pascal.slice(1)).toBe(camel.slice(1));
    }
  });

  it("snake(pascalForm) === snakeForm for every realistic pair", () => {
    for (const [wf, fn] of WF_PAIRS) {
      expect(snake(workflowFnPascal(wf, fn)), `(${wf},${fn})`).toBe(workflowFnSnake(wf, fn));
    }
  });

  it("snake(camelForm) === snakeForm for every realistic pair", () => {
    for (const [wf, fn] of WF_PAIRS) {
      expect(snake(workflowFnCamel(wf, fn)), `(${wf},${fn})`).toBe(workflowFnSnake(wf, fn));
    }
  });

  // DEFECT (handed off, not fixed here — this packet is test-only).
  //
  //   src/util/naming.ts:17-22 (`snake`) vs src/util/naming.ts:46-48
  //   (`workflowFnSnake`).
  //
  // Mutual derivability BREAKS when both halves are a single character:
  //   workflowFnPascal("a","b") === "AB"      → snake("AB")      === "ab"
  //   workflowFnSnake ("a","b") === "a_b"
  // `snake`'s two regexes both need a lowercase neighbour to find a boundary
  // (`([a-z0-9])([A-Z])` and `([A-Z]+)([A-Z][a-z])`), and `AB` has neither, so
  // the boundary between the workflow and the function name is lost.  Same for
  // any pair whose Pascal form contains a capital run with no following
  // lowercase, e.g. ("x","y").
  //
  // Impact is narrow (each backend uses ONE casing consistently at both the
  // call site and the definition site, so nothing mis-links today) but it means
  // the snake name is NOT recoverable from the Pascal name, and a
  // one-letter-named workflow + one-letter-named function collides in `snake`
  // space with a two-letter workflow: snake("ab") === snake(workflowFnPascal("a","b")).
  //
  // PROPOSED PATCH: none to `snake` (widening it would move existing table /
  // column names).  Either (a) document `workflowFnSnake` as the sole source of
  // the snake form — never `snake(pascalForm)` — which is already how the
  // emitters call it, or (b) gate one-character workflow / function names in the
  // validator.  Flip this to `it` if `snake` is ever made boundary-preserving.
  it.fails("snake(pascalForm) === snakeForm also for single-character names", () => {
    expect(snake(workflowFnPascal("a", "b"))).toBe(workflowFnSnake("a", "b"));
  });

  it("records the current single-character behaviour explicitly", () => {
    expect(workflowFnPascal("a", "b")).toBe("AB");
    expect(snake("AB")).toBe("ab"); // boundary lost
    expect(workflowFnSnake("a", "b")).toBe("a_b"); // boundary kept
  });
});

// ---------------------------------------------------------------------------

describe("naming — elixirString", () => {
  it("re-quotes and escapes a double quote", () => {
    expect(elixirString('a"b')).toBe('"a\\"b"');
  });

  it("escapes a backslash (so `a\\b` stays a literal backslash in Elixir)", () => {
    expect(elixirString("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes a newline as `\\n`, never a raw line break", () => {
    expect(elixirString("a\nb")).toBe('"a\\nb"');
    expect(elixirString("a\nb")).not.toContain("\n");
  });

  it("escapes carriage return and tab", () => {
    expect(elixirString("a\r\tb")).toBe('"a\\r\\tb"');
  });

  it("neutralises `#{` so Elixir string interpolation cannot fire", () => {
    expect(elixirString("a#{x}")).toBe('"a\\#{x}"');
    // The injection case the funnel exists for.
    expect(elixirString('hi#{System.cmd("id", [])}')).toBe('"hi\\#{System.cmd(\\"id\\", [])}"');
  });

  it("neutralises every `#{`, not just the first", () => {
    expect(elixirString("#{a}#{b}")).toBe('"\\#{a}\\#{b}"');
  });

  it("leaves a lone `#` alone (only `#{` interpolates)", () => {
    expect(elixirString("a#b")).toBe('"a#b"');
  });

  it("always returns a fully-delimited literal", () => {
    for (const s of ["", "a", 'q"q', "#{x}", "\\", "\n"]) {
      const out = elixirString(s);
      expect(out.startsWith('"')).toBe(true);
      expect(out.endsWith('"')).toBe(true);
    }
  });
});

describe("naming — elixirRegexBody", () => {
  it("escapes `/` so it cannot close the `~r/…/` sigil", () => {
    expect(elixirRegexBody("a/b")).toBe("a\\/b");
    expect(elixirRegexBody("^/+$")).toBe("^\\/+$");
  });

  it("escapes every `/`, not just the first", () => {
    expect(elixirRegexBody("a/b/c")).toBe("a\\/b\\/c");
  });

  it("neutralises `#{` so the sigil cannot interpolate", () => {
    expect(elixirRegexBody("#{x}")).toBe("\\#{x}");
    expect(elixirRegexBody("^a/b#{c}$")).toBe("^a\\/b\\#{c}$");
  });

  it("leaves regex backslash classes untouched (`\\d`, `\\w`, `\\.`)", () => {
    expect(elixirRegexBody("\\d+")).toBe("\\d+");
    expect(elixirRegexBody("^\\w+\\.\\w+$")).toBe("^\\w+\\.\\w+$");
  });

  it("does not add delimiters — it returns a sigil BODY, not a literal", () => {
    expect(elixirRegexBody("abc")).toBe("abc");
    expect(elixirRegexBody("")).toBe("");
  });

  it("leaves a quote alone (a `~r/…/` body needs no quote escaping)", () => {
    expect(elixirRegexBody('a"b')).toBe('a"b');
  });

  // DEFECT (handed off, not fixed here — this packet is test-only).
  //
  //   src/util/naming.ts:422-424
  //     return pattern.replace(/#\{/g, "\\#{").replace(/\//g, "\\/");
  //
  // The `/` pass is unconditional, so an ALREADY-ESCAPED `\/` — legal and
  // common in a hand-written regex — is double-escaped:
  //     "a\\/b"  →  "a\\\\/b"
  // Emitted into the sigil that reads `~r/a\\/b/`: Elixir consumes `\\` as an
  // escaped backslash, so the following `/` CLOSES THE SIGIL EARLY and the
  // trailing `b/` is a syntax error.  The helper that exists to stop a `/` from
  // closing the sigil introduces exactly that when the author pre-escaped.
  //
  // Same class for a pre-escaped `\#{`: "a\\#{b}" → "a\\\\#{b}", which is a
  // literal backslash followed by a LIVE interpolation.
  //
  // PROPOSED PATCH (src/util/naming.ts), escape only UNESCAPED occurrences by
  // consuming backslash pairs first:
  //     export function elixirRegexBody(pattern: string): string {
  //       return pattern.replace(/\\.|#\{|\//g, (m) =>
  //         m === "/" ? "\\/" : m === "#{" ? "\\#{" : m,
  //       );
  //     }
  //   — a single left-to-right scan: `\\.` swallows an escape pair verbatim, so
  //   only a bare `/` or `#{` is rewritten.  Flip these to `it` when it lands.
  it.fails("an already-escaped `\\/` is not double-escaped", () => {
    expect(elixirRegexBody("a\\/b")).toBe("a\\/b");
  });

  it.fails("an already-escaped `\\#{` is not double-escaped", () => {
    expect(elixirRegexBody("a\\#{b}")).toBe("a\\#{b}");
  });

  it("records the current double-escaping behaviour explicitly", () => {
    expect(elixirRegexBody("a\\/b")).toBe("a\\\\/b");
    expect(elixirRegexBody("a\\#{b}")).toBe("a\\\\#{b}");
  });
});
