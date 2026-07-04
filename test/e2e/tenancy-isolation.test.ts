import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Cross-tenant isolation — the runtime leak test for first-class multi-tenancy
// (docs/tenancy.md).  Generates the node backend from the corpus fixture
// `tenancy-owned.ddd` (`tenancy by user.tenantId of Organization` + a
// `with tenantOwned` aggregate), boots it against a throwaway docker postgres
// (migrations apply at boot), then round-trips with two different principals
// via the dev-stub's `x-loom-dev-claims` header:
//
//   POST /api/invoices            as tenant org-a  → 201 (tenantId stamped)
//   GET  /api/invoices/:id        as org-a         → 200 (own row visible)
//   GET  /api/invoices/:id        as org-b         → 404 (existence hidden)
//   GET  /api/invoices            as org-b         → 200, row ABSENT
//   POST body smuggling tenantId  as org-b         → tenantId ignored (internal)
//
// Phase 1b adds the registry (derived self-scope + claim-less bootstrap):
//
//   POST /api/organizations       claim-less/foreign → 201 (creates unfiltered)
//   GET  /api/organizations/:own  claim = own org id → 200 (tenantId ≡ Organization.id)
//   GET  /api/organizations/:other                   → 404 (existence hidden)
//   GET  /api/organizations       claim = own org id → exactly the own org
//
// This is the assertion the structural tiers can't make: the filter is pinned
// per backend by generator tests and the stamp by the 1a.0 pin tests, but only
// a boot proves the two agree end-to-end (the pre-1a.0 bug — stamp writes the
// actor id, filter reads the claim — made every created row invisible and NO
// structural test saw it).
//
// Slow (npm install + docker pg + boot), so opt-in: LOOM_TENANCY_E2E=1.
// LOOM_TENANCY_PG_URL=postgres://… skips the docker sidecar (docker-less dev).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E === "1";
const PG_URL_OVERRIDE = process.env.LOOM_TENANCY_PG_URL;

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

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

/** The dev-stub verifier merges this over the built-in stub user. */
function claims(tenantId: string): Record<string, string> {
  return {
    "x-loom-dev-claims": Buffer.from(JSON.stringify({ tenantId })).toString("base64"),
    "content-type": "application/json",
  };
}

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated node backend (LOOM_TENANCY_E2E=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-"));
      const pgContainer = `loom-tenancy-pg-${process.pid}`;
      let startedContainer = false;
      let child: ReturnType<typeof spawn> | undefined;
      try {
        // --- fixture: corpus tenancy-owned.ddd pinned to the node backend ---
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-owned.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-owned-node.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "node"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        // --- postgres: override URL or throwaway docker sidecar ---
        let pgUrl = PG_URL_OVERRIDE;
        if (!pgUrl) {
          if (!hasDocker()) {
            throw new Error(
              "LOOM_TENANCY_E2E=1 set but docker is unreachable and no " +
                "LOOM_TENANCY_PG_URL override was given.",
            );
          }
          const pgPort = await freePort();
          execSync(
            `docker run -d --rm --name ${pgContainer} ` +
              `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app ` +
              `-p ${pgPort}:5432 postgres:18-alpine`,
            { stdio: "pipe", timeout: 60_000 },
          );
          startedContainer = true;
          const pgDeadline = Date.now() + 60_000;
          while (Date.now() < pgDeadline) {
            try {
              execSync(`docker exec ${pgContainer} pg_isready -U postgres`, {
                stdio: "pipe",
                timeout: 5_000,
              });
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          pgUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/app`;
        }

        // --- boot (migrations apply at startup) ---
        execSync("npm install --silent --no-audit --no-fund", {
          cwd: appDir,
          stdio: "pipe",
          timeout: 180_000,
        });
        const port = await freePort();
        child = spawn("npx", ["tsx", "index.ts"], {
          cwd: appDir,
          env: { ...process.env, DATABASE_URL: pgUrl, PORT: String(port) },
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
        const deadline = Date.now() + 60_000;
        for (;;) {
          try {
            const r = await fetch(`${base}/ready`);
            if (r.status === 200) break;
          } catch {
            /* not up yet */
          }
          if (Date.now() > deadline)
            throw new Error(`backend never became ready; log:\n${bootLog.slice(0, 8192)}`);
          await new Promise((r) => setTimeout(r, 500));
        }

        // --- the leak test ---
        // org-a creates an invoice; the body carries no tenantId (internal —
        // the stamp copies it from the claim).
        const created = await fetch(`${base}/api/invoices`, {
          method: "POST",
          headers: claims("org-a"),
          body: JSON.stringify({ number: "INV-1", amountDue: 42 }),
        });
        expect(created.status, await created.clone().text()).toBe(201);
        const { id } = (await created.json()) as { id: string };
        expect(id).toBeTruthy();

        // org-a sees its own row (proves stamp and filter AGREE — the
        // pre-1a.0 bug failed exactly here).
        const ownRead = await fetch(`${base}/api/invoices/${id}`, { headers: claims("org-a") });
        expect(ownRead.status).toBe(200);
        const ownBody = (await ownRead.json()) as { number: string };
        expect(ownBody.number).toBe("INV-1");

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

        // A client-smuggled tenantId is ignored (internal field → not in the
        // create input; zod strips/rejects it rather than honouring it).
        const smuggle = await fetch(`${base}/api/invoices`, {
          method: "POST",
          headers: claims("org-b"),
          body: JSON.stringify({ number: "INV-2", amountDue: 1, tenantId: "org-a" }),
        });
        if (smuggle.status === 201) {
          const { id: id2 } = (await smuggle.json()) as { id: string };
          // Stamped with org-b (the claim), not the smuggled org-a value:
          const asA = await fetch(`${base}/api/invoices/${id2}`, { headers: claims("org-a") });
          expect(asA.status).toBe(404);
          const asB = await fetch(`${base}/api/invoices/${id2}`, { headers: claims("org-b") });
          expect(asB.status).toBe(200);
        } else {
          // Strict input schema rejecting the unknown key is also acceptable.
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
        // Signup bootstrap: the registry's create is NOT filter-gated, so an
        // authenticated principal whose token has NO usable tenant claim can
        // create an org.  The dev-stub's built-in identity (no dev-claims
        // header) carries `tenantId: "admin"` — a claim matching no org, i.e.
        // the claim-less/foreign-claim signup token.
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

        // Round-trip: the signup-created org's id IS a valid tenantId claim —
        // the `tenantId ≡ Organization.id` identity the derived self-scope
        // filter encodes.  Reading your own org succeeds…
        const ownOrg = await fetch(`${base}/api/organizations/${orgAId}`, {
          headers: claims(orgAId),
        });
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
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        if (startedContainer) {
          try {
            execSync(`docker rm -f ${pgContainer}`, { stdio: "pipe", timeout: 15_000 });
          } catch {
            /* best-effort */
          }
        }
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }, 360_000);
  },
);
