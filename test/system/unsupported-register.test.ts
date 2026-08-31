import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openGaps, UNSUPPORTED_REGISTER } from "../../src/diagnostics/unsupported-register.js";

// ---------------------------------------------------------------------------
// Gate for the `*-unsupported` register (M-T9.27).
//
// The register is only worth having if it cannot drift from the code it
// describes.  Three invariants, plus a ratchet:
//
//   1. every suffixed code EMITTED in src/ is registered — a new gap cannot be
//      minted silently, which is the failure mode the whole register exists to
//      stop (`allowlist-ratchet.test.ts`'s "SILENT GROWTH", one layer over);
//   2. every registered code is STILL EMITTED — a drained gap must delete its
//      row in the same PR, so the register ratchets down instead of becoming a
//      graveyard of codes that no longer exist;
//   3. no duplicate rows;
//   4. the `gap` count is pinned.  Lower MAX_OPEN_GAPS when you drain; raising
//      it is a deliberate, reviewed line in the diff.
//
// Mutation-proof (CLAUDE.md — a green first run proves nothing): delete any row
// from the register and (1) fails; rename a registered code at its emission
// site and (2) fails; drain a gap without lowering the pin and the "left slack"
// assertion fails.
//
// NOT registered in `allowlist-ratchet.test.ts` on purpose: that gate counts
// entries in a `Set`/record `const` against a `max`, and this register is an
// array of typed rows carrying its own pin (invariant 4) plus a
// still-emitted check the count-only ratchet cannot express.  It is
// deliberately self-ratcheting, not an omission.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(repoRoot, "src");

/** The register lists every code as a string literal, so it would match itself. */
const REGISTER_FILE = path.join(srcRoot, "diagnostics", "unsupported-register.ts");

/** Pinned `gap` count.  LOWER when you drain; raising it is reviewed.
 *
 *  37 → 38: `loom.store-lifetime-target-unsupported`.  The gap it names is not
 *  new — `persist: local|session|url` has always been dropped to in-memory by
 *  the feliz and flutter store emitters (flutter leaves a `// TODO(flutter
 *  full-parity)` comment in the emitted Dart; feliz has no `.lifetime`
 *  reference at all).  What is new is that the degradation is now HONEST
 *  rather than silent, which is exactly the trade this register exists to
 *  record: a gap that appears here is a gap that stopped shipping broken
 *  output.  Drained by the wave-2 tasks that implement the ladder on both
 *  targets, which delete the row and lower this back to 37.
 *
 *  38 → 39: `loom.flutter-async-effect-unsupported`.  Same trade again — the gap
 *  is not new (the Flutter component emitter has always filtered out a component
 *  whose action carries a `match await`, emitting NO widget and rendering every
 *  call site as `SizedBox.shrink()`), only the honesty is.  Feliz gated the
 *  identical component-host limitation from the start; Flutter dropped it
 *  silently.  Drained by the M-T1.20 slice that gives the Flutter component
 *  emitter the notifier/route-id path, which deletes the row and lowers this
 *  back to 38.
 *
 *  39 → 39 (2026-08 prose audit, no count change).  Re-reading every row against
 *  the Set / emitter it names showed the register had frozen in a three-backend
 *  era: ~20 rows said "missing on some backends" while their gate already named
 *  every shipping target.  Those rows' PROSE was rewritten (they are now marked
 *  "latent seam" / "dormant" / "unreachable backstop"); their `kind` was NOT,
 *  because the codes are still emitted in `src/` and invariant (1) demands a row
 *  for each.  Consequence for this pin: it counts LIVE gaps and LATENT gates
 *  together, so it is not a backlog depth — a latent row lowers it only when the
 *  seam itself is deleted, a live one when the last target ports.  Do not "drain"
 *  a latent row by deleting it while its code still fires from `src/`; test (2)
 *  is the thing that would catch the reverse mistake.
 *
 *  39 → 40: `loom.toast-message-unsupported`.  The trade this register exists to
 *  record, in its sharpest form yet — the gap is not new and the degradation was
 *  not even a degradation: an `on <chan>.<Event> { toast(<expr>) }` message
 *  outside the v1 subset (a literal, the event binding, single-level member
 *  access off it, paren, binary) THREW a raw `Error` out of all three realtime
 *  renderers, aborting `ddd generate system` with a stack trace and no `loom.*`
 *  code.  The validator bounded the handler STATEMENT vocabulary and never
 *  looked inside the `toast(…)`.  Drained by the renderers growing the general
 *  expression path (M-T1.10), which deletes the row and lowers this back to 39.
 *
 *  40 → 41: `loom.audited-returning-operation-unsupported` (generator review
 *  2026-08-24, A6).  Same trade as the rows above, and the same reason to raise
 *  rather than dodge: the gap is not new — the Hono route builder has always
 *  routed an `audited`/`provenanced` operation that DECLARES a return type into
 *  the void-204 handler, discarding the tagged result and auditing `status:
 *  "ok"` even on the error variant.  What is new is that it stopped shipping a
 *  contract the backend silently drops.  Python already emits both halves, so
 *  this is a one-backend gap; draining it folds the audit transaction into
 *  `emitReturningOperationRoute`, deletes the row, and lowers this back to 40.
 *
 *  41 → 42: `loom.tph-filter-unsupported`.  Same trade, and the sharpest example
 *  of it in this register: the .NET config emitter replaced the WHOLE query-filter
 *  list with `[]` for any TPH participant, so a declared read restriction on a
 *  subtype (`filter Live`, a `softDeletable` visibility rule, a tenancy filter)
 *  was absent from every emitted query with no compile error and no diagnostic.
 *  Most of that gap is now EMITTED rather than gated — filters reading root
 *  columns move to the root config discriminator-guarded — and only the residue
 *  EF Core structurally cannot express (a subtype-only column) is gated here.
 *  Drains when .NET moves capability filters off `HasQueryFilter` onto the
 *  per-read LINQ `.Where(...)`, which is per-`DbSet` and therefore subtype-typed.
 *
 *  42 → 43: `loom.seed-event-sourced-unsupported` (targets-completeness
 *  2026-08-30, `F2-SEED-EVENTSOURCED`; M-T6.52).  The gap is not new — no
 *  backend has ever had an event-append seed path.  What is new is that it
 *  stopped being INVISIBLE: elixir dropped the row and still wrote the
 *  dataset's ship-once marker, while java/.NET emitted a `create(...)` call
 *  that does not compile against the declared factory.  Raising the pin buys
 *  five backends refusing identically instead of three diverging silently;
 *  M-T6.52 lands the seed path, deletes the row, and lowers this back to 42. */
const MAX_OPEN_GAPS = 43;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Codes actually emitted from a `code:`/`code =` position in src/. */
function emittedSuffixedCodes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(srcRoot)) {
    if (path.resolve(file) === REGISTER_FILE) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/code\s*[:=]\s*["'`](loom\.[a-zA-Z0-9-]+)["'`]/);
      if (!m) return;
      const code = m[1];
      if (!/unsupported|-backend$/.test(code)) return;
      if (!found.has(code)) {
        found.set(code, `${path.relative(repoRoot, file)}:${i + 1}`);
      }
    });
  }
  return found;
}

describe("`*-unsupported` register (M-T9.27)", () => {
  const emitted = emittedSuffixedCodes();
  const registered = new Set(UNSUPPORTED_REGISTER.map((e) => e.code));

  it("registers every suffixed code emitted in src/", () => {
    const unregistered = [...emitted.entries()]
      .filter(([code]) => !registered.has(code))
      .map(([code, site]) => `${code}  (${site})`);
    expect(
      unregistered,
      "New `*-unsupported` code(s) with no register row. Add each to " +
        "src/diagnostics/unsupported-register.ts, classified (gap | scope | never | rule) " +
        "— a `gap` is a commitment under the no-permanent-skips policy.",
    ).toEqual([]);
  });

  it("has no rows for codes that are no longer emitted", () => {
    const stale = UNSUPPORTED_REGISTER.map((e) => e.code).filter((c) => !emitted.has(c));
    expect(
      stale,
      "Register row(s) whose code is no longer emitted anywhere in src/. " +
        "A drained gap deletes its row in the same PR — the register ratchets down.",
    ).toEqual([]);
  });

  it("has no duplicate rows", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of UNSUPPORTED_REGISTER) {
      if (seen.has(e.code)) dupes.push(e.code);
      seen.add(e.code);
    }
    expect(dupes).toEqual([]);
  });

  it("keeps the open-gap count at or below the pin", () => {
    const gaps = openGaps();
    expect(
      gaps.length,
      `${gaps.length} open gaps against a pin of ${MAX_OPEN_GAPS}. Raising the pin is a ` +
        "reviewed decision — every gap is an eleven-target commitment.",
    ).toBeLessThanOrEqual(MAX_OPEN_GAPS);
    // Tracks reality: drain a gap, lower the pin in the same PR.
    expect(
      gaps.length,
      `Only ${gaps.length} open gaps remain — lower MAX_OPEN_GAPS to ${gaps.length}.`,
    ).toBe(MAX_OPEN_GAPS);
  });

  it("cites a site for every row", () => {
    const bad = UNSUPPORTED_REGISTER.filter((e) => !/^src\/.+:\d+$/.test(e.site)).map(
      (e) => e.code,
    );
    expect(bad, "Every row needs a `file:line` emission site for the reviewer.").toEqual([]);
  });

  // --- ownership (slice 3) -------------------------------------------------
  // A gap with no owner is work nobody has agreed to do — the state 53 of the
  // original 69 were in, and the reason the list could not be sprint-planned.

  it("gives every gap an owning mission", () => {
    const unowned = openGaps()
      .filter((e) => !e.mission)
      .map((e) => e.code);
    expect(
      unowned,
      "Gap(s) with no `mission`. Every gap is a commitment under the no-permanent-skips " +
        "policy — assign it to a mission in docs/new-plan/, minting one if none fits.",
    ).toEqual([]);
  });

  it("resolves every cited mission to exactly one heading in docs/new-plan/", () => {
    // A `mission` pointing at a missing OR duplicated id is worse than none: the
    // first is a dangling reference, the second sends two readers to different
    // work.  T6 carried three duplicate ids when this check was written (two
    // separate renumbering attempts had each collided) — that is the failure
    // this pins, and it is why the field is validated rather than trusted.
    const planDir = path.join(repoRoot, "docs", "new-plan");
    const headings = new Map<string, number>();
    const scan = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (e.name.endsWith(".md")) {
          for (const line of fs.readFileSync(p, "utf8").split("\n")) {
            const m = line.match(/^##\s+(M-T\d+\.\d+)\b/);
            if (m) headings.set(m[1], (headings.get(m[1]) ?? 0) + 1);
          }
        }
      }
    };
    scan(planDir);

    const cited = [...new Set(UNSUPPORTED_REGISTER.flatMap((e) => (e.mission ? [e.mission] : [])))];
    const missing = cited.filter((m) => !headings.has(m));
    const ambiguous = cited.filter((m) => (headings.get(m) ?? 0) > 1);

    expect(
      missing,
      "Register cites mission id(s) with no `## <id>` heading in docs/new-plan/.",
    ).toEqual([]);
    expect(
      ambiguous.map((m) => `${m} (${headings.get(m)} headings)`),
      "Register cites mission id(s) that appear more than once — renumber the duplicates so " +
        "the reference is unambiguous.",
    ).toEqual([]);
  });
});
