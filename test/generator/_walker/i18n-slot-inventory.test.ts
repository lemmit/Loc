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
  "table.ts":
    '`Column("Name", …)` headers — a per-column slot needs a role shape the current table (role, hash) key can\'t express (the header repeats per page)',
  "icon.ts":
    "`Icon(label:)` is an ACCESSIBLE NAME (role=img), so it belongs with the aria slots rather than the text ones",
  "code-block.ts": "`CodeBlock(title:)` — a caption above a code sample",
  "chart.ts":
    'the derived accessible name ("Line chart of <projection>: <y> by <x>", a11y `role="img"` + needsName) is EMITTER-built from model identifiers, so it belongs with the `chrome.*` sentence-frame keys rather than a per-call catalog slot',
  "file-link.ts": "the download affordance's label text",
  "provenance-info.ts": "the disclosure's summary text (pack chrome, not authored)",
  "for.ts": "`For(empty:)` renders authored markup, whose own primitives localize",
};

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
      if (/\blocalized[A-Z]\w*\(/.test(fs.readFileSync(full, "utf8"))) {
        stale.push(`${file} (now localizes — delete the entry)`);
      }
    }
    expect(stale, "stale NO_SLOT_YET entries").toEqual([]);
  });
});
