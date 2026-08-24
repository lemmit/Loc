// Which page primitives carry user-visible text that has NO catalog slot yet.
//
// The walker ships ~55 primitives and `USER_VISIBLE_SLOTS` covers a subset;
// several of the rest also carry author-written text a user reads.  Those are
// not DROPPED (the sibling `user-visible-slot-coverage.test.ts` gates that);
// they render fine.  They are simply never translatable, and nothing said so.
//
// This is the inventory, and it is a RATCHET IN TWO DIRECTIONS:
//
//  * per MODULE — every primitive module either routes its text through an
//    `i18n-emit` helper, or appears below with the reason it doesn't yet;
//  * per SLOT — every ROLE in `USER_VISIBLE_SLOTS` names the module that routes
//    it (`SLOT_EMITTERS`), and that module must still pass the role to a
//    localizer.
//
// The second half exists because the first is a whole-FILE regex, and a module
// that localizes ONE thing used to vouch for everything beside it.  Three did
// exactly that while emitting raw English: `inputs.ts` (field labels, beside the
// localized `Select…` placeholder), `layout.ts` (a `Tab` caption, beside the
// localized Toolbar aria) and `data-grid.ts` (a `Column` header, beside the
// entire localized chrome band).
//
// Deleting a line is how the gap closes.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USER_VISIBLE_SLOTS } from "../../../src/util/user-visible-slots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const primitivesDir = path.resolve(here, "../../../src/generator/_walker/primitives");

/** module → why its user-visible text is not in the message catalog yet.
 *  Each entry is a slice of the i18n epic (M-T1.11), not a defect. */
const NO_SLOT_YET: Readonly<Record<string, string>> = {
  "chart.ts":
    'the derived accessible name ("Line chart of <projection>: <y> by <x>", a11y `role="img"` + needsName) is EMITTER-built from model identifiers, so it belongs with the `chrome.*` sentence-frame keys rather than a per-call catalog slot',
  "provenance-info.ts": "the disclosure's summary text (pack chrome, not authored)",
};

/** Entries in `NO_SLOT_YET` whose module DOES route some other text through an
 *  `i18n-emit` helper, while the gap named above survives.
 *
 *  The waiver is per-MODULE and the staleness check below is a regex for "does
 *  this file localize anything" — a proxy that holds only while a module is all
 *  or nothing.  `table.ts` broke that, and it was not alone: `inputs.ts`
 *  localized the `Select…` placeholder chrome while every field LABEL beside it
 *  shipped raw, `layout.ts` localized the Toolbar's accessible name while a
 *  `Tab` caption did not, and `data-grid.ts` localized the entire grid chrome
 *  band while the `Column` header rendered in English.  Three modules PASSED
 *  this gate while emitting untranslated authored prose — the regex's blind
 *  spot, not a listed gap.
 *
 *  All four slots are now routed (`inputLabel` / `tabLabel` / `columnHeader`),
 *  so the escape hatch is empty — but the mechanism stays, because the regex
 *  still cannot see a partially-localized module, and the `roles are routed
 *  per SLOT` check below is what now catches that class.  Listing a module here
 *  is only legitimate while BOTH halves hold: it still has a listed gap, and it
 *  really does localize something else. */
const PARTIALLY_LOCALIZED: ReadonlySet<string> = new Set<string>([]);

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

/** Catalog ROLE → the primitive module(s) whose emitter routes it through an
 *  `i18n-emit` helper.  The per-SLOT inventory, and the direct answer to the
 *  per-FILE regex's blind spot: a module that localizes ONE slot can no longer
 *  vouch for the authored text it renders raw beside it.
 *
 *  Ratchets in BOTH directions.  A new entry in `USER_VISIBLE_SLOTS` with no
 *  emitter fails (`every declared role is routed`); an emitter that stops
 *  passing its role — the exact regression these three slots are — fails too,
 *  because the role literal disappears from the module named here.
 *
 *  The proof that a routed role actually REACHES the runtime on every pack is
 *  `test/generator/user-visible-slot-coverage.test.ts`, which renders a probe
 *  per role across all fifteen targets and asserts the emitted page resolves
 *  the catalog key.  This table is the cheap upstream tripwire that says WHERE
 *  each slot is wired, so a regression names a file instead of a matrix cell. */
const SLOT_EMITTERS: Readonly<Record<string, readonly string[]>> = {
  heading: ["text.ts"],
  text: ["text.ts"],
  bold: ["text.ts"],
  italic: ["text.ts"],
  code: ["text.ts"],
  empty: ["text.ts"],
  anchor: ["text.ts"],
  keyValue: ["text.ts"],
  badge: ["display.ts"],
  statLabel: ["display.ts"],
  statValue: ["display.ts"],
  alert: ["display.ts"],
  alertTitle: ["display.ts"],
  dividerLabel: ["display.ts"],
  button: ["controls.ts"],
  buttonAria: ["controls.ts"],
  cardTitle: ["layout.ts"],
  toolbarAria: ["layout.ts"],
  modalTitle: ["forms.ts"],
  iconLabel: ["icon.ts"],
  codeBlockTitle: ["code-block.ts"],
  // The three slots the per-file regex waved through (C8).
  inputLabel: ["inputs.ts"],
  tabLabel: ["layout.ts"],
  // `Column` is read by BOTH the table and the grid, and each resolves the
  // header itself — so both must route it, which is why the value is a list.
  columnHeader: ["table.ts", "data-grid.ts"],
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

  it("every declared role is routed by the emitter that owns it (per SLOT)", () => {
    const declared = new Set(
      Object.values(USER_VISIBLE_SLOTS)
        .flat()
        .map((s) => s.role),
    );
    const listed = new Set(Object.keys(SLOT_EMITTERS));
    expect(
      [...declared].filter((r) => !listed.has(r)).sort(),
      "roles in USER_VISIBLE_SLOTS with no emitter listed in SLOT_EMITTERS — " +
        "wire the slot through an i18n-emit helper and name its module here",
    ).toEqual([]);
    expect(
      [...listed].filter((r) => !declared.has(r)).sort(),
      "SLOT_EMITTERS entries for roles no longer in USER_VISIBLE_SLOTS",
    ).toEqual([]);

    // …and each named module really does pass that role to a localizer.  A
    // module that quietly stops routing one of its slots — the regression this
    // whole file exists to catch — loses the role literal and fails here.
    const unrouted: string[] = [];
    for (const [role, modules] of Object.entries(SLOT_EMITTERS)) {
      for (const file of modules) {
        const full = path.join(primitivesDir, file);
        if (!fs.existsSync(full)) {
          unrouted.push(`${role}: ${file} (module no longer exists)`);
          continue;
        }
        // Newlines collapsed so a formatter-wrapped call still reads as one.
        const src = fs.readFileSync(full, "utf8").replace(/\s+/g, " ");
        if (!new RegExp(`localized\\w*\\([^;]*"${role}"`).test(src)) {
          unrouted.push(`${role}: ${file} never passes it to a localized*() call`);
        }
      }
    }
    expect(unrouted, "declared slots whose emitter no longer localizes them").toEqual([]);
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
