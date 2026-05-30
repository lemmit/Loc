import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectOps,
  diffSpecs,
  isCleanDiff,
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

// Cross-backend OpenAPI parity defaults to REPORT-ONLY locally (diffs
// log without failing).  The `conformance-parity.yml` CI job sets
// `LOOM_E2E_STRICT_PARITY=1` so each divergence becomes a hard
// `expect(...).toBe(...)` assertion — the gate that catches generator
// drift between Hono / .NET / Phoenix at PR time.
const STRICT_PARITY = process.env.LOOM_E2E_STRICT_PARITY === "1";

// Parity-only mode (per-PR CI tier): build + boot only the three backends
// and run only the OpenAPI parity check — skip the behavioral DSL suite and
// the Playwright UI run (and the React frontend builds they need).  The
// full nightly tier leaves this unset.
const PARITY_ONLY = process.env.LOOM_E2E_PARITY_ONLY === "1";

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
    // In parity-only mode (per-PR CI tier) build + boot just the three
    // backends + their db — the React frontends are slow to build and the
    // OpenAPI parity check doesn't need them.  The full run builds all.
    const services = PARITY_ONLY ? " dotnet_api hono_api phoenix_api" : "";
    execSync(`docker compose -f ${outDir}/docker-compose.yml build${services}`, {
      stdio: "inherit",
      timeout: 600_000,
    });
    try {
      execSync(`docker compose -f ${outDir}/docker-compose.yml up -d${services}`, {
        stdio: "inherit",
        timeout: 120_000,
      });
    } catch (err) {
      // `afterAll` immediately tears the stack down via `down -v` and
      // removes outDir, taking the containers' stdout/stderr with them.
      // Dump state + tail before we re-throw — both to console.error
      // (vitest's per-test capture) and to a fixed file path that survives
      // the cleanup so the workflow's post-failure step can surface it.
      const capture = (cmd: string): string => {
        try {
          return execSync(cmd, {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 30_000,
          });
        } catch (e: unknown) {
          const ex = e as { stdout?: string; stderr?: string; message?: string };
          return `[capture failed] ${ex.message ?? "unknown"}\nstdout: ${ex.stdout ?? ""}\nstderr: ${ex.stderr ?? ""}`;
        }
      };
      const sections = [
        "===== compose ps -a (post-failure) =====",
        capture(`docker compose -f ${outDir}/docker-compose.yml ps -a`),
        "===== compose logs --tail=400 (post-failure) =====",
        capture(`docker compose -f ${outDir}/docker-compose.yml logs --tail=400`),
        "===== end compose diagnostics =====",
      ];
      const body = sections.join("\n");
      // 1) inline so a developer running the test locally sees it.
      console.error("\n" + body + "\n");
      // 2) persisted so CI's post-failure step can re-print it even after
      //    the e2e test's afterAll deletes outDir.
      try {
        fs.writeFileSync("/tmp/loom-e2e-diagnostics.log", body);
      } catch {
        /* ignore */
      }
      throw err;
    }

    // showcase.ddd ships one backend per platform, all serving the same
    // modules so their OpenAPI specs are comparable.  Hono boots in
    // sub-second; .NET takes a few seconds (cold restore + EnsureCreated);
    // Phoenix is slowest (mix release boot + Ecto migrate).
    try {
      await pollHealthy("http://localhost:3000/health", 60_000); // honoApi
      await pollHealthy("http://localhost:8080/health", 120_000); // dotnetApi
      await pollHealthy("http://localhost:4000/health", 180_000); // phoenixApi
    } catch (err) {
      // Same forensic capture as the up -d catch: containers are up
      // (up -d succeeded), but one didn't get to "responding on
      // /health" within its budget.  Dump ps + logs so the next round
      // shows the actual crash/stall reason.
      const capture = (cmd: string): string => {
        try {
          return execSync(cmd, {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 30_000,
          });
        } catch (e: unknown) {
          const ex = e as { stdout?: string; stderr?: string; message?: string };
          return `[capture failed] ${ex.message ?? "unknown"}\nstdout: ${ex.stdout ?? ""}\nstderr: ${ex.stderr ?? ""}`;
        }
      };
      const sections = [
        "===== compose ps -a (post-health-timeout) =====",
        capture(`docker compose -f ${outDir}/docker-compose.yml ps -a`),
        "===== compose logs --tail=400 (post-health-timeout) =====",
        capture(`docker compose -f ${outDir}/docker-compose.yml logs --tail=400`),
        "===== end compose diagnostics =====",
      ];
      const body = sections.join("\n");
      console.error("\n" + body + "\n");
      try {
        fs.writeFileSync("/tmp/loom-e2e-diagnostics.log", body);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }, 900_000);

  it.skipIf(PARITY_ONLY)(
    "generated DSL-level e2e suite runs against the live system",
    async () => {
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
    },
    600_000,
  );

  it.skipIf(PARITY_ONLY)(
    "generated Playwright UI suite runs against the live web_app",
    async () => {
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
    },
    900_000,
  );

  it("cross-check (3-way): Hono / .NET / Phoenix OpenAPI parity", async () => {
    // All three backends serve the same modules from showcase.ddd, so
    // their OpenAPI specs should describe the same contract.  Hono via
    // @hono/zod-openapi, .NET via Swashbuckle, Phoenix via OpenApiSpex.
    let specs: Record<string, OpenApiSpec>;
    try {
      specs = {
        hono: await fetchSpec("http://localhost:3000/openapi.json"),
        dotnet: await fetchSpec("http://localhost:8080/swagger/v1/swagger.json"),
        phoenix: await fetchSpec("http://localhost:4000/api/openapi.json"),
      };
    } catch (err) {
      // /health succeeded but a spec endpoint didn't.  Most likely cause is
      // a server-side rendering exception (e.g. an OpenApiSpex schema error
      // in Phoenix).  Dump the same diagnostic surface as the up -d and
      // /health catches so the next round shows the actual stack trace.
      const capture = (cmd: string): string => {
        try {
          return execSync(cmd, {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 30_000,
          });
        } catch (e: unknown) {
          const ex = e as { stdout?: string; stderr?: string; message?: string };
          return `[capture failed] ${ex.message ?? "unknown"}\nstdout: ${ex.stdout ?? ""}\nstderr: ${ex.stderr ?? ""}`;
        }
      };
      const sections = [
        "===== compose ps -a (post-spec-fetch) =====",
        capture(`docker compose -f ${outDir}/docker-compose.yml ps -a`),
        "===== compose logs --tail=400 (post-spec-fetch) =====",
        capture(`docker compose -f ${outDir}/docker-compose.yml logs --tail=400`),
        "===== end compose diagnostics =====",
      ];
      const body = sections.join("\n");
      console.error("\n" + body + "\n");
      try {
        fs.writeFileSync("/tmp/loom-e2e-diagnostics.log", body);
      } catch {
        /* ignore */
      }
      throw err;
    }

    // Sanity: every backend must publish a non-empty contract.
    for (const [name, spec] of Object.entries(specs)) {
      expect(collectOps(spec).size, `${name} emits at least one operation`).toBeGreaterThan(0);
    }

    // Compare each pair of backends.  Three pairs total — hono↔dotnet,
    // hono↔phoenix, dotnet↔phoenix.  The third pair catches drift
    // where two non-Hono backends diverge from each other in a way
    // that's NOT a Hono divergence (e.g., both Phoenix and .NET
    // shipping a contract change Hono hasn't picked up yet).  Without
    // the direct pair we'd see two "ref drift" reports that don't
    // make their joint relationship explicit.
    //
    // `diffSpecs` is pure — see test/_helpers/openapi-normalize.test.ts
    // for the unit-test coverage of each divergence class.
    const pairs: Array<[keyof typeof specs, keyof typeof specs]> = [
      ["hono", "dotnet"],
      ["hono", "phoenix"],
      ["dotnet", "phoenix"],
    ];
    let cleanOverall = true;
    for (const [refName, otherName] of pairs) {
      const diff = diffSpecs(
        { name: refName, spec: specs[refName] },
        { name: otherName, spec: specs[otherName] },
      );

      if (!isCleanDiff(diff)) {
        cleanOverall = false;
        console.warn(`[parity] ${refName} ↔ ${otherName} divergence (finding):`);
        if (diff.onlyOther.length) console.warn(`  ops only on ${otherName}:`, diff.onlyOther);
        if (diff.onlyRef.length) console.warn(`  ops only on ${refName}:`, diff.onlyRef);
        if (diff.cardMismatches.length) console.warn("  cardinality:", diff.cardMismatches);
        if (diff.onlySchemasOther.length)
          console.warn(`  schemas only on ${otherName}:`, diff.onlySchemasOther);
        if (diff.onlySchemasRef.length)
          console.warn(`  schemas only on ${refName}:`, diff.onlySchemasRef);
        if (diff.fieldDiffs.length) console.warn("  fields:", diff.fieldDiffs);
        if (diff.requiredDiffs.length) console.warn("  required:", diff.requiredDiffs);
        if (diff.propertyTypeDiffs.length)
          console.warn("  property types:", diff.propertyTypeDiffs);
        if (diff.propertyFormatDiffs.length)
          console.warn("  property formats:", diff.propertyFormatDiffs);
        if (diff.paramTypeDiffs.length) console.warn("  path-param types:", diff.paramTypeDiffs);
        if (diff.queryParamDiffs.length) console.warn("  query params:", diff.queryParamDiffs);
        if (diff.requestBodyDiffs.length)
          console.warn("  request-body schemas:", diff.requestBodyDiffs);
        if (diff.responseBodyDiffs.length)
          console.warn("  response-body schemas:", diff.responseBodyDiffs);
        if (diff.operationIdDiffs.length) console.warn("  operationIds:", diff.operationIdDiffs);
        if (diff.enumValueDiffs.length) console.warn("  enum value-sets:", diff.enumValueDiffs);
        if (diff.errorResponseDiffs.length)
          console.warn("  error responses:", diff.errorResponseDiffs);
      }

      const pair = `${refName} ↔ ${otherName}`;
      if (STRICT_PARITY) {
        expect(diff.onlyRef, `ops only on ${refName} (${pair})`).toEqual([]);
        expect(diff.onlyOther, `ops only on ${otherName} (${pair})`).toEqual([]);
        expect(diff.cardMismatches, `cardinality drift (${pair})`).toEqual([]);
        expect(diff.onlySchemasRef, `schemas only on ${refName} (${pair})`).toEqual([]);
        expect(diff.onlySchemasOther, `schemas only on ${otherName} (${pair})`).toEqual([]);
        expect(diff.fieldDiffs, `field-set drift (${pair})`).toEqual([]);
        expect(diff.requiredDiffs, `required-set drift (${pair})`).toEqual([]);
        expect(diff.propertyTypeDiffs, `property-type drift (${pair})`).toEqual([]);
        expect(diff.propertyFormatDiffs, `property-format drift (${pair})`).toEqual([]);
        expect(diff.paramTypeDiffs, `path-param type drift (${pair})`).toEqual([]);
        expect(diff.queryParamDiffs, `query-param drift (${pair})`).toEqual([]);
        expect(diff.requestBodyDiffs, `request-body schema drift (${pair})`).toEqual([]);
        expect(diff.responseBodyDiffs, `response-body schema drift (${pair})`).toEqual([]);
        expect(diff.operationIdDiffs, `operationId drift (${pair})`).toEqual([]);
        expect(diff.enumValueDiffs, `enum value-set drift (${pair})`).toEqual([]);
        expect(diff.errorResponseDiffs, `error-response drift (${pair})`).toEqual([]);
      }
    }

    if (cleanOverall) {
      console.info(
        "[parity] all three backends agree across all three pairs (ops / cardinality / schemas / fields / required).",
      );
    }
  }, 120_000);

  it("cross-backend: a guarded workflow denies with 403 (runtime authorization)", async () => {
    // showcase's `registerProject` workflow guards on
    // `currentUser.permissions.length > 0`.  Every backend's dev-stub auth
    // verifier returns an admin user with EMPTY permissions, so the guard
    // fails for any authenticated request — exercising the authorization
    // (403) path end-to-end on all three backends.  Each previously 500'd
    // because the guard crashed before it could deny:
    //   - Hono   left `currentUser` unbound in the workflow handler
    //            (ReferenceError) — now bound from httpCtx.
    //   - Phoenix rendered `.length` on a list as a map field access
    //            (BadMapError) — now `Enum.count(...)`.
    //   - .NET   already bound `currentUser` (ICurrentUserAccessor); 403.
    // The body is valid (name + visibility) so request validation doesn't
    // short-circuit with a 400 before the guard runs.  The stub accepts
    // any bearer token, so a placeholder satisfies `auth: required`.
    const targets: Record<string, string> = {
      hono: "http://localhost:3000/workflows/register_project",
      dotnet: "http://localhost:8080/workflows/register_project",
      phoenix: "http://localhost:4000/api/workflows/register_project",
    };
    const statuses: Record<string, number> = {};
    for (const [name, url] of Object.entries(targets)) {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer e2e-stub-token",
        },
        body: JSON.stringify({ name: "Parity Test", visibility: "Public" }),
      });
      statuses[name] = r.status;
    }
    // Every backend must deny with 403 — not 400 (domain/validation) and
    // not 500 (the pre-fix guard-crash path).  Asserting all three at once
    // surfaces which backend diverged in the failure message.
    for (const [name, status] of Object.entries(statuses)) {
      expect(status, `${name} guarded-workflow status (all: ${JSON.stringify(statuses)})`).toBe(
        403,
      );
    }
  }, 60_000);
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
