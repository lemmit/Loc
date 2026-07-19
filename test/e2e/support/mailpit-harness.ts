// Runtime-e2e harness for the mailer (smtp) resource kind — M-T4.6.
//
// Every backend sends mail through a `MAIL_URL` SMTP endpoint (the smtp
// ResourceAdapter on each of the five backends) and mounts the notify
// workflow at `POST /api/workflows/notify`.  This harness stands up the two
// sidecars a boot needs — a throwaway postgres (migrations apply at boot) and
// a **Mailpit** catch-all SMTP server that ALSO exposes a queryable REST
// inbox — and carries the single backend-agnostic assertion (drive the
// workflow, then poll the inbox for the delivered envelope).  Only how the
// server gets booted differs per backend (the sibling test files); the
// delivery proof is identical.  Mailpit is the mocked-SMTP server the plan's
// e2e TODO asked for (docs/old/proposals/email-resource-kind.md §6).
//
// Both sidecars honour a CI-service override so `services:` containers can be
// used instead of a docker-in-the-runner sidecar:
//   LOOM_MAIL_PG_URL   = postgres://user:pass@host:port/db
//   LOOM_MAILPIT_SMTP  = host:port          (SMTP endpoint the backend sends to)
//   LOOM_MAILPIT_API   = http://host:port   (REST inbox base)

import { execSync } from "node:child_process";
import * as net from "node:net";
import { expect } from "vitest";

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

/** Postgres connection parts — each backend assembles its own URL flavour
 *  (drizzle `postgres://` / asyncpg / jdbc / EF conn-string / ecto). */
export interface PgParts {
  host: string;
  port: number;
  user: string;
  password: string;
  db: string;
  stop: () => void;
}

/**
 * Spin (or reuse) a throwaway postgres.  Honours `LOOM_MAIL_PG_URL` (a
 * `postgres://user:pass@host:port/db` URL — the CI `services:` container) and
 * otherwise spins a docker sidecar.  Returns the parts, not a URL, so each
 * backend can assemble its own flavour.
 */
export async function startPostgres(label: string): Promise<PgParts> {
  const override = process.env.LOOM_MAIL_PG_URL;
  if (override) {
    const u = new URL(override);
    return {
      host: u.hostname,
      port: Number(u.port || "5432"),
      user: decodeURIComponent(u.username || "postgres"),
      password: decodeURIComponent(u.password || "postgres"),
      db: u.pathname.replace(/^\//, "") || "app",
      stop: () => {},
    };
  }
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
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "postgres",
    db: "app",
    stop: () => {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    },
  };
}

// Mailpit is started with SMTP AUTH REQUIRED (MP_SMTP_AUTH) — not accept-any —
// so a backend that ignores the credentials in MAIL_URL fails to deliver and
// its e2e cell goes red.  That is the point: this proves each backend actually
// authenticates.  ALLOW_INSECURE lets the auth happen over the plain (no-TLS)
// dev connection.
export const MAILPIT_USER = "loom";
export const MAILPIT_PASS = "s3cr3t";

export interface Mailpit {
  /** `host:port` SMTP endpoint (no credentials). */
  smtp: string;
  /** `smtp://user:pass@host:port` — the authenticated URL for MAIL_URL. */
  authUrl: string;
  /** REST inbox base (`http://host:port`). */
  api: string;
  stop: () => void;
}

/** Spin (or reuse) a Mailpit sidecar (auth-required SMTP endpoint + REST inbox). */
export async function startMailpit(label: string): Promise<Mailpit> {
  const smtpOverride = process.env.LOOM_MAILPIT_SMTP;
  const apiOverride = process.env.LOOM_MAILPIT_API;
  if (smtpOverride && apiOverride) {
    return {
      smtp: smtpOverride,
      authUrl: `smtp://${MAILPIT_USER}:${MAILPIT_PASS}@${smtpOverride}`,
      api: apiOverride.replace(/\/$/, ""),
      stop: () => {},
    };
  }
  const name = `loom-mailpit-${label}-${process.pid}`;
  const smtpPort = await freePort();
  const apiPort = await freePort();
  execSync(
    `docker run -d --rm --name ${name} ` +
      `-e MP_SMTP_AUTH=${MAILPIT_USER}:${MAILPIT_PASS} -e MP_SMTP_AUTH_ALLOW_INSECURE=1 ` +
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
    authUrl: `smtp://${MAILPIT_USER}:${MAILPIT_PASS}@127.0.0.1:${smtpPort}`,
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

/** Fetch one message's full text body (the list endpoint carries only a snippet). */
export async function messageText(api: string, id: string): Promise<string> {
  const r = await fetch(`${api}/api/v1/message/${id}`);
  if (!r.ok) throw new Error(`Mailpit message ${id} fetch failed: ${r.status}`);
  const body = (await r.json()) as { Text?: string };
  return body.Text ?? "";
}

/** Poll `${base}/health` until 200 or the deadline; throws with the boot log. */
export async function waitForHealth(
  base: string,
  bootLog: () => string,
  ms = 90_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`backend never became healthy; log:\n${bootLog().slice(0, 8192)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The backend-agnostic delivery assertion: drive `POST /api/workflows/notify`
 * with the given note, then prove the mail landed in the Mailpit inbox with
 * the envelope the fixture declares — `from` from the mailer config, `to` +
 * `subject` from the `mail.send(...)` call site, body from the workflow param.
 * Identical for every backend; only the boot (the caller) differs.
 */
export async function assertMailDelivered(
  base: string,
  mailpitApi: string,
  note: string,
): Promise<void> {
  const res = await fetch(`${base}/api/workflows/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note }),
  });
  expect(res.ok, `notify workflow returned ${res.status}: ${await res.clone().text()}`).toBe(true);

  const messages = await waitForMessages(mailpitApi, 1);
  expect(messages.length).toBeGreaterThanOrEqual(1);
  const msg = messages[0]!;
  expect(msg.From.Address).toBe("no-reply@test.local");
  expect(msg.To.map((t) => t.Address)).toContain("inbox@test.local");
  expect(msg.Subject).toBe("Hello from Loom");
  const text = await messageText(mailpitApi, msg.ID);
  expect(text).toContain(note);
}
