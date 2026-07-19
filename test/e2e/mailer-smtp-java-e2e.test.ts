import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  assertMailDelivered,
  freePort,
  hasDocker,
  startMailpit,
  startPostgres,
  waitForHealth,
} from "./support/mailpit-harness.js";

// ---------------------------------------------------------------------------
// Mailer (smtp) runtime e2e — JAVA/Spring Boot (sibling of mailer-smtp-e2e.ts).
// Same fixture + same shared delivery assertion (assertMailDelivered); only
// the boot differs (gradle bootJar + java -jar).  Proves the Jakarta Mail
// mailer client reaches an SMTP server and delivers at RUNTIME, not just that
// it compiles under `corpus × java`.
//
// Opt-in: LOOM_EMAIL_E2E_JAVA=1.  Needs Gradle 9.1+ / JDK 25 on PATH + docker
// (or the LOOM_MAIL_PG_URL / LOOM_MAILPIT_{SMTP,API} `services:` overrides).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "mailer-e2e.ddd");

const ENABLED = process.env.LOOM_EMAIL_E2E_JAVA === "1";
const HAVE_SIDECARS =
  !!process.env.LOOM_MAIL_PG_URL &&
  !!process.env.LOOM_MAILPIT_SMTP &&
  !!process.env.LOOM_MAILPIT_API;

function hasGradle(): boolean {
  try {
    execSync("gradle --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "generated Java backend delivers mail through an smtp mailer resource (LOOM_EMAIL_E2E_JAVA=1)",
  () => {
    it("POST /api/workflows/notify → SmtpResources.mailSend(...) lands in the Mailpit inbox", async () => {
      if (!hasGradle()) throw new Error("LOOM_EMAIL_E2E_JAVA=1 set but `gradle` is not on PATH.");
      if (!HAVE_SIDECARS && !hasDocker()) {
        throw new Error(
          "mailer java e2e: docker unreachable and no LOOM_MAIL_PG_URL / LOOM_MAILPIT_* overrides given.",
        );
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mail-java-"));
      const pg = await startPostgres("java");
      const mailpit = await startMailpit("java");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const dddPath = path.join(outDir, "mailer-java.ddd");
        fs.writeFileSync(dddPath, fs.readFileSync(fixture, "utf8").replace("__PLATFORM__", "java"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const apiDir = path.join(outDir, "api");
        execSync("gradle --no-daemon -q bootJar", {
          cwd: apiDir,
          stdio: "pipe",
          timeout: 600_000,
        });
        const jar = fs
          .readdirSync(path.join(apiDir, "build", "libs"))
          .find((f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"));
        if (!jar) throw new Error("bootJar produced no runnable jar");

        const port = await freePort();
        // Boot with the toolchain JDK (Java 25 → class-file v69); a stale PATH
        // `java` throws UnsupportedClassVersionError. JAVA_HOME is the
        // setup-java JDK; fall back to PATH `java` locally.
        const javaBin = process.env.JAVA_HOME
          ? path.join(process.env.JAVA_HOME, "bin", "java")
          : "java";
        child = spawn(javaBin, ["-jar", path.join("build", "libs", jar)], {
          cwd: apiDir,
          env: {
            ...process.env,
            SPRING_DATASOURCE_URL: `jdbc:postgresql://${pg.host}:${pg.port}/${pg.db}`,
            SPRING_DATASOURCE_USERNAME: pg.user,
            SPRING_DATASOURCE_PASSWORD: pg.password,
            MAIL_URL: mailpit.authUrl,
            SERVER_PORT: String(port),
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        let bootLog = "";
        child.stdout?.on("data", (c: Buffer) => {
          bootLog += c.toString("utf8");
        });
        child.stderr?.on("data", (c: Buffer) => {
          bootLog += c.toString("utf8");
        });

        const base = `http://127.0.0.1:${port}`;
        await waitForHealth(base, () => bootLog, 180_000);
        await assertMailDelivered(base, mailpit.api, `e2e body ${port}`);
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        mailpit.stop();
        pg.stop();
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }, 600_000);
  },
);
