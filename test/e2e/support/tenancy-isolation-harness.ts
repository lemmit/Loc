// Shared harness for the cross-tenant isolation e2e across backends.
//
// The HTTP assertion sequence is backend-agnostic: every Loom backend emits
// the same REST surface and (since the dev-stub `x-loom-dev-claims` parity
// fix) honours an injected base64-JSON claim header, so a single sequence can
// prove isolation on node / dotnet / python / java / elixir.  Only the boot
// mechanics differ per backend (own test file), so those stay per-backend; the
// postgres sidecar + the assertions live here.

import { execSync } from "node:child_process";
import * as net from "node:net";
import { expect } from "vitest";

/** The dev-stub verifier merges this base64-JSON over the built-in stub user. */
export function claims(tenantId: string): Record<string, string> {
  return {
    "x-loom-dev-claims": Buffer.from(JSON.stringify({ tenantId })).toString("base64"),
    "content-type": "application/json",
  };
}

export function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

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

export interface Postgres {
  host: string;
  port: number;
  user: string;
  password: string;
  db: string;
  stop: () => void;
}

/**
 * A throwaway postgres for one backend boot.  Honours `LOOM_TENANCY_PG_URL`
 * (a `postgres://user:pass@host:port/db` URL — the CI `services:` container)
 * and otherwise spins a docker sidecar.  Returns the parts so each backend can
 * assemble its own URL flavour (asyncpg / jdbc / ecto / ADO).
 */
export async function startPostgres(label: string): Promise<Postgres> {
  const override = process.env.LOOM_TENANCY_PG_URL;
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
  if (!hasDocker()) {
    throw new Error(
      "tenancy isolation e2e: docker unreachable and no LOOM_TENANCY_PG_URL override given.",
    );
  }
  const name = `loom-tenancy-pg-${label}-${process.pid}`;
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

/** Poll `${base}/ready` until 200 or the deadline; throws with the boot log. */
export async function waitForReady(
  base: string,
  bootLog: () => string,
  ms = 90_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${base}/ready`);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`backend never became ready; log:\n${bootLog().slice(0, 8192)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The cross-tenant isolation + registry-bootstrap assertion sequence, driven
 * over a booted backend's REST API.  Identical for every backend — the only
 * per-backend variable is how the server got booted.
 */
export async function assertCrossTenantIsolation(base: string): Promise<void> {
  // org-a creates an invoice; the body carries no tenantId (internal — the
  // stamp copies it from the claim).
  const created = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: claims("org-a"),
    body: JSON.stringify({ number: "INV-1", amountDue: 42 }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect(id).toBeTruthy();

  // org-a sees its own row (proves stamp and filter AGREE — the pre-1a.0 bug
  // failed exactly here: the stamp wrote the actor id, the filter read the
  // claim, so a created row was invisible to its own creator).
  const ownRead = await fetch(`${base}/api/invoices/${id}`, { headers: claims("org-a") });
  expect(ownRead.status).toBe(200);
  expect(((await ownRead.json()) as { number: string }).number).toBe("INV-1");

  // org-b gets 404 on the same id — existence hidden, not 403.
  const crossRead = await fetch(`${base}/api/invoices/${id}`, { headers: claims("org-b") });
  expect(crossRead.status).toBe(404);

  // org-b's list does not contain the row; org-a's does.
  const listB = (await (
    await fetch(`${base}/api/invoices`, { headers: claims("org-b") })
  ).json()) as Array<{ id: string }>;
  expect(listB.map((r) => r.id)).not.toContain(id);
  const listA = (await (
    await fetch(`${base}/api/invoices`, { headers: claims("org-a") })
  ).json()) as Array<{ id: string }>;
  expect(listA.map((r) => r.id)).toContain(id);

  // A client-smuggled tenantId is ignored (internal field → not in the create
  // input; the schema strips/rejects it rather than honouring it).
  const smuggle = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: claims("org-b"),
    body: JSON.stringify({ number: "INV-2", amountDue: 1, tenantId: "org-a" }),
  });
  if (smuggle.status === 201) {
    const { id: id2 } = (await smuggle.json()) as { id: string };
    // Stamped with org-b (the claim), not the smuggled org-a value.
    const asA = await fetch(`${base}/api/invoices/${id2}`, { headers: claims("org-a") });
    expect(asA.status).toBe(404);
    const asB = await fetch(`${base}/api/invoices/${id2}`, { headers: claims("org-b") });
    expect(asB.status).toBe(200);
  } else {
    expect([400, 422]).toContain(smuggle.status);
  }

  // crossTenant reference data is visible to every tenant.
  const planCreate = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: claims("org-a"),
    body: JSON.stringify({ code: "basic", monthlyPrice: 10 }),
  });
  expect(planCreate.status, await planCreate.clone().text()).toBe(201);
  const { id: planId } = (await planCreate.json()) as { id: string };
  const planAsB = await fetch(`${base}/api/plans/${planId}`, { headers: claims("org-b") });
  expect(planAsB.status).toBe(200);

  // --- registry self-scope + claim-less bootstrap (Phase 1b) ---
  // The registry's create is NOT filter-gated, so a principal whose token has
  // no usable tenant claim can create an org (the built-in stub identity's
  // claim matches no org — the claim-less/foreign-claim signup token).
  const orgACreate = await fetch(`${base}/api/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json" }, // no dev-claims at all
    body: JSON.stringify({ name: "Acme A" }),
  });
  expect(orgACreate.status, await orgACreate.clone().text()).toBe(201);
  const { id: orgAId } = (await orgACreate.json()) as { id: string };
  expect(orgAId).toBeTruthy();
  // A FOREIGN tenant claim can't block a signup either.
  const orgBCreate = await fetch(`${base}/api/organizations`, {
    method: "POST",
    headers: claims(orgAId),
    body: JSON.stringify({ name: "Acme B" }),
  });
  expect(orgBCreate.status, await orgBCreate.clone().text()).toBe(201);
  const { id: orgBId } = (await orgBCreate.json()) as { id: string };

  // Round-trip: the signup-created org's id IS a valid tenantId claim — the
  // `tenantId ≡ Organization.id` identity the derived self-scope filter
  // encodes.  Reading your own org succeeds…
  const ownOrg = await fetch(`${base}/api/organizations/${orgAId}`, { headers: claims(orgAId) });
  expect(ownOrg.status, await ownOrg.clone().text()).toBe(200);
  expect(((await ownOrg.json()) as { name: string }).name).toBe("Acme A");

  // …reading ANOTHER org 404s (existence hidden, not 403)…
  const foreignOrg = await fetch(`${base}/api/organizations/${orgBId}`, {
    headers: claims(orgAId),
  });
  expect(foreignOrg.status).toBe(404);

  // …and the list is scoped to exactly your own org.
  const orgList = (await (
    await fetch(`${base}/api/organizations`, { headers: claims(orgAId) })
  ).json()) as Array<{ id: string }>;
  expect(orgList.map((o) => o.id)).toEqual([orgAId]);
}
