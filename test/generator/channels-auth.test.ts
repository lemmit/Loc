// M-T4.4 slice 5a — broker service-to-service auth (design §7).
//
// v1 stance, pinned per broker: credentials ride the one seam every driver
// already consumes — the `LOOM_CHANNEL_<NAME>_URL` env — so production
// overrides the URL and no second credential channel exists.
//
// - redis:    `requirepass` on the Valkey sidecar; single credential v1
//             (`redis://:<pass>@…`; ACL-per-service deferred).
// - rabbitmq: one vhost `loom`, one user per deployable with permissions
//             scoped to its compiler-known exchanges/queues, provisioned by
//             a mounted `load_definitions` file (which also suppresses the
//             image's default open `guest` account).
// - kafka:    SASL/PLAIN on the CLIENT listener (`kafka://user:pass@…`,
//             each driver parses the userinfo into its SASL config); topic
//             ACLs deferred.  Inter-broker + healthcheck stay on the
//             loopback PLAINTEXT listener.
//
// A credential-LESS URL keeps every driver on the pre-auth plain contract —
// that back-compat arm is what keeps the native e2e harnesses (which run
// unauthed brokers on localhost) green, and it's pinned here per backend.

import { describe, expect, it } from "vitest";
import {
  brokerUser,
  devPassword,
  rabbitPasswordHash,
  rabbitPermissionRegex,
} from "../../src/generator/_channels/auth.js";
import { generateSystemFiles } from "../_helpers/index.js";

const fixture = (storageType: string, channel: string): string => `
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
        ${channel}
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
  storage bus { type: ${storageType} }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const REDIS = fixture(
  "redis",
  "carries: OrderPlaced\n        delivery: broadcast\n        retention: ephemeral",
);
const RABBIT = fixture(
  "rabbitmq",
  "carries: OrderPlaced\n        delivery: queue\n        retention: work",
);
const KAFKA = fixture(
  "kafka",
  "carries: OrderPlaced\n        delivery: broadcast\n        retention: log",
);

describe("broker auth — credential derivation (M-T4.4 slice 5a §7)", () => {
  it("derives deterministic dev identities", () => {
    expect(brokerUser("salesApi")).toBe("sales_api");
    expect(devPassword("bus")).toBe("loom-dev-bus");
    expect(devPassword("bus", "sales_api")).toBe("loom-dev-bus-sales_api");
  });

  it("hashes rabbit passwords with the salted-SHA-256 definitions scheme", () => {
    // base64("LOOM" ++ sha256("LOOM" ++ password)) — cross-checked against
    // hashlib; rabbit verifies by re-hashing with the embedded salt.
    expect(rabbitPasswordHash("loom-dev-bus-sales_api")).toBe(
      "TE9PTfjGU1RRGCX2r/0S6lJBQ8cxwC1nASNfdiuhEPzWMJ4H",
    );
  });

  it("scopes the rabbit permission regex to the deployable's compiler-known names", () => {
    const rx = rabbitPermissionRegex(["loom.Orders.Lifecycle"], ["loom.Orders.Lifecycle.shipApi"]);
    expect(rx).toBe(
      "^(loom\\.Orders\\.Lifecycle|loom\\.Orders\\.Lifecycle\\.shipApi|loom\\.dlq\\.loom\\.Orders\\.Lifecycle|loom\\.dlx)$",
    );
    const re = new RegExp(rx);
    expect(re.test("loom.Orders.Lifecycle")).toBe(true);
    expect(re.test("loom.dlx")).toBe(true);
    expect(re.test("loom.dlq.loom.Orders.Lifecycle")).toBe(true);
    // Another service's queue does NOT match — the isolation the ACL buys.
    expect(re.test("loom.Orders.Lifecycle.salesApi")).toBe(false);
    expect(re.test("loom.Other.Channel")).toBe(false);
  });
});

describe("broker auth — redis (requirepass)", () => {
  it("locks the valkey sidecar and rides the password in the URL", async () => {
    const files = await generateSystemFiles(REDIS);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain('command: ["valkey-server", "--requirepass", "loom-dev-bus"]');
    expect(compose).toContain('test: ["CMD", "valkey-cli", "-a", "loom-dev-bus", "ping"]');
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "redis://:loom-dev-bus@bus:6379"');
  });
});

describe("broker auth — rabbitmq (vhost + per-deployable users)", () => {
  it("provisions the loom vhost + scoped users via a mounted definitions file", async () => {
    const files = await generateSystemFiles(RABBIT);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("- ./broker-init/bus.conf:/etc/rabbitmq/conf.d/10-loom.conf:ro");
    expect(compose).toContain(
      "- ./broker-init/bus-definitions.json:/etc/rabbitmq/loom-definitions.json:ro",
    );
    // Per-deployable identity in each service's URL, on the loom vhost.
    expect(compose).toContain(
      'LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://sales_api:loom-dev-bus-sales_api@bus:5672/loom"',
    );
    expect(compose).toContain(
      'LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://ship_api:loom-dev-bus-ship_api@bus:5672/loom"',
    );
    expect(files.get("broker-init/bus.conf")).toContain(
      "load_definitions = /etc/rabbitmq/loom-definitions.json",
    );
    const defs = JSON.parse(files.get("broker-init/bus-definitions.json") ?? "{}") as {
      vhosts: { name: string }[];
      users: { name: string; password_hash: string; hashing_algorithm: string }[];
      permissions: {
        user: string;
        vhost: string;
        configure: string;
        write: string;
        read: string;
      }[];
    };
    expect(defs.vhosts).toEqual([{ name: "loom" }]);
    expect(defs.users.map((u) => u.name)).toEqual(["sales_api", "ship_api"]);
    for (const u of defs.users) {
      expect(u.hashing_algorithm).toBe("rabbit_password_hashing_sha256");
      expect(u.password_hash).toBe(rabbitPasswordHash(devPassword("bus", u.name)));
    }
    // The consumer's grant admits its own group queue, the exchange, and
    // the dead-letter topology — and nothing else.
    const ship = defs.permissions.find((p) => p.user === "ship_api");
    expect(ship?.vhost).toBe("loom");
    expect(ship?.read).toBe(
      rabbitPermissionRegex(["loom.Orders.Lifecycle"], ["loom.Orders.Lifecycle.shipApi"]),
    );
  });
});

describe("broker auth — kafka (SASL/PLAIN)", () => {
  it("runs the client listener on SASL/PLAIN with one JAAS user per deployable", async () => {
    const files = await generateSystemFiles(KAFKA);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain(
      "KAFKA_LISTENERS: CLIENT://:9092,PLAINTEXT://:9094,CONTROLLER://:9093",
    );
    expect(compose).toContain(
      'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,CLIENT:SASL_PLAINTEXT"',
    );
    expect(compose).toContain("KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT");
    expect(compose).toContain("KAFKA_LISTENER_NAME_CLIENT_SASL_ENABLED_MECHANISMS: PLAIN");
    expect(compose).toContain(
      'KAFKA_LISTENER_NAME_CLIENT_PLAIN_SASL_JAAS_CONFIG: "org.apache.kafka.common.security.plain.PlainLoginModule required user_sales_api=\\"loom-dev-bus-sales_api\\" user_ship_api=\\"loom-dev-bus-ship_api\\";"',
    );
    // Healthcheck rides the auth-free loopback listener.
    expect(compose).toContain(
      'test: ["CMD", "/opt/kafka/bin/kafka-broker-api-versions.sh", "--bootstrap-server", "localhost:9094"]',
    );
    expect(compose).toContain(
      'LOOM_CHANNEL_LIFECYCLE_BUS_URL: "kafka://sales_api:loom-dev-bus-sales_api@bus:9092"',
    );
    expect(compose).toContain(
      'LOOM_CHANNEL_LIFECYCLE_BUS_URL: "kafka://ship_api:loom-dev-bus-ship_api@bus:9092"',
    );
  });

  it("parses the URL userinfo into kafkajs SASL config (hono driver)", async () => {
    const files = await generateSystemFiles(KAFKA);
    const channels = files.get("sales_api/http/channels.ts") ?? "";
    expect(channels).toContain('mechanism: "plain" as const');
    expect(channels).toContain("username: decodeURIComponent(userinfo.slice(0, colon))");
    // Credential-less URLs keep sasl undefined — the pre-auth contract.
    expect(channels).toContain("...(sasl ? { sasl } : {})");
  });

  it("parses the URL userinfo into each backend driver's SASL config", async () => {
    const on = (platform: string): string =>
      KAFKA.replace(
        "platform: node contexts: [Orders]",
        `platform: ${platform} contexts: [Orders]`,
      ).replace(
        "platform: node contexts: [Shipping]",
        `platform: ${platform} contexts: [Shipping]`,
      );
    const find = (files: Map<string, string>, dep: string, suffix: string): string => {
      for (const [path, content] of files) {
        if (path.startsWith(`${dep}/`) && path.endsWith(suffix)) return content;
      }
      return "";
    };

    const py = await generateSystemFiles(on("python"));
    const pyMod = py.get("sales_api/app/channels.py") ?? "";
    expect(pyMod).toContain('"sasl_plain_username": unquote(user),');
    expect(pyMod).toContain("AIOKafkaProducer(bootstrap_servers=self._bootstrap, **self._sasl)");

    const cs = await generateSystemFiles(on("dotnet"));
    const csMod = find(cs, "sales_api", "ChannelTransport.cs");
    expect(csMod).toContain("config.SecurityProtocol = SecurityProtocol.SaslPlaintext;");
    expect(csMod).toContain(
      "new ProducerBuilder<string, string>(ApplySasl(new ProducerConfig { BootstrapServers = _bootstrap })).Build()",
    );

    const jv = await generateSystemFiles(on("java"));
    const jvMod = find(jv, "sales_api", "KafkaChannelTransport.java");
    expect(jvMod).toContain('props.put("security.protocol", "SASL_PLAINTEXT");');
    expect(jvMod).toContain(
      '"org.apache.kafka.common.security.plain.PlainLoginModule required username=\\""',
    );

    const ex = await generateSystemFiles(on("elixir"));
    const exMod = ex.get("sales_api/lib/sales_api/kafka_broker.ex") ?? "";
    expect(exMod).toContain("[user, pass] -> [sasl: {:plain, URI.decode(user), URI.decode(pass)}]");
  });

  it("parses a redis URL password into the SE.Redis config string (.NET driver)", async () => {
    const files = await generateSystemFiles(REDIS.replace(/platform: node/g, "platform: dotnet"));
    let mod = "";
    for (const [path, content] of files) {
      if (path.startsWith("sales_api/") && path.endsWith("ChannelTransport.cs")) mod = content;
    }
    expect(mod).toContain(
      'config = $"{config[(at + 1)..]},password={Uri.UnescapeDataString(pass)}";',
    );
  });
});
