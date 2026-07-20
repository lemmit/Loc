// M-T4.4 slice 7c — RabbitMQ queue semantics on the Java backend, end to
// end.
//
// The all-java sibling of channels-e2e-rabbit.test.ts: boots the GENERATED
// Spring Boot producer plus TWO REPLICAS of the generated consumer against
// docker postgres + rabbitmq sidecars and proves the `queue`/`work` contract
// on this backend:
//   1. exactly-one-of-N — every `Order.place()` emit lands in the producer's
//      NEW `__loom_outbox` tier via the tee, is published by the relay
//      (design §5), and consumed by exactly one replica of the
//      competing-consumer fleet;
//   2. DLQ parking — a poisoned (malformed) message published straight to
//      the channel exchange parks in `loom.dlq.<address>`.
//
// Opt-in: LOOM_CHANNELS_E2E_RABBIT_JAVA=1 (npm run
// test:channels-rabbit-java).  Needs docker + `gradle` (9.1+) + JDK 25 on
// PATH (the tenancy-isolation-java pattern: `gradle bootJar` → `java -jar`).
// LOOM_CHANNELS_PG_URL / LOOM_CHANNELS_AMQP_URL point at existing services
// (the DLQ leg is docker-only and skips under an AMQP override).

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

const ENABLED = process.env.LOOM_CHANNELS_E2E_RABBIT_JAVA === "1";

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
      channel Lifecycle {
        carries: OrderPlaced
        delivery: queue
        retention: work
      }
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
  storage bus { type: rabbitmq }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: java contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const SALES_PORT = 3211;
const REPLICA_PORTS = [3212, 3213];
const PG_PORT = 55443;
const AMQP_PORT = 55675;
const ORDERS = 6;
const ADDRESS = "loom.Orders.Lifecycle";

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

describe.skipIf(!ENABLED)("rabbitmq queue semantics — java leg (M-T4.4 slice 7c)", () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];
  let pgJdbc: (db: string) => string;
  let amqpUrl: string;
  let dlqProbe = false;

  const jarOf = (app: string): string => {
    const jar = readdirSync(join(dir, "out", app, "build", "libs")).find(
      (f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"),
    );
    if (!jar) throw new Error(`bootJar produced no runnable jar for ${app}`);
    return jar;
  };

  const boot = (app: string, port: number, db: string): void => {
    const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
    // Detached process group so teardown can kill the whole tree.
    const child = spawn(javaBin, ["-jar", join("build", "libs", jarOf(app))], {
      cwd: join(dir, "out", app),
      detached: true,
      env: {
        ...process.env,
        SPRING_DATASOURCE_URL: pgJdbc(db),
        SPRING_DATASOURCE_USERNAME: "postgres",
        SPRING_DATASOURCE_PASSWORD: "postgres",
        LOOM_CHANNEL_LIFECYCLE_BUS_URL: amqpUrl,
        SERVER_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = join(dir, `${app}-${port}.log`);
    const sink = (d: Buffer): void => appendFileSync(log, d);
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    apps.push(child);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-channels-e2e-rbjv-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    const pgOverride = process.env.LOOM_CHANNELS_PG_URL;
    const amqpOverride = process.env.LOOM_CHANNELS_AMQP_URL;
    if (pgOverride) {
      pgJdbc = (db) => {
        const u = new URL(pgOverride.replace(/^postgres(ql)?:/, "http:"));
        return `jdbc:postgresql://${u.hostname}:${u.port || "5432"}/${db}`;
      };
    } else {
      sh(
        `docker run -d --rm --name loom-channels-rbjv-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-channels-rbjv-pg");
      pgJdbc = (db) => `jdbc:postgresql://localhost:${PG_PORT}/${db}`;
      // The postgres entrypoint restarts after initdb — make CREATE DATABASE
      // itself the retried probe (see channels-e2e.test.ts).
      await waitFor(
        async () => {
          sh(
            `docker exec loom-channels-rbjv-pg psql -U postgres -c "CREATE DATABASE sales_api;" -c "CREATE DATABASE ship_api;"`,
          );
          return true;
        },
        60_000,
        "postgres accepting CREATE DATABASE",
      );
    }
    if (amqpOverride) {
      amqpUrl = amqpOverride;
    } else {
      // Cookie pre-seed: see channels-e2e-rabbit.test.ts — under sandboxed
      // docker storage drivers the image's .erlang.cookie can surface with
      // unreadable ownership and rabbit crash-loops on eacces.
      sh(
        `docker run -d --name loom-channels-rbjv-mq -p ${AMQP_PORT}:5672 --entrypoint sh rabbitmq:4-management-alpine ` +
          `-c 'mkdir -p /var/lib/rabbitmq && echo loomcookie > /var/lib/rabbitmq/.erlang.cookie && chown -R rabbitmq:rabbitmq /var/lib/rabbitmq && chmod 600 /var/lib/rabbitmq/.erlang.cookie && exec docker-entrypoint.sh rabbitmq-server'`,
      );
      dockerNames.push("loom-channels-rbjv-mq");
      amqpUrl = `amqp://guest:guest@localhost:${AMQP_PORT}`;
      dlqProbe = true;
      await waitFor(
        async () => {
          sh(`docker exec loom-channels-rbjv-mq rabbitmq-diagnostics -q ping`);
          return true;
        },
        120_000,
        "rabbitmq accepting ping",
      );
    }

    for (const app of ["sales_api", "ship_api"] as const) {
      sh("gradle --no-daemon -q bootJar", join(dir, "out", app));
    }
    boot("sales_api", SALES_PORT, "sales_api");
    // Replica 1 boots first and owns the migration run; replica 2 joins after
    // (concurrent first-boot DDL races the migrator — a real-deployment
    // concern, not this gate's).
    boot("ship_api", REPLICA_PORTS[0], "ship_api");
    await waitFor(ready(SALES_PORT), 180_000, "salesApi /ready");
    await waitFor(ready(REPLICA_PORTS[0]), 180_000, "shipApi replica 1 /ready");
    boot("ship_api", REPLICA_PORTS[1], "ship_api");
    await waitFor(ready(REPLICA_PORTS[1]), 180_000, "shipApi replica 2 /ready");
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

  it("delivers each relay-published event to exactly one replica of the fleet", async () => {
    const ids: string[] = [];
    for (let i = 0; i < ORDERS; i++) {
      const createRes = await fetch(`http://localhost:${SALES_PORT}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: `c${i}`, status: "Draft" }),
      });
      if (createRes.status !== 201) {
        const tail = readFileSync(join(dir, `sales_api-${SALES_PORT}.log`), "utf8")
          .split("\n")
          .slice(-12)
          .join("\n");
        throw new Error(
          `create -> ${createRes.status}: ${await createRes.text()}\n--- sales log tail ---\n${tail}`,
        );
      }
      const { id } = (await createRes.json()) as { id: string };
      ids.push(id);
      const placeRes = await fetch(`http://localhost:${SALES_PORT}/api/orders/${id}/place`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(placeRes.ok).toBe(true);
    }

    // No loss: all ORDERS events land (outbox → relay → broker → a replica).
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${REPLICA_PORTS[0]}/api/shipments?pageSize=50`);
        if (!res.ok) return false;
        const body = (await res.json()) as { total: number };
        return body.total >= ORDERS;
      },
      30_000,
      `all ${ORDERS} shipments created across the fleet`,
    );
    // No dupes: exactly one shipment per order (the replicas COMPETE on one
    // durable queue — a broadcast regression would double up here).
    const body = (await (
      await fetch(`http://localhost:${REPLICA_PORTS[0]}/api/shipments?pageSize=50`)
    ).json()) as { total: number; items: { orderRef: string }[] };
    expect(body.total).toBe(ORDERS);
    expect(new Set(body.items.map((s) => s.orderRef)).size).toBe(ORDERS);
    for (const id of ids) {
      expect(body.items.some((s) => s.orderRef === id)).toBe(true);
    }
    // Work was actually SHARED: total consumed across replica logs == ORDERS,
    // and the producer relay announced the publishes.
    const consumedPerReplica = REPLICA_PORTS.map((p) => {
      const log = readFileSync(join(dir, `ship_api-${p}.log`), "utf8");
      return (log.match(/channel_consumed/g) ?? []).length;
    });
    expect(consumedPerReplica.reduce((a, b) => a + b, 0)).toBe(ORDERS);
    const salesLog = readFileSync(join(dir, `sales_api-${SALES_PORT}.log`), "utf8");
    expect((salesLog.match(/channel_published/g) ?? []).length).toBe(ORDERS);
  }, 120_000);

  it("parks a poisoned message in the DLQ instead of losing it", async () => {
    if (!dlqProbe) return; // AMQP override: no container to drive rabbitmqadmin in
    sh(
      `docker exec loom-channels-rbjv-mq rabbitmqadmin publish message --exchange ${ADDRESS} --payload 'not-json{{'`,
    );
    await waitFor(
      async () => {
        const out = sh(
          `docker exec loom-channels-rbjv-mq rabbitmqadmin get messages --queue loom.dlq.${ADDRESS}`,
        );
        return out.includes("not-json{{");
      },
      20_000,
      "poisoned message parked in the DLQ",
    );
    // The parking was announced on the consumer side.  Polled: piped stdout
    // can flush a beat after the broker shows the parked message.
    await waitFor(
      async () =>
        REPLICA_PORTS.some((p) =>
          readFileSync(join(dir, `ship_api-${p}.log`), "utf8").includes("channel_dead_lettered"),
        ),
      10_000,
      "channel_dead_lettered announced by a replica",
    );
  }, 60_000);
});
