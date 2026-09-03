import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The theme ratchet (M-T8.23 slice 4, audit M16).
//
// The playground was written against Mantine's RAW dark palette — ~110 uses of
// `dark.N` / `--mantine-color-dark-N` across 25 files.  A raw shade is not a
// role, so nothing could adapt: a viewer whose stored Mantine scheme was light
// got white-on-white panels, and M-T8.16 had to pin `forceColorScheme="dark"`
// to stop it.  Slice 4 routed every one of those through a SEMANTIC token in
// `web/src/theme.css` and dropped the pin.
//
// Shaped like `vocabulary.test.ts`: a grep over the real tree, failing with the
// file named.  Both halves matter — the ratchet stops the literals coming back,
// and the assertions on `main.tsx` / `theme.css` stop the pin coming back with
// them.
//
// WAIVERS RATCHET (CLAUDE.md): a waived file that no longer needs the waiver
// fails this test, so the fix deletes its entry in the same PR.

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");

/** `dark.6` in a Mantine prop, or `--mantine-color-dark-6` in a style. */
const RAW_DARK = /\bdark\.\d\b|--mantine-color-dark-\d/;

/** Files still allowed to carry raw shades, and why.  Each entry is a claim
 *  that SOMEONE ELSE owns the file right now — not that the shades are fine. */
const WAIVED: { file: string; reason: string }[] = [
  {
    file: "layout/ChatPanel.tsx",
    reason:
      "owned by M-T8.19 (agent loop) while that mission is in flight — editing it here would " +
      "collide on every line of the same file; M-T8.19 migrates its six shades and deletes this entry",
  },
];

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "examples") continue;
      out.push(...walkSources(full));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = walkSources(webSrc);
const rel = (f: string): string => path.relative(webSrc, f).split(path.sep).join("/");

describe("theme tokens — the ratchet over web/src", () => {
  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no raw `dark.N` / `--mantine-color-dark-N` outside the waivers", () => {
    const waived = new Set(WAIVED.map((w) => w.file));
    const offenders = files
      .filter((f) => !waived.has(rel(f)))
      .filter((f) => RAW_DARK.test(fs.readFileSync(f, "utf8")))
      .map(rel);
    expect(
      offenders,
      "use a semantic token from web/src/theme.css (--loom-bg / --loom-border / …) instead of a raw palette shade",
    ).toEqual([]);
  });

  it("every waiver is still needed — a clean file must lose its waiver", () => {
    const stale = WAIVED.filter(
      (w) => !RAW_DARK.test(fs.readFileSync(path.join(webSrc, w.file), "utf8")),
    ).map((w) => w.file);
    expect(stale, "this file no longer carries raw shades — delete its WAIVED entry").toEqual([]);
  });
});

describe("theme tokens — the token module", () => {
  const css = fs.readFileSync(path.join(webSrc, "theme.css"), "utf8");

  it("defines every role the tree uses", () => {
    for (const token of [
      "--loom-border",
      "--loom-border-strong",
      "--loom-bg",
      "--loom-bg-raised",
      "--loom-bg-sunken",
      "--loom-bg-active",
      "--loom-edge",
      "--loom-edge-strong",
    ]) {
      expect(css, `theme.css is missing ${token}`).toContain(`${token}:`);
    }
  });

  it("resolves per scheme rather than hard-coding one — light-dark() or a Mantine role", () => {
    // A token whose value is a bare dark shade would be the same defect under
    // a new name.  Every definition must either use `light-dark()` or alias a
    // Mantine semantic var (`--mantine-color-body` / `-default-border`).
    const defs = [...css.matchAll(/^\s*(--loom-[a-z-]+):\s*(.+?);/gm)];
    expect(defs.length).toBeGreaterThan(4);
    for (const [, name, value] of defs) {
      const adaptive =
        value?.includes("light-dark(") ||
        value?.includes("--mantine-color-body") ||
        value?.includes("--mantine-color-default-border");
      expect(adaptive, `${name} is fixed to one scheme: ${value}`).toBe(true);
    }
  });

  it("no token is defined in terms of a raw dark shade OUTSIDE its dark half", () => {
    // `light-dark(<light>, <dark>)` — the FIRST argument is the light value, so
    // a `dark-N` there is the white-on-white bug reintroduced.
    for (const [, name, value] of css.matchAll(/^\s*(--loom-[a-z-]+):\s*(.+?);/gm)) {
      const m = /light-dark\(([^,]+),/.exec(value ?? "");
      if (!m) continue;
      expect(m[1], `${name}'s LIGHT value is a dark shade`).not.toMatch(/--mantine-color-dark-\d/);
    }
  });
});

describe("theme tokens — the color scheme is no longer forced", () => {
  const main = fs.readFileSync(path.join(webSrc, "main.tsx"), "utf8");

  it("main.tsx honours the viewer's scheme again", () => {
    // The PROP, not the word — the comment above the provider explains why
    // the pin went, and naming it there must not fail the gate.
    expect(main).not.toMatch(/forceColorScheme\s*=/);
    expect(main).toContain('defaultColorScheme="dark"');
  });

  it("main.tsx loads the token module", () => {
    expect(main).toContain('import "./theme.css"');
  });
});
