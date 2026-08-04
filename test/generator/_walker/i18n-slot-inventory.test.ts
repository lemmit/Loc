// Which page primitives carry user-visible text that has NO catalog slot yet.
//
// `USER_VISIBLE_SLOTS` covers 16 primitives.  The walker ships ~55, and several
// of the rest also carry author-written text a user reads — a `Column` header, a
// field `label:`, an `Icon`'s accessible name, a `CodeBlock` title.  Those are
// not DROPPED (the sibling `user-visible-slot-coverage.test.ts` gates that);
// they render fine.  They are simply never translatable, and nothing said so.
//
// This is the inventory, and it is a RATCHET: every primitive module either
// routes its text through an `i18n-emit` helper, or appears below with the
// reason it doesn't yet.  Adding a primitive with untranslatable text fails
// here until it is either wired up or listed — so the gap stays a stated
// decision instead of quietly growing.
//
// Deleting a line is how the gap closes.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const primitivesDir = path.resolve(here, "../../../src/generator/_walker/primitives");

/** module → why its user-visible text is not in the message catalog yet.
 *  Each entry is a slice of the i18n epic (M-T1.11), not a defect. */
const NO_SLOT_YET: Readonly<Record<string, string>> = {
  // PARTIAL — the pager chrome localizes (M-T1.11); the header gap below does not.
  "table.ts":
    '`Column("Name", …)` headers — a per-column slot needs a role shape the current table (role, hash) key can\'t express (the header repeats per page)',
  "chart.ts":
    'the derived accessible name ("Line chart of <projection>: <y> by <x>", a11y `role="img"` + needsName) is EMITTER-built from model identifiers, so it belongs with the `chrome.*` sentence-frame keys rather than a per-call catalog slot',
  "provenance-info.ts": "the disclosure's summary text (pack chrome, not authored)",
};

/** Entries in `NO_SLOT_YET` whose module DOES route some other text through an
 *  `i18n-emit` helper, while the gap named above survives.
 *
 *  The waiver is per-MODULE and the staleness check below is a regex for "does
 *  this file localize anything" — a proxy that holds only while a module is all
 *  or nothing.  `table.ts` broke that: its pager chrome ("Prev" / "Next" / the
 *  position counter) went through the catalog with M-T1.11's pager slice, but a
 *  `Column("Name", …)` header still has no slot, for exactly the reason listed.
 *
 *  Deleting the waiver would have made the gate pass and quietly lost the
 *  record of a real gap — the one thing this file exists to prevent.  So a
 *  partially-localized module is named HERE instead: it stays listed, and the
 *  staleness check skips it because "localizes something" no longer answers
 *  "is the listed gap closed".  Removing a module from this set is how you
 *  assert the gap really did close; the entry above then has to go too. */
const PARTIALLY_LOCALIZED: ReadonlySet<string> = new Set(["table.ts"]);

/** Modules that emit NO user-visible prose — nothing to translate, as opposed
 *  to `NO_SLOT_YET`'s "prose we haven't wired yet".  Reasoned so the two lists
 *  stay distinguishable to a reviewer. */
const NO_TEXT: Readonly<Record<string, string>> = {
  "index.ts": "re-exports only",
  "registry.ts": "the dispatch table",
  "data-grid-shape.ts":
    "a ctx-free PREDICATE leaf (is any column filterable?) shared by the emitter and the chrome extractor — it renders nothing",
  "timeline.ts":
    "emits native `<ol>/<li>/<time>/<dl>` over audit DATA plus typographic placeholders (`—`, `→`); the words come from the record, not the emitter",
  "file-link.ts":
    "the anchor's text is the file's own `.key` (wire DATA, never authored) and the null arm is a typographic em-dash — no prose of its own",
  "for.ts":
    "`For(empty:)` is authored MARKUP walked in the parent context, so its own primitives localize; `For` contributes no text itself",
};

describe("i18n slot inventory — untranslatable primitive text is listed, not silent", () => {
  const modules = fs
    .readdirSync(primitivesDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !NO_TEXT[f]);

  it("every primitive module either localizes its text or states why not", () => {
    const unlisted: string[] = [];
    for (const file of modules) {
      const src = fs.readFileSync(path.join(primitivesDir, file), "utf8");
      const localizes = /\blocalized[A-Z]\w*\(/.test(src);
      if (localizes) continue;
      if (NO_SLOT_YET[file]) continue;
      unlisted.push(file);
    }
    expect(
      unlisted,
      "these primitive modules carry user-visible text with no catalog slot and no stated reason — " +
        "wire them through an i18n-emit helper, or add them to NO_SLOT_YET with the reason",
    ).toEqual([]);
  });

  it("the waiver list has no stale entries (a listed module that now localizes)", () => {
    const stale: string[] = [];
    for (const file of Object.keys(NO_SLOT_YET)) {
      const full = path.join(primitivesDir, file);
      if (!fs.existsSync(full)) {
        stale.push(`${file} (module no longer exists)`);
        continue;
      }
      if (PARTIALLY_LOCALIZED.has(file)) continue;
      if (/\blocalized[A-Z]\w*\(/.test(fs.readFileSync(full, "utf8"))) {
        stale.push(`${file} (now localizes — delete the entry)`);
      }
    }
    expect(stale, "stale NO_SLOT_YET entries").toEqual([]);
  });

  it("every PARTIALLY_LOCALIZED module is still waived and does still localize", () => {
    // The escape hatch needs its own ratchet, or it becomes the place gaps go
    // to be forgotten.  An entry is only legitimate while BOTH halves hold: the
    // module still has a listed gap, and it really does localize something else
    // (otherwise the plain waiver covers it and this indirection is noise).
    const wrong: string[] = [];
    for (const file of PARTIALLY_LOCALIZED) {
      if (!NO_SLOT_YET[file]) {
        wrong.push(`${file} (no longer in NO_SLOT_YET — drop it from PARTIALLY_LOCALIZED)`);
        continue;
      }
      const full = path.join(primitivesDir, file);
      if (!fs.existsSync(full)) {
        wrong.push(`${file} (module no longer exists)`);
        continue;
      }
      if (!/\blocalized[A-Z]\w*\(/.test(fs.readFileSync(full, "utf8"))) {
        wrong.push(`${file} (localizes nothing — the plain waiver already covers it)`);
      }
    }
    expect(wrong, "PARTIALLY_LOCALIZED entries that no longer apply").toEqual([]);
  });
});
