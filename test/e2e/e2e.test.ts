import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectOps,
  collectResponseShapes,
  fieldSet,
  type OpenApiSpec,
} from "../_helpers/openapi-normalize.js";

// ---------------------------------------------------------------------------
// E2E smoke: generate the acme system, `docker compose build && up`, poll
// /health on every deployable, then `down`.
//
// Slow (~1-2 min depending on network).  Opt-in: only runs when
// `LOOM_E2E=1` is set in the environment.  `npm run test:e2e` sets it for
// you.
//
// In sandboxed environments where outbound HTTPS goes through a TLS-
// intercepting proxy, set `LOOM_E2E_CA_DIR=<dir-with-*.crt>` to inject
// the proxy CA into each Dockerfile before building.  In a normal
// environment this is unnecessary — the generated Dockerfiles work
// as-is.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const example = path.join(repoRoot, "examples", "showcase.ddd");

const ENABLED = process.env.LOOM_E2E === "1";

// Cross-backend OpenAPI parity is REPORT-ONLY by default: the first real
// runs are expected to surface genuine generator drift (e.g. Phoenix's
// OpenApiSpex emitter namespaces aggregate CRUD under `/aggregates/<plural>`
// while Hono/.NET serve `/<plural>`).  Diffs are logged so they can be
// triaged; set `LOOM_E2E_STRICT_PARITY=1` to turn each diff into a hard
// assertion once the backends are reconciled.
const STRICT_PARITY = process.env.LOOM_E2E_STRICT_PARITY === "1";

function hasDocker(): boolean {
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN = ENABLED && hasDocker();

describe.skipIf(!RUN)("e2e: docker compose smoke", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-"));
    execSync(`node ${cli} generate system ${example} -o ${outDir}`, {
      stdio: "inherit",
    });
    injectProxyCAsIfPresent(outDir);
  }, 60_000);

  afterAll(() => {
    try {
      execSync(`docker compose -f ${outDir}/docker-compose.yml down -v`, {
        stdio: "inherit",
      });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 60_000);

  it("builds every deployable, brings up the system, and serves /health", async () => {
    execSync(`docker compose -f ${outDir}/docker-compose.yml build`, {
      stdio: "inherit",
      timeout: 600_000,
    });
    execSync(`docker compose -f ${outDir}/docker-compose.yml up -d`, {
      stdio: "inherit",
      timeout: 120_000,
    });

    // showcase.ddd ships one backend per platform, all serving the same
    // modules so their OpenAPI specs are comparable.  Hono boots in
    // sub-second; .NET takes a few seconds (cold restore + EnsureCreated);
    // Phoenix is slowest (mix release boot + Ecto migrate).
    await pollHealthy("http://localhost:3000/health", 60_000); // honoApi
    await pollHealthy("http://localhost:8080/health", 120_000); // dotnetApi
    await pollHealthy("http://localhost:4000/health", 180_000); // phoenixApi
  }, 900_000);

  it("generated DSL-level e2e suite runs against the live system", async () => {
    const e2eDir = path.join(outDir, "e2e");
    if (!fs.existsSync(e2eDir)) {
      // System has no `test e2e` blocks — nothing to verify.
      return;
    }
    // Install vitest in the e2e folder, run the generated suite.
    execSync(`npm install --silent --no-audit --no-fund`, {
      cwd: e2eDir,
      stdio: "inherit",
      timeout: 180_000,
    });
    execSync(`npx vitest run`, {
      cwd: e2eDir,
      stdio: "inherit",
      timeout: 120_000,
    });
  }, 600_000);

  it("generated Playwright UI suite runs against the live web_app", async () => {
    // Find any react deployable that ships a Playwright e2e suite.
    // The smoke spec is always present; a UI spec is only there
    // when the system declared `test e2e ... against <react>` blocks.
    const reactDirs = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(outDir, d.name))
      .filter((p) => fs.existsSync(path.join(p, "e2e", "playwright.config.ts")));
    if (reactDirs.length === 0) {
      // No react deployable in this system.
      return;
    }
    for (const dir of reactDirs) {
      const e2eDir = path.join(dir, "e2e");
      // The frontend's e2e/ has its own package.json with
      // @playwright/test as a dev dep — keeping it out of the
      // runtime image.  Install it here.
      execSync(`npm install --silent --no-audit --no-fund`, {
        cwd: e2eDir,
        stdio: "inherit",
        timeout: 180_000,
      });
      // Browser binaries — `playwright install --with-deps` would
      // also pull system packages, but the proxy CA setup in this
      // sandbox already covers them.  PLAYWRIGHT_BROWSERS_PATH
      // points at a per-host shared cache so repeat runs skip the
      // 100 MB download.
      const env = {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers",
      };
      execSync(`npx playwright install chromium`, {
        cwd: e2eDir,
        stdio: "inherit",
        env,
        timeout: 300_000,
      });
      execSync(`npx playwright test`, {
        cwd: e2eDir,
        stdio: "inherit",
        env,
        timeout: 300_000,
      });
    }
  }, 900_000);

  it("cross-check (3-way): Hono / .NET / Phoenix OpenAPI parity", async () => {
    // All three backends serve the same modules from showcase.ddd, so
    // their OpenAPI specs should describe the same contract.  Hono via
    // @hono/zod-openapi, .NET via Swashbuckle, Phoenix via OpenApiSpex.
    const specs: Record<string, OpenApiSpec> = {
      hono: await fetchSpec("http://localhost:3000/openapi.json"),
      dotnet: await fetchSpec("http://localhost:8080/swagger/v1/swagger.json"),
      phoenix: await fetchSpec("http://localhost:4000/api/openapi.json"),
    };

    // Sanity: every backend must publish a non-empty contract.
    for (const [name, spec] of Object.entries(specs)) {
      expect(collectOps(spec).size, `${name} emits at least one operation`).toBeGreaterThan(0);
    }

    // Compare each backend against Hono as the reference.
    const refOps = collectOps(specs.hono);
    const refCard = collectResponseShapes(specs.hono);
    const sharedSchemas = ["ProjectResponse", "BuildResponse", "EngineerResponse"];

    let cleanVsRef = true;
    for (const name of ["dotnet", "phoenix"] as const) {
      const ops = collectOps(specs[name]);
      const onlyRef = [...refOps].filter((o) => !ops.has(o)).sort();
      const onlyThis = [...ops].filter((o) => !refOps.has(o)).sort();

      const cardMismatches: string[] = [];
      const thisCard = collectResponseShapes(specs[name]);
      for (const op of refCard.keys()) {
        if (!thisCard.has(op)) continue;
        if (refCard.get(op) !== thisCard.get(op)) {
          cardMismatches.push(`${op}: hono=${refCard.get(op)}, ${name}=${thisCard.get(op)}`);
        }
      }

      const fieldDiffs: string[] = [];
      for (const schema of sharedSchemas) {
        const ref = fieldSet(specs.hono, schema);
        const got = fieldSet(specs[name], schema);
        const onlyA = [...ref].filter((f) => !got.has(f)).sort();
        const onlyB = [...got].filter((f) => !ref.has(f)).sort();
        if (onlyA.length || onlyB.length) {
          fieldDiffs.push(`${schema}: only-hono=[${onlyA}] only-${name}=[${onlyB}]`);
        }
      }

      if (onlyRef.length || onlyThis.length || cardMismatches.length || fieldDiffs.length) {
        cleanVsRef = false;
        console.warn(`[parity] hono ↔ ${name} divergence (finding):`);
        if (onlyThis.length) console.warn(`  ops only on ${name}:`, onlyThis);
        if (onlyRef.length) console.warn(`  ops missing on ${name}:`, onlyRef);
        if (cardMismatches.length) console.warn("  cardinality:", cardMismatches);
        if (fieldDiffs.length) console.warn("  fields:", fieldDiffs);
      }

      if (STRICT_PARITY) {
        expect(onlyRef, `ops missing on ${name}`).toEqual([]);
        expect(onlyThis, `ops only on ${name}`).toEqual([]);
        expect(cardMismatches, `cardinality drift on ${name}`).toEqual([]);
        expect(fieldDiffs, `field-set drift on ${name}`).toEqual([]);
      }
    }

    if (cleanVsRef) {
      console.info("[parity] all three backends agree on ops / cardinality / shared fields.");
    }
  }, 120_000);
});

async function fetchSpec(url: string): Promise<OpenApiSpec> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as OpenApiSpec;
}

async function pollHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const body = (await r.json()) as { status?: string };
        if (body.status === "ok") return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`/health never responded ok at ${url}: ${String(lastError)}`);
}

/**
 * In sandboxed environments where the docker daemon's outbound HTTPS
 * is intercepted by a TLS-rewriting proxy, the build step needs the
 * proxy CA installed inside the build context.  Each generated
 * Dockerfile already declares `COPY certs/ /usr/local/share/...` and
 * the generator emits an empty `<deployable>/certs/.gitkeep`, so we
 * just drop the proxy's `*.crt` files into every deployable's
 * `certs/` directory.  No regex rewriting, no per-platform hacks —
 * an empty `certs/` is a no-op at build time.
 *
 * Driven by `LOOM_E2E_CA_DIR=<path-with-*.crt>`.  Unset = no-op.
 */
function injectProxyCAsIfPresent(outDir: string): void {
  const caDir = process.env.LOOM_E2E_CA_DIR;
  if (!caDir || !fs.existsSync(caDir)) return;
  const crts = fs.readdirSync(caDir).filter((f) => f.endsWith(".crt"));
  if (crts.length === 0) return;

  const subdirs = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const sub of subdirs) {
    const certsDir = path.join(outDir, sub, "certs");
    if (!fs.existsSync(certsDir)) continue; // not a generated deployable
    for (const crt of crts) {
      fs.copyFileSync(path.join(caDir, crt), path.join(certsDir, crt));
    }
  }
}
