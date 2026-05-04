import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const example = path.join(repoRoot, "examples", "acme.ddd");

const ENABLED = process.env.LOOM_E2E === "1";

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

  it(
    "builds every deployable, brings up the system, and serves /health",
    async () => {
      execSync(`docker compose -f ${outDir}/docker-compose.yml build`, {
        stdio: "inherit",
        timeout: 600_000,
      });
      execSync(`docker compose -f ${outDir}/docker-compose.yml up -d`, {
        stdio: "inherit",
        timeout: 120_000,
      });

      // Hono boots in sub-second; .NET ASP.NET Core takes a few
      // seconds (cold restore + EnsureCreated).  When two .NET
      // services share one postgres they race for connections, so
      // we give each a generous window.
      await pollHealthy("http://localhost:3000/health", 60_000);
      await pollHealthy("http://localhost:8080/health", 120_000);
      await pollHealthy("http://localhost:8081/health", 120_000);
    },
    900_000,
  );

  it(
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

  it(
    "cross-check: .NET (Swashbuckle) and Hono (zod-openapi) emit the same set of (method, path) for the same modules",
    async () => {
      // Both deployables host the Catalog module — Swashbuckle on
      // .NET (8081) and @hono/zod-openapi on Hono (3000).  If the
      // generators drift, the (method, path) sets will diverge.
      const dotnetSpec = await fetchSpec(
        "http://localhost:8081/swagger/v1/swagger.json",
      );
      const honoSpec = await fetchSpec("http://localhost:3000/openapi.json");

      const dotnetOps = collectOps(dotnetSpec);
      const honoOps = collectOps(honoSpec);

      const onlyDotnet = [...dotnetOps].filter((o) => !honoOps.has(o)).sort();
      const onlyHono = [...honoOps].filter((o) => !dotnetOps.has(o)).sort();

      if (onlyDotnet.length > 0 || onlyHono.length > 0) {
        console.error("Cross-check diff:");
        console.error("  only on .NET :", onlyDotnet);
        console.error("  only on Hono :", onlyHono);
      }
      expect(onlyDotnet, "operations only on .NET").toEqual([]);
      expect(onlyHono, "operations only on Hono").toEqual([]);
      // Sanity: each spec should have at least one operation.
      expect(dotnetOps.size).toBeGreaterThan(0);
      expect(honoOps.size).toBeGreaterThan(0);
    },
    120_000,
  );
});

interface OpenApiPathItem {
  [method: string]: unknown;
}

interface OpenApiSpec {
  paths?: Record<string, OpenApiPathItem>;
}

async function fetchSpec(url: string): Promise<OpenApiSpec> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as OpenApiSpec;
}

/** Build a `Set<"METHOD path">` from an OpenAPI spec's `paths`. */
function collectOps(spec: OpenApiSpec): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    // Infrastructure endpoints aren't part of the public contract;
    // skip them so the diff focuses on aggregate routes.
    if (p === "/health" || p === "/openapi.json" || p.startsWith("/swagger")) {
      continue;
    }
    for (const m of Object.keys(item)) {
      const method = m.toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
        out.add(`${method} ${normalisePath(p)}`);
      }
    }
  }
  return out;
}

/** Normalise OpenAPI path templates so `{id}` and `:id` collapse into a
 * single representation across the two emitters. */
function normalisePath(p: string): string {
  return p.replace(/\{[^}]+\}/g, "{id}").replace(/\/+$/, "") || "/";
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
 * proxy CA installed inside the build context.  We do this by
 * inserting a few lines into each generated Dockerfile *only* if
 * `LOOM_E2E_CA_DIR` points at a directory containing `*.crt` files.
 *
 * In any other environment this function is a no-op and the
 * generated Dockerfile is built unchanged.
 */
function injectProxyCAsIfPresent(outDir: string): void {
  const caDir = process.env.LOOM_E2E_CA_DIR;
  if (!caDir || !fs.existsSync(caDir)) return;
  const crts = fs
    .readdirSync(caDir)
    .filter((f) => f.endsWith(".crt"));
  if (crts.length === 0) return;

  const subdirs = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const sub of subdirs) {
    const dockerfile = path.join(outDir, sub, "Dockerfile");
    if (!fs.existsSync(dockerfile)) continue;
    for (const crt of crts) {
      fs.copyFileSync(path.join(caDir, crt), path.join(outDir, sub, crt));
    }
    let content = fs.readFileSync(dockerfile, "utf8");
    if (content.includes("dotnet/sdk")) {
      content = content.replace(
        /(FROM mcr\.microsoft\.com\/dotnet\/sdk[^\n]+\nWORKDIR \/src\n)/,
        `$1COPY *.crt /usr/local/share/ca-certificates/\nRUN update-ca-certificates 2>&1 | tail -1\n`,
      );
    } else if (content.includes("node:22-alpine")) {
      content = content.replace(
        /(FROM node:22-alpine[^\n]+\nWORKDIR \/app\n)/,
        `$1COPY *.crt /usr/local/share/ca-certificates/\nRUN cat /usr/local/share/ca-certificates/*.crt >> /etc/ssl/cert.pem\nENV NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem\nENV NPM_CONFIG_CAFILE=/etc/ssl/cert.pem\n`,
      );
    }
    fs.writeFileSync(dockerfile, content);
  }
}
