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
// Mailer (smtp) runtime e2e — ELIXIR/Phoenix (vanilla Ecto).  Sibling of
// mailer-smtp-e2e.ts; same fixture + same shared delivery assertion
// (assertMailDelivered).  Only the boot differs (mix deps.get + ecto + phx.server).
// Proves the Swoosh mailer client reaches an SMTP server and delivers at
// RUNTIME, not just that it compiles under `elixir-vanilla-build`.
//
// Opt-in: LOOM_EMAIL_E2E_ELIXIR=1.  Needs elixir/mix on PATH (setup-beam) +
// docker (or the LOOM_MAIL_PG_URL / LOOM_MAILPIT_{SMTP,API} `services:` overrides).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "mailer-e2e.ddd");

const ENABLED = process.env.LOOM_EMAIL_E2E_ELIXIR === "1";
const HAVE_SIDECARS =
  !!process.env.LOOM_MAIL_PG_URL &&
  !!process.env.LOOM_MAILPIT_SMTP &&
  !!process.env.LOOM_MAILPIT_API;

function hasElixir(): boolean {
  try {
    execSync("mix --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "generated Phoenix backend delivers mail through an smtp mailer resource (LOOM_EMAIL_E2E_ELIXIR=1)",
  () => {
    it("POST /api/workflows/notify → Resources.Smtp.mail_send(...) lands in the Mailpit inbox", async () => {
      if (!hasElixir())
        throw new Error(
          "LOOM_EMAIL_E2E_ELIXIR=1 set but `mix` is not on PATH. " +
            "Add `erlef/setup-beam@v1` (otp-version 27.x, elixir-version 1.18.x) to the workflow.",
        );
      if (!HAVE_SIDECARS && !hasDocker()) {
        throw new Error(
          "mailer elixir e2e: docker unreachable and no LOOM_MAIL_PG_URL / LOOM_MAILPIT_* overrides given.",
        );
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mail-elixir-"));
      const pg = await startPostgres("elixir");
      const mailpit = await startMailpit("elixir");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const dddPath = path.join(outDir, "mailer-elixir.ddd");
        fs.writeFileSync(
          dddPath,
          fs.readFileSync(fixture, "utf8").replace("__PLATFORM__", "elixir"),
        );
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const apiDir = path.join(outDir, "api");

        execSync("mix local.hex --force && mix local.rebar --force && mix deps.get", {
          cwd: apiDir,
          stdio: "pipe",
          timeout: 600_000,
          shell: "/bin/bash",
        });

        const dbUrl = `ecto://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;
        execSync("mix ecto.create && mix ecto.migrate", {
          cwd: apiDir,
          stdio: "pipe",
          env: { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" },
          timeout: 300_000,
          shell: "/bin/bash",
        });

        const port = await freePort();
        child = spawn("mix", ["phx.server"], {
          cwd: apiDir,
          env: {
            ...process.env,
            DATABASE_URL: dbUrl,
            MAIL_URL: `smtp://${mailpit.smtp}`,
            PHX_SERVER: "true",
            PORT: String(port),
            MIX_ENV: "dev",
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
