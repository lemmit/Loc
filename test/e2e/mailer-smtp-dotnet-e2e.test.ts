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
// Mailer (smtp) runtime e2e — .NET/ASP.NET (sibling of mailer-smtp-e2e.ts).
// Same fixture + same shared delivery assertion (assertMailDelivered); only
// the boot differs (dotnet restore + dotnet run).  Proves the MailKit mailer
// client reaches an SMTP server and delivers at RUNTIME, not just that it
// compiles under `corpus × dotnet`.
//
// Opt-in: LOOM_EMAIL_E2E_DOTNET=1.  Needs the .NET SDK on PATH + docker (or
// the LOOM_MAIL_PG_URL / LOOM_MAILPIT_{SMTP,API} `services:` overrides in CI).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "mailer-e2e.ddd");

const ENABLED = process.env.LOOM_EMAIL_E2E_DOTNET === "1";
const HAVE_SIDECARS =
  !!process.env.LOOM_MAIL_PG_URL &&
  !!process.env.LOOM_MAILPIT_SMTP &&
  !!process.env.LOOM_MAILPIT_API;

function hasDotnet(): boolean {
  try {
    execSync("dotnet --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "generated .NET backend delivers mail through an smtp mailer resource (LOOM_EMAIL_E2E_DOTNET=1)",
  () => {
    it("POST /api/workflows/notify → SmtpResources.Mail_Send(...) lands in the Mailpit inbox", async () => {
      if (!hasDotnet()) throw new Error("LOOM_EMAIL_E2E_DOTNET=1 set but `dotnet` is not on PATH.");
      if (!HAVE_SIDECARS && !hasDocker()) {
        throw new Error(
          "mailer dotnet e2e: docker unreachable and no LOOM_MAIL_PG_URL / LOOM_MAILPIT_* overrides given.",
        );
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mail-dotnet-"));
      const pg = await startPostgres("dotnet");
      const mailpit = await startMailpit("dotnet");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const dddPath = path.join(outDir, "mailer-dotnet.ddd");
        fs.writeFileSync(
          dddPath,
          fs.readFileSync(fixture, "utf8").replace("__PLATFORM__", "dotnet"),
        );
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const apiDir = path.join(outDir, "api");
        execSync("dotnet restore", { cwd: apiDir, stdio: "pipe", timeout: 300_000 });

        const port = await freePort();
        child = spawn("dotnet", ["run", "--no-restore", "--no-launch-profile"], {
          cwd: apiDir,
          env: {
            ...process.env,
            ConnectionStrings__Default: `Host=${pg.host};Port=${pg.port};Database=${pg.db};Username=${pg.user};Password=${pg.password}`,
            MAIL_URL: `smtp://${mailpit.smtp}`,
            ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
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
    }, 480_000);
  },
);
