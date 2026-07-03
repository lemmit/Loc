import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// C8 — backends no longer emit a blanket wildcard CORS.  They read a
// `CORS_ORIGIN` allowlist (the compose stack pins it to the frontend origins
// the topology declares) and fall back to permissive `*` ONLY for an auth-less
// system; an auth-bearing one denies cross-origin by default (session cookie +
// `*` is unsafe).

const backend = (platform: string, auth: boolean) => `
system Shop {
  ${auth ? "user { id: string\n    role: string\n    permissions: string[] }" : ""}
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
      }
      repository Orders for Order {}
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8000
    ${auth ? "auth: required" : ""}
  }
}
`;

// Node backend + a separate-origin React frontend (so compose has a frontend
// origin to pin, and the topology exercises the CORS wiring end to end).
const nodeWithFrontend = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order {}
    }
  }
  ui Web with scaffold(aggregates: [Order]) {
    api Sales: OrdersApi
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8080
  }
  deployable web {
    platform: react
    targets: api
    ui: Web { Sales: api }
    port: 5173
  }
}
`;

async function filesFor(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function findFile(files: Map<string, string>, suffix: string): string {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no generated file ending in ${suffix}`);
}

describe("CORS origin hardening (C8)", () => {
  it("compose pins CORS_ORIGIN to the frontend origin for the backend service", async () => {
    const files = await filesFor(nodeWithFrontend);
    const compose = findFile(files, "docker-compose.yml");
    expect(compose).toContain('CORS_ORIGIN: "http://localhost:5173"');
  });

  it("hono reads CORS_ORIGIN and, without auth, allows the permissive fallback", async () => {
    const http = findFile(await filesFor(nodeWithFrontend), "http/index.ts");
    expect(http).toContain("process.env.CORS_ORIGIN");
    expect(http).toContain("const corsAllowAnyFallback = true;");
    expect(http).not.toContain('app.use("*", cors());');
  });

  it("hono denies the permissive fallback when the system requires auth", async () => {
    const http = findFile(await filesFor(backend("node", true)), "http/index.ts");
    expect(http).toContain("const corsAllowAnyFallback = false;");
  });

  it("python reads CORS_ORIGIN; fallback is ['*'] without auth, [] with auth", async () => {
    const noAuth = findFile(await filesFor(backend("python", false)), "app/main.py");
    expect(noAuth).toContain('os.environ.get("CORS_ORIGIN"');
    expect(noAuth).toContain('allow_origins=_cors_allowlist or ["*"]');
    expect(noAuth).not.toContain('allow_origins=["*"]');

    const withAuth = findFile(await filesFor(backend("python", true)), "app/main.py");
    expect(withAuth).toContain("allow_origins=_cors_allowlist or []");
  });

  it("dotnet reads CORS_ORIGIN; AllowAnyOrigin fallback only without auth", async () => {
    const noAuth = findFile(await filesFor(backend("dotnet", false)), "Program.cs");
    expect(noAuth).toContain('builder.Configuration["CORS_ORIGIN"]');
    expect(noAuth).toContain("WithOrigins(corsOrigins).AllowCredentials()");
    expect(noAuth).toContain("p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();");

    const withAuth = findFile(await filesFor(backend("dotnet", true)), "Program.cs");
    expect(withAuth).not.toContain("p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();");
    expect(withAuth).toContain("WithOrigins(corsOrigins).AllowCredentials()");
  });
});
