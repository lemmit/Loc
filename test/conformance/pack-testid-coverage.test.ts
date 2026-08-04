// Test-ID coverage tripwire — catches the day a pack stops emitting
// `data-testid` on a primitive that should have one.  Lightweight
// static scan: read each `primitive-*.hbs` file as text and assert
// either an explicit `data-testid` attribute or a `{{testidAttr}}`
// helper expansion is present.
//
// Why static-scan and not render-with-canned-context: each TSX
// primitive's render context is a different shape (form-of needs
// `aggregateName`, `fields[]`, `idTargets[]`, `defaultValuesTs`,
// `testidNamespace`, `slug`, `humanAgg`, …) and mocking all 40 would
// be a separate maintenance liability.  Static scan covers ~95% of
// the regression class — a pack template losing its testid is
// almost always a visible textual delete — at zero mock surface.
//
// HEEx packs are scanned but only the currently observed
// testid-emitting set is locked in (per the Phase A plan note: HEEx
// testid emission is split between templates and walker code in
// `heex-walker.ts`; broader HEEx coverage parity with TSX is a
// separate work item, not a regression target).
//
// Design source: `docs/old/plans/phase-a-platform-expansion-prereqs.md`
// Item 3.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadPack } from "../../src/generator/_packs/loader-fs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Static testid contract per pack file.  Either:
//   - `data-testid="..."` literal in the template, OR
//   - `{{testidAttr}}` / `{{{testidAttr}}}` partial — the
//     walker-side helper that expands to ` data-testid="..."` when
//     a testid is in scope.
// Both anchor the same contract.
const TESTID_RX = /data-testid|testidAttr/;

// Primitives intentionally exempt from the testid contract.  Each
// entry must come with a reason — the allowlist is the surface
// future contributors review when adding a new exemption.
const TSX_EXEMPT = new Set<string>([
  // Render-prop wrapper component.  Emits its children's testid
  // (the children's own `data-testid`s carry the contract); the
  // wrapper itself has no rendered DOM node to attach one to.
  "primitive-query-view",
  // shadcn / mui / chakra delegate the operation modal to a
  // separately-rendered `<<Op>OpModal>` component (declared via
  // `form-op-decls`) that owns its own internal testids.  The
  // primitive itself is a one-line component-instantiation pass-
  // through.  Mantine wraps the trigger in a Button that DOES
  // carry testid — both shapes are honoured by `TESTID_RX`.
  "primitive-modal",
]);

interface PackUnderTest {
  /** Disk path to the pack root (`<repo>/designs/<family>/<vN>`). */
  dir: string;
  /** Human label for test names (`mantine@v9`). */
  label: string;
  format: "tsx" | "heex" | "svelte" | "vue";
}

const BUILT_IN_PACKS: ReadonlyArray<PackUnderTest> = [
  { dir: "designs/mantine/v7", label: "mantine@v7", format: "tsx" },
  { dir: "designs/mantine/v9", label: "mantine@v9", format: "tsx" },
  { dir: "designs/shadcn/v3", label: "shadcn@v3", format: "tsx" },
  { dir: "designs/shadcn/v4", label: "shadcn@v4", format: "tsx" },
  { dir: "designs/mui/v5", label: "mui@v5", format: "tsx" },
  { dir: "designs/mui/v7", label: "mui@v7", format: "tsx" },
  { dir: "designs/chakra/v2", label: "chakra@v2", format: "tsx" },
  { dir: "designs/chakra/v3", label: "chakra@v3", format: "tsx" },
  { dir: "designs/coreComponents/v3", label: "coreComponents@v3", format: "heex" },
  { dir: "designs/daisyui/v1", label: "daisyui@v1", format: "heex" },
  // Svelte + Vue packs share the TSX contract — same walker, same
  // testidAttr splices in the templates.
  { dir: "designs/shadcnSvelte/v1", label: "shadcnSvelte@v1", format: "svelte" },
  { dir: "designs/flowbite/v1", label: "flowbite@v1", format: "svelte" },
  { dir: "designs/vuetify/v3", label: "vuetify@v3", format: "vue" },
  { dir: "designs/shadcnVue/v1", label: "shadcnVue@v1", format: "vue" },
  // Angular packs splice the same `data-testid` literals into their HTML
  // template strings, driven by the same testid-keyed page objects — so
  // they share the TSX contract (`data-testid` literal, scanned by
  // `TESTID_RX`).  Forms render inline via the walker seam, so `form-of`
  // / `field-input-*` aren't pack templates here; the input testids come
  // from `src/generator/angular/form-fields.ts`.
  { dir: "designs/angularMaterial/v1", label: "angularMaterial@v1", format: "tsx" },
  { dir: "designs/primeng/v1", label: "primeng@v1", format: "tsx" },
];

// Phoenix testid emission lives entirely in the walker
// (`testIdAttr`/`renderPrimitive` in heex-primitives.ts / heex-walker-core.ts)
// — a HEEx pack ships NO call-site `primitive-*` templates at all (its design
// surface is the shell: core-components / layouts / sidebar / theme / assets;
// see `REQUIRED_PRIMITIVES.heex`).  The lock below pins that architectural
// invariant: a `primitive-*.heex.hbs` reappearing in a HEEx pack would be dead
// weight the walker never renders, which is exactly the inert-template debt
// the pack wiring removed.

/** List primitive template files in a pack, by their logical name
 *  (the file basename without the extension chain).  Handles both
 *  `primitive-X.hbs` (TSX) and `primitive-X.heex.hbs` (HEEx). */
function listPrimitives(packDir: string): { name: string; file: string }[] {
  const abs = path.join(repoRoot, packDir);
  const out: { name: string; file: string }[] = [];
  for (const entry of fs.readdirSync(abs)) {
    if (!entry.startsWith("primitive-")) continue;
    if (!entry.endsWith(".hbs")) continue;
    // Strip `.heex.hbs` or `.hbs`.
    const name = entry.endsWith(".heex.hbs")
      ? entry.slice(0, -".heex.hbs".length)
      : entry.slice(0, -".hbs".length);
    out.push({ name, file: path.join(abs, entry) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe("pack testid coverage — TSX + Svelte + Vue packs", () => {
  for (const pack of BUILT_IN_PACKS) {
    if (pack.format === "heex") continue;
    it(`${pack.label}: every non-exempt primitive carries data-testid (template or partial)`, () => {
      const missing: string[] = [];
      for (const { name, file } of listPrimitives(pack.dir)) {
        if (TSX_EXEMPT.has(name)) continue;
        const source = fs.readFileSync(file, "utf-8");
        if (!TESTID_RX.test(source)) missing.push(name);
      }
      expect(
        missing,
        `${pack.label}: primitives missing testid (add data-testid="..." or {{testidAttr}} — or add to TSX_EXEMPT with a reason)`,
      ).toEqual([]);
    });
  }
});

describe("pack testid coverage — HEEx packs (no call-site templates)", () => {
  for (const pack of BUILT_IN_PACKS) {
    if (pack.format !== "heex") continue;
    it(`${pack.label}: ships no primitive-* templates (walker owns call-site markup + testids)`, () => {
      expect(
        listPrimitives(pack.dir).map((p) => p.name),
        `${pack.label}: a primitive-*.heex.hbs template is dead weight — the HEEx walker never ` +
          `dispatches call-site pack templates.  Put design vocabulary in the pack's shell surface ` +
          `(core-components / assets-css / tailwind-config) instead.`,
      ).toEqual([]);
    });
  }
});

describe("pack testid coverage — negative path", () => {
  it("fails when a TSX pack's primitive-button.hbs loses its testid", () => {
    // Synthesise a minimal pack copy whose `primitive-button.hbs`
    // has had its testid stripped.  The static scan must flag it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-no-testid-"));
    // Copy mantine@v9's whole template set, then overwrite primitive-button.
    const source = path.join(repoRoot, "designs/mantine/v9");
    for (const entry of fs.readdirSync(source)) {
      fs.copyFileSync(path.join(source, entry), path.join(dir, entry));
    }
    // Strip testid from primitive-button.
    const buttonFile = path.join(dir, "primitive-button.hbs");
    const stripped = fs
      .readFileSync(buttonFile, "utf-8")
      .replace(/\s*data-testid="[^"]*"/g, "")
      .replace(/\s*\{\{\{?testidAttr\}?\}\}/g, "");
    fs.writeFileSync(buttonFile, stripped);

    // Verify the strip actually removed the testid markers — guards
    // against the test mutating its sentinel without breaking it.
    expect(TESTID_RX.test(fs.readFileSync(buttonFile, "utf-8"))).toBe(false);

    // Apply the same static-scan to the mutated pack — must flag
    // primitive-button as missing.
    const missing: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith("primitive-") || !entry.endsWith(".hbs")) continue;
      const name = entry.slice(0, -".hbs".length);
      if (TSX_EXEMPT.has(name)) continue;
      const src = fs.readFileSync(path.join(dir, entry), "utf-8");
      if (!TESTID_RX.test(src)) missing.push(name);
    }
    expect(missing).toContain("primitive-button");
  });
});

describe("pack testid coverage — sanity (built-in packs load)", () => {
  // Belt-and-suspenders: the gate is static-scan, but every pack
  // surveyed here must also actually load.  Catches the case where
  // an `emits` map references a renamed/deleted file but the scan
  // wouldn't see (the scan iterates filenames; the loader iterates
  // emits keys).
  for (const pack of BUILT_IN_PACKS) {
    it(`${pack.label} loads cleanly`, () => {
      const dir = path.join(repoRoot, pack.dir);
      expect(() => loadPack(dir)).not.toThrow();
    });
  }
});
