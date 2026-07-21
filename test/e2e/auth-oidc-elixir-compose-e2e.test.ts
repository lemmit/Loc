import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// FULL-COMPOSE OIDC runtime e2e on the Phoenix backend (D-AUTH-OIDC).  The
// Phoenix sibling of auth-oidc-compose-e2e (Hono): boots the generated
// `docker-compose.yml` *as-is* — the containerized Phoenix release (which
// runs migrations then serves) + the bundled dev Keycloak + postgres — gets a
// real token for the seeded `demo` user via the password grant, and asserts
// the generated Auth OIDC verifier (joken + joken_jwks against the issuer's
// JWKS, reached over host.docker.internal) validates it and maps the claims
// onto the user {} shape.  This is the RUNTIME proof the compile/Dialyzer gates
// can't give — e.g. the joken_jwks strategy's JWKS fetch, the signature verify,
// and the iss/aud/exp checks actually working against a real IdP (the Phoenix
// analogue of the bug the .NET runtime e2e caught).
//
// Uses the full compose (not a native `mix phx.server`) so the generated
// release Dockerfile owns all prod boot/config/migration wiring — no blind
// mix orchestration here.  It can't run in the dev sandbox (the inner image
// build needs hex egress), so it's a CI-only gate.  Opt-in via
// LOOM_AUTH_E2E_PHOENIX=1; needs docker + the compose plugin.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
// Reuse the elixir-vanilla-build OIDC fixture (single source of truth — it's the
// same system the vanilla compile gate exercises).
const fixture = path.join(here, "fixtures", "elixir-vanilla-build", "vanilla-auth-oidc.ddd");

const ENABLED = process.env.LOOM_AUTH_E2E_PHOENIX === "1";

function hasComposeDocker(): boolean {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN = ENABLED && hasComposeDocker();

// The generated compose pins host ports (the turnkey defaults): the Phoenix
// backend on 4000, Keycloak on 8081 with issuer host.docker.internal:8081.
// The whole stack serves domain + auth under /api (`/api/tickets`,
// `/api/auth/me`); only the infra probes (`/health`, `/ready`) sit at the root.
const API_BASE = "http://localhost:4000";
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
  "auth OIDC e2e (Phoenix compose): turnkey stack (LOOM_AUTH_E2E_PHOENIX=1)",
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
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-ph-e2e-"));
      execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, { stdio: "inherit" });

      // Boot the WHOLE generated stack — db + keycloak + the containerized
      // Phoenix release (built from ./phoenix_app; its bin/server runs
      // PhoenixApp.Release.migrate() then starts).  `--build` exercises the
      // emitted Dockerfile; `--wait` blocks on the compose healthchecks (db
      // pg_isready + phoenix /health).  The Phoenix image build (mix deps.get +
      // compiling Ash) is heavy — generous timeout.
      execSync("docker compose up -d --build --wait", {
        cwd: outDir,
        stdio: "inherit",
        timeout: 900_000,
      });

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
        120_000,
        "backend /health",
      );
    }, 1_200_000);

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

    it("the compose-booted Phoenix verifier validates a real Keycloak token over host.docker.internal", async () => {
      try {
        // Unauthenticated → 401 (the Auth plug on the :api pipeline rejects).
        expect((await fetch(`${API_BASE}/api/tickets`)).status).toBe(401);

        const token = await passwordGrantToken();
        const bearer = { authorization: `Bearer ${token}` };

        // Authenticated → 200.  ApiWeb.Auth (in its container) validated the
        // token against Keycloak's JWKS reached over host.docker.internal.
        expect((await fetch(`${API_BASE}/api/tickets`, { headers: bearer })).status).toBe(200);

        // /auth/me projects the verified claims: id ← sub, roles ←
        // realm_access.roles (dotted), email ← email.
        const me = await fetch(`${API_BASE}/api/auth/me`, { headers: bearer });
        expect(me.status).toBe(200);
        const user = (await me.json()) as { id?: string; roles?: string[]; email?: string };
        expect(user.id).toBeTruthy();
        expect(user.roles).toContain("agent");
        expect(user.email).toBe("demo@example.com");

        // A forged token is rejected (signature fails against the JWKS).
        expect(
          (
            await fetch(`${API_BASE}/api/auth/me`, {
              headers: { authorization: "Bearer not.a.token" },
            })
          ).status,
        ).toBe(401);

        // The /auth/login handshake entry starts the authorization-code flow:
        // a 302 to the IdP's authorize endpoint (discovered from the issuer)
        // with an oidc_state cookie.  We don't follow it (the host can't
        // resolve host.docker.internal), but the redirect target + cookie
        // prove the generated handshake runs.  (The full code→token callback
        // needs a browser session — out of scope for this headless smoke.)
        const login = await fetch(`${API_BASE}/api/auth/login`, { redirect: "manual" });
        expect(login.status).toBe(302);
        expect(login.headers.get("location") ?? "").toContain("/protocol/openid-connect/auth");
        expect(login.headers.get("set-cookie") ?? "").toContain("oidc_state");
      } catch (err) {
        console.error(`\n===== compose logs =====\n${composeLogs()}\n========================\n`);
        throw err;
      }
    }, 60_000);
  },
);
