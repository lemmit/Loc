import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// OIDC runtime e2e on the Java backend (D-AUTH-OIDC).  The Java sibling of
// auth-oidc-dotnet-e2e.test.ts: boots a REAL Keycloak (the bundled dev realm
// import from Phase 3) + postgres in docker, builds + runs the generated
// Spring Boot backend natively (`gradle bootJar` → `java -jar`), gets a real
// token for the seeded `demo` user via the password grant, and asserts the
// generated OidcUserVerifier validates it (JWKS signature + iss/exp) and
// projects the configured claims onto User — including the dotted
// `realm_access.roles` path.  This is the runtime verification the compile-only
// Java build gate (`gradle testClasses bootJar`) can't give.
//
// The backend runs natively (host `java`) rather than via the generated docker
// image so the suite doesn't depend on in-container Gradle/Maven egress — same
// pattern as observability-events-java.  Keycloak / postgres are pulled images
// (no build).  Opt-in via LOOM_AUTH_E2E_JAVA=1; needs docker + a JDK 21 + Gradle.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "auth-oidc-e2e-java.ddd");

const ENABLED = process.env.LOOM_AUTH_E2E_JAVA === "1";

function hasDocker(): boolean {
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasGradle(): boolean {
  try {
    execSync("gradle --version", { stdio: "pipe", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const RUN = ENABLED && hasDocker() && hasGradle();

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
  "auth OIDC e2e (Java): real Keycloak token flow (LOOM_AUTH_E2E_JAVA=1)",
  () => {
    let outDir = "";
    let apiDir = "";
    let backend: ChildProcess | undefined;
    let backendLog = "";
    const pgName = `loom-auth-jv-pg-${process.pid}`;
    const kcName = `loom-auth-jv-kc-${process.pid}`;
    let apiBase = "";
    let kcBase = "";

    beforeAll(async () => {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-jv-e2e-"));
      execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, { stdio: "inherit" });
      apiDir = path.join(outDir, "api");
      // Build the bootJar up front (cold Gradle ~2-3min) so the boot below is
      // just `java -jar`.
      execSync("gradle --no-daemon -q bootJar", {
        cwd: apiDir,
        stdio: "inherit",
        timeout: 600_000,
      });

      const pgPort = await freePort();
      const kcPort = await freePort();
      const apiPort = await freePort();
      apiBase = `http://127.0.0.1:${apiPort}`;
      kcBase = `http://localhost:${kcPort}`;

      // Postgres (the Java backend migrates at boot via Flyway) + Keycloak (the
      // bundled dev realm import).  KC_HOSTNAME pins the issuer/endpoints to the
      // same host-reachable URL the native backend validates against.
      execSync(
        `docker run -d --name ${pgName} -p ${pgPort}:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=api postgres:18-alpine`,
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

      const jar = fs
        .readdirSync(path.join(apiDir, "build", "libs"))
        .find((f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"));
      if (!jar) throw new Error("no jar produced by gradle bootJar");
      // Boot with the toolchain JDK (Java 25 → class-file v69); a stale PATH
      // `java` on the runner throws UnsupportedClassVersionError. JAVA_HOME is
      // the setup-java JDK; fall back to PATH `java` locally.
      const javaBin = process.env.JAVA_HOME
        ? path.join(process.env.JAVA_HOME, "bin", "java")
        : "java";
      backend = spawn(javaBin, ["-jar", path.join("build", "libs", jar)], {
        cwd: apiDir,
        env: {
          ...process.env,
          SERVER_PORT: String(apiPort),
          SPRING_DATASOURCE_URL: `jdbc:postgresql://127.0.0.1:${pgPort}/api`,
          SPRING_DATASOURCE_USERNAME: "postgres",
          SPRING_DATASOURCE_PASSWORD: "postgres",
          OIDC_ISSUER: `${kcBase}/realms/helpdesk`,
          OIDC_CLIENT_ID: "helpdesk-app",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
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
    }, 900_000);

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

    it("the generated Java OIDC verifier validates a real Keycloak token + maps claims", async () => {
      try {
        // Unauthenticated → 401 (filter + verifier reject).
        expect((await fetch(`${apiBase}/api/tickets`)).status).toBe(401);

        const token = await passwordGrantToken();
        const bearer = { authorization: `Bearer ${token}` };

        // Authenticated with the real token → 200 (verifier validated it
        // against Keycloak's live JWKS).
        expect((await fetch(`${apiBase}/api/tickets`, { headers: bearer })).status).toBe(200);

        // /auth/me projects the verified claims onto User: id ← sub, the roles
        // array ← realm_access.roles (a dotted path), email ← email.
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
      } catch (err) {
        console.error(`\n===== backend log =====\n${backendLog}\n=======================\n`);
        throw err;
      }
    }, 60_000);
  },
);
