import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// FU2 slice 1 — server-sourced create-form defaults (`now()` / `currentUser.*`)
// via a `GET /<plural>/prepare` endpoint the create form fetches and overlays on
// its type-zero seed.  Reference vertical: Hono backend + React shadcn frontend.

const SYS = (field: string, extra = "") => `
  system S {
    ${extra}
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: node contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000${extra ? " auth: required" : ""} }
    deployable web { platform: react targets: api ui: WebApp { Sales: api } design: "shadcn@v4" port: 3001 }
    ui WebApp with scaffold(aggregates: [Order]) { api Sales: SalesApi }
  }
`;

describe("server-sourced create defaults (Hono + React shadcn)", () => {
  it("emits a GET /prepare route returning the now() default", async () => {
    const files = await generateSystemFiles(SYS("createdAt: datetime = now()"));
    const routes = files.get("api/http/order.routes.ts") ?? findBySuffix(files, "order.routes.ts");
    expect(routes).toMatch(/path: "\/prepare"/);
    expect(routes).toMatch(/operationId: "prepareOrder"/);
    expect(routes).toMatch(
      /PrepareOrderResponse = z\.object\(\{ createdAt: [^}]*\}\)\.partial\(\)/,
    );
    expect(routes).toMatch(/return c\.json\(\{ createdAt: new Date\(\)\.toISOString\(\) \}, 200\)/);
  });

  it("emits usePrepareOrder + the create form's reset overlay", async () => {
    const files = await generateSystemFiles(SYS("createdAt: datetime = now()"));
    const api = findBySuffix(files, "api/order.ts");
    expect(api).toMatch(/export function usePrepareOrder\(\)/);
    expect(api).toMatch(/api\.get\(`\/orders\/prepare`\)/);
    expect(api).toMatch(/export const PrepareOrderResponse = z\.object\(/);
    const newPage = findBySuffix(files, "orders/new.tsx");
    expect(newPage).toMatch(/const __prep = usePrepareOrder\(\)/);
    expect(newPage).toMatch(
      /useEffect\(\(\) => \{ if \(__prep\.data\) form\.reset\(\{ \.\.\..*\.\.\.__prep\.data \}, \{ keepDirtyValues: true \}\)/,
    );
  });

  it("overlays via a destructured `reset` on the non-`form.` React packs", async () => {
    // mantine/mui/chakra destructure `useForm` — the overlay adds `reset` to the
    // destructure (only when needed) and calls it, rather than `form.reset`.
    const files = await generateSystemFiles(
      SYS("createdAt: datetime = now()").replace('design: "shadcn@v4"', 'design: "mantine@v9"'),
    );
    const newPage = findBySuffix(files, "orders/new.tsx");
    expect(newPage).toMatch(/\{ register, handleSubmit, setError, reset,/);
    expect(newPage).toMatch(/if \(__prep\.data\) reset\(\{ \.\.\..*\.\.\.__prep\.data \}/);
  });

  it("evaluates currentUser.* server-side against the ambient principal", async () => {
    const files = await generateSystemFiles(
      SYS("ownerId: string = currentUser.tenantId", "user { tenantId: string }"),
    );
    const routes = findBySuffix(files, "order.routes.ts");
    expect(routes).toMatch(/const currentUser = .*get\("currentUser"\)/);
    expect(routes).toMatch(/return c\.json\(\{ ownerId: currentUser\.tenantId \}, 200\)/);
  });

  it("does NOT emit the endpoint / hook when no default is server-sourced", async () => {
    // A constant default is client-seeded — no prepare endpoint, no fetch.
    const files = await generateSystemFiles(SYS(`status: string = "draft"`));
    const routes = findBySuffix(files, "order.routes.ts");
    const api = findBySuffix(files, "api/order.ts");
    const newPage = findBySuffix(files, "orders/new.tsx");
    expect(routes).not.toMatch(/path: "\/prepare"/);
    expect(api).not.toMatch(/usePrepareOrder/);
    expect(newPage).not.toMatch(/__prep/);
  });
});

// A non-React frontend has no create-form overlay yet (the RHF `usePrepare` +
// `useEffect` hooks are React-shaped).  The Hono `/prepare` endpoint still
// emits, but the Svelte create form must degrade to the type-zero seed with a
// CLEAN import set — never a dangling `usePrepare<Agg>` / `react` import that
// its own api module and template don't provide.  (`manifest.seedsServerDefaults`
// gates the overlay so only the React packs opt in.)
const SVELTE_SYS = (field: string) => `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: node contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000 }
    deployable web { platform: svelte targets: api ui: WebApp { Sales: api } design: "flowbite@v1" port: 3001 }
    ui WebApp with scaffold(aggregates: [Order]) { api Sales: SalesApi }
  }
`;

describe("server-sourced create defaults — non-React degradation (Svelte)", () => {
  it("emits a clean Svelte create form (no dangling usePrepare / react import)", async () => {
    const files = await generateSystemFiles(SVELTE_SYS("createdAt: datetime = now()"));
    // The backend endpoint is unaffected — the server still computes the default.
    const routes = findBySuffix(files, "order.routes.ts");
    expect(routes).toMatch(/path: "\/prepare"/);
    // The Svelte create page must not reference the React-only overlay hooks.
    const newPage = findBySuffix(files, "orders/new/+page.svelte");
    expect(newPage).not.toMatch(/usePrepare/);
    expect(newPage).not.toMatch(/from "react"/);
    expect(newPage).not.toMatch(/__prep/);
  });
});

function findBySuffix(files: Map<string, string>, suffix: string): string {
  const hit = [...files.entries()].find(([k]) => k.endsWith(suffix));
  if (!hit) throw new Error(`no generated file ending in ${suffix}`);
  return hit[1];
}
