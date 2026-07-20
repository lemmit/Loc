// M-T4.4 slice 6c — CROSS-BACKEND broker delivery, end to end (Phoenix leg).
//
// The Elixir sibling of channels-e2e-java.test.ts: the GENERATED Hono
// producer (salesApi) publishes a CloudEvents envelope to a docker valkey
// sidecar; the GENERATED Phoenix consumer (shipApi) receives it via
// Redix.PubSub, spawns the correlated `Fulfil` instance, and persists the
// Shipment in its OWN database.
//
// Opt-in: LOOM_CHANNELS_E2E_ELIXIR=1 (npm run test:channels-elixir).  Needs
// docker, npm network access, and `mix` (Elixir 1.16+) on PATH — the
// observability-events-elixir-vanilla host-boot pattern.
// LOOM_CHANNELS_PG_URL / LOOM_CHANNELS_REDIS_URL point at existing services.

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_CHANNELS_E2E_ELIXIR === "1";

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
  deployable shipApi  { platform: elixir contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const SALES_PORT = 3202;
const SHIP_PORT = 3203;
const PG_PORT = 55439;
const REDIS_PORT = 56395;

const sh = (cmd: string, cwd?: string, env?: Record<string, string>): string =>
  execSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  }).toString();

async function waitFor(probe: () => Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ready =
  (port: number, path = "/ready") =>
  async (): Promise<boolean> =>
    (await fetch(`http://localhost:${port}${path}`)).ok;

describe.skipIf(!ENABLED)("cross-backend broker delivery (channels-e2e, elixir consumer)", () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];
  let pgUrl: (db: string) => string;
  let redisUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-channels-e2e-ex-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    const pgOverride = process.env.LOOM_CHANNELS_PG_URL;
    const redisOverride = process.env.LOOM_CHANNELS_REDIS_URL;
    if (pgOverride) {
      pgUrl = (db) => `${pgOverride.replace(/\/[^/]*$/, "")}/${db}`;
    } else {
      sh(
        `docker run -d --rm --name loom-channels-ex-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-channels-ex-pg");
      pgUrl = (db) => `postgres://postgres:postgres@localhost:${PG_PORT}/${db}`;
      // The postgres entrypoint restarts after initdb — make CREATE DATABASE
      // itself the retried probe (see channels-e2e.test.ts).
      await waitFor(
        async () => {
          sh(
            `docker exec loom-channels-ex-pg psql -U postgres -c "CREATE DATABASE sales_api;" -c "CREATE DATABASE ship_api;"`,
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
        `docker run -d --rm --name loom-channels-ex-valkey -p ${REDIS_PORT}:6379 valkey/valkey:8-alpine`,
      );
      dockerNames.push("loom-channels-ex-valkey");
      redisUrl = `redis://localhost:${REDIS_PORT}`;
    }

    sh("npm install --silent", join(dir, "out", "sales_api"));
    const shipDir = join(dir, "out", "ship_api");
    const shipEnv = {
      DATABASE_URL: pgUrl("ship_api"),
      LOOM_CHANNEL_LIFECYCLE_BUS_URL: redisUrl,
      MIX_ENV: "dev",
      PORT: String(SHIP_PORT),
    };
    sh("mix deps.get", shipDir, shipEnv);
    sh("mix ecto.migrate", shipDir, shipEnv);

    const boot = (
      app: string,
      cmd: string,
      cmdArgs: string[],
      env: Record<string, string>,
    ): void => {
      // Detached process group so teardown can kill the whole tree.
      const child = spawn(cmd, cmdArgs, {
        cwd: join(dir, "out", app),
        detached: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const log = join(dir, `${app}.log`);
      const sink = (d: Buffer): void => appendFileSync(log, d);
      child.stdout?.on("data", sink);
      child.stderr?.on("data", sink);
      apps.push(child);
    };
    boot("sales_api", join(dir, "out", "sales_api", "node_modules/.bin/tsx"), ["index.ts"], {
      DATABASE_URL: pgUrl("sales_api"),
      LOOM_CHANNEL_LIFECYCLE_BUS_URL: redisUrl,
      PORT: String(SALES_PORT),
    });
    boot("ship_api", "mix", ["phx.server"], shipEnv);
    await waitFor(ready(SALES_PORT), 60_000, "salesApi /ready");
    await waitFor(ready(SHIP_PORT, "/health"), 180_000, "shipApi (phoenix) /health");
  }, 900_000);

  const killGroup = (app: ChildProcess, signal: NodeJS.Signals): void => {
    if (app.pid === undefined) return;
    try {
      process.kill(-app.pid, signal);
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

  it("delivers a Hono-published envelope into the Phoenix consumer", async () => {
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
      throw new Error(`create -> ${createRes.status}\n--- sales_api log tail ---\n${tail}`);
    }
    const { id } = (await createRes.json()) as { id: string };
    const placeRes = await fetch(`http://localhost:${SALES_PORT}/api/orders/${id}/place`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(placeRes.ok).toBe(true);

    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/shipments`);
        if (!res.ok) return false;
        const body = (await res.json()) as { items: { orderRef: string; status: string }[] };
        return body.items.some((s) => s.orderRef === id && s.status === "Pending");
      },
      30_000,
      "shipment created on the phoenix shipApi",
    );
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/workflows/fulfil/instances`);
        if (!res.ok) return false;
        const instances = (await res.json()) as { orderId: string }[];
        return instances.some((i) => i.orderId === id);
      },
      10_000,
      "correlated Fulfil instance on the phoenix shipApi",
    );
  }, 180_000);
});
