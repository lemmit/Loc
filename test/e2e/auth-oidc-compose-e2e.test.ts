import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// FULL-COMPOSE OIDC runtime e2e (D-AUTH-OIDC).  Where the native suites
// (auth-oidc-e2e / auth-oidc-dotnet-e2e) run the generated backend on the
// HOST against a dockerized Keycloak, this one boots the generated
// `docker-compose.yml` *as-is* — the turnkey `docker compose up` a user
// gets — so the generated compose wiring itself is under test: the
// containerized backend's `build: ./api`, the `host.docker.internal`
// extra_hosts / KC_HOSTNAME bridge, depends_on health gating, and the OIDC
// env block.  The test then gets a real token for the seeded `demo` user
// and asserts the backend (inside its container) validates it against
// Keycloak (reached over host.docker.internal) and maps the claims.
//
// This is the integration the native suites can't reach: there the backend
// talks to Keycloak over plain localhost; here it's the cross-container
// host-gateway path the emitted compose actually ships.
//
// Opt-in via LOOM_AUTH_E2E_COMPOSE=1; needs docker + the compose plugin and
// the ability to BUILD the backend image (in-container package egress) — so
// this is effectively a CI-only gate (the dev sandbox blocks container
// registry egress; the inner build would hang on `npm install`).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "auth-oidc-e2e.ddd");

const ENABLED = process.env.LOOM_AUTH_E2E_COMPOSE === "1";

function hasComposeDocker(): boolean {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN = ENABLED && hasComposeDocker();

// The generated compose pins host ports (the turnkey defaults): the Hono
// backend on 3000, Keycloak on 8081 with issuer host.docker.internal:8081.
const API_BASE = "http://localhost:3000";
const KC_BASE = "http://localhost:8081";

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
  "auth OIDC e2e (full compose): turnkey stack (LOOM_AUTH_E2E_COMPOSE=1)",
  () => {
    let outDir = "";

    function composeLogs(): string {
      try {
        return execSync("docker compose logs --no-color --tail=200", {
          cwd: outDir,
          encoding: "utf8",
        });
      } catch {
        return "(could not capture compose logs)";
      }
    }

    beforeAll(async () => {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-compose-e2e-"));
      execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, { stdio: "inherit" });

      // Boot the WHOLE generated stack — db + keycloak + the containerized
      // backend (built from ./api).  `--build` forces a fresh image so the
      // emitted Dockerfile is exercised; `--wait` blocks on the compose
      // healthchecks (db pg_isready + api /ready), so a return here means the
      // backend is already up and the host.docker.internal bridge resolved.
      execSync("docker compose up -d --build --wait", {
        cwd: outDir,
        stdio: "inherit",
        timeout: 540_000,
      });

      // The compose `--wait` gates db + api health, but Keycloak has no
      // healthcheck (started, not healthy) — wait on its discovery doc here.
      await pollUntil(
        async () => (await fetch(`${KC_BASE}/realms/helpdesk/.well-known/openid-configuration`)).ok,
        180_000,
        "keycloak discovery",
      );
      await pollUntil(
        async () => {
          const r = await fetch(`${API_BASE}/health`);
          return r.ok && ((await r.json()) as { status?: string }).status === "ok";
        },
        60_000,
        "backend /health",
      );
    }, 800_000);

    afterAll(() => {
      if (outDir) {
        try {
          execSync("docker compose down -v", { cwd: outDir, stdio: "ignore", timeout: 120_000 });
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 180_000);

    async function passwordGrantToken(): Promise<string> {
      const body = new URLSearchParams({
        grant_type: "password",
        client_id: "helpdesk-app",
        username: "demo",
        password: "demo",
        scope: "openid",
      });
      const r = await fetch(`${KC_BASE}/realms/helpdesk/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!r.ok) throw new Error(`token grant failed: ${r.status} ${await r.text()}`);
      const json = (await r.json()) as { access_token?: string };
      if (!json.access_token) throw new Error("token grant returned no access_token");
      return json.access_token;
    }

    it("the compose-booted backend validates a real Keycloak token over host.docker.internal", async () => {
      try {
        // Unauthenticated → 401 (middleware + verifier reject).
        expect((await fetch(`${API_BASE}/tickets`)).status).toBe(401);

        const token = await passwordGrantToken();
        const bearer = { authorization: `Bearer ${token}` };

        // Authenticated → 200.  The backend (in its container) validated the
        // token against Keycloak's JWKS reached over host.docker.internal —
        // the cross-container bridge the generated compose wires.
        expect((await fetch(`${API_BASE}/tickets`, { headers: bearer })).status).toBe(200);

        // /auth/me projects the verified claims: id ← sub, roles ←
        // realm_access.roles (dotted), email ← email.
        const me = await fetch(`${API_BASE}/auth/me`, { headers: bearer });
        expect(me.status).toBe(200);
        const user = (await me.json()) as { id?: string; roles?: string[]; email?: string };
        expect(user.id).toBeTruthy();
        expect(user.roles).toContain("agent");
        expect(user.email).toBe("demo@example.com");

        // A forged token is rejected (signature fails against the JWKS).
        expect(
          (await fetch(`${API_BASE}/auth/me`, { headers: { authorization: "Bearer not.a.token" } }))
            .status,
        ).toBe(401);
      } catch (err) {
        console.error(`\n===== compose logs =====\n${composeLogs()}\n========================\n`);
        throw err;
      }
    }, 60_000);
  },
);
