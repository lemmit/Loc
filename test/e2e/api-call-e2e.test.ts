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
// COVERAGE, stated plainly: all five backends emit a typed client and all five
// are COMPILE-verified (tsc / mypy / dotnet /warnaserror / gradle / mix
// --warnings-as-errors).  Only `node` and `python` are RUNTIME-verified here.
// That bound is deliberate — it is the set that boots natively without a
// container — but it is a real gap, not a formality: the Phoenix client
// initially read its base URL from a `@module_attribute`, which is evaluated at
// COMPILE time and so would have baked in the localhost fallback and never seen
// compose's address.  `mix compile` was perfectly happy with it.  A dotnet /
// java / elixir leg is a row in `CALLERS` plus that backend's toolchain setup
// in the workflow — worth adding on a runner that has them.
//
// Opt-in: LOOM_API_CALL_E2E=1 (npm run test:api-call).  Needs docker (throwaway
// postgres) and network for the generated projects' dependency install; the
// python caller additionally needs `uv` on PATH.
// LOOM_API_CALL_PG_URL points at an existing postgres and skips the sidecar.

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.LOOM_API_CALL_E2E === "1";

/** How each caller backend installs and boots, plus the DSN dialect it wants.
 *  One entry per backend shipping a typed in-system client. */
const CALLERS = {
  node: {
    install: (cwd: string) => sh("npm install --silent", cwd),
    cmd: (cwd: string, _port: number) => ({
      bin: join(cwd, "node_modules/.bin/tsx"),
      args: ["index.ts"],
    }),
    driver: undefined as string | undefined,
  },
  python: {
    install: (cwd: string) => sh("uv sync --quiet", cwd),
    cmd: (_cwd: string, port: number) => ({
      bin: "uv",
      args: ["run", "uvicorn", "app.main:app", "--port", String(port)],
    }),
    driver: "asyncpg" as string | undefined,
  },
} as const;

type Caller = keyof typeof CALLERS;
const CALLER = (process.env.LOOM_API_CALL_CALLER ?? "node") as Caller;
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
      repository Orders for Order {}
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
  // SQLAlchemy wants the driver spelled in the scheme (`postgresql+asyncpg://`);
  // node's pg client wants it absent.
  let pgUrl: (db: string, driver?: string) => string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-api-call-e2e-"));
    writeFileSync(join(dir, "sys.ddd"), FIXTURE);
    sh(`node ${join(process.cwd(), "bin/cli.js")} generate system sys.ddd -o out`, dir);

    const pgOverride = process.env.LOOM_API_CALL_PG_URL;
    if (pgOverride) {
      pgUrl = (db, driver) =>
        `${(driver ? pgOverride.replace(/^postgres(ql)?:/, `postgresql+${driver}:`) : pgOverride).replace(/\/[^/]*$/, "")}/${db}`;
    } else {
      sh(
        `docker run -d --rm --name loom-api-call-pg -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:18-alpine`,
      );
      dockerNames.push("loom-api-call-pg");
      pgUrl = (db, driver) =>
        `postgres${driver ? `ql+${driver}` : ""}://postgres:postgres@localhost:${PG_PORT}/${db}`;
      await waitFor(
        async () => {
          try {
            sh("docker exec loom-api-call-pg pg_isready -U postgres");
            return true;
          } catch {
            return false;
          }
        },
        60_000,
        "postgres",
      );
      // Each deployable owns its own database — the caller must not be able to
      // read the callee's rows locally, or the assertion below proves nothing.
      for (const db of ["orders_svc", "shipping_svc"]) {
        sh(`docker exec loom-api-call-pg psql -U postgres -c "CREATE DATABASE ${db}"`);
      }
    }

    // The callee is always Hono; only the caller varies.
    const callee = CALLERS.node;
    const caller = CALLERS[CALLER];
    callee.install(join(dir, "out", "orders_svc"));
    caller.install(join(dir, "out", "shipping_svc"));

    const boot = (
      app: string,
      spec: { bin: string; args: string[] },
      env: Record<string, string>,
    ): void => {
      // Detached process group: the tsx / uv wrappers spawn the server as a
      // grandchild, so teardown has to kill the whole tree or an orphan squats
      // the port across runs (same reason as channels-e2e).
      const child = spawn(spec.bin, spec.args, {
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

    const ordersDir = join(dir, "out", "orders_svc");
    boot("orders_svc", callee.cmd(ordersDir, ORDERS_PORT), {
      DATABASE_URL: pgUrl("orders_svc", callee.driver),
      PORT: String(ORDERS_PORT),
    });
    boot("shipping_svc", caller.cmd(join(dir, "out", "shipping_svc"), SHIPPING_PORT), {
      DATABASE_URL: pgUrl("shipping_svc", caller.driver),
      PORT: String(SHIPPING_PORT),
      // The one seam compose writes.  Named through the same derivation the
      // emitted client reads, so a rename of either half breaks HERE.
      ORDERS_URL: `http://localhost:${ORDERS_PORT}`,
    });
    await waitFor(ready(ORDERS_PORT), 60_000, "ordersSvc /ready");
    await waitFor(ready(SHIPPING_PORT), 120_000, `shippingSvc (${CALLER}) /ready`);
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
