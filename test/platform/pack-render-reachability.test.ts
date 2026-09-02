// ---------------------------------------------------------------------------
// Pack-render REACHABILITY invariant.
//
// `pack-required-primitives.test.ts` gates one direction: every name in
// `REQUIRED_PRIMITIVES` is present in every pack.  It says nothing about the
// other direction — names the walker RENDERS that nobody required — and that
// is the direction with a crash at the end of it.
//
// `compilePack`'s `render(name, ctx)` THROWS when `templates` has no entry:
//
//     loader: pack <name>: no template registered for "<name>".
//
// So a `renderPrimitive(ctx, "X")` / `ctx.pack.render("X")` call site in the
// SHARED body walker (`src/generator/_walker/**` — the core the JSX-family
// `WalkerTarget`s all ride) is a latent generate-time throw on every format
// whose packs are not obliged to ship `X`.
//
// Today fifteen such names are reachable-but-unavailable on `angular`:
//
//     primitive-form-of, primitive-modal, form-default-onsubmit,
//     and the twelve-strong field-input-* family
//
// They do not fire only because `angularTarget` FORKS every form primitive
// (`renderCreateForm` / `renderOperationForm` / `renderDestroyForm` /
// `renderWorkflowForm` / `renderModal`, wired in
// `src/generator/angular/walker/angular-target.ts`) and never returns `null`
// for a real call — the shared emitters below the fork are dead code on that
// format.  Every one of those seams is typed `string | null`, so the day an
// override bails (an unsupported shape, an early return, a new form primitive
// that forgets its Angular arm) the walk falls through to
// `renderFormOfPrimitive` and codegen dies with the loader error above, on a
// `.ddd` that validates clean.
//
// This file makes that dependency EXPLICIT rather than accidental, in two
// halves:
//
//   A. STATIC — per format, (reachable ∖ available) must be empty or listed in
//      `KNOWN_UNREACHABLE`.  The list RATCHETS: an entry that stops being
//      reachable-but-unavailable (the pack gained the template, or the call
//      site went away) fails the gate too, so it can only shrink.
//
//   B. RUNTIME — the exemptions above are a CLAIM about the Angular fork, and
//      a claim about `string | null` returns is not checkable from types.  So
//      this half generates a real frontend from a fixture that exercises every
//      form primitive, against an instrumented pack that RECORDS the requested
//      template names instead of throwing, and asserts: the tsx reference run
//      requests the exempted names (proving the fixture reaches the forked
//      code paths at all — otherwise half A's exemptions are unfalsifiable),
//      and the angular run requests NONE of them.  An Angular override that
//      starts returning `null` fails this assertion — with a message naming
//      the fork — instead of surfacing as a loader crash at generate time.
//
// Scope — the four `.hbs` JSX-family formats.  `heex` is out because LiveView
// does not consume `walkBody` at all (`heex-walker-core.ts` is a parallel
// engine, and HEEx packs own no call-site primitive templates by design).
// `feliz` and `flutter` are out because their PROCEDURAL packs implement
// `render` as a lookup returning a visible comment sentinel for an unknown
// name — they cannot throw, so this invariant does not apply; their
// equivalent contract is `feliz-pack-groundwork.test.ts` /
// `flutter-pack-groundwork.test.ts`.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The instrumented pack for half B.  `vi.hoisted` so the sink exists before
// the (hoisted) `vi.mock` factory can run.
const { RENDER_LOG } = vi.hoisted(() => ({ RENDER_LOG: new Set<string>() }));

vi.mock("../../src/generator/_packs/loader-fs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/generator/_packs/loader-fs.js")>();
  return {
    ...mod,
    loadPack: (dir: string, options?: { validateRequired?: boolean }) => {
      const pack = mod.loadPack(dir, options);
      return {
        ...pack,
        render(name: string, context: unknown): string {
          RENDER_LOG.add(name);
          // Swallow the throw so half B's assertion is what fails, not a
          // loader crash three frames deeper with no mention of the fork.
          if (!pack.templates.has(name)) return `<!-- unavailable template: ${name} -->`;
          return pack.render(name, context);
        },
      };
    },
  };
});

import { loadPack, resolvePackDir } from "../../src/generator/_packs/loader-fs.js";
import {
  flattenRequired,
  REQUIRED_PRIMITIVES,
} from "../../src/generator/_packs/required-primitives.js";
import { BUILTIN_PACK_FORMATS, type PackFormat } from "../../src/util/builtin-formats.js";
import { generateSystemFiles } from "../_helpers/generate.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WALKER_DIR = path.join(REPO_ROOT, "src", "generator", "_walker");

/** The formats whose packs are `.hbs`-backed AND whose targets ride the shared
 *  `walkBody` core — i.e. the formats where a missing template is a hard throw
 *  out of `compilePack`'s `render`.  See the header for the exclusions. */
const WALKER_HBS_FORMATS = [
  "tsx",
  "vue",
  "svelte",
  "angular",
] as const satisfies readonly PackFormat[];

type WalkerFormat = (typeof WALKER_HBS_FORMATS)[number];

// ---------------------------------------------------------------------------
// The ratcheting exempt-list.
//
// One entry per (format, template) pair that IS reachable through the shared
// walker but is NOT in that format's available surface.  Each needs a reason
// naming the thing that keeps it from firing — because that thing is now
// load-bearing, and this list is where the next reader finds out.
//
// A fix DELETES its entry in the same PR: the ratchet test below fails on an
// entry whose pair is no longer in the computed diff.
// ---------------------------------------------------------------------------
const KNOWN_UNREACHABLE: ReadonlyArray<{
  format: WalkerFormat;
  template: string;
  reason: string;
}> = [
  // --- angular: the form fork (src/generator/angular/*-form.ts) -------------
  // `REQUIRED_PRIMITIVES.angular` deliberately drops `primitive-form-of` and
  // `primitive-modal` from the shared lists, declares no `fieldInput` set, and
  // declares no `form` set beyond `realtime-toast` — because `angularTarget`
  // renders every form primitive as inline typed Reactive Forms.  Each name
  // below is therefore reachable in the shared walker and absent from all
  // three Angular packs (angularMaterial / primeng / spartanNg).
  {
    format: "angular",
    template: "primitive-form-of",
    reason:
      "angularTarget.renderCreateForm / renderWorkflowForm / renderDestroyForm always " +
      "return a string, so the shared renderFormOfPrimitive below the fork is never " +
      "reached.  If any override ever returns null, this is the throw.",
  },
  {
    format: "angular",
    template: "form-default-onsubmit",
    reason:
      "Rendered only from renderFormOfPrimitive's default-submit branch — behind the " +
      "same fork as primitive-form-of.  Angular builds its submit handler inline.",
  },
  {
    format: "angular",
    template: "primitive-modal",
    reason:
      "angularTarget.renderModal always returns a string, so the shared " +
      "operation-modal trigger emitter is never reached.",
  },
  {
    format: "angular",
    template: "field-input-array",
    reason:
      "The field-input-* family dispatches through renderFormField(vm.template) from the " +
      "shared CreateForm / WorkflowForm emitters — all behind the Angular form fork. " +
      "Angular builds each control from the FormFieldVM directly.",
  },
  {
    format: "angular",
    template: "field-input-bool",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-datetime",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-decimal",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-enum-select",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-file",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-id-select",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-id-text",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-int",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-money",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-string",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
  {
    format: "angular",
    template: "field-input-valueobject",
    reason: "field-input-* family behind the Angular form fork — see field-input-array.",
  },
];

// ---------------------------------------------------------------------------
// Half A — the static reachable/available diff.
// ---------------------------------------------------------------------------

/** Call sites whose FIRST argument to `pack.render` is not a string literal.
 *  Each must be accounted for by hand (its possible names contributed to the
 *  reachable set some other way), otherwise the scrape below silently
 *  under-reports.  A NEW dynamic site fails the pin. */
const DYNAMIC_RENDER_SITES: ReadonlyArray<{ file: string; note: string }> = [
  {
    file: "render-form-field.ts",
    note:
      'pack.render(vm.template, …) — the field-input-* family.  Its values are the `template: "field-input-…"` ' +
      "literals in form-fields-vm.ts, which the scrape picks up directly.",
  },
  {
    file: "render-primitive.ts",
    note:
      "ctx.pack.render(name, templateCtx) inside `renderPrimitive` itself — the generic wrapper, not a " +
      'distinct site.  Its `name` is whatever callers pass, and those are the `renderPrimitive(ctx, "…")` ' +
      "literals the scrape already collects.",
  },
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

interface Reachable {
  /** Names rendered with no capability probe — a missing template throws. */
  unguarded: Set<string>;
  /** Names rendered only behind a `pack.templates.has(name)` probe. */
  guarded: Set<string>;
}

function scrapeReachable(): Reachable {
  const rendered = new Set<string>();
  const guarded = new Set<string>();
  for (const file of tsFilesUnder(WALKER_DIR)) {
    const src = fs.readFileSync(file, "utf-8");
    // `renderPrimitive(ctx, "name", …)` — the import-registering wrapper.
    for (const m of src.matchAll(/renderPrimitive\s*\(\s*ctx\s*,\s*"([^"]+)"/g)) {
      rendered.add(m[1]!);
    }
    // `pack.render("name", …)` / `ctx.pack.render("name", …)` — the raw call.
    for (const m of src.matchAll(/\bpack\.render\s*\(\s*"([^"]+)"/g)) rendered.add(m[1]!);
    // `pack.templates.has("name")` — the capability probe that makes a render
    // safe.  Recorded separately so a guarded name never counts as a throw.
    for (const m of src.matchAll(/\.templates\.has\s*\(\s*"([^"]+)"\s*\)/g)) guarded.add(m[1]!);
    // The `field-input-*` names `renderFormField` dispatches `vm.template` to.
    for (const m of src.matchAll(/template:\s*"(field-input-[a-z-]+)"/g)) rendered.add(m[1]!);
  }
  const unguarded = new Set([...rendered].filter((n) => !guarded.has(n)));
  return { unguarded, guarded };
}

/** Templates a `pack.render` on this format is guaranteed to resolve: the
 *  per-format REQUIRED contract, plus every template the real loader resolves
 *  for EVERY pack of that format (pack.json `emits` ∪ the repo-root shared
 *  dirs ∪ the pack's stack layer).  The intersection is deliberate — a
 *  template only one pack of the format declares is not something the shared
 *  walker may rely on. */
function availableFor(format: WalkerFormat): Set<string> {
  const available = new Set<string>(flattenRequired(REQUIRED_PRIMITIVES[format]));
  const packs = Object.entries(BUILTIN_PACK_FORMATS)
    .filter(([, f]) => f === format)
    .map(([name]) => loadPack(resolvePackDir(name)));
  expect(packs.length, `no built-in packs registered for format "${format}"`).toBeGreaterThan(0);
  const perPack = packs.map((p) => new Set(p.templates.keys()));
  for (const name of perPack[0]!) {
    if (perPack.every((s) => s.has(name))) available.add(name);
  }
  return available;
}

/** The `(format, template)` pairs that are reachable-but-unavailable today. */
function computeDiff(): Map<WalkerFormat, string[]> {
  const { unguarded } = scrapeReachable();
  const out = new Map<WalkerFormat, string[]>();
  for (const format of WALKER_HBS_FORMATS) {
    const available = availableFor(format);
    out.set(format, [...unguarded].filter((n) => !available.has(n)).sort());
  }
  return out;
}

describe("pack-render reachability — static", () => {
  it("the walker scrape actually reaches the call sites it claims to", () => {
    // Anti-vacuity.  A regex that stops matching turns every assertion below
    // into a tautology — the exact shape of a gate that never reaches the
    // thing it names.  Pin an anchor from each of the three scrape arms.
    const { unguarded, guarded } = scrapeReachable();
    expect(unguarded.size).toBeGreaterThanOrEqual(40);
    // renderPrimitive arm
    expect(unguarded).toContain("primitive-button");
    expect(unguarded).toContain("primitive-form-of");
    // raw ctx.pack.render arm
    expect(unguarded).toContain("form-default-onsubmit");
    expect(unguarded).toContain("primitive-chart");
    // form-fields-vm `vm.template` arm
    expect(unguarded).toContain("field-input-string");
    expect(unguarded).toContain("field-input-valueobject");
    // …and the guarded arm is found, not folded into the unguarded set.
    expect([...guarded]).toEqual(["primitive-modal-controlled"]);
    expect(unguarded.has("primitive-modal-controlled")).toBe(false);
  });

  it("every dynamic pack.render call site is accounted for by hand", () => {
    // `pack.render(someVariable, …)` cannot be scraped.  Every such site must
    // appear in DYNAMIC_RENDER_SITES with a note saying how its names reach the
    // reachable set — otherwise a new one silently shrinks that set.
    const found: string[] = [];
    for (const file of tsFilesUnder(WALKER_DIR)) {
      const src = fs.readFileSync(file, "utf-8");
      // First non-space char of arg 1 is not a quote → dynamic.
      if (/\bpack\.render\s*\(\s*[^"'\s)]/.test(src)) {
        found.push(path.relative(WALKER_DIR, file));
      }
    }
    expect(found.sort()).toEqual(DYNAMIC_RENDER_SITES.map((s) => s.file).sort());
  });

  for (const format of WALKER_HBS_FORMATS) {
    it(`${format}: every reachable pack template is available (or exempted)`, () => {
      const diff = computeDiff().get(format)!;
      const exempt = new Set(
        KNOWN_UNREACHABLE.filter((e) => e.format === format).map((e) => e.template),
      );
      const unexplained = diff.filter((n) => !exempt.has(n));
      expect(
        unexplained,
        `Format "${format}": the shared body walker can render these pack templates, but no ` +
          `${format} pack is obliged to ship them — reaching one throws at generate time ` +
          `("loader: pack …: no template registered for …").\n` +
          `Either add the name to REQUIRED_PRIMITIVES.${format} (and ship the template in every ` +
          `${format} pack), guard the call site the way forms.ts guards ` +
          `"primitive-modal-controlled", or add an entry to KNOWN_UNREACHABLE in this file with ` +
          `the reason it cannot fire.`,
      ).toEqual([]);
    });
  }

  it("the exempt-list ratchets — no stale entries", () => {
    // A KNOWN_UNREACHABLE entry is a debt marker.  Once the pack gains the
    // template (or the call site goes away) the pair drops out of the computed
    // diff, and keeping the entry would quietly re-open the hole for the next
    // regression.  Same rule as every other ratcheting waiver in this repo.
    const diff = computeDiff();
    const stale = KNOWN_UNREACHABLE.filter((e) => !diff.get(e.format)!.includes(e.template)).map(
      (e) => `${e.format}:${e.template}`,
    );
    expect(
      stale,
      "Stale KNOWN_UNREACHABLE entries — these pairs are no longer reachable-but-unavailable. " +
        "Delete them from the list.",
    ).toEqual([]);
  });

  it("every exempt entry carries a reason and names a walker format", () => {
    for (const e of KNOWN_UNREACHABLE) {
      expect(WALKER_HBS_FORMATS as readonly string[]).toContain(e.format);
      expect(e.reason.length, `${e.format}:${e.template} needs a real reason`).toBeGreaterThan(30);
    }
  });
});

// ---------------------------------------------------------------------------
// Half B — the runtime precondition behind the angular exemptions.
// ---------------------------------------------------------------------------

/** One system exercising every form primitive the Angular target forks:
 *  scaffolded CRUD gives the New page (`CreateForm`), the Details page
 *  (`OperationForm` + its `Modal` trigger, `DestroyForm`) and the workflow
 *  form (`WorkflowForm`); the field list spans the `field-input-*` family
 *  (scalars, money, bool, datetime, enum, `X id`, value object, `[]`, File). */
const FORM_HEAVY = (platform: string, design: string) => `
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Ordering {
      enum Status { draft, placed }
      valueobject Address { street: string  city: string }
      valueobject LineItem { sku: string  qty: int }
      aggregate Customer { name: string  derived display: string = name }
      repository Customers for Customer { }
      aggregate Order with crudish {
        reference: string
        qty: int
        rate: decimal
        price: money
        active: bool
        placedAt: datetime
        status: Status
        customer: Customer id
        ship: Address
        items: LineItem[]
        doc: File
      }
      repository Orders for Order { }
      workflow PlaceOrder {
        ref: string
        create(
          reference: string, qty: int, rate: decimal, price: money, active: bool,
          placedAt: datetime, status: Status, customer: Customer id,
          ship: Address, items: LineItem[], doc: File
        ) {
          let o = Order.create({
            reference: reference, qty: qty, rate: rate, price: price, active: active,
            placedAt: placedAt, status: status, customer: customer,
            ship: ship, items: items, doc: doc
          })
        }
      }
    }
  }
  storage db { type: postgres }
  storage blobs { type: localDisk }
  resource ordState { for: Ordering, kind: state, use: db }
  resource ordFiles { for: Ordering, kind: objectStore, use: blobs }
  ui WebApp with scaffold(subdomains: [Sales]) { api Shop: ShopApi }
  deployable api { platform: node contexts: [Ordering] dataSources: [ordState, ordFiles] serves: ShopApi port: 3000 }
  deployable web { platform: ${platform} targets: api ui: WebApp { Shop: api } port: 3005 design: ${design} }
}
`;

/** Generate the fixture and return every template name the walk asked the
 *  pack to render — recorded by the instrumented `loadPack` above, which
 *  returns a placeholder rather than throwing on an unavailable name. */
async function requestedTemplates(platform: string, design: string): Promise<Set<string>> {
  RENDER_LOG.clear();
  await generateSystemFiles(FORM_HEAVY(platform, design));
  return new Set(RENDER_LOG);
}

/** The names half A exempts for angular, i.e. the ones the fork must swallow. */
const ANGULAR_EXEMPT = KNOWN_UNREACHABLE.filter((e) => e.format === "angular").map(
  (e) => e.template,
);

describe("pack-render reachability — runtime (the angular fork's precondition)", () => {
  it("the fixture really does drive the forked form paths (tsx reference run)", async () => {
    // Without this, half B's angular assertion is unfalsifiable: a fixture
    // that never renders a form would trivially "prove" the fork holds.  The
    // tsx target does NOT fork, so a form-heavy page must request the shared
    // form templates there.
    const tsx = await requestedTemplates("react", "mantine");
    for (const name of [
      "primitive-form-of",
      "primitive-modal",
      "form-default-onsubmit",
      "field-input-string",
      "field-input-int",
      "field-input-valueobject",
      "field-input-file",
    ]) {
      expect(
        tsx,
        `tsx reference run should render "${name}" — fixture no longer covers it`,
      ).toContain(name);
    }
  });

  it("the angular run requests none of the exempted templates", async () => {
    const angular = await requestedTemplates("angular", "angularMaterial");
    const leaked = ANGULAR_EXEMPT.filter((n) => angular.has(n)).sort();
    expect(
      leaked,
      "The Angular form fork stopped swallowing these — the walk fell through to the shared " +
        "emitters, which render pack templates no Angular pack ships.  In production (no " +
        "instrumented pack) this is a hard throw at generate time: " +
        '"loader: pack …: no template registered for …".  Either restore the override in ' +
        "src/generator/angular/walker/angular-target.ts (and its *-form.ts delegates), or add " +
        "the template to REQUIRED_PRIMITIVES.angular and ship it in all three Angular packs.",
    ).toEqual([]);
  });

  it("the angular run requests nothing outside the available surface", async () => {
    // The general form of the above: whatever the walk asked for, an Angular
    // pack must be able to resolve.  Catches a leak of a name that is not
    // (yet) on the exempt list at all.
    const angular = await requestedTemplates("angular", "angularMaterial");
    const available = availableFor("angular");
    const missing = [...angular].filter((n) => !available.has(n)).sort();
    expect(missing).toEqual([]);
  });
});
