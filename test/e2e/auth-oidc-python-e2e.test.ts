import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// OIDC runtime e2e on the Python/FastAPI backend (D-AUTH-OIDC).  The Python
// sibling of auth-oidc-dotnet-e2e: boots a REAL Keycloak (the bundled dev realm
// import) + postgres in docker, runs the generated FastAPI app natively
// (`uv run uvicorn`), password-grants a real token for the seeded `demo` user,
// and asserts the generated OIDC verifier validates it (PyJWT against the
// issuer's JWKS) and projects the configured claims onto User — including the
// dotted `realm_access.roles` path.  Also smoke-checks the /auth/login
// handshake entry (302 to the IdP).  This is the runtime verification the
// ruff + mypy --strict build gate can't give.
//
// The app runs natively (host `uv run uvicorn`) rather than via the generated
// docker image so the suite doesn't depend on in-container pip egress —
// Keycloak / postgres are pulled images (no build).  Opt-in via
// LOOM_AUTH_E2E_PYTHON=1; needs docker + uv on PATH.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
// Reuse the python-build OIDC fixture (single source of truth with the
// ruff/mypy compile gate).
const fixture = path.join(here, "fixtures", "python-build", "auth-oidc.ddd");

const ENABLED = process.env.LOOM_AUTH_E2E_PYTHON === "1";

function hasDocker(): boolean {
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasUv(): boolean {
  try {
    execSync("uv --version", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const RUN = ENABLED && hasDocker() && hasUv();

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`${label} never ready within ${timeoutMs}ms: ${String(lastError)}`);
}

describe.skipIf(!RUN)(
  "auth OIDC e2e (Python): real Keycloak token flow (LOOM_AUTH_E2E_PYTHON=1)",
  () => {
    let outDir = "";
    let apiDir = "";
    let backend: ChildProcess | undefined;
    let backendLog = "";
    const pgName = `loom-auth-py-pg-${process.pid}`;
    const kcName = `loom-auth-py-kc-${process.pid}`;
    let apiBase = "";
    let kcBase = "";

    beforeAll(async () => {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-py-e2e-"));
      execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, { stdio: "inherit" });
      apiDir = path.join(outDir, "api");
      execSync("uv sync", { cwd: apiDir, stdio: "inherit", timeout: 300_000 });

      const pgPort = await freePort();
      const kcPort = await freePort();
      const apiPort = await freePort();
      apiBase = `http://127.0.0.1:${apiPort}`;
      kcBase = `http://localhost:${kcPort}`;

      // Postgres (the app migrates at boot) + Keycloak (the bundled dev realm
      // import).  KC_HOSTNAME pins the issuer/endpoints to the same
      // host-reachable URL the native backend validates against.
      execSync(
        `docker run -d --name ${pgName} -p ${pgPort}:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=api postgres:16-alpine`,
        { stdio: "inherit", timeout: 120_000 },
      );
      execSync(
        `docker run -d --name ${kcName} -p ${kcPort}:8080 ` +
          `-e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin ` +
          `-e KC_HOSTNAME=${kcBase} ` +
          `-v ${path.join(outDir, "keycloak")}:/opt/keycloak/data/import:ro ` +
          `quay.io/keycloak/keycloak:26.0 start-dev --import-realm`,
        { stdio: "inherit", timeout: 180_000 },
      );

      await pollUntil(
        async () => {
          try {
            execSync(`docker exec ${pgName} pg_isready -U postgres`, { stdio: "ignore" });
            return true;
          } catch {
            return false;
          }
        },
        60_000,
        "postgres",
      );
      await pollUntil(
        async () => (await fetch(`${kcBase}/realms/helpdesk/.well-known/openid-configuration`)).ok,
        180_000,
        "keycloak discovery",
      );

      backend = spawn(
        "uv",
        ["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
        {
          cwd: apiDir,
          env: {
            ...process.env,
            PORT: String(apiPort),
            DATABASE_URL: `postgresql+asyncpg://postgres:postgres@localhost:${pgPort}/api`,
            OIDC_ISSUER: `${kcBase}/realms/helpdesk`,
            OIDC_CLIENT_ID: "helpdesk-app",
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      backend.stdout?.on("data", (d: Buffer) => {
        backendLog += d.toString();
      });
      backend.stderr?.on("data", (d: Buffer) => {
        backendLog += d.toString();
      });
      await pollUntil(
        async () => {
          const r = await fetch(`${apiBase}/health`);
          return r.ok && ((await r.json()) as { status?: string }).status === "ok";
        },
        120_000,
        "backend /health",
      );
    }, 600_000);

    afterAll(() => {
      if (backend?.pid) {
        try {
          process.kill(-backend.pid, "SIGKILL");
        } catch {
          try {
            backend.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
      for (const name of [kcName, pgName]) {
        try {
          execSync(`docker rm -f ${name}`, { stdio: "ignore" });
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 60_000);

    async function passwordGrantToken(): Promise<string> {
      const body = new URLSearchParams({
        grant_type: "password",
        client_id: "helpdesk-app",
        username: "demo",
        password: "demo",
        scope: "openid",
      });
      const r = await fetch(`${kcBase}/realms/helpdesk/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!r.ok) throw new Error(`token grant failed: ${r.status} ${await r.text()}`);
      const json = (await r.json()) as { access_token?: string };
      if (!json.access_token) throw new Error("token grant returned no access_token");
      return json.access_token;
    }

    it("the generated Python OIDC verifier validates a real Keycloak token + maps claims", async () => {
      try {
        // Unauthenticated → 401 (middleware + verifier reject).
        expect((await fetch(`${apiBase}/api/tickets`)).status).toBe(401);

        const token = await passwordGrantToken();
        const bearer = { authorization: `Bearer ${token}` };

        // Authenticated with the real token → 200 (PyJWT validated it against
        // Keycloak's live JWKS).
        expect((await fetch(`${apiBase}/api/tickets`, { headers: bearer })).status).toBe(200);

        // /auth/me projects the verified claims: id ← sub, roles ←
        // realm_access.roles (a dotted path), email ← email.
        const me = await fetch(`${apiBase}/api/auth/me`, { headers: bearer });
        expect(me.status).toBe(200);
        const user = (await me.json()) as { id?: string; roles?: string[]; email?: string };
        expect(user.id).toBeTruthy();
        expect(user.roles).toContain("agent");
        expect(user.email).toBe("demo@example.com");

        // A forged token is rejected (signature fails against the JWKS).
        expect(
          (
            await fetch(`${apiBase}/api/auth/me`, {
              headers: { authorization: "Bearer not.a.token" },
            })
          ).status,
        ).toBe(401);

        // The /auth/login handshake entry starts the authorization-code flow:
        // a 302 to the IdP's authorize endpoint with an oidc_state cookie.
        const login = await fetch(`${apiBase}/api/auth/login`, { redirect: "manual" });
        expect(login.status).toBe(307);
        expect(login.headers.get("location") ?? "").toContain("/protocol/openid-connect/auth");
        expect(login.headers.get("set-cookie") ?? "").toContain("oidc_state");
      } catch (err) {
        console.error(`\n===== backend log =====\n${backendLog}\n=======================\n`);
        throw err;
      }
    }, 60_000);
  },
);
