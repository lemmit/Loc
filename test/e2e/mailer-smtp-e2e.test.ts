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
// Mailer (smtp) runtime e2e — HONO/node.  The mocked-SMTP-server test the
// M-T4.6 plan asked for (docs/old/proposals/email-resource-kind.md §6 "TODO —
// runtime e2e with a mocked SMTP server").  Generates the Hono backend from
// `mailer-e2e.ddd`, boots it against a throwaway postgres (migrations apply)
// and a **Mailpit** sidecar (real SMTP endpoint + queryable REST inbox),
// drives `POST /api/workflows/notify`, then asserts the message actually
// landed — from / to / subject / body — via Mailpit's REST API.
//
// The delivery assertion (assertMailDelivered) is backend-agnostic and shared
// with the .NET / Java / Python / Elixir siblings; only the boot differs.
// This is the assertion the compile gates can't make: `corpus × tsc` proves
// the emitted nodemailer client type-checks, but only a boot proves
// `mail.send(...)` reaches an SMTP server and delivers the declared envelope.
//
// Slow (npm install + docker pg + Mailpit + boot), so opt-in via
// LOOM_EMAIL_E2E=1.  In CI the two sidecars come from `services:` containers
// via LOOM_MAIL_PG_URL / LOOM_MAILPIT_{SMTP,API}.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "mailer-e2e.ddd");

const ENABLED = process.env.LOOM_EMAIL_E2E === "1";
const HAVE_SIDECARS =
  !!process.env.LOOM_MAIL_PG_URL &&
  !!process.env.LOOM_MAILPIT_SMTP &&
  !!process.env.LOOM_MAILPIT_API;

describe.skipIf(!ENABLED)(
  "generated Hono backend delivers mail through an smtp mailer resource (LOOM_EMAIL_E2E=1)",
  () => {
    it("POST /api/workflows/notify → mail.send(...) lands in the Mailpit inbox", async () => {
      if (!HAVE_SIDECARS && !hasDocker()) {
        throw new Error(
          "mailer smtp e2e: docker unreachable and no LOOM_MAIL_PG_URL / LOOM_MAILPIT_* overrides given.",
        );
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mail-node-"));
      const pg = await startPostgres("node");
      const mailpit = await startMailpit("node");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const dddPath = path.join(outDir, "mailer-node.ddd");
        fs.writeFileSync(dddPath, fs.readFileSync(fixture, "utf8").replace("__PLATFORM__", "node"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const apiDir = path.join(outDir, "api");
        execSync("npm install --silent --no-audit --no-fund", {
          cwd: apiDir,
          stdio: "pipe",
          timeout: 300_000,
        });

        const port = await freePort();
        // detached: own process group so a single kill(-pid) reaches the
        // tsx-wrapped node child on teardown.
        child = spawn("npx", ["tsx", "index.ts"], {
          cwd: apiDir,
          env: {
            ...process.env,
            DATABASE_URL: `postgres://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`,
            MAIL_URL: mailpit.authUrl,
            PORT: String(port),
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
        await waitForHealth(base, () => bootLog);
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
    }, 420_000);
  },
);
