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

// Parity-only mode (per-PR CI tier): build + boot only the five backends
// and run only the OpenAPI parity check — skip the behavioral DSL suite and
// the Playwright UI run (and the React frontend builds they need).  The
// full nightly tier leaves this unset.
const PARITY_ONLY = process.env.LOOM_E2E_PARITY_ONLY === "1";

// Phoenix is now part of the 5-backend showcase parity set: the vanilla gaps that
// kept it out (aggregate-`function` calls, `currentUser` threading through the pure
// core + guarded-op domain tests, relational nested-part persistence, OpenAPI-spec
// emission, and the project-wide WorkflowsController — vanilla-phoenix-gaps.md
// §11a–g) are closed, and `examples/showcase.ddd` carries the elixir `phoenixApi`
// deployable again.  `LOOM_E2E_SKIP_PHOENIX=1` remains as a local opt-out (e.g. a
// fast run that skips the slowest backend); it is NOT set in conformance-parity.yml,
// so the per-PR gate includes phoenix by default.
const SKIP_PHOENIX = process.env.LOOM_E2E_SKIP_PHOENIX === "1";

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
    // In parity-only mode (per-PR CI tier) build + boot just the five
    // backends + their db — the SPA frontends are slow to build and the
    // OpenAPI parity check doesn't need them.  The full run builds all.
    const services = PARITY_ONLY
      ? ` dotnet_api hono_api${SKIP_PHOENIX ? "" : " phoenix_api"} python_api java_api`
      : "";
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
      await pollHealthy("http://localhost:8000/health", 120_000); // pythonApi
      await pollHealthy("http://localhost:8080/health", 120_000); // dotnetApi
      if (!SKIP_PHOENIX) {
        await pollHealthy("http://localhost:4000/health", 180_000); // phoenixApi
      }
      await pollHealthy("http://localhost:8081/health", 180_000); // javaApi
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
      // When the generated system requires auth (it ships a Keycloak realm
      // import), the generated harness must present a real bearer token or
      // every request 401s before reaching its create/validation/not-found
      // path.  Mint the same demo/demo token the runtime-authorization test
      // uses and hand it to the suite via E2E_BEARER_TOKEN (the harness sends
      // no Authorization header when the var is unset, so auth-less systems
      // are unaffected).
      const authEnv: NodeJS.ProcessEnv = { ...process.env };
      if (fs.existsSync(path.join(outDir, "keycloak", "realm.json"))) {
        authEnv.E2E_BEARER_TOKEN = await keycloakPasswordGrantToken(outDir);
      }
      execSync(`npx vitest run`, {
        cwd: e2eDir,
        stdio: "inherit",
        timeout: 120_000,
        env: authEnv,
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

  it("cross-check (5-way): Hono / .NET / Phoenix / Python / Java OpenAPI parity", async () => {
    // All five backends serve the same modules from showcase.ddd, so
    // their OpenAPI specs should describe the same contract.  Hono via
    // @hono/zod-openapi, .NET via Swashbuckle, Phoenix via OpenApiSpex,
    // Python via FastAPI (+ the install_openapi parity post-processor),
    // Java via springdoc-openapi.
    let specs: Record<string, OpenApiSpec>;
    try {
      specs = {
        // Every backend now serves the spec at the aligned root path /openapi.json.
        node: await fetchSpec("http://localhost:3000/openapi.json"),
        dotnet: await fetchSpec("http://localhost:8080/openapi.json"),
        python: await fetchSpec("http://localhost:8000/openapi.json"),
        java: await fetchSpec("http://localhost:8081/openapi.json"),
      };
      // The vanilla Phoenix backend isn't showcase-complete yet (see
      // SKIP_PHOENIX above) — only fetch/compare its spec when it was built.
      if (!SKIP_PHOENIX) {
        specs.phoenix = await fetchSpec("http://localhost:4000/openapi.json");
      }
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

    // Compare every pair of backends — the full 10 (5 choose 2: node, dotnet,
    // python, phoenix, java).  The all-pairs (not just node-vs-each) form catches
    // drift where two NON-node backends diverge from each other in a way that's
    // NOT a node divergence (e.g. both Phoenix and .NET shipping a contract change
    // the node backend hasn't picked up yet).  Java was historically spec-fetched +
    // sanity-checked but NEVER diffed (an oversight from #1530, which added java's
    // fetch + this "ten pairs" comment but not the java pairs); now wired in so the
    // gate is a genuine 5-way contract check, not 4-way.
    //
    // `diffSpecs` is pure — see test/_helpers/openapi-normalize.test.ts
    // for the unit-test coverage of each divergence class.
    const pairs: Array<[keyof typeof specs, keyof typeof specs]> = (
      [
        ["node", "dotnet"],
        ["node", "phoenix"],
        ["dotnet", "phoenix"],
        ["node", "python"],
        ["dotnet", "python"],
        ["phoenix", "python"],
        ["node", "java"],
        ["dotnet", "java"],
        ["python", "java"],
        ["phoenix", "java"],
      ] as Array<[keyof typeof specs, keyof typeof specs]>
    ).filter(([a, b]) => !SKIP_PHOENIX || (a !== "phoenix" && b !== "phoenix"));
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
        "[parity] all five backends agree across all ten pairs (ops / cardinality / schemas / fields / required).",
      );
    }
  }, 120_000);

  // Runtime authorization parity — distinct from the OpenAPI parity above.
  // showcase's `registerProject` workflow guards on
  // `currentUser.permissions.contains(permissions.manageProjects)`.  Since
  // #1623 showcase ships OIDC-only auth (no dev stub): the test mints a REAL
  // token from the bundled Keycloak via password grant (demo/demo — the
  // same fixture user auth-oidc-dotnet-e2e.test.ts exercises).  The demo
  // user's realm roles (user/agent) map onto `currentUser.permissions` and
  // do NOT contain "Projects.manageProjects", so every backend must DENY
  // the verified, authenticated request with 403 — not 401 (verification
  // failed), not 400/422 (validation), not 500 (a guard crash).
  //
  // Runs in parity-only mode too (the five backends are already booted).
  // History: Hono once 500'd (unbound currentUser, #759), Phoenix once
  // 500'd (`.length` field access #759, then uncaught `throw` #771).  This
  // test dumps each backend's response body + container logs on any non-403
  // so the real server-side error surfaces in CI.
  it("cross-backend: a guarded workflow denies with 403 (runtime authorization)", async () => {
    const targets: Record<string, string> = {
      node: "http://localhost:3000/api/workflows/register_project",
      dotnet: "http://localhost:8080/api/workflows/register_project",
      // phoenix dropped when SKIP_PHOENIX (not built/booted) — see above.
      ...(SKIP_PHOENIX ? {} : { phoenix: "http://localhost:4000/api/workflows/register_project" }),
      python: "http://localhost:8000/api/workflows/register_project",
      java: "http://localhost:8081/api/workflows/register_project",
    };

    // An unverifiable token must be rejected 401 by every backend's OIDC
    // verifier BEFORE any guard runs — the verifier-parity half of this test.
    for (const [name, url] of Object.entries(targets)) {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer e2e-stub-token",
        },
        body: JSON.stringify({ name: "Parity Test", visibility: "Public" }),
      });
      await r.text();
      expect(r.status, `${name} must 401 an unverifiable bearer token`).toBe(401);
    }

    const token = await keycloakPasswordGrantToken(outDir);
    const statuses: Record<string, number> = {};
    const bodies: Record<string, string> = {};
    for (const [name, url] of Object.entries(targets)) {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "Parity Test", visibility: "Public" }),
      });
      statuses[name] = r.status;
      bodies[name] = (await r.text()).slice(0, 1000);
    }

    const allDeny = Object.values(statuses).every((s) => s === 403);
    if (!allDeny) {
      // A guard-crash returns a generic 500 body that hides the cause, so
      // dump the response bodies AND the container logs (the .NET
      // DomainExceptionFilter logs the real exception before returning
      // 500; Phoenix prints an Elixir stacktrace).  Persist to the same
      // diagnostics file the workflow's post-failure step surfaces.
      dumpComposeDiagnostics(outDir, "workflow-403", {
        statuses,
        bodies,
      });
    }

    // Every backend must deny with 403 — not 400 (domain/validation) and
    // not 500 (a guard crash).  Asserting each at once names which
    // backend diverged in the failure message.
    for (const [name, status] of Object.entries(statuses)) {
      expect(
        status,
        `${name} guarded-workflow status (all: ${JSON.stringify(statuses)}; body: ${bodies[name]})`,
      ).toBe(403);
    }
  }, 60_000);
});

/** Mint a real access token from the bundled dev Keycloak via the password
 *  grant (fixture user demo/demo, client `<realm>-app` — the realm import
 *  the generator writes to <outDir>/keycloak/realm.json).  The Keycloak
 *  HOST port is derived from the generated docker-compose.yml (the
 *  generator picks the first free port ≥8081, so it shifts with the
 *  deployable set — 8082 for showcase).  Retries while Keycloak finishes
 *  its realm import: the backends' /health gate proves the container is
 *  up, not that the token endpoint is serving yet. */
async function keycloakPasswordGrantToken(outDir: string): Promise<string> {
  const compose = fs.readFileSync(path.join(outDir, "docker-compose.yml"), "utf8");
  const kcBlock = /(^|\n)\s{2}keycloak:\n([\s\S]*?)(\n\s{2}\S|$)/.exec(compose)?.[2] ?? "";
  const port = /- "(\d+):8080"/.exec(kcBlock)?.[1];
  if (!port) throw new Error("could not derive the keycloak host port from docker-compose.yml");
  const realmJson = JSON.parse(
    fs.readFileSync(path.join(outDir, "keycloak", "realm.json"), "utf8"),
  ) as { realm: string };
  const realm = realmJson.realm;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: `${realm}-app`,
    username: "demo",
    password: "demo",
    scope: "openid",
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const r = await fetch(
        `http://localhost:${port}/realms/${realm}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        },
      );
      if (r.ok) {
        const json = (await r.json()) as { access_token?: string };
        if (json.access_token) return json.access_token;
        throw new Error("token grant returned no access_token");
      }
      lastError = new Error(`token grant → ${r.status} ${await r.text()}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(`keycloak token grant never succeeded: ${String(lastError)}`);
}

/** Capture compose ps + logs (and any extra context) to console.error and
 *  to /tmp/loom-e2e-diagnostics.log, which the parity workflow's
 *  post-failure step re-prints after this suite's afterAll deletes outDir.
 *  Mirrors the inline capture blocks in the health/boot paths. */
function dumpComposeDiagnostics(
  outDir: string,
  tag: string,
  extra?: Record<string, unknown>,
): void {
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
    `===== ${tag}: context =====`,
    extra ? JSON.stringify(extra, null, 2) : "(none)",
    `===== ${tag}: compose ps -a =====`,
    capture(`docker compose -f ${outDir}/docker-compose.yml ps -a`),
    `===== ${tag}: compose logs --tail=400 =====`,
    capture(`docker compose -f ${outDir}/docker-compose.yml logs --tail=400`),
    `===== end ${tag} diagnostics =====`,
  ];
  const body = sections.join("\n");
  console.error("\n" + body + "\n");
  try {
    fs.writeFileSync("/tmp/loom-e2e-diagnostics.log", body);
  } catch {
    /* ignore */
  }
}

async function fetchSpec(url: string): Promise<OpenApiSpec> {
  // Retry on transient socket errors.  The smoke test polls `/health` on
  // these origins early in this same process, so undici pools a keep-alive
  // connection per backend; by the time the parity check runs (after the
  // minutes-long DSL-e2e + Playwright subprocesses) an idle pooled socket
  // may have been closed server-side, and the first reuse throws
  // `UND_ERR_SOCKET: other side closed` before the request reaches the
  // backend.  `connection: close` keeps each attempt from re-pooling, and a
  // fresh attempt opens a new socket.  Real failures (non-2xx, malformed
  // JSON, a genuinely-down backend) still surface after the retries.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { connection: "close" } });
      if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
      return (await r.json()) as OpenApiSpec;
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
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
