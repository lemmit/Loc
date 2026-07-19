// M-T4.4 slice 6b — CROSS-BACKEND broker delivery, end to end (Java leg).
//
// The Java sibling of channels-e2e-python.test.ts: the GENERATED Hono
// producer (salesApi) publishes a CloudEvents envelope to a docker valkey
// sidecar; the GENERATED Spring Boot consumer (shipApi) receives it, spawns
// the correlated `Fulfil` instance, and persists the Shipment in its OWN
// database — envelope parity across backends, no shared code.
//
// Opt-in: LOOM_CHANNELS_E2E_JAVA=1 (npm run test:channels-java).  Needs
// docker, npm network access, and `gradle` (9.1+) + JDK 25 on PATH (the
// tenancy-isolation-java pattern: `gradle bootJar` → `java -jar`).
// LOOM_CHANNELS_PG_URL / LOOM_CHANNELS_REDIS_URL point at existing services
// instead.

import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_CHANNELS_E2E_JAVA === "1";

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
  deployable shipApi  { platform: java contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const SALES_PORT = 3199;
const SHIP_PORT = 3201;
const PG_PORT = 55438;
const REDIS_PORT = 56394;

const sh = (cmd: string, cwd?: string): string =>
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 }).toString();

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

describe.skipIf(!ENABLED)("cross-backend broker delivery (channels-e2e, java consumer)", () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];
  let pgUrl: (db: string) => string;
  let pgJdbc: (db: string) => string;
  let redisUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-channels-e2e-jv-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    const pgOverride = process.env.LOOM_CHANNELS_PG_URL;
    const redisOverride = process.env.LOOM_CHANNELS_REDIS_URL;
    if (pgOverride) {
      pgUrl = (db) => `${pgOverride.replace(/\/[^/]*$/, "")}/${db}`;
      pgJdbc = (db) => {
        const u = new URL(pgUrl(db).replace(/^postgres(ql)?:/, "http:"));
        return `jdbc:postgresql://${u.hostname}:${u.port || "5432"}/${db}`;
      };
    } else {
      sh(
        `docker run -d --rm --name loom-channels-jv-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-channels-jv-pg");
      pgUrl = (db) => `postgres://postgres:postgres@localhost:${PG_PORT}/${db}`;
      pgJdbc = (db) => `jdbc:postgresql://localhost:${PG_PORT}/${db}`;
      // The postgres entrypoint restarts the server after initdb — make the
      // CREATE DATABASE itself the retried probe (see channels-e2e.test.ts).
      await waitFor(
        async () => {
          sh(
            `docker exec loom-channels-jv-pg psql -U postgres -c "CREATE DATABASE sales_api;" -c "CREATE DATABASE ship_api;"`,
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
        `docker run -d --rm --name loom-channels-jv-valkey -p ${REDIS_PORT}:6379 valkey/valkey:8-alpine`,
      );
      dockerNames.push("loom-channels-jv-valkey");
      redisUrl = `redis://localhost:${REDIS_PORT}`;
    }

    sh("npm install --silent", join(dir, "out", "sales_api"));
    sh("gradle --no-daemon -q bootJar", join(dir, "out", "ship_api"));
    const jar = readdirSync(join(dir, "out", "ship_api", "build", "libs")).find(
      (f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"),
    );
    if (!jar) throw new Error("bootJar produced no runnable jar");

    const boot = (
      app: string,
      cmd: string,
      cmdArgs: string[],
      env: Record<string, string>,
    ): void => {
      // Detached process group so teardown can kill the whole tree (see
      // channels-e2e.test.ts — wrappers orphan the server otherwise).
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
    // Boot with the toolchain JDK (Java 25 → class-file v69); a stale PATH
    // `java` on the runner throws UnsupportedClassVersionError.
    const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
    boot("ship_api", javaBin, ["-jar", join("build", "libs", jar)], {
      SPRING_DATASOURCE_URL: pgJdbc("ship_api"),
      SPRING_DATASOURCE_USERNAME: "postgres",
      SPRING_DATASOURCE_PASSWORD: "postgres",
      LOOM_CHANNEL_LIFECYCLE_BUS_URL: redisUrl,
      SERVER_PORT: String(SHIP_PORT),
    });
    await waitFor(ready(SALES_PORT), 60_000, "salesApi /ready");
    await waitFor(ready(SHIP_PORT), 180_000, "shipApi (java) /ready");
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

  it("delivers a Hono-published envelope into the Java consumer", async () => {
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

    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/shipments`);
        if (!res.ok) return false;
        const body = (await res.json()) as { items: { orderRef: string; status: string }[] };
        return body.items.some((s) => s.orderRef === id && s.status === "Pending");
      },
      20_000,
      "shipment created on the java shipApi",
    );
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/workflows/fulfil/instances`);
        if (!res.ok) return false;
        const instances = (await res.json()) as { orderId: string }[];
        return instances.some((i) => i.orderId === id);
      },
      10_000,
      "correlated Fulfil instance on the java shipApi",
    );
  }, 180_000);
});
