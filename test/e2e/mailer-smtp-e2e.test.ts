import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  freePort,
  hasDocker,
  messageText,
  startSidecars,
  waitForMessages,
} from "./support/mailpit-harness.js";

// ---------------------------------------------------------------------------
// Mailer (smtp) runtime e2e — the mocked-SMTP-server test the M-T4.6 plan
// asked for (docs/old/proposals/email-resource-kind.md §6 "TODO — runtime
// e2e with a mocked SMTP server").  Generates the Hono backend from
// `mailer-e2e.ddd`, boots it against a throwaway postgres (migrations apply)
// and a **Mailpit** sidecar (real SMTP endpoint + queryable REST inbox),
// drives `POST /api/workflows/notify`, then asserts the message actually
// landed — recipient, subject, and body — by polling Mailpit's REST API.
//
// This is the assertion the compile gates can't make: `corpus-tsc-build`
// proves the emitted nodemailer client type-checks, but only a boot proves
// `mail.send(...)` reaches an SMTP server and delivers the declared envelope.
//
// Slow (npm install + docker pg + Mailpit + boot), so opt-in via
// LOOM_EMAIL_E2E=1.  Sibling to the tenancy / obs e2e legs; same rationale
// (runtime regression net, not a per-PR gate).  In CI the two sidecars come
// from `services:` containers via LOOM_MAIL_PG_URL / LOOM_MAILPIT_{SMTP,API}.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "mailer-e2e.ddd");

const ENABLED = process.env.LOOM_EMAIL_E2E === "1";
// Sidecars need docker unless CI supplies them as `services:` overrides.
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
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mail-"));
      const sidecars = await startSidecars("smtp");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, {
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
            DATABASE_URL: sidecars.databaseUrl,
            MAIL_URL: sidecars.mailUrl,
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
        // Wait for the backend to serve /health (migrations applied, listening).
        const deadline = Date.now() + 90_000;
        for (;;) {
          try {
            if ((await fetch(`${base}/health`)).status === 200) break;
          } catch {
            /* not up yet */
          }
          if (Date.now() > deadline) {
            throw new Error(`backend never became healthy; log:\n${bootLog.slice(0, 8192)}`);
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        const note = `e2e body ${port}`;
        const res = await fetch(`${base}/api/workflows/notify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note }),
        });
        expect(res.status, await res.clone().text()).toBe(204);

        const messages = await waitForMessages(sidecars.mailpitApi, 1);
        expect(messages.length).toBeGreaterThanOrEqual(1);
        const msg = messages[0]!;
        // The declared envelope: from the mailer config `from:`, to/subject
        // from the `mail.send(...)` call site, body from the workflow param.
        expect(msg.From.Address).toBe("no-reply@test.local");
        expect(msg.To.map((t) => t.Address)).toContain("inbox@test.local");
        expect(msg.Subject).toBe("Hello from Loom");
        const text = await messageText(sidecars.mailpitApi, msg.ID);
        expect(text).toContain(note);
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        sidecars.stop();
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }, 420_000);
  },
);
