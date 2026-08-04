// The frontend render-degradation gate.
//
// The backends cannot silently drop an expression: `_expr/target.ts` dispatches
// over an EXHAUSTIVE `ExprIR.kind` switch with a `never` check, and each
// backend's leaf table is pinned by `intrinsic-completeness.test.ts`.  The
// frontend walker has neither.  `emitExpr` ends in a soft `default:` that
// returns `/* unsupported expr: <kind> */ undefined`, its `method-call` arm
// falls through to a VERBATIM `<recv>.<member>(<args>)`, and an unknown call
// name in a body renders as NOTHING at all.
//
// None of that was visible.  A scan of every `.ddd` in this repo finds zero
// page/component bodies using a scalar intrinsic or a value-object
// construction, so the per-frontend build gates compiled green on coverage
// they never had.
//
// This gate closes that.  It generates `expression-showcase.ddd` — the fixture
// that exercises the expression vocabulary — for every frontend and asserts the
// emitted page files carry NO degradation sentinel.  The sentinels are read out
// of the emitter sources rather than copied here, so a newly-invented
// placeholder is covered the moment it is added.
//
// KNOWN_DEGRADATIONS is a RATCHET, not a waiver list: each entry names a real
// defect with its fix slice, and the entry is deleted by the PR that fixes it.
// Adding an entry requires the same justification as adding a wire-waiver.

import { describe, expect, it } from "vitest";
import { snake } from "../../../src/util/naming.js";
import { generateSystemFiles, loadExample } from "../../_helpers/index.js";

const FIXTURE = "web/src/examples/expression-showcase.ddd";

/** Frontends the fixture is generated for, with the hosting deployable's
 *  platform and the path fragment identifying its emitted page files. */
const TARGETS = [
  { framework: "react", platform: "static", pages: /\/src\/pages\/.*\.tsx$/ },
  { framework: "vue", platform: "static", pages: /\/src\/pages\/.*\.vue$/ },
  { framework: "svelte", platform: "static", pages: /\+page\.svelte$/ },
  { framework: "angular", platform: "static", pages: /\/src\/app\/pages\// },
  { framework: "feliz", platform: "feliz", pages: /\.fs$/ },
  { framework: "flutter", platform: "flutter", pages: /lib\/pages\// },
  { framework: "phoenixLiveView", platform: "elixir", pages: /_live\.ex$|\.html\.heex$/ },
] as const;

/**
 * Emitted-output patterns that mean "the walker gave up".  Each corresponds to
 * a real placeholder in the emitters:
 *
 *   `/* unsupported expr: <kind> *​/ undefined`  walker-core.ts `emitExpr` default
 *   `/* TODO: method-call … *​/ undefined`       walker-core.ts unresolved receiver
 *   `/* ref: <name> *​/`                          walker-core.ts unresolved ref
 *   `// flutter pack: no renderer for "X"`       flutter/pack.ts
 *
 * A rendered page containing any of them is a generated project that is broken,
 * blank, or silently wrong at that spot.
 */
const SENTINELS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "unsupported expr", re: /unsupported expr:\s*(\w+)/g },
  { label: "unresolved method-call", re: /TODO: method-call/g },
  { label: "unresolved ref", re: /\bref:\s*\w+\s*\*\//g },
  { label: "flutter: no renderer", re: /flutter pack: no renderer for "([^"]+)"/g },
];

/**
 * RATCHET — every entry is a live defect with a named fix slice.  Delete the
 * entry in the PR that lands the fix; never add one to make a red build green.
 *
 * Keyed `<framework>:<sentinel label>`.
 */
const KNOWN_DEGRADATIONS: ReadonlyMap<string, string> = new Map([
  // (empty — the `paren` entries that lived here were retired by the arm added
  // to `emitExpr` in this same change.  Keep this map empty unless a defect is
  // genuinely queued behind a named slice.)
]);

/**
 * RATCHET — targets whose walker still emits Loom's own intrinsic SPELLING
 * verbatim instead of translating it (`toUpper` rather than `.toUpperCase()` /
 * `.ToUpper()` / `String.upcase`).  Deleted per target by slice 4.
 *
 * Verbatim emission is not sentinel-shaped, so the sentinel scan above cannot
 * see it — which is precisely how it survived: it produces output that *looks*
 * like code.
 */
const KNOWN_VERBATIM_INTRINSICS: ReadonlySet<string> = new Set([
  "feliz", // S4: fs-expr.ts HAS the F# table, wired only to the action path
  "flutter", // S4: DART_LEAVES has no intrinsic table
  "phoenixLiveView", // S4: heex-walker-core.ts renders collection ops, not intrinsics
]);

async function generateFor(framework: string, platform: string): Promise<Map<string, string>> {
  // The fixture declares `framework: react` + `platform: static`; retarget it
  // in-memory so one fixture covers every frontend.
  const src = loadExample(FIXTURE)
    .replace("framework: react", `framework: ${framework}`)
    .replace("platform: static", `platform: ${platform}`);
  return await generateSystemFiles(src);
}

describe("frontend render degradation — the emitted page must not give up", () => {
  for (const target of TARGETS) {
    it(`${target.framework}: no degradation sentinel in any emitted page`, async () => {
      const files = await generateFor(target.framework, target.platform);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      expect(pages.length, `no page files matched for ${target.framework}`).toBeGreaterThan(0);

      const found: string[] = [];
      for (const [path, content] of pages) {
        for (const { label, re } of SENTINELS) {
          for (const m of content.matchAll(new RegExp(re.source, re.flags))) {
            found.push(`${label}${m[1] ? ` (${m[1]})` : ""} @ ${path}`);
          }
        }
      }

      const labels = new Set(found.map((f) => f.split(" (")[0]!.split(" @")[0]!));
      const unexpected = [...labels].filter(
        (l) => !KNOWN_DEGRADATIONS.has(`${target.framework}:${l}`),
      );
      expect(
        unexpected,
        `${target.framework}: NEW degradation(s).  Fix the emitter — do not add a ratchet entry ` +
          `to silence this.\n${found.join("\n")}`,
      ).toEqual([]);
    }, 120_000);
  }

  // -------------------------------------------------------------------------
  // The second failure mode: not "gave up", but "emitted the Loom spelling".
  // `s.toUpper()` is not JavaScript, F#, Dart or Elixir — every target must
  // translate it through a snippet table.  Untranslated, it is a compile error
  // where the host language has no such member, and SILENTLY WRONG where it
  // has one that means something else (`replace`, `substring`).
  // -------------------------------------------------------------------------
  for (const target of TARGETS) {
    const known = KNOWN_VERBATIM_INTRINSICS.has(target.framework);
    it(`${target.framework}: no Loom intrinsic spelling survives into the page${known ? " (ratcheted)" : ""}`, async () => {
      const { INTRINSIC_SIGNATURES } = await import("../../../src/util/intrinsics.js");
      const files = await generateFor(target.framework, target.platform);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      const raw = new Set<string>();
      for (const [, content] of pages) {
        for (const sig of INTRINSIC_SIGNATURES) {
          // Only the ops whose Loom spelling has NO same-named counterpart in
          // the host language would be unambiguous; rather than model that per
          // target, look for the Loom-only names, which no target legitimately
          // emits: `toUpper` / `toLower` / `divTrunc`.
          if (!["toUpper", "toLower", "divTrunc"].includes(sig.name)) continue;
          // HEEx snake-cases the member on its way out (`to_upper()`), so the
          // Loom name survives in either casing — check both.
          const spellings = [sig.name, snake(sig.name)];
          if (spellings.some((s) => new RegExp(`\\.${s}\\s*\\(`).test(content))) raw.add(sig.name);
        }
      }
      if (known) {
        expect(
          raw.size,
          `${target.framework} is ratcheted as emitting verbatim intrinsics but emitted none — ` +
            `delete it from KNOWN_VERBATIM_INTRINSICS`,
        ).toBeGreaterThan(0);
      } else {
        expect(
          [...raw],
          `${target.framework}: Loom intrinsic spelling survived into the emitted page`,
        ).toEqual([]);
      }
    }, 120_000);
  }

  it("the ratchet only lists degradations that are still real", async () => {
    // A stale entry is worse than a missing one: it hides a regression AND
    // implies work that is already done.  Prove every entry still fires.
    const stale: string[] = [];
    for (const target of TARGETS) {
      const expected = [...KNOWN_DEGRADATIONS.keys()].filter((k) =>
        k.startsWith(`${target.framework}:`),
      );
      if (expected.length === 0) continue;
      const files = await generateFor(target.framework, target.platform);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      const seen = new Set<string>();
      for (const [, content] of pages)
        for (const { label, re } of SENTINELS)
          if (new RegExp(re.source).test(content)) seen.add(`${target.framework}:${label}`);
      for (const key of expected) if (!seen.has(key)) stale.push(key);
    }
    expect(stale, `ratchet entries no longer firing — delete them: ${stale.join(", ")}`).toEqual(
      [],
    );
  }, 300_000);
});
