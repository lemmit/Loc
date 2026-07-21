// M-T4.4 slice 5a — broker auth (design §7), end to end: channels-e2e WITH
// AUTH ON.
//
// Generates ONE system that wires all three brokers at once (redis
// broadcast/ephemeral + rabbitmq queue/work + kafka broadcast/log — also the
// first runtime proof of the multi-transport factory dispatch), provisions
// each broker container EXACTLY as the generated artifacts say —
// `--requirepass` from the compose command line, the generated
// `broker-init/` definitions file mounted into rabbitmq, the generated JAAS
// line on kafka's SASL listener — and boots the two generated Hono
// deployables with the generated credentialed URLs (host-rewritten).  Then:
//
//   1. POSITIVE — each broker delivers its event across deployables under
//      auth: place()/shipIt()/archive() on salesApi each spawn their
//      workflow Shipment on shipApi, one per broker.
//   2. NEGATIVE — credential-less access is refused per broker: valkey
//      answers NOAUTH, rabbitmq's default `guest` account is gone
//      (definitions suppress it), kafka's client listener rejects a
//      SASL-less client.
//
// Opt-in: LOOM_CHANNELS_E2E_AUTH=1 (npm run test:channels-auth).  Docker
// required (the negative probes drive the containers' own CLIs).

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_CHANNELS_E2E_AUTH === "1";

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
        operation archive() {
          precondition status == "Shipped"
          status := "Archived"
          emit OrderArchived { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      event OrderShipped { order: Order id, at: datetime }
      event OrderArchived { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
      channel Handoff {
        carries: OrderShipped
        delivery: queue
        retention: work
      }
      channel Archive {
        carries: OrderArchived
        delivery: broadcast
        retention: log
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
      workflow Handover {
        orderId: Order id
        create(p: OrderShipped) by p.order {
          let s = Shipment.create({ orderRef: p.order, status: "Handed" })
        }
      }
      workflow Archivist {
        orderId: Order id
        create(p: OrderArchived) by p.order {
          let s = Shipment.create({ orderRef: p.order, status: "Archived" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage busRedis { type: redis }
  storage busRabbit { type: rabbitmq }
  storage busKafka { type: kafka }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: busRedis }
  channelSource handoffBus { for: Handoff, use: busRabbit }
  channelSource archiveBus { for: Archive, use: busKafka }
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus, handoffBus, archiveBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus, handoffBus, archiveBus] port: 3001 }
}
`;

const SALES_PORT = 3232;
const SHIP_PORT = 3233;
const PG_PORT = 55450;
const REDIS_PORT = 55682;
const AMQP_PORT = 55683;
const KAFKA_PORT = 55684;

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

/** Every `KEY: <json-string>` env line in compose, decoded.  The emitter
 *  writes env values via JSON.stringify, so values with embedded escaped
 *  quotes (the kafka JAAS line) MUST be JSON-parsed, not regex-captured —
 *  a naive capture truncates at the first inner quote and hands the broker
 *  a malformed JAAS config (a silent boot-crash, found the hard way). */
function composeEnv(compose: string, key: string): string[] {
  return compose
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${key}: `))
    .map((l) => JSON.parse(l.slice(key.length + 1).trim()) as string);
}

describe.skipIf(!ENABLED)("broker auth e2e — all three brokers authed (M-T4.4 slice 5a)", () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-channels-auth-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);
    const compose = readFileSync(join(dir, "out", "docker-compose.yml"), "utf8");

    // --- postgres ---
    sh(
      `docker run -d --rm --name loom-channels-auth-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
    );
    dockerNames.push("loom-channels-auth-pg");
    await waitFor(
      async () => {
        sh(
          `docker exec loom-channels-auth-pg psql -U postgres -c "CREATE DATABASE sales_api;" -c "CREATE DATABASE ship_api;"`,
        );
        return true;
      },
      60_000,
      "postgres accepting CREATE DATABASE",
    );

    // --- valkey, locked with the GENERATED requirepass ---
    const requirepass = /"--requirepass", "([^"]+)"/.exec(compose)?.[1];
    expect(requirepass, "compose carries the valkey requirepass").toBeTruthy();
    sh(
      `docker run -d --rm --name loom-channels-auth-valkey -p ${REDIS_PORT}:6379 valkey/valkey:8-alpine valkey-server --requirepass ${requirepass}`,
    );
    dockerNames.push("loom-channels-auth-valkey");

    // --- rabbitmq, provisioned by the GENERATED definitions file ---
    // (cookie pre-seed: see channels-e2e-rabbit.test.ts)
    sh(
      `docker run -d --name loom-channels-auth-mq -p ${AMQP_PORT}:5672 ` +
        `-v ${join(dir, "out", "broker-init", "bus_rabbit.conf")}:/etc/rabbitmq/conf.d/10-loom.conf:ro ` +
        `-v ${join(dir, "out", "broker-init", "bus_rabbit-definitions.json")}:/etc/rabbitmq/loom-definitions.json:ro ` +
        `--entrypoint sh rabbitmq:4-management-alpine ` +
        `-c 'mkdir -p /var/lib/rabbitmq && echo loomcookie > /var/lib/rabbitmq/.erlang.cookie && chown -R rabbitmq:rabbitmq /var/lib/rabbitmq && chmod 600 /var/lib/rabbitmq/.erlang.cookie && exec docker-entrypoint.sh rabbitmq-server'`,
    );
    dockerNames.push("loom-channels-auth-mq");
    await waitFor(
      async () => {
        sh(`docker exec loom-channels-auth-mq rabbitmq-diagnostics -q ping`);
        return true;
      },
      120_000,
      "rabbitmq accepting ping",
    );

    // --- kafka, SASL/PLAIN on the client-facing listener with the
    // GENERATED JAAS line (HOST listener for the native apps; PLAINTEXT
    // stays loopback-only for inter-broker + healthcheck, as in compose) ---
    const jaas = composeEnv(compose, "KAFKA_LISTENER_NAME_CLIENT_PLAIN_SASL_JAAS_CONFIG")[0];
    expect(jaas, "compose carries the kafka JAAS config").toBeTruthy();
    sh(
      `docker run -d --name loom-channels-auth-kafka -p ${KAFKA_PORT}:19092 ` +
        `-e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller ` +
        `-e KAFKA_LISTENERS=HOST://:19092,PLAINTEXT://:9094,CONTROLLER://:9093 ` +
        `-e KAFKA_ADVERTISED_LISTENERS=HOST://localhost:${KAFKA_PORT},PLAINTEXT://localhost:9094 ` +
        `-e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER ` +
        `-e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 ` +
        `-e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,HOST:SASL_PLAINTEXT ` +
        `-e KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT ` +
        `-e KAFKA_LISTENER_NAME_HOST_SASL_ENABLED_MECHANISMS=PLAIN ` +
        `-e KAFKA_LISTENER_NAME_HOST_PLAIN_SASL_JAAS_CONFIG='${jaas}' ` +
        `-e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 ` +
        `-e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 ` +
        `-e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 ` +
        `-e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 ` +
        `-e KAFKA_NUM_PARTITIONS=3 ` +
        `apache/kafka:4.1.0`,
    );
    dockerNames.push("loom-channels-auth-kafka");
    await waitFor(
      async () => {
        sh(
          `docker exec loom-channels-auth-kafka /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9094`,
        );
        return true;
      },
      120_000,
      "kafka accepting api-versions on the plaintext listener",
    );

    // --- the generated apps, on the generated credentialed URLs ---
    for (const app of ["sales_api", "ship_api"] as const) {
      sh("npm install --silent", join(dir, "out", app));
    }
    const boot = (app: string, port: number, db: string): void => {
      // Compose injects per-service URLs; host-rewrite the broker address
      // to the published ports, keeping the generated credentials intact.
      const svcBlock = compose.split(`${app.replace("_api", "_api")}:`)[1] ?? compose;
      const urlFor = (env: string, host: string, hostPort: number): string => {
        const urls = composeEnv(compose, env);
        const own = urls[app === "sales_api" ? 0 : 1] ?? urls[0];
        return own.replace(/@[^:@]+:\d+/, `@${host}:${hostPort}`);
      };
      void svcBlock;
      const child = spawn(join(dir, "out", app, "node_modules/.bin/tsx"), ["index.ts"], {
        cwd: join(dir, "out", app),
        detached: true,
        env: {
          ...process.env,
          DATABASE_URL: `postgres://postgres:postgres@localhost:${PG_PORT}/${db}`,
          LOOM_CHANNEL_LIFECYCLE_BUS_URL: urlFor(
            "LOOM_CHANNEL_LIFECYCLE_BUS_URL",
            "localhost",
            REDIS_PORT,
          ),
          LOOM_CHANNEL_HANDOFF_BUS_URL: urlFor(
            "LOOM_CHANNEL_HANDOFF_BUS_URL",
            "localhost",
            AMQP_PORT,
          ),
          LOOM_CHANNEL_ARCHIVE_BUS_URL: urlFor(
            "LOOM_CHANNEL_ARCHIVE_BUS_URL",
            "localhost",
            KAFKA_PORT,
          ),
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const log = join(dir, `${app}.log`);
      const sink = (d: Buffer): void => appendFileSync(log, d);
      child.stdout?.on("data", sink);
      child.stderr?.on("data", sink);
      apps.push(child);
    };
    boot("sales_api", SALES_PORT, "sales_api");
    boot("ship_api", SHIP_PORT, "ship_api");
    await waitFor(ready(SALES_PORT), 120_000, "salesApi /ready");
    await waitFor(ready(SHIP_PORT), 120_000, "shipApi /ready");
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

  it("delivers one event per authed broker across deployables", async () => {
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
        `create -> ${createRes.status}: ${await createRes.text()}\n--- sales log tail ---\n${tail}`,
      );
    }
    const { id } = (await createRes.json()) as { id: string };
    for (const op of ["place", "ship_it", "archive"]) {
      const res = await fetch(`http://localhost:${SALES_PORT}/api/orders/${id}/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.ok, op).toBe(true);
    }
    // One Shipment per broker-carried event: redis (Pending), rabbit
    // (Handed), kafka (Archived).
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${SHIP_PORT}/api/shipments?pageSize=50`);
        if (!res.ok) return false;
        const body = (await res.json()) as { total: number };
        return body.total >= 3;
      },
      30_000,
      "all three brokers delivered under auth",
    );
    const body = (await (
      await fetch(`http://localhost:${SHIP_PORT}/api/shipments?pageSize=50`)
    ).json()) as { total: number; items: { orderRef: string; status: string }[] };
    expect(body.total).toBe(3);
    expect(body.items.map((s) => s.status).sort()).toEqual(["Archived", "Handed", "Pending"]);
    for (const s of body.items) expect(s.orderRef).toBe(id);
  }, 120_000);

  it("refuses credential-less access on every broker", async () => {
    // valkey: unauthenticated PING answers NOAUTH.
    const noauth = sh(`docker exec loom-channels-auth-valkey sh -c 'valkey-cli ping 2>&1 || true'`);
    expect(noauth).toContain("NOAUTH");
    // rabbitmq: definitions suppressed the default open guest account, and
    // the per-deployable users exist in its place.
    const users = sh(`docker exec loom-channels-auth-mq rabbitmqctl list_users --quiet`);
    expect(users).not.toContain("guest");
    expect(users).toContain("sales_api");
    expect(users).toContain("ship_api");
    expect(() =>
      sh(`docker exec loom-channels-auth-mq rabbitmqctl authenticate_user guest guest`),
    ).toThrow();
    // kafka: a SASL-less client is rejected by the SASL listener (the
    // loopback PLAINTEXT listener used by the healthcheck stays open).
    expect(() =>
      sh(
        `docker exec loom-channels-auth-kafka /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:19092 --command-config /dev/null`,
      ),
    ).toThrow();
  }, 90_000);
});
