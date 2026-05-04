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

      // Both deployables should respond ok within 60s.  Hono boots in
      // sub-second; .NET ASP.NET Core takes a few seconds.
      await pollHealthy("http://localhost:3000/health", 60_000);
      await pollHealthy("http://localhost:8080/health", 60_000);
    },
    900_000,
  );
});

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
