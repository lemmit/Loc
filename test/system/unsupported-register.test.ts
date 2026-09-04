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
 *  M-T6.52 lands the seed path, deletes the row, and lowers this back to 42.
 *
 *  43 → 42 (net −1: two rows out, one in).  OUT, as PHANTOMS:
 *  `loom.java-projection-field-unsupported` and
 *  `loom.java-workflow-instance-field-unsupported` (M-T6.36).  Both refused an
 *  ENTITY-typed read-model field; probing the mission's premise showed the shape
 *  is unreachable — a part type resolves only inside its own aggregate, so
 *  `projection P { line: Line }` fails at phase ③ on EVERY platform.  Two rows
 *  nothing could ever drain, against a backend that was never limited.  This is
 *  the one case where deleting a row is right even though its cause was never
 *  implemented: there was nothing to implement.  IN:
 *  `loom.java-reserved-identifier-unsupported` (F2-ADP-7's java arm) — the trade
 *  this register records, again: `aggregate T { case: string }` used to emit
 *  `String case;` and fail javac with zero diagnostics; it now refuses.
 *
 *  42 → 44: `loom.table-filter-unsupported` and
 *  `loom.modal-controlled-op-form-unsupported` (targets-completeness W1,
 *  `M-T1.1-table-filter-silent-drop` / `F2-CFE-12`).  Same trade, and the same
 *  reason to raise rather than dodge: NEITHER gap is new.  `Table { filter: q }`
 *  has always been dropped on HEEx (whose `renderTable` never reads the arg) and
 *  on any server-paged table — and since the auto-paged rewrite, the simplest
 *  hand-written paged table IS server-paged, so the natural spelling lost its
 *  filter with `ddd parse` reporting no error and the bound state left as a dead
 *  `useState`.  `Modal { open: …, OperationForm { … } }` has always collapsed the
 *  whole modal to a comment on react/vue/svelte/flutter.  What is new is that
 *  both stopped being silent.  Draining the first is a `filter` param on the
 *  generated `list/4` plus a LiveView `handle_event` (and a server-side filter
 *  on the paged read); the second is the controlled shell rendered around the
 *  recorded OperationFormState on the four JSX/Dart targets.  Each deletes its
 *  row and lowers this by one.
 *
 *  44 → 45: `loom.scaffold-filter-param-unsupported` (targets drain wave 3).
 *  Again the gap is not new — M-T1.15 widened the scaffolded filter bar to
 *  `string`/`guid`/`datetime`/`int`/`long`/`bool`/`<X> id` and left `enum` and
 *  `decimal`/`money` out, which the macro handled by dropping the whole find
 *  from the bar with no diagnostic anywhere.  What is new is that the drop is
 *  announced.  Draining it is two frontend-side changes, not a macro change:
 *  typing an `enum` `state {}` field as the emitted enum union instead of bare
 *  `string` (`stateTypeAsTsString` and its React/Vue/Angular twins), and a
 *  per-target zero-literal seam for `decimal`/`money`.  Both land the macro arm,
 *  delete the row, and lower this back to 44.
 *
 *  45 → 46: `loom.heex-component-host-state-unsupported` (W1b elixir packet,
 *  ledger row `G2646-open-heex-in-component-degradation`).  The sharpest version
 *  of this trade so far, because the thing it replaces is not a degradation at
 *  all — it is a CRASH the compile gate cannot see.  A `CreateForm` (or
 *  `OperationForm` / `WorkflowForm` / `DestroyForm` / `QueryView` / `Table` /
 *  `FileUpload` / `Chart`) inside a `component` on phoenixLiveView emitted
 *  `<.simple_form for={@form} phx-submit="save_thing">` into a function
 *  component whose host LiveView has an empty `mount/3`, no `@form` assign and
 *  no matching `handle_event` — output that passes `mix compile
 *  --warnings-as-errors` and then raises on page load.  #2646 built exactly the
 *  hoisting this needs for a component's `state { … }` and named `action`s and
 *  stopped there; draining this extends the same `ComponentActionInfo` +
 *  `gather*` seam to the walker's form / query / upload / table-control
 *  accumulators, deletes the row, and lowers this back to 41.
 *
 *  46 -> 47: `loom.sensitive-wire-unsupported` (W1 validator packet, ledger row
 *  `M-T3.8-sensitivity-phases-2-4`).  A raise taken deliberately on a
 *  SECURITY-class row, because the alternative was worse than a gap: the word
 *  `sensitive(pii)` reads as protection, and the only consequence that ships is
 *  the synthesized `inspect` printing `<redacted>` -- the DEBUG surface, not the
 *  API one.  Every backend builds its response DTO from the wire shape with no
 *  sensitivity arm, so the field is served in cleartext to any caller allowed to
 *  read the aggregate, and it is unmarked at every log / event / resource sink.
 *  A silent almost-protection is the one shape a security marker must never
 *  have.  The warning suppresses itself where the author already HAS the
 *  guarantee (`mask unless`, `internal`, `secret`), so it marks real cleartext
 *  exposure only.  Draining it is M-T3.8 phases 2-4 -- route `sensitivity`
 *  through the same response-boundary seam `mask unless` already uses on all
 *  five backends -- which deletes the row, the check module, and lowers this
 *  back to 46. */
const MAX_OPEN_GAPS = 47;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Matches an emission site: a `code:`/`code =` assignment naming a `loom.*`
 *  diagnostic code, capturing the bare code (no `#slug`). Shared by the
 *  existence scan below and the per-row site-resolution check. */
const EMIT_RE = /code\s*[:=]\s*["'`](loom\.[a-zA-Z0-9-]+)["'`]/;

/** Codes actually emitted from a `code:`/`code =` position in src/. */
function emittedSuffixedCodes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(srcRoot)) {
    if (path.resolve(file) === REGISTER_FILE) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(EMIT_RE);
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

  // `site` used to be validated only by REGEX SHAPE (`^src\/.+:\d+$`) — never
  // opened, so a raiser that MOVED (a sibling check grew/shrank above it in
  // the same file, the check was extracted to a new file, …) left a
  // perfectly-shaped, perfectly wrong citation and nothing caught it.  Six
  // adapter rows drifted this way by 200+ lines apiece before a wholesale
  // correction (see the mismatches this test found on the pre-fix tree,
  // quoted in the mission hand-off).  This resolves the file and asserts the
  // row's OWN code is actually raised near the cited line.
  it("resolves every row's site to its own code nearby (the register cannot notice a moved raiser otherwise)", () => {
    // N=20. Reading every row against the current tree (this PR's own
    // wholesale re-verification) found two clusters: rows already accurate to
    // within 0-9 lines (trivial reformatting — a comment grew, a blank line
    // moved) and rows that had drifted 23 to 782 lines (a sibling check's body
    // grew above the cited one, or the citation was never updated after the
    // file reorganized). Nothing fell in between. N=20 sits above the first
    // cluster with better than 2x headroom and far below the second, so it
    // absorbs incidental reformatting while still catching a raiser that
    // moved to a different function, a different file region, or was deleted
    // outright — exactly the "moved raiser" shape this check exists to catch,
    // proved below by seeding that shape and reverting the seed by file copy.
    const N = 20;
    const bad: string[] = [];
    for (const e of UNSUPPORTED_REGISTER) {
      const m = /^(src\/.+):(\d+)$/.exec(e.site);
      if (!m) continue; // malformed shape is the previous assertion's job
      const [, relPath, lineStr] = m;
      const abs = path.join(repoRoot, relPath);
      let fileLines: string[];
      try {
        fileLines = fs.readFileSync(abs, "utf8").split("\n");
      } catch {
        bad.push(`${e.code}: site file does not exist (${e.site})`);
        continue;
      }
      const lineNo = Number(lineStr);
      const lo = Math.max(0, lineNo - 1 - N);
      const hi = Math.min(fileLines.length, lineNo - 1 + N + 1);
      const resolved = fileLines.slice(lo, hi).some((line) => EMIT_RE.exec(line)?.[1] === e.code);
      if (!resolved) {
        bad.push(`${e.code}: no emission of its own code within ±${N} lines of ${e.site}`);
      }
    }
    expect(
      bad,
      "Row(s) whose site does not resolve to their own code nearby — the citation has drifted " +
        "from the raiser it names. Re-point `site` at the code's current file:line.",
    ).toEqual([]);
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
