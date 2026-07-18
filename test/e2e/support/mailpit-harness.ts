// Runtime-e2e harness for the mailer (smtp) resource kind — M-T4.6.
//
// The generated Hono backend sends mail through nodemailer at a `MAIL_URL`
// SMTP endpoint (src/generator/typescript resource-clients smtp adapter).
// This harness stands up the two sidecars a boot needs — a throwaway
// postgres (migrations apply at boot) and a **Mailpit** catch-all SMTP
// server that ALSO exposes a queryable REST inbox — so the test can drive a
// `mail.send(...)` workflow and assert the message actually arrived, with no
// provider mocking.  Mailpit is the mocked-SMTP server the plan's e2e TODO
// asked for (docs/old/proposals/email-resource-kind.md §6).
//
// Both sidecars honour a CI-service override so `services:` containers can be
// used instead of a docker-in-the-runner sidecar:
//   LOOM_MAIL_PG_URL   = postgres://user:pass@host:port/db
//   LOOM_MAILPIT_SMTP  = host:port   (SMTP endpoint the backend sends to)
//   LOOM_MAILPIT_API   = http://host:port   (REST inbox base)

import { execSync } from "node:child_process";
import * as net from "node:net";

/** True when a docker daemon is reachable (sidecars need it, unless overridden). */
export function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Pick a port the OS just confirmed is free (small race window; opt-in suite). */
export async function freePort(): Promise<number> {
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

export interface Sidecar {
  /** `postgres://…` URL the backend's DATABASE_URL is set to. */
  databaseUrl: string;
  /** `smtp://host:port` URL the backend's MAIL_URL is set to. */
  mailUrl: string;
  /** REST inbox base (`http://host:port`) the assertions poll. */
  mailpitApi: string;
  stop: () => void;
}

/** Spin (or reuse) a throwaway postgres.  Returns a `postgres://` URL. */
async function startPostgres(label: string): Promise<{ url: string; stop: () => void }> {
  const override = process.env.LOOM_MAIL_PG_URL;
  if (override) return { url: override, stop: () => {} };
  const name = `loom-mail-pg-${label}-${process.pid}`;
  const port = await freePort();
  execSync(
    `docker run -d --rm --name ${name} ` +
      `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app ` +
      `-p ${port}:5432 postgres:18-alpine`,
    { stdio: "pipe", timeout: 60_000 },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      execSync(`docker exec ${name} pg_isready -U postgres`, { stdio: "pipe", timeout: 5_000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/app`,
    stop: () => {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Spin (or reuse) a Mailpit sidecar (SMTP endpoint + REST inbox). */
async function startMailpit(
  label: string,
): Promise<{ smtp: string; api: string; stop: () => void }> {
  const smtpOverride = process.env.LOOM_MAILPIT_SMTP;
  const apiOverride = process.env.LOOM_MAILPIT_API;
  if (smtpOverride && apiOverride) {
    return { smtp: smtpOverride, api: apiOverride.replace(/\/$/, ""), stop: () => {} };
  }
  const name = `loom-mailpit-${label}-${process.pid}`;
  const smtpPort = await freePort();
  const apiPort = await freePort();
  execSync(
    `docker run -d --rm --name ${name} ` +
      `-e MP_SMTP_AUTH_ACCEPT_ANY=1 -e MP_SMTP_AUTH_ALLOW_INSECURE=1 ` +
      `-p ${smtpPort}:1025 -p ${apiPort}:8025 axllent/mailpit:latest`,
    { stdio: "pipe", timeout: 60_000 },
  );
  const api = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${api}/api/v1/messages`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    smtp: `127.0.0.1:${smtpPort}`,
    api,
    stop: () => {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Stand up both sidecars for one backend boot. */
export async function startSidecars(label: string): Promise<Sidecar> {
  const pg = await startPostgres(label);
  const mail = await startMailpit(label);
  return {
    databaseUrl: pg.url,
    mailUrl: `smtp://${mail.smtp}`,
    mailpitApi: mail.api,
    stop: () => {
      mail.stop();
      pg.stop();
    },
  };
}

export interface MailpitMessage {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
  Snippet: string;
}

/** Poll Mailpit's REST inbox until at least `min` messages land, or throw. */
export async function waitForMessages(
  api: string,
  min = 1,
  ms = 20_000,
): Promise<MailpitMessage[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${api}/api/v1/messages`);
      if (r.ok) {
        const body = (await r.json()) as { messages: MailpitMessage[] };
        if (body.messages.length >= min) return body.messages;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`Mailpit inbox never reached ${min} message(s) within ${ms}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Fetch one message's full text body (the list endpoint only carries a snippet). */
export async function messageText(api: string, id: string): Promise<string> {
  const r = await fetch(`${api}/api/v1/message/${id}`);
  if (!r.ok) throw new Error(`Mailpit message ${id} fetch failed: ${r.status}`);
  const body = (await r.json()) as { Text?: string };
  return body.Text ?? "";
}
