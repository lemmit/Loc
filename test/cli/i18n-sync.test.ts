// End-to-end for the `ddd i18n` CLI handlers against a real temp tree:
// extract → init → translate → sync, exercising the file layout and the lock
// lag that makes the three-way merge work.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractCatalog } from "../../src/cli/i18n/extract.js";
import { runI18nInit, runI18nSync } from "../../src/cli/i18n/index.js";
import { TODO_PREFIX } from "../../src/i18n/merge.js";

const SOURCE = `
  system S {
    subdomain M { context C { } }
    ui WebApp {
      page Welcome {
        route: "/welcome"
        body:  Heading { "Welcome" }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

let tmp: string;
let ddd: string;
let dir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-i18n-"));
  ddd = path.join(tmp, "app.ddd");
  dir = path.join(tmp, "locales");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;

describe("ddd i18n — extract/init/sync", () => {
  it("extractCatalog surfaces user-visible page text keyed by content hash", async () => {
    fs.writeFileSync(ddd, SOURCE);
    const catalog = await extractCatalog(ddd);
    const entries = Object.entries(catalog);
    expect(entries.length).toBeGreaterThan(0);
    expect(Object.values(catalog)).toContain("Welcome");
    // Authored page text carries the D-I18N-KEY page-scoped content-hash shape;
    // an i18n-enabled system also merges the app-shell chrome (`chrome.*`) and
    // the active design pack's DECLARED chrome (`pack.<family>.<role>.<hash>`,
    // D-PACK-CHROME) — neither of which is authored page text.
    const pageKeys = entries.filter(([k]) => !k.startsWith("chrome.") && !k.startsWith("pack."));
    expect(pageKeys.every(([k]) => /^page\.Welcome\./.test(k))).toBe(true);
    expect(catalog["chrome.notFound"]).toBe("Not found");
  });

  it("init seeds a TODO locale file + a lock snapshot of the source", async () => {
    fs.writeFileSync(ddd, SOURCE);
    await runI18nInit(ddd, "fr", { dir });

    const fr = readJson(path.join(dir, "fr.json"));
    expect(Object.values(fr).every((v) => v.startsWith(TODO_PREFIX))).toBe(true);

    const lock = readJson(path.join(dir, ".loom", "source.lock.json"));
    expect(Object.values(lock)).toContain("Welcome");
    // lock == source (BASE snapshot), no TODO prefix.
    expect(Object.values(lock).every((v) => !v.startsWith(TODO_PREFIX))).toBe(true);
  });

  it("init leaves an existing locale untouched", async () => {
    fs.writeFileSync(ddd, SOURCE);
    await runI18nInit(ddd, "fr", { dir });
    const frFile = path.join(dir, "fr.json");
    const key = Object.keys(readJson(frFile))[0];
    fs.writeFileSync(frFile, JSON.stringify({ [key]: "Bienvenue" }, null, 2));

    await runI18nInit(ddd, "fr", { dir });
    expect(readJson(frFile)).toEqual({ [key]: "Bienvenue" });
  });

  it("sync keeps a human translation and reports no new work when source is unchanged", async () => {
    fs.writeFileSync(ddd, SOURCE);
    await runI18nInit(ddd, "fr", { dir });
    const frFile = path.join(dir, "fr.json");
    // Provide a human translation for the page string; leave the other keys
    // (the merged app-shell chrome, M-T1.11) as their seeded TODOs so the file
    // is COMPLETE — an unchanged source must then be no new work.
    const seeded = readJson(frFile);
    const key = Object.keys(seeded).find((k) => !k.startsWith("chrome."))!;
    seeded[key] = "Bienvenue";
    fs.writeFileSync(frFile, JSON.stringify(seeded, null, 2));

    await runI18nSync(ddd, { dir });
    expect(readJson(frFile)).toEqual(seeded);
  });

  it("sync adds a fresh TODO when the source grows a new string", async () => {
    fs.writeFileSync(ddd, SOURCE);
    await runI18nInit(ddd, "fr", { dir });
    const frFile = path.join(dir, "fr.json");
    const key = Object.keys(readJson(frFile))[0];
    fs.writeFileSync(frFile, JSON.stringify({ [key]: "Bienvenue" }, null, 2));
    await runI18nSync(ddd, { dir });

    // Add a second user-visible string, re-extract, re-sync.
    fs.writeFileSync(
      ddd,
      SOURCE.replace(
        'Heading { "Welcome" }',
        'Stack { Heading { "Welcome" }, Text { "Sign in" } }',
      ),
    );
    await runI18nSync(ddd, { dir });

    const fr = readJson(frFile);
    expect(fr[key]).toBe("Bienvenue"); // old translation preserved
    const todos = Object.values(fr).filter((v) => v.startsWith(TODO_PREFIX));
    expect(todos).toContain(`${TODO_PREFIX}Sign in`);
  });
});
