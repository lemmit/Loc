// M-T4.8 — typed in-system api call, end to end.
//
// Everything else in this feature proves the generated code COMPILES.  This
// proves it RUNS: two generated backends boot as separate processes with
// separate databases, and the caller's workflow reaches the callee over real
// HTTP, parses the response at its boundary, and persists a value it could
// only have learned from the other service.
//
// The assertion is deliberately indirect.  `orderCode` on the caller's own
// Shipment row is copied from the callee's response body — the code was only
// ever POSTed to the callee, and the caller's database never saw it.  So the
// row matching proves the round-trip happened AND that the parsed body carried
// real field values; a stubbed client, a 404-swallowing client, or a response
// schema that silently dropped `code` all fail it.
//
// This also exercises the `<RESOURCE>_URL` seam end to end: the harness sets
// `ORDERS_URL` exactly the way `src/system/index.ts` writes it into compose,
// so a drift between `resourceEnvUrlVar` and what the client reads shows up
// here as a connection failure rather than as a silent fallback.
//
// The CALLER's platform is the knob (LOOM_API_CALL_CALLER, default `node`);
// the callee stays Hono throughout, because what's under test is the caller's
// generated client, not the callee's routes.
//
// COVERAGE: all five backends that emit a typed client are RUNTIME-verified
// here.  `node` and `python` boot natively; `dotnet`, `java` and `elixir` boot
// in the SAME container images their compile gates use, because this
// environment has no host toolchain for them.
//
// Closing that gap was not bookkeeping.  Two defects were sitting behind it,
// both of which compile perfectly and neither of which any emitter test could
// see:
//   - the Phoenix client read its base URL from a `@module_attribute`
//     (evaluated at COMPILE time — a release would have baked in the localhost
//     fallback and never seen compose's address);
//   - every Phoenix workflow with a multi-word parameter raised `MatchError` at
//     runtime, because the emitted destructure snake_cased the wire key
//     (`%{"order_id" => …}` against a body carrying `orderId`).  That one was
//     PRE-EXISTING and had nothing to do with in-system calls — it broke any
//     `create(someParam: …)` workflow on that backend.
// Both were found by booting, not by reading.
//
// Opt-in: LOOM_API_CALL_E2E=1 (npm run test:api-call).  Needs docker (throwaway
// postgres) and network for the generated projects' dependency install; the
// python caller additionally needs `uv` on PATH.
// LOOM_API_CALL_PG_URL points at an existing postgres and skips the sidecar.

import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_API_CALL_E2E === "1";

// The SAME images each backend's compile gate uses — a runtime leg that boots
// on a different toolchain than the one CI compiles with proves less.
const DOTNET_IMAGE = "mcr.microsoft.com/dotnet/sdk:10.0";
const JAVA_IMAGE = "gradle:9-jdk25";
const ELIXIR_IMAGE = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20250428-slim";

/** Postgres coordinates, so each backend can spell its own DSN dialect. */
interface Pg {
  readonly host: string;
  readonly port: number;
  readonly db: string;
  readonly user: string;
  readonly password: string;
}

interface BootSpec {
  readonly bin: string;
  readonly args: readonly string[];
  /** Extra process env.  Each backend names its DB and port variables itself —
   *  the values come straight from the generated compose file, so a rename on
   *  the emitter side surfaces here as a failed boot. */
  readonly env: Record<string, string>;
  /** Container to `docker rm -f` at teardown.  Killing a `docker run` client
   *  does NOT stop the container, so a dockerised leg must name it. */
  readonly container?: string;
}

interface CallerSpec {
  /** Fetch/restore dependencies.  May be slow; runs once in beforeAll. */
  install(cwd: string): void;
  boot(cwd: string, port: number, pg: Pg, ordersUrl: string): BootSpec;
  /** Boot budget.  A JIT/JVM/BEAM cold start in a container is not a node boot. */
  readonly readyMs: number;
}

/** Package caches, mounted into BOTH the install and the boot container.
 *
 *  Load-bearing, not an optimisation: a package cache lives INSIDE the
 *  container (`/root/.nuget`, `/root/.gradle`, `/root/.hex`) and `--rm`
 *  discards it, so a restore in one container and a run in another see
 *  different caches — the boot then fails with "package was not found. It might
 *  have been deleted since NuGet restore".  Shared across runs on purpose: a
 *  warm cache turns a 5-minute cold boot into seconds.
 */
function cacheDir(backend: string, name: string): string {
  const dir = join(tmpdir(), "loom-api-call-cache", backend, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Proxy + CA plumbing every container needs to reach its package registry in
 *  this environment.  Harmless where the proxy is absent (CI runners). */
const PROXY_ENV = [
  "-e",
  "HTTPS_PROXY",
  "-e",
  "HTTP_PROXY",
  "-e",
  "SSL_CERT_FILE=/root/.ccr/ca-bundle.crt",
  "-v",
  "/root/.ccr:/root/.ccr:ro",
];

/** `docker run` argv for a caller that has no host toolchain.  `--network host`
 *  is load-bearing: the container has to reach BOTH the postgres sidecar and
 *  the Hono callee, which both live on the host's loopback. */
function dockerRun(
  name: string,
  image: string,
  cwd: string,
  env: Record<string, string>,
  shellCmd: string,
  extra: readonly string[] = [],
): BootSpec {
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "host",
    "-v",
    `${cwd}:/src`,
    "-w",
    "/src",
    ...PROXY_ENV,
    ...extra,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image,
    "sh",
    "-c",
    shellCmd,
  ];
  return { bin: "docker", args, env: {}, container: name };
}

/** One entry per backend shipping a typed in-system client.  `node` and
 *  `python` boot natively; the rest boot in the SAME images their compile gates
 *  use, because this environment has no host toolchain for them. */
const CALLERS: Record<string, CallerSpec> = {
  node: {
    install: (cwd) => sh("npm install --silent", cwd),
    boot: (cwd, port, pg, ordersUrl) => ({
      bin: join(cwd, "node_modules/.bin/tsx"),
      args: ["index.ts"],
      env: {
        DATABASE_URL: `postgres://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`,
        PORT: String(port),
        ORDERS_URL: ordersUrl,
      },
    }),
    readyMs: 60_000,
  },
  python: {
    install: (cwd) => sh("uv sync --quiet", cwd),
    boot: (_cwd, port, pg, ordersUrl) => ({
      bin: "uv",
      args: ["run", "uvicorn", "app.main:app", "--port", String(port)],
      env: {
        // SQLAlchemy wants the driver spelled in the scheme.
        DATABASE_URL: `postgresql+asyncpg://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`,
        PORT: String(port),
        ORDERS_URL: ordersUrl,
      },
    }),
    readyMs: 120_000,
  },
  dotnet: {
    install: (cwd) =>
      sh(
        `docker run --rm --network host -v "${cwd}":/src -w /src ` +
          `-v "${cacheDir("dotnet", "nuget")}":/root/.nuget ${PROXY_ENV.join(" ")} ` +
          `${DOTNET_IMAGE} dotnet restore`,
      ),
    boot: (cwd, port, pg, ordersUrl) =>
      dockerRun(
        "loom-api-call-dotnet",
        DOTNET_IMAGE,
        cwd,
        {
          // Straight from the generated compose file — a rename on the emitter
          // side shows up here as a failed boot, not a silent default.
          ConnectionStrings__Default: `Host=${pg.host};Port=${pg.port};Database=${pg.db};Username=${pg.user};Password=${pg.password}`,
          ASPNETCORE_URLS: `http://+:${port}`,
          ORDERS_URL: ordersUrl,
        },
        "dotnet run --no-launch-profile --no-restore",
        ["-v", `${cacheDir("dotnet", "nuget")}:/root/.nuget`],
      ),
    readyMs: 300_000,
  },
  java: {
    // `--no-daemon`: a Gradle daemon would outlive the container's foreground
    // process and keep the port held after teardown.
    install: (cwd) =>
      sh(
        `docker run --rm --network host -v "${cwd}":/src -w /src ` +
          `-v "${cacheDir("java", "gradle")}":/home/gradle/.gradle ${PROXY_ENV.join(" ")} ` +
          `-e JAVA_TOOL_OPTIONS ${JAVA_IMAGE} gradle --no-daemon classes`,
      ),
    boot: (cwd, port, pg, ordersUrl) =>
      dockerRun(
        "loom-api-call-java",
        JAVA_IMAGE,
        cwd,
        {
          SPRING_DATASOURCE_URL: `jdbc:postgresql://${pg.host}:${pg.port}/${pg.db}`,
          SPRING_DATASOURCE_USERNAME: pg.user,
          SPRING_DATASOURCE_PASSWORD: pg.password,
          SERVER_PORT: String(port),
          ORDERS_URL: ordersUrl,
        },
        "gradle --no-daemon bootRun",
        ["-v", `${cacheDir("java", "gradle")}:/home/gradle/.gradle`, "-e", "JAVA_TOOL_OPTIONS"],
      ),
    readyMs: 420_000,
  },
  elixir: {
    // `mix deps.get` needs hex.pm, which some egress proxies reject for
    // Erlang's TLS fingerprint — LOOM_HEX_MIRROR is the documented workaround
    // and the reason install and boot are split (boot needs no network).
    install: (cwd) =>
      sh(
        `docker run --rm --network host -v "${cwd}":/src -w /src ` +
          `-v "${cacheDir("elixir", "hex")}":/root/.hex -v "${cacheDir("elixir", "mix")}":/root/.mix ` +
          `${PROXY_ENV.join(" ")} ${ELIXIR_IMAGE} ` +
          `sh -c "mix local.hex --force && mix local.rebar --force && mix deps.get && mix compile"`,
      ),
    boot: (cwd, port, pg, ordersUrl) =>
      dockerRun(
        "loom-api-call-elixir",
        ELIXIR_IMAGE,
        cwd,
        {
          DATABASE_URL: `ecto://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`,
          PORT: String(port),
          PHX_HOST: "localhost",
          PHX_SERVER: "true",
          SECRET_KEY_BASE: "x".repeat(64),
          ORDERS_URL: ordersUrl,
        },
        "mix ecto.migrate && mix phx.server",
        [
          "-v",
          `${cacheDir("elixir", "hex")}:/root/.hex`,
          "-v",
          `${cacheDir("elixir", "mix")}:/root/.mix`,
        ],
      ),
    readyMs: 420_000,
  },
};

const CALLER = process.env.LOOM_API_CALL_CALLER ?? "node";
if (ENABLED && !(CALLER in CALLERS)) {
  throw new Error(
    `LOOM_API_CALL_CALLER=${CALLER} is not a backend with a typed in-system client (have: ${Object.keys(CALLERS).join(", ")})`,
  );
}

// `shippingSvc` calls `ordersSvc` through a `kind: api` resource bound to the
// api `ordersSvc` serves.  No address is authored anywhere in this source —
// that is the whole point of the binding.
const FIXTURE = `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
      }
      repository Orders for Order {
        // An ABSENCE union — the caller gets a miss as a VALUE, not a raise.
        find byCode(code: string): Order option
      }
    }
    context Shipping {
      aggregate Shipment with crudish {
        orderCode: string
        status: string
      }
      repository Shipments for Shipment {}
      workflow fulfil {
        create(orderId: Order id) {
          let o = orders.getOrderById(orderId)
          let s = Shipment.create({ orderCode: o.code, status: "Pending" })
        }
      }
      workflow lookup {
        create(code: string) {
          let maybe = orders.byCodeOrder(code)
          let note = match maybe { Order x => x.code, else => "MISSING" }
          let s = Shipment.create({ orderCode: note, status: "Looked" })
        }
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: api,   use: OrdersApi }
  deployable ordersSvc {
    platform: node contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: ${CALLER} contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;

const ORDERS_PORT = 3183;
const SHIPPING_PORT = 3184;
const PG_PORT = 55434;

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function waitFor(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ready = (port: number) => async (): Promise<boolean> =>
  (await fetch(`http://localhost:${port}/ready`)).ok;

describe.skipIf(!ENABLED)(`typed in-system api call (api-call-e2e, caller=${CALLER})`, () => {
  let dir: string;
  const apps: ChildProcess[] = [];
  const dockerNames: string[] = [];
  // Coordinates, not a URL: each backend spells its own DSN dialect
  // (`postgres://`, `postgresql+asyncpg://`, an ADO key-value string, a JDBC
  // URL, `ecto://`).  Handing out the parts instead of a string keeps that
  // knowledge in the one place that already has to know it — the CALLERS entry,
  // which copies it from the generated compose file.
  let pg: (db: string) => Pg;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-api-call-e2e-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    const pgOverride = process.env.LOOM_API_CALL_PG_URL;
    if (pgOverride) {
      const u = new URL(pgOverride);
      pg = (db) => ({
        host: u.hostname,
        port: Number(u.port || 5432),
        db,
        user: decodeURIComponent(u.username) || "postgres",
        password: decodeURIComponent(u.password) || "postgres",
      });
    } else {
      sh(
        `docker run -d --rm --name loom-api-call-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-api-call-pg");
      pg = (db) => ({
        host: "localhost",
        port: PG_PORT,
        db,
        user: "postgres",
        password: "postgres",
      });
      // Each deployable owns its own database — the caller must not be able to
      // read the callee's rows locally, or the round-trip assertion proves
      // nothing.
      //
      // CREATE DATABASE is itself the retried probe, not a step after a
      // `pg_isready` gate: the postgres entrypoint restarts the server once
      // after initdb, so `pg_isready` can pass against the FIRST server and the
      // create then hit the socket during the restart (see channels-e2e).
      await waitFor(
        async () => {
          try {
            sh(
              'docker exec loom-api-call-pg psql -U postgres -c "CREATE DATABASE orders_svc;" -c "CREATE DATABASE shipping_svc;"',
            );
            return true;
          } catch {
            return false;
          }
        },
        90_000,
        "postgres + per-deployable databases",
      );
    }

    // The callee is always Hono; only the caller varies.
    const callee = CALLERS.node;
    const caller = CALLERS[CALLER];
    callee.install(join(dir, "out", "orders_svc"));
    caller.install(join(dir, "out", "shipping_svc"));

    const boot = (app: string, spec: BootSpec): void => {
      // Detached process group: the tsx / uv wrappers spawn the server as a
      // grandchild, so teardown has to kill the whole tree or an orphan squats
      // the port across runs (same reason as channels-e2e).  For a dockerised
      // leg the child is only the `docker run` CLIENT — killing it leaves the
      // container running, which is why `spec.container` joins `dockerNames`.
      if (spec.container) dockerNames.push(spec.container);
      const child = spawn(spec.bin, [...spec.args], {
        cwd: join(dir, "out", app),
        detached: true,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const log = join(dir, `${app}.log`);
      const sink = (d: Buffer): void => appendFileSync(log, d);
      child.stdout?.on("data", sink);
      child.stderr?.on("data", sink);
      apps.push(child);
    };

    // The one seam compose writes.  Named through the same derivation the
    // emitted client reads, so a rename of either half breaks HERE.
    const ordersUrl = `http://localhost:${ORDERS_PORT}`;
    boot(
      "orders_svc",
      callee.boot(join(dir, "out", "orders_svc"), ORDERS_PORT, pg("orders_svc"), ordersUrl),
    );
    boot(
      "shipping_svc",
      caller.boot(join(dir, "out", "shipping_svc"), SHIPPING_PORT, pg("shipping_svc"), ordersUrl),
    );
    await waitFor(ready(ORDERS_PORT), 60_000, "ordersSvc /ready");
    await waitFor(ready(SHIPPING_PORT), caller.readyMs, `shippingSvc (${CALLER}) /ready`);
  }, 600_000);

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

  const tail = (app: string): string => {
    try {
      return readFileSync(join(dir, `${app}.log`), "utf8")
        .split("\n")
        .slice(-40)
        .join("\n");
    } catch {
      return "(no log)";
    }
  };

  // `findAll` answers with the paged envelope (`{ items, page, total, … }`),
  // not a bare array.  Reading `.items` explicitly matters: the first cut of
  // this file treated the body as an array, and the LENGTH comparison in the
  // 404 test then passed vacuously (`undefined === undefined`) — a green
  // assertion that proved nothing.  Asserting the envelope shape first keeps
  // the failure loud if the wire contract ever changes.
  const shipments = async (): Promise<{ orderCode: string; status: string }[]> => {
    const res = await fetch(`http://localhost:${SHIPPING_PORT}/api/shipments`);
    expect(res.ok, `list failed:\n${tail("shipping_svc")}`).toBe(true);
    const body = (await res.json()) as { items?: { orderCode: string; status: string }[] };
    expect(
      Array.isArray(body.items),
      `expected a paged envelope, got ${JSON.stringify(body)}`,
    ).toBe(true);
    return body.items ?? [];
  };

  it("reaches the callee over HTTP and persists a value only it could supply", async () => {
    // A code the CALLER's database never sees — it is POSTed to the callee
    // only, so the caller can learn it exclusively through the typed call.
    const code = `ORD-${Date.now()}`;
    const created = await fetch(`http://localhost:${ORDERS_PORT}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, status: "Draft" }),
    });
    expect(created.status, `create failed:\n${tail("orders_svc")}`).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(id).toBeTruthy();

    // Drive the caller's workflow, which issues the typed in-system call.
    const ran = await fetch(`http://localhost:${SHIPPING_PORT}/api/workflows/fulfil`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: id }),
    });
    expect(ran.ok, `workflow failed:\n${tail("shipping_svc")}`).toBe(true);

    // The round-trip proof: the caller's own row carries the callee's data.
    const rows = await shipments();
    const match = rows.find((s) => s.orderCode === code);
    expect(
      match,
      `no shipment carried the callee's code ${code}:\n${JSON.stringify(rows)}\n${tail("shipping_svc")}`,
    ).toBeDefined();
    expect(match?.status).toBe("Pending");
  }, 120_000);

  it("binds a callee 404 as a VALUE when the callee declares an absence union", async () => {
    // The counterpart to the test below.  `getOrderById` declares `Order` with
    // 404 among its error statuses, so a miss RAISES.  `byCode` declares
    // `Order option`, so a miss is a value the caller matches on — and the two
    // live in the same generated client, against the same callee.
    //
    // This is the half no compile gate can see: a client that types the union
    // correctly but still throws on 404 passes tsc / mypy / dotnet / gradle /
    // mix, and only a booted 404 tells them apart.
    const missing = `NOPE-${Date.now()}`;
    const ran = await fetch(`http://localhost:${SHIPPING_PORT}/api/workflows/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: missing }),
    });
    expect(ran.ok, `absence must not fail the workflow:\n${tail("shipping_svc")}`).toBe(true);

    // The `else` arm ran: the row exists and carries the arm's literal, which
    // proves the call RETURNED rather than threw.
    const rows = await shipments();
    expect(
      rows.some((s) => s.orderCode === "MISSING" && s.status === "Looked"),
      `no shipment carried the absence arm:\n${JSON.stringify(rows)}\n${tail("shipping_svc")}`,
    ).toBe(true);
  }, 120_000);

  it("surfaces a callee 404 as a failed call rather than a silent success", async () => {
    // A well-formed but unknown id: the callee answers 404, and the client
    // must raise instead of persisting a Shipment built from an absent body.
    const before = await shipments();
    const ran = await fetch(`http://localhost:${SHIPPING_PORT}/api/workflows/fulfil`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "01860d1e-0000-7000-8000-000000000000" }),
    });
    expect(ran.ok, "a call against a missing order should not succeed").toBe(false);

    const after = await shipments();
    expect(
      after.length,
      `a failed remote call must not leave a Shipment behind:\n${tail("shipping_svc")}`,
    ).toBe(before.length);
  }, 120_000);
});
