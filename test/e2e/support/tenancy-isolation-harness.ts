// Shared harness for the cross-tenant isolation e2e across backends.
//
// The HTTP assertion sequence is backend-agnostic: every Loom backend emits
// the same REST surface and (since the dev-stub `x-loom-dev-claims` parity
// fix) honours an injected base64-JSON claim header, so a single sequence can
// prove isolation on node / dotnet / python / java / elixir.  Only the boot
// mechanics differ per backend (own test file), so those stay per-backend; the
// postgres sidecar + the assertions live here.

import { execFileSync, execSync } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Hierarchy / `policy {}` read-ladder isolation (multi-tenancy Phase 2, P2.4/5).
//
// Where `assertCrossTenantIsolation` proves the FLAT tenant floor, this proves
// the TREE-scoped reads over the same REST surface, from the `tenancy-hierarchy`
// corpus fixture: a registry `Org implements tenantRegistry` (materialized-path
// `dataKey`) and three `tenantOwned` aggregates carrying
// `policy { allow deep on Account · allow global on Entry · allow local on Memo }`.
//
// The org tree is seeded deterministically (plain create → id, then the `setPath`
// op → managed `dataKey`), so the harness controls the exact path strings; each
// aggregate row is then created AS a principal of its org, letting the backend
// stamp `dataKey` from `currentUser.orgPath` (a registry `data_key` read).  Rows
// are identified by their `label` (`dataKey`/`tenantId` are not on the read
// wire), seeded to the owning org's path key.
//
// Backend-agnostic — the only per-backend variable is how the server booted.
// `pg` is threaded through solely for the NULL-`dataKey` fallback probe, which
// nulls one column via host `psql` (a state a principal-stamped write can never
// produce, since `orgPath` always resolves — the flat floor or the claim).
// ---------------------------------------------------------------------------

/** `postgres://…` URL for host `psql`, from the harness's `Postgres` parts. */
function psqlUrl(pg: Postgres): string {
  return `postgres://${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${pg.db}`;
}

/** Run one SQL statement via host `psql` (no shell — `execFileSync`); returns
 *  trimmed stdout.  Used only for the NULL-`dataKey` legacy-row probe. */
export function runSql(pg: Postgres, sql: string): string {
  try {
    return execFileSync("psql", [psqlUrl(pg), "-tAqc", sql], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    })
      .toString()
      .trim();
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    throw new Error(
      `psql failed (is postgresql-client on PATH?): ${err.stderr?.toString() ?? err.message ?? e}`,
    );
  }
}

export async function assertHierarchyIsolation(base: string, pg: Postgres): Promise<void> {
  // --- seed the registry tree: plain create (→ id) then setPath (managed path).
  async function createOrg(name: string, parent?: string): Promise<string> {
    const r = await fetch(`${base}/api/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // claim-less signup
      body: JSON.stringify(parent ? { name, parent } : { name }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(id).toBeTruthy();
    return id;
  }
  async function setPath(orgId: string, path: string): Promise<void> {
    const r = await fetch(`${base}/api/orgs/${orgId}/set_path`, {
      method: "POST",
      headers: claims(orgId), // self-scope: the op reads its own org row
      body: JSON.stringify({ p: path }),
    });
    expect(r.status, await r.clone().text()).toBe(204);
  }

  // org_a → org_a.b → org_a.b.c (a spine), plus the delimiter-trap sibling root
  // `org_ab` (NOT a child of org_a) and an unrelated root `org_z`.
  const orgA = await createOrg("A");
  await setPath(orgA, "org_a");
  const orgAB = await createOrg("A.B", orgA);
  await setPath(orgAB, "org_a.b");
  const orgABC = await createOrg("A.B.C", orgAB);
  await setPath(orgABC, "org_a.b.c");
  const orgAb = await createOrg("Ab"); // delimiter trap: "org_ab" vs "org_a"
  await setPath(orgAb, "org_ab");
  const orgZ = await createOrg("Z");
  await setPath(orgZ, "org_z");

  const tree = [
    { id: orgA, key: "org_a" },
    { id: orgAB, key: "org_a.b" },
    { id: orgABC, key: "org_a.b.c" },
    { id: orgAb, key: "org_ab" },
    { id: orgZ, key: "org_z" },
  ];

  // --- seed one row per org in each aggregate, AS that org (backend stamps
  //     dataKey from currentUser.orgPath).  Row label = the owning org key.
  async function createRow(
    plural: string,
    orgId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const r = await fetch(`${base}/api/${plural}`, {
      method: "POST",
      headers: claims(orgId),
      body: JSON.stringify(body),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  }
  const acctId: Record<string, string> = {};
  for (const o of tree) {
    acctId[o.key] = await createRow("accounts", o.id, { label: o.key, amount: 1 });
    await createRow("entries", o.id, { label: o.key });
    await createRow("memos", o.id, { label: o.key });
  }

  // Visible labels for a caller (sorted), and a by-id status probe.
  async function labels(plural: string, orgId: string): Promise<string[]> {
    const r = await fetch(`${base}/api/${plural}`, { headers: claims(orgId) });
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as Array<{ label: string }>).map((x) => x.label).sort();
  }
  async function getStatus(plural: string, orgId: string, rowId: string): Promise<number> {
    return (await fetch(`${base}/api/${plural}/${rowId}`, { headers: claims(orgId) })).status;
  }

  // === DEEP (Account): descendant-or-self on the materialized path. ===
  // Caller at org_a.b sees itself + its descendant, NOT its ancestor org_a, NOT
  // the delimiter-trap sibling org_ab, NOT the unrelated org_z.
  expect(await labels("accounts", orgAB)).toEqual(["org_a.b", "org_a.b.c"]);
  // Caller at the root org_a sees its WHOLE subtree — and the delimiter trap is
  // excluded (`org_ab` must not prefix-match `org_a`).
  expect(await labels("accounts", orgA)).toEqual(["org_a", "org_a.b", "org_a.b.c"]);
  // Neither root leaks into the other; org_z is an island.
  expect(await labels("accounts", orgAb)).toEqual(["org_ab"]);
  expect(await labels("accounts", orgZ)).toEqual(["org_z"]);
  // By-id: an in-subtree row is 200, an out-of-subtree row is 404 (hidden).
  expect(await getStatus("accounts", orgAB, acctId["org_a.b.c"])).toBe(200); // descendant
  expect(await getStatus("accounts", orgAB, acctId.org_a)).toBe(404); // ancestor
  expect(await getStatus("accounts", orgAB, acctId.org_ab)).toBe(404); // delimiter trap
  expect(await getStatus("accounts", orgAB, acctId.org_z)).toBe(404); // unrelated

  // === LOCAL (Memo, the default): only own-org rows (flat tenant floor). ===
  expect(await labels("memos", orgAB)).toEqual(["org_a.b"]);
  expect(await labels("memos", orgA)).toEqual(["org_a"]);
  expect(await labels("memos", orgABC)).toEqual(["org_a.b.c"]);

  // === GLOBAL (Entry): the caller's ROOT-org subtree (root-org widening). ===
  // The grandchild org_a.b.c widens to the whole org_a subtree…
  expect(await labels("entries", orgABC)).toEqual(["org_a", "org_a.b", "org_a.b.c"]);
  // …still never the delimiter-trap sibling or the unrelated root.
  expect(await labels("entries", orgAb)).toEqual(["org_ab"]);
  expect(await labels("entries", orgZ)).toEqual(["org_z"]);

  // === NULL-dataKey fallback: a legacy row degrades to the LOCAL floor. ===
  // A row a principal-stamped write can never make (orgPath always resolves), so
  // it's forced via SQL: create a normal Account as org_a.b, then null its
  // data_key.  It must stay visible to its own tenant and NEVER widen past it.
  const legacyId = await createRow("accounts", orgAB, { label: "legacy", amount: 1 });
  const acctTable = runSql(
    pg,
    "SELECT format('%I.%I', table_schema, table_name) FROM information_schema.columns WHERE lower(column_name) = 'amount' LIMIT 1",
  );
  expect(acctTable, "could not locate the accounts table via information_schema").toBeTruthy();
  runSql(pg, `UPDATE ${acctTable} SET data_key = NULL WHERE id = '${legacyId}'`);
  expect(runSql(pg, `SELECT data_key IS NULL FROM ${acctTable} WHERE id = '${legacyId}'`)).toBe(
    "t",
  );

  // Own tenant (org_a.b) still sees it — via the NULL-branch tenantId floor.
  expect(await labels("accounts", orgAB)).toContain("legacy");
  expect(await getStatus("accounts", orgAB, legacyId)).toBe(200);
  // The ANCESTOR org_a — whose deep subtree contains org_a.b — does NOT see it:
  // the NULL row has no path, so it never widens past its own tenant floor.
  expect(await labels("accounts", orgA)).not.toContain("legacy");
  expect(await getStatus("accounts", orgA, legacyId)).toBe(404);
  // Nor does a DESCENDANT (org_a.b.c) — different tenant → outside the floor.
  expect(await labels("accounts", orgABC)).not.toContain("legacy");
  expect(await getStatus("accounts", orgABC, legacyId)).toBe(404);
}
