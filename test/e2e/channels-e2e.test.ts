// M-T4.4 slice 2 — cross-deployable broker delivery, end to end.
//
// Boots the GENERATED two-deployable system (producer salesApi + consumer
// shipApi, each with its OWN database) against real docker sidecars
// (postgres + valkey), fires the choreography over HTTP, and asserts the
// event crossed processes: an `Order.place()` emit on salesApi publishes a
// CloudEvents envelope to the broker; shipApi's consumer loop receives it,
// spawns the correlated `Fulfil` instance, and persists the Shipment — in a
// database the producer never touches.  This is the runtime agreement the
// per-PR generator pins (channels-transport.test.ts) can't prove.
//
// Opt-in: LOOM_CHANNELS_E2E=1 (npm run test:channels).  Needs docker (the
// suite provisions throwaway postgres + valkey containers on random free
// ports) and network access for the generated projects' npm install.
// LOOM_CHANNELS_PG_URL / LOOM_CHANNELS_REDIS_URL skip the sidecars and
// point at existing services (CI or a local stack).

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_CHANNELS_E2E === "1";

const FIXTURE = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced }
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
      }
      repository Shipments for Shipment {}
      workflow Fulfil {
        orderId: Order id
        create(p: OrderPlaced) by p.order {
          let s = Shipment.create({ orderRef: p.order, status: "Pending" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: redis }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const SALES_PORT = 3181;
const SHIP_PORT = 3182;
const PG_PORT = 55433;
const REDIS_PORT = 56390;

const sh = (cmd: string, cwd?: string): string =>
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 420_000 }).toString();

async function waitFor(probe: () => Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ready = (port: number) => async (): Promise<boolean> =>
  (await fetch(`http://localhost:${port}/ready`)).ok;

describe.skipIf(!ENABLED)("cross-deployable broker delivery (channels-e2e)", () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];
  let pgUrl: (db: string) => string;
  let redisUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-channels-e2e-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    // Sidecars: env-provided services, else throwaway docker containers.
    const pgOverride = process.env.LOOM_CHANNELS_PG_URL;
    const redisOverride = process.env.LOOM_CHANNELS_REDIS_URL;
    if (pgOverride) {
      pgUrl = (db) => `${pgOverride.replace(/\/[^/]*$/, "")}/${db}`;
    } else {
      sh(
        `docker run -d --rm --name loom-channels-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-channels-pg");
      pgUrl = (db) => `postgres://postgres:postgres@localhost:${PG_PORT}/${db}`;
      // The postgres entrypoint restarts the server after initdb, so a bare
      // pg_isready can pass in the init window — make the CREATE DATABASE
      // itself the retried probe.
      await waitFor(
        async () => {
          sh(
            `docker exec loom-channels-pg psql -U postgres -c "CREATE DATABASE sales_api;" -c "CREATE DATABASE ship_api;"`,
          );
          return true;
        },
        60_000,
        "postgres accepting CREATE DATABASE",
      );
    }
    if (redisOverride) {
      redisUrl = redisOverride;
    } else {
      sh(
        `docker run -d --rm --name loom-channels-valkey -p ${REDIS_PORT}:6379 valkey/valkey:8-alpine`,
      );
      dockerNames.push("loom-channels-valkey");
      redisUrl = `redis://localhost:${REDIS_PORT}`;
    }

    for (const app of ["sales_api", "ship_api"] as const) {
      sh("npm install --silent", join(dir, "out", app));
    }
    const boot = (app: string, port: number, db: string): void => {
      // The project-local tsx binary, NOT `npx tsx`: the npx wrapper spawns
      // the server as a grandchild that outlives a kill of the wrapper — the
      // orphan then squats the port and poisons the next run.  `detached`
      // puts the server in its own process group so teardown can kill the
      // whole tree.
      const child = spawn(join(dir, "out", app, "node_modules/.bin/tsx"), ["index.ts"], {
        cwd: join(dir, "out", app),
        detached: true,
        env: {
          ...process.env,
          DATABASE_URL: pgUrl(db),
          LOOM_CHANNEL_LIFECYCLE_BUS_URL: redisUrl,
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Persist app output — the only debugging seam when a boot or request
      // fails inside the harness (assertions attach the log tail).
      const log = join(dir, `${app}.log`);
      const sink = (d: Buffer): void => appendFileSync(log, d);
      child.stdout?.on("data", sink);
      child.stderr?.on("data", sink);
      apps.push(child);
    };
    boot("sales_api", SALES_PORT, "sales_api");
    boot("ship_api", SHIP_PORT, "ship_api");
    await waitFor(ready(SALES_PORT), 60_000, "salesApi /ready");
    await waitFor(ready(SHIP_PORT), 60_000, "shipApi /ready");
  }, 600_000);

  const killGroup = (app: ChildProcess, signal: NodeJS.Signals): void => {
    if (app.pid === undefined) return;
    try {
      process.kill(-app.pid, signal); // negative pid = the detached group
    } catch {
      app.kill(signal);
    }
  };

  afterAll(async () => {
    for (const app of apps) killGroup(app, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1_000));
    for (const app of apps) killGroup(app, "SIGKILL");
    for (const name of dockerNames) {
      try {
        sh(`docker rm -f ${name}`);
      } catch {
        /* already gone */
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("delivers an event across deployables and databases via the broker", async () => {
    // Producer: create a Draft order, then place() it — the operation's emit
    // drains through the repository save into the publish tee.
    const createRes = await fetch(`http://localhost:${SALES_PORT}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "c1", status: "Draft" }),
    });
    if (createRes.status !== 201) {
      const tail = readFileSync(join(dir, "sales_api.log"), "utf8")
        .split("\n")
        .slice(-12)
        .join("\n");
      throw new Error(
        `create -> ${createRes.status}: ${await createRes.text()}\n--- sales_api log tail ---\n${tail}`,
      );
    }
    const { id } = (await createRes.json()) as { id: string };
    const placeRes = await fetch(`http://localhost:${SALES_PORT}/api/orders/${id}/place`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(placeRes.ok).toBe(true);

    // Consumer: the event-triggered create spawns the correlated Fulfil
    // instance and persists the Shipment — poll until the envelope lands.
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/shipments`);
        if (!res.ok) return false;
        const body = (await res.json()) as { items: { orderRef: string; status: string }[] };
        return body.items.some((s) => s.orderRef === id && s.status === "Pending");
      },
      20_000,
      "shipment created on shipApi",
    );
    // The correlated instance row lands in the same consumer drain but after
    // the shipment insert — poll it too rather than racing a single fetch.
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/workflows/fulfil/instances`);
        if (!res.ok) return false;
        const instances = (await res.json()) as { orderId: string }[];
        return instances.some((i) => i.orderId === id);
      },
      10_000,
      "correlated Fulfil instance on shipApi",
    );
  }, 120_000);
});
