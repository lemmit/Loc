import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator regression test: emit each example, install deps, run
// `tsc --noEmit` (type-check only — tsup handles emit), then run
// `npm run build` to exercise the tsup bundle.  Catches generator
// drift that breaks generated TS without running the full docker
// e2e.
//
// Slow (~60s with cached node_modules) — opt-in via LOOM_TS_BUILD=1
// so `npm test` stays fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TS_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated TS type-checks (tsc) AND bundles (tsup) under strict mode",
  () => {
    it.each([
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/roster.ddd",
      // crudish lifecycle — the only example that emits a canonical
      // destroy, so this cell is what compiles the Hono DELETE route +
      // repo `delete()` paths.
      "examples/lifecycle.ddd",
      // Document-persistence path (`normalised(false)`): jsonb column +
      // JSON round-trip through `_create` (toDoc / fromDoc).
      "examples/document.ddd",
      // First-boot seeding (database-seeding.md): compiles db/seed.ts + the
      // index.ts runSeeds wiring + the db:seed package.json script.
      "examples/seeding.ddd",
    ])("%s — `ddd generate ts` output type-checks + tsup-bundles", (example) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-"));
      try {
        execSync(`node ${cli} generate ts ${example} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 180_000,
        });
        // Type-check (tsup is build-only with `dts: false`).
        execSync(`npx tsc --noEmit`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        // Build the production bundle.
        execSync(`npm run build`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        // Bundle exists where the Dockerfile expects it.
        expect(fs.existsSync(path.join(outDir, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // D-REALIZATION-AXES Phase 5b: `directoryLayout: byFeature` is a SYSTEM-MODE
    // selection (it lives on a deployable), so `generate ts` above never sees it.
    // This case generates the SYSTEM and type-checks the node deployable's
    // project, proving the byFeature relocation + relative-import rewrite produce
    // a COMPILING project — the gap that let the first byFeature attempt ship
    // broken.
    it("system `directoryLayout: byFeature` (node) — relocated project type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-bf-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/byfeature.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        // The node deployable is named `api` → its project lands under `api/`.
        const proj = path.join(outDir, "api");
        // Sanity: the layout actually relocated files under features/.
        expect(fs.existsSync(path.join(proj, "features", "order", "order.ts"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "domain", "order.ts"))).toBe(false);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // Event sourcing (appliers A2): a `persistedAs(eventLog)` aggregate emits
    // the `<agg>_events` stream table, the `_apply`/`_fromEvents` fold, the
    // record-and-fold `emit`, the shell-+emit-body `create` factory, and the
    // append/fold repository.  Generated via `generate system` (the ES storage
    // validator requires a Hono host).  The discriminated-union push/apply is
    // the type-sensitive part this gate compiles.
    it("system event sourcing (eventLog + appliers + create) — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-es-"));
      try {
        execSync(`node ${cli} generate system examples/event-sourcing.ddd -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, "api");
        // Sanity: the event-store table + the fold rehydrator made it out.
        expect(fs.readFileSync(path.join(proj, "db", "schema.ts"), "utf8")).toContain(
          "account_events",
        );
        expect(fs.readFileSync(path.join(proj, "domain", "account.ts"), "utf8")).toContain(
          "_fromEvents",
        );
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);
  },
);
