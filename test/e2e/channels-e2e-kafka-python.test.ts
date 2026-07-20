// M-T4.4 slice 8a — Kafka log semantics on the Python backend, end to end.
//
// Boots the GENERATED FastAPI producer plus TWO REPLICAS of the generated FastAPI
// consumer against docker postgres + apache/kafka (KRaft) sidecars and
// proves the log contract:
//   1. exactly-one-of-N within the deployable's group — every emit lands in
//      `__loom_outbox` via the tee, is published by the relay (design §5,
//      envelope id = row id) onto the topic, and is consumed by exactly one
//      replica of the group;
//   2. ORDERING-PER-KEY — the channel declares `key: order`, so both of an
//      order's events (`OrderPlaced` then `OrderShipped`) carry the same
//      `loomkey`, land in the same partition, are consumed by the SAME
//      replica, in emit order;
//   3. DLQ parking — a poisoned (malformed) record published straight to the
//      topic parks on `<address>.dlq` (v1 log + park) and the partition
//      keeps moving.
//
// Opt-in: LOOM_CHANNELS_E2E_KAFKA_PYTHON=1 (npm run test:channels-kafka-python).  Needs
// docker + npm network access.  LOOM_CHANNELS_PG_URL /
// LOOM_CHANNELS_KAFKA_URL point at existing services (the DLQ leg is
// docker-only and skips under a kafka override).

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_CHANNELS_E2E_KAFKA_PYTHON === "1";

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
        operation shipIt() {
          precondition status == "Placed"
          status := "Shipped"
          emit OrderShipped { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      event OrderShipped { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced, OrderShipped
        delivery: broadcast
        retention: log
        key: order
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
  storage bus { type: kafka }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: python contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: python contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const SALES_PORT = 3220;
const REPLICA_PORTS = [3221, 3222];
const PG_PORT = 55446;
const KAFKA_PORT = 55678;
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

/** channel_consumed entries (type + partition key) in log order. */
function consumedEntries(log: string): { type: string; key: string }[] {
  const out: { type: string; key: string }[] = [];
  for (const line of log.split("\n")) {
    if (!line.includes('"channel_consumed"')) continue;
    // python json.dumps puts a space after the colon (unlike pino).
    const type = /"type":\s*"([^"]+)"/.exec(line)?.[1];
    const key = /"key":\s*"([^"]+)"/.exec(line)?.[1];
    if (type && key) out.push({ type, key });
  }
  return out;
}

describe.skipIf(!ENABLED)("kafka log semantics — python leg (M-T4.4 slice 8a)", () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];
  let pgUrl: (db: string) => string;
  let kafkaUrl: string;
  let dlqProbe = false;

  const boot = (app: string, port: number, db: string): void => {
    // uv wrapper spawns uvicorn as a grandchild — detached process group so
    // teardown can kill the whole tree.
    const child = spawn("uv", ["run", "uvicorn", "app.main:app", "--port", String(port)], {
      cwd: join(dir, "out", app),
      detached: true,
      env: {
        ...process.env,
        DATABASE_URL: pgUrl(db),
        LOOM_CHANNEL_LIFECYCLE_BUS_URL: kafkaUrl,
        PORT: String(port),
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
    dir = mkdtempSync(join(tmpdir(), "loom-channels-e2e-kfpy-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    const pgOverride = process.env.LOOM_CHANNELS_PG_URL;
    const kafkaOverride = process.env.LOOM_CHANNELS_KAFKA_URL;
    if (pgOverride) {
      pgUrl = (db) =>
        `${pgOverride.replace(/^postgres(ql)?:/, "postgresql+asyncpg:").replace(/\/[^/]*$/, "")}/${db}`;
    } else {
      sh(
        `docker run -d --rm --name loom-channels-kfpy-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-channels-kfpy-pg");
      pgUrl = (db) => `postgresql+asyncpg://postgres:postgres@localhost:${PG_PORT}/${db}`;
      // The postgres entrypoint restarts after initdb — make CREATE DATABASE
      // itself the retried probe (see channels-e2e.test.ts).
      await waitFor(
        async () => {
          sh(
            `docker exec loom-channels-kfpy-pg psql -U postgres -c "CREATE DATABASE sales_api;" -c "CREATE DATABASE ship_api;"`,
          );
          return true;
        },
        60_000,
        "postgres accepting CREATE DATABASE",
      );
    }
    if (kafkaOverride) {
      kafkaUrl = kafkaOverride;
    } else {
      // Single-node KRaft apache/kafka (Apache 2.0 — §6a licensing, never
      // bitnami).  Dual data listeners: PLAINTEXT (advertised
      // localhost:9092) keeps the in-container console tools working for
      // the DLQ probe, HOST (advertised at the published host port) serves
      // the native apps — a single advertised listener can't do both.
      sh(
        `docker run -d --name loom-channels-kfpy-kafka -p ${KAFKA_PORT}:19092 ` +
          `-e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller ` +
          `-e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093,HOST://:19092 ` +
          `-e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092,HOST://localhost:${KAFKA_PORT} ` +
          `-e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER ` +
          `-e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 ` +
          `-e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,HOST:PLAINTEXT ` +
          `-e KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT ` +
          `-e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 ` +
          `-e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 ` +
          `-e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 ` +
          `-e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 ` +
          `-e KAFKA_NUM_PARTITIONS=3 ` +
          `apache/kafka:4.1.0`,
      );
      dockerNames.push("loom-channels-kfpy-kafka");
      kafkaUrl = `localhost:${KAFKA_PORT}`;
      dlqProbe = true;
      await waitFor(
        async () => {
          sh(
            `docker exec loom-channels-kfpy-kafka /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092`,
          );
          return true;
        },
        120_000,
        "kafka accepting api-versions",
      );
    }

    for (const app of ["sales_api", "ship_api"] as const) {
      sh("uv sync --quiet", join(dir, "out", app));
    }
    boot("sales_api", SALES_PORT, "sales_api");
    // Replica 1 boots first and owns the migration run; replica 2 joins after.
    boot("ship_api", REPLICA_PORTS[0], "ship_api");
    await waitFor(ready(SALES_PORT), 120_000, "salesApi /ready");
    await waitFor(ready(REPLICA_PORTS[0]), 120_000, "shipApi replica 1 /ready");
    boot("ship_api", REPLICA_PORTS[1], "ship_api");
    await waitFor(ready(REPLICA_PORTS[1]), 120_000, "shipApi replica 2 /ready");
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

  it("delivers relay-published events exactly once per group, ordered per key", async () => {
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
      for (const op of ["place", "ship_it"]) {
        const res = await fetch(`http://localhost:${SALES_PORT}/api/orders/${id}/${op}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.ok, `${op} ${id}`).toBe(true);
      }
    }

    // No loss: every OrderPlaced spawned a Fulfil shipment.
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
    const body = (await (
      await fetch(`http://localhost:${REPLICA_PORTS[0]}/api/shipments?pageSize=50`)
    ).json()) as { total: number; items: { orderRef: string }[] };
    // No dupes: the replicas COMPETE within their group — a broadcast-to-
    // every-replica regression would double up here.
    expect(body.total).toBe(ORDERS);
    expect(new Set(body.items.map((s) => s.orderRef)).size).toBe(ORDERS);

    // All 2×ORDERS events consumed exactly once across the group…
    await waitFor(
      async () =>
        REPLICA_PORTS.flatMap((p) =>
          consumedEntries(readFileSync(join(dir, `ship_api-${p}.log`), "utf8")),
        ).length >=
        ORDERS * 2,
      20_000,
      "all events consumed across the fleet",
    );
    const perReplica = REPLICA_PORTS.map((p) =>
      consumedEntries(readFileSync(join(dir, `ship_api-${p}.log`), "utf8")),
    );
    expect(perReplica.flat().length).toBe(ORDERS * 2);
    // …and ORDERED PER KEY: both of an order's events carry its id as the
    // partition key, so they land on the SAME replica with OrderPlaced
    // strictly before OrderShipped.
    for (const id of ids) {
      const owners = perReplica.filter((entries) => entries.some((e) => e.key === id));
      expect(owners.length, `order ${id} consumed by exactly one replica`).toBe(1);
      const seq = (owners[0] ?? []).filter((e) => e.key === id).map((e) => e.type);
      expect(seq, `order ${id} per-key order`).toEqual([
        "Orders.OrderPlaced",
        "Orders.OrderShipped",
      ]);
    }
    // The producer relay announced every publish (design §5: all durable).
    const salesLog = readFileSync(join(dir, `sales_api-${SALES_PORT}.log`), "utf8");
    expect((salesLog.match(/channel_published/g) ?? []).length).toBe(ORDERS * 2);
  }, 120_000);

  it("parks a poisoned record on <address>.dlq instead of stalling the partition", async () => {
    if (!dlqProbe) return; // kafka override: no container to drive the console tools in
    sh(
      `docker exec loom-channels-kfpy-kafka sh -c 'echo "not-json{{" | /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic ${ADDRESS}'`,
    );
    await waitFor(
      async () => {
        const out = sh(
          `docker exec loom-channels-kfpy-kafka sh -c '/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic ${ADDRESS}.dlq --from-beginning --timeout-ms 5000 2>/dev/null || true'`,
        );
        return out.includes("not-json{{");
      },
      30_000,
      "poisoned record parked on the dlq topic",
    );
    // The parking was announced on the consumer side.  Polled: piped stdout
    // can flush a beat after the broker shows the parked record.
    await waitFor(
      async () =>
        REPLICA_PORTS.some((p) =>
          readFileSync(join(dir, `ship_api-${p}.log`), "utf8").includes("channel_dead_lettered"),
        ),
      10_000,
      "channel_dead_lettered announced by a replica",
    );
  }, 90_000);
});
