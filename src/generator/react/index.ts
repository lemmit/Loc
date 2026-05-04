import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  SystemIR,
} from "../../ir/loom-ir.js";
import { camel, snake, plural } from "../../util/naming.js";
import { buildApiModule } from "./api-builder.js";
import {
  buildDetailPage,
  buildListPage,
  buildNewPage,
} from "./pages-builder.js";
import { buildPageObjectModule } from "./page-objects-builder.js";

// ---------------------------------------------------------------------------
// React + React Query + Zod + Mantine generator.
//
// Emits a Vite-built SPA per react-platform deployable.  Pages are
// derived mechanically from each aggregate's IR:
//
//   /<plural>            list.tsx        Mantine Table from useAll<Agg>()
//   /<plural>/new        new.tsx         Mantine form for Create<Agg>Request
//   /<plural>/:id        detail.tsx      Card + nested tables (master-detail)
//                                        + one button per public operation
//
// API URLs are baked in at generation time from the target deployable's
// port (overridable via `import.meta.env.VITE_API_BASE_URL`).  The
// generated app uses `@hono/zod-openapi`-style Zod schemas matching the
// backend's wire shape, parsed at the boundary so response types are
// validated, not just trusted.
// ---------------------------------------------------------------------------

export function generateReactForContexts(
  contexts: BoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const apiBaseUrl = `http://localhost:${target?.port ?? 8080}`;

  // Per-aggregate api modules + pages.
  const aggregates: Array<{ agg: AggregateIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }

  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/api/${camel(agg.name)}.ts`, buildApiModule(agg, repo, ctx));
    out.set(`src/pages/${snake(plural(agg.name))}/list.tsx`, buildListPage(agg));
    out.set(`src/pages/${snake(plural(agg.name))}/new.tsx`, buildNewPage(agg, ctx));
    out.set(
      `src/pages/${snake(plural(agg.name))}/detail.tsx`,
      buildDetailPage(agg, ctx),
    );
    out.set(
      `e2e/pages/${camel(agg.name)}.ts`,
      buildPageObjectModule(agg, ctx),
    );
  }

  out.set("e2e/smoke.spec.ts", smokeSpec(aggregates.map((a) => a.agg)));
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  out.set("src/api/client.ts", CLIENT_TS);
  out.set("src/api/config.ts", configTs(apiBaseUrl));
  out.set("src/main.tsx", MAIN_TSX);
  out.set("src/App.tsx", appTsx(aggregates.map((a) => a.agg)));
  out.set("src/pages/home.tsx", homeTsx(aggregates.map((a) => a.agg)));

  out.set("package.json", PACKAGE_JSON);
  out.set("tsconfig.json", TSCONFIG_JSON);
  out.set("tsconfig.node.json", TSCONFIG_NODE_JSON);
  out.set("vite.config.ts", VITE_CONFIG_TS);
  out.set("index.html", INDEX_HTML);
  out.set("Dockerfile", DOCKERFILE_REACT);
  out.set(".dockerignore", DOCKERIGNORE_REACT);
  out.set("certs/.gitkeep", "");

  return out;
}

// ---------------------------------------------------------------------------
// Project-shell constants
// ---------------------------------------------------------------------------

const PACKAGE_JSON =
  JSON.stringify(
    {
      name: "loom-react-app",
      version: "0.0.0",
      type: "module",
      private: true,
      scripts: {
        dev: "vite",
        build: "vite build",
        preview: "vite preview --host 0.0.0.0 --port 3000",
      },
      dependencies: {
        react: "^18.3.0",
        "react-dom": "^18.3.0",
        "react-router-dom": "^6.27.0",
        "@tanstack/react-query": "^5.59.0",
        "@mantine/core": "^7.13.0",
        "@mantine/hooks": "^7.13.0",
        "@mantine/form": "^7.13.0",
        "@mantine/notifications": "^7.13.0",
        "@mantine/dates": "^7.13.0",
        "@mantine/modals": "^7.13.0",
        "mantine-form-zod-resolver": "^1.1.0",
        zod: "^3.23.0",
        dayjs: "^1.11.0",
      },
      devDependencies: {
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        "@vitejs/plugin-react": "^4.3.0",
        typescript: "^5.7.0",
        vite: "^5.4.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "Bundler",
        allowImportingTsExtensions: false,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        noFallthroughCasesInSwitch: true,
      },
      include: ["src"],
      references: [{ path: "./tsconfig.node.json" }],
    },
    null,
    2,
  ) + "\n";

const TSCONFIG_NODE_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        composite: true,
        skipLibCheck: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        allowSyntheticDefaultImports: true,
        strict: true,
      },
      include: ["vite.config.ts"],
    },
    null,
    2,
  ) + "\n";

const VITE_CONFIG_TS = `// Auto-generated.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, host: true },
  preview: { port: 3000, host: true },
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Loom-generated app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const MAIN_TSX = `// Auto-generated.
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/dates/styles.css";
import App from "./App.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ModalsProvider>
          <Notifications position="top-right" />
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
`;

function configTs(apiBaseUrl: string): string {
  return `// Auto-generated.
// Browser hits localhost:<api_port> directly; baked at generation time
// from the target deployable's port.  Override at build time via
// VITE_API_BASE_URL for non-docker-compose deployments.
const fromEnv = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL;
export const API_BASE_URL: string = fromEnv ?? "${apiBaseUrl}";
`;
}

const CLIENT_TS = `// Auto-generated.
import { API_BASE_URL } from "./config.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function rawFetch(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(\`\${API_BASE_URL}\${path}\`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : r.statusText;
    throw new ApiError(r.status, message);
  }
  return body;
}

export const api = {
  get: (path: string) => rawFetch(path, { method: "GET" }),
  post: (path: string, body: unknown) =>
    rawFetch(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
};
`;

function appTsx(aggregates: AggregateIR[]): string {
  const imports: string[] = [];
  const routes: string[] = [`        <Route path="/" element={<Home />} />`];
  imports.push(`import Home from "./pages/home.js";`);
  for (const agg of aggregates) {
    const slug = snake(plural(agg.name));
    const cap = upper(agg.name);
    imports.push(`import ${cap}List from "./pages/${slug}/list.js";`);
    imports.push(`import ${cap}New from "./pages/${slug}/new.js";`);
    imports.push(`import ${cap}Detail from "./pages/${slug}/detail.js";`);
    routes.push(
      `        <Route path="/${slug}" element={<${cap}List />} />`,
    );
    routes.push(
      `        <Route path="/${slug}/new" element={<${cap}New />} />`,
    );
    routes.push(
      `        <Route path="/${slug}/:id" element={<${cap}Detail />} />`,
    );
  }
  return `// Auto-generated.
import { Routes, Route, Link } from "react-router-dom";
import { AppShell, Group, Title, Anchor } from "@mantine/core";
${imports.join("\n")}

export default function App(): JSX.Element {
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={4}>Loom</Title>
          <Group>
${aggregates
  .map(
    (a) =>
      `            <Anchor component={Link} to="/${snake(plural(a.name))}">${plural(a.name)}</Anchor>`,
  )
  .join("\n")}
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Routes>
${routes.join("\n")}
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
`;
}

function smokeSpec(aggregates: AggregateIR[]): string {
  // Auto-generated minimal Playwright smoke: every aggregate's list
  // page loads.  Users add per-aggregate scenarios using the page
  // objects under e2e/pages/.
  const imports = aggregates
    .map(
      (a) =>
        `import { ${upper(a.name)}ListPage } from "./pages/${camel(a.name)}.js";`,
    )
    .join("\n");
  const cases = aggregates
    .map(
      (a) =>
        `test("${snake(plural(a.name))} list loads", async ({ page }) => {\n  const p = await new ${upper(a.name)}ListPage(page).goto();\n  await expect(p.page).toHaveURL(/${snake(plural(a.name))}$/);\n});`,
    )
    .join("\n\n");
  return `// Auto-generated smoke spec.
import { test, expect } from "@playwright/test";
${imports}

${cases}
`;
}

const PLAYWRIGHT_CONFIG_TS = `// Auto-generated.
import { defineConfig, devices } from "@playwright/test";

// Tests target a running web_app — typically the docker-compose
// service on port 3001.  Override via E2E_BASE_URL.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\\.spec\\.ts$/,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
`;

// The Playwright suite has its own package.json so the runtime image
// builds fast (no @playwright/test in the production install).  Run
// it from inside ./e2e with `npm install && npx playwright test`.
const E2E_PACKAGE_JSON =
  JSON.stringify(
    {
      name: "loom-react-app-e2e",
      version: "0.0.0",
      type: "module",
      private: true,
      scripts: {
        test: "playwright test",
        "test:install": "playwright install --with-deps chromium",
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        "@types/node": "^22.0.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

const E2E_TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["**/*.ts", "../src/api/**/*.ts"],
    },
    null,
    2,
  ) + "\n";

function homeTsx(aggregates: AggregateIR[]): string {
  return `// Auto-generated.
import { Stack, Title, Text, Anchor, Card } from "@mantine/core";
import { Link } from "react-router-dom";

export default function Home(): JSX.Element {
  return (
    <Stack>
      <Title order={2}>Welcome</Title>
      <Text c="dimmed">Pick an aggregate to manage:</Text>
${aggregates
  .map(
    (a) => `      <Card withBorder>
        <Anchor component={Link} to="/${snake(plural(a.name))}">${plural(a.name)}</Anchor>
      </Card>`,
  )
  .join("\n")}
    </Stack>
  );
}
`;
}

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

const DOCKERFILE_REACT = `# syntax=docker/dockerfile:1
# Auto-generated.

FROM node:22-alpine AS build
WORKDIR /app
# Optional proxy CAs — drop *.crt files into ./certs/ to make npm
# trust them.  The directory always exists (with a .gitkeep), so
# this COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN cat /usr/local/share/ca-certificates/*.crt 2>/dev/null >> /etc/ssl/cert.pem || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem NPM_CONFIG_CAFILE=/etc/ssl/cert.pem
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vite.config.ts ./vite.config.ts
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"]
`;

const DOCKERIGNORE_REACT = `# Auto-generated.
node_modules
dist
e2e
playwright-report
test-results
.git
.env
.env.*
*.log
`;
