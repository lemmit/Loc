import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// E2E smoke: generate the acme system, `docker compose build && up`, poll
// /health on every deployable, then `down`.
//
// Slow (~1-2 min depending on network).  Opt-in: only runs when
// `LOOM_E2E=1` is set in the environment.  `npm run test:e2e` sets it for
// you.
//
// In sandboxed environments where outbound HTTPS goes through a TLS-
// intercepting proxy, set `LOOM_E2E_CA_DIR=<dir-with-*.crt>` to inject
// the proxy CA into each Dockerfile before building.  In a normal
// environment this is unnecessary — the generated Dockerfiles work
// as-is.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const example = path.join(repoRoot, "examples", "acme.ddd");

const ENABLED = process.env.LOOM_E2E === "1";

function hasDocker(): boolean {
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN = ENABLED && hasDocker();

describe.skipIf(!RUN)("e2e: docker compose smoke", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-"));
    execSync(`node ${cli} generate system ${example} -o ${outDir}`, {
      stdio: "inherit",
    });
    injectProxyCAsIfPresent(outDir);
  }, 60_000);

  afterAll(() => {
    try {
      execSync(`docker compose -f ${outDir}/docker-compose.yml down -v`, {
        stdio: "inherit",
      });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 60_000);

  it("builds every deployable, brings up the system, and serves /health", async () => {
    execSync(`docker compose -f ${outDir}/docker-compose.yml build`, {
      stdio: "inherit",
      timeout: 600_000,
    });
    execSync(`docker compose -f ${outDir}/docker-compose.yml up -d`, {
      stdio: "inherit",
      timeout: 120_000,
    });

    // Hono boots in sub-second; .NET ASP.NET Core takes a few
    // seconds (cold restore + EnsureCreated).  When two .NET
    // services share one postgres they race for connections, so
    // we give each a generous window.
    await pollHealthy("http://localhost:3000/health", 60_000);
    await pollHealthy("http://localhost:8080/health", 120_000);
    await pollHealthy("http://localhost:8081/health", 120_000);
  }, 900_000);

  it("generated DSL-level e2e suite runs against the live system", async () => {
    const e2eDir = path.join(outDir, "e2e");
    if (!fs.existsSync(e2eDir)) {
      // System has no `test e2e` blocks — nothing to verify.
      return;
    }
    // Install vitest in the e2e folder, run the generated suite.
    execSync(`npm install --silent --no-audit --no-fund`, {
      cwd: e2eDir,
      stdio: "inherit",
      timeout: 180_000,
    });
    execSync(`npx vitest run`, {
      cwd: e2eDir,
      stdio: "inherit",
      timeout: 120_000,
    });
  }, 600_000);

  it("generated Playwright UI suite runs against the live web_app", async () => {
    // Find any react deployable that ships a Playwright e2e suite.
    // The smoke spec is always present; a UI spec is only there
    // when the system declared `test e2e ... against <react>` blocks.
    const reactDirs = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(outDir, d.name))
      .filter((p) => fs.existsSync(path.join(p, "e2e", "playwright.config.ts")));
    if (reactDirs.length === 0) {
      // No react deployable in this system.
      return;
    }
    for (const dir of reactDirs) {
      const e2eDir = path.join(dir, "e2e");
      // The frontend's e2e/ has its own package.json with
      // @playwright/test as a dev dep — keeping it out of the
      // runtime image.  Install it here.
      execSync(`npm install --silent --no-audit --no-fund`, {
        cwd: e2eDir,
        stdio: "inherit",
        timeout: 180_000,
      });
      // Browser binaries — `playwright install --with-deps` would
      // also pull system packages, but the proxy CA setup in this
      // sandbox already covers them.  PLAYWRIGHT_BROWSERS_PATH
      // points at a per-host shared cache so repeat runs skip the
      // 100 MB download.
      const env = {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers",
      };
      execSync(`npx playwright install chromium`, {
        cwd: e2eDir,
        stdio: "inherit",
        env,
        timeout: 300_000,
      });
      execSync(`npx playwright test`, {
        cwd: e2eDir,
        stdio: "inherit",
        env,
        timeout: 300_000,
      });
    }
  }, 900_000);

  it("cross-check: .NET (Swashbuckle) and Hono (zod-openapi) emit the same set of (method, path) for the same modules", async () => {
    // Both deployables host the Catalog module — Swashbuckle on
    // .NET (8081) and @hono/zod-openapi on Hono (3000).  If the
    // generators drift, the (method, path) sets will diverge.
    const dotnetSpec = await fetchSpec("http://localhost:8081/swagger/v1/swagger.json");
    const honoSpec = await fetchSpec("http://localhost:3000/openapi.json");

    const dotnetOps = collectOps(dotnetSpec);
    const honoOps = collectOps(honoSpec);

    const onlyDotnet = [...dotnetOps].filter((o) => !honoOps.has(o)).sort();
    const onlyHono = [...honoOps].filter((o) => !dotnetOps.has(o)).sort();

    if (onlyDotnet.length > 0 || onlyHono.length > 0) {
      console.error("Cross-check diff:");
      console.error("  only on .NET :", onlyDotnet);
      console.error("  only on Hono :", onlyHono);
    }
    expect(onlyDotnet, "operations only on .NET").toEqual([]);
    expect(onlyHono, "operations only on Hono").toEqual([]);
    // Sanity: each spec should have at least one operation.
    expect(dotnetOps.size).toBeGreaterThan(0);
    expect(honoOps.size).toBeGreaterThan(0);
  }, 120_000);

  it("cross-check: response component schemas have the same field set across backends", async () => {
    // Both backends serialize the Product wire-shape: ProductResponse
    // (id, sku, price.amount, price.currency).  If the generators
    // drift on field names or shapes, this diff fires.
    const dotnetSpec = await fetchSpec("http://localhost:8081/swagger/v1/swagger.json");
    const honoSpec = await fetchSpec("http://localhost:3000/openapi.json");

    // Schemas worth comparing — both backends declare these.
    const sharedSchemas = ["ProductResponse"];

    for (const name of sharedSchemas) {
      const d = fieldSet(dotnetSpec, name);
      const h = fieldSet(honoSpec, name);
      const onlyD = [...d].filter((f) => !h.has(f)).sort();
      const onlyH = [...h].filter((f) => !d.has(f)).sort();
      if (onlyD.length > 0 || onlyH.length > 0) {
        console.error(`Shape diff for ${name}:`);
        console.error("  only on .NET :", onlyD);
        console.error("  only on Hono :", onlyH);
      }
      expect(onlyD, `${name} fields only on .NET`).toEqual([]);
      expect(onlyH, `${name} fields only on Hono`).toEqual([]);
      expect(d.size, `${name} field set should be non-empty`).toBeGreaterThan(0);
    }
  }, 120_000);

  it("cross-check: response cardinality (array vs single vs nullable) matches per shared route", async () => {
    // Catches the kind of drift where both backends declare the same
    // `GET /products/by_sku` route but disagree on whether the
    // response is `ProductResponse` or `ProductResponse[]`.
    // Originally found by the audit: .NET emitted
    // `IReadOnlyList<ProductResponse>` for finds that returned
    // `Product?`.  Fixed in api.tpl.ts; this test guards the fix.
    const dotnetSpec = await fetchSpec("http://localhost:8081/swagger/v1/swagger.json");
    const honoSpec = await fetchSpec("http://localhost:3000/openapi.json");

    const dotnetShapes = collectResponseShapes(dotnetSpec);
    const honoShapes = collectResponseShapes(honoSpec);

    const mismatches: string[] = [];
    for (const op of dotnetShapes.keys()) {
      if (!honoShapes.has(op)) continue;
      const d = dotnetShapes.get(op)!;
      const h = honoShapes.get(op)!;
      if (d !== h) mismatches.push(`${op}: .NET=${d}, Hono=${h}`);
    }
    if (mismatches.length > 0) {
      console.error("Response-cardinality drift:");
      for (const m of mismatches) console.error("  " + m);
    }
    expect(mismatches, "response cardinality must match per route").toEqual([]);
  }, 120_000);
});

interface OpenApiPathItem {
  [method: string]: unknown;
}

interface OpenApiSchema {
  type?: string;
  properties?: Record<string, unknown>;
  items?: OpenApiSchema;
  $ref?: string;
}

interface OpenApiSpec {
  paths?: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

/**
 * Field-name set for a named component schema.  Used by the cross-
 * platform shape diff: both backends produce `<Agg>Response`, so we
 * line up `properties`'s keys.  Doesn't recurse into nested schemas
 * (`price` shows up once; the cross-check on its sub-fields runs as
 * a separate pass when needed).
 */
function fieldSet(spec: OpenApiSpec, schemaName: string): Set<string> {
  const schema = spec.components?.schemas?.[schemaName];
  if (!schema || !schema.properties) return new Set();
  return new Set(Object.keys(schema.properties));
}

async function fetchSpec(url: string): Promise<OpenApiSpec> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as OpenApiSpec;
}

/** Build a `Set<"METHOD path">` from an OpenAPI spec's `paths`. */
function collectOps(spec: OpenApiSpec): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    // Infrastructure endpoints aren't part of the public contract;
    // skip them so the diff focuses on aggregate routes.
    if (p === "/health" || p === "/openapi.json" || p.startsWith("/swagger")) {
      continue;
    }
    for (const m of Object.keys(item)) {
      const method = m.toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
        out.add(`${method} ${normalisePath(p)}`);
      }
    }
  }
  return out;
}

/** Build `Map<"METHOD path", "array" | "object" | "nullable">` from an
 * OpenAPI spec — the cardinality of each operation's 2xx response
 * body.  Used by the cross-platform cardinality check to surface
 * shape drift the field-set diff misses.
 *
 * `array`    — response wraps the schema in `type: array`.
 * `nullable` — response is the schema with `nullable: true` (Swashbuckle)
 *              or a `oneOf`/`anyOf` union with `null` (zod-openapi).
 * `object`   — single, required-present.
 *
 * Default for the unknown shape is `object` so a missing 200 response
 * doesn't false-positive. */
function collectResponseShapes(spec: OpenApiSpec): Map<string, "array" | "object" | "nullable"> {
  const out = new Map<string, "array" | "object" | "nullable">();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (p === "/health" || p === "/openapi.json" || p.startsWith("/swagger")) {
      continue;
    }
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        continue;
      }
      const op = raw as {
        responses?: Record<string, { content?: Record<string, { schema?: ResponseSchema }> }>;
      };
      const ok = op.responses?.["200"] ?? op.responses?.["201"];
      const schema = ok?.content?.["application/json"]?.schema;
      out.set(`${method} ${normalisePath(p)}`, classifyShape(schema, spec));
    }
  }
  return out;
}

type ResponseSchema = OpenApiSchema & {
  nullable?: boolean;
  oneOf?: unknown[];
  anyOf?: unknown[];
  $ref?: string;
};

/** Classify a response schema as `array` / `nullable` / `object`,
 * dereferencing `$ref` to a top-level component if present.  Hono's
 * `@hono/zod-openapi` emits the list-of-X type as a named component
 * (`ProductListResponse`); without dereferencing the spec looks like
 * `{ $ref: "#/components/schemas/ProductListResponse" }` which would
 * misclassify as `object`. */
function classifyShape(
  schema: ResponseSchema | undefined,
  spec: OpenApiSpec,
): "array" | "object" | "nullable" {
  if (!schema) return "object";
  // Resolve a single-step $ref.  Components don't transitively ref
  // each other in the generated specs (verified per backend), so one
  // hop suffices.
  let resolved: ResponseSchema = schema;
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (m) {
      const target = spec.components?.schemas?.[m[1]!];
      if (target) resolved = target as ResponseSchema;
    }
  }
  if (resolved.type === "array") return "array";
  if (
    resolved.nullable === true ||
    (resolved.oneOf?.some((x) => (x as { type?: string }).type === "null") ?? false) ||
    (resolved.anyOf?.some((x) => (x as { type?: string }).type === "null") ?? false)
  ) {
    return "nullable";
  }
  return "object";
}

/** Normalise OpenAPI path templates so `{id}` and `:id` collapse into a
 * single representation across the two emitters. */
function normalisePath(p: string): string {
  return p.replace(/\{[^}]+\}/g, "{id}").replace(/\/+$/, "") || "/";
}

async function pollHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const body = (await r.json()) as { status?: string };
        if (body.status === "ok") return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`/health never responded ok at ${url}: ${String(lastError)}`);
}

/**
 * In sandboxed environments where the docker daemon's outbound HTTPS
 * is intercepted by a TLS-rewriting proxy, the build step needs the
 * proxy CA installed inside the build context.  Each generated
 * Dockerfile already declares `COPY certs/ /usr/local/share/...` and
 * the generator emits an empty `<deployable>/certs/.gitkeep`, so we
 * just drop the proxy's `*.crt` files into every deployable's
 * `certs/` directory.  No regex rewriting, no per-platform hacks —
 * an empty `certs/` is a no-op at build time.
 *
 * Driven by `LOOM_E2E_CA_DIR=<path-with-*.crt>`.  Unset = no-op.
 */
function injectProxyCAsIfPresent(outDir: string): void {
  const caDir = process.env.LOOM_E2E_CA_DIR;
  if (!caDir || !fs.existsSync(caDir)) return;
  const crts = fs.readdirSync(caDir).filter((f) => f.endsWith(".crt"));
  if (crts.length === 0) return;

  const subdirs = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const sub of subdirs) {
    const certsDir = path.join(outDir, sub, "certs");
    if (!fs.existsSync(certsDir)) continue; // not a generated deployable
    for (const crt of crts) {
      fs.copyFileSync(path.join(caDir, crt), path.join(certsDir, crt));
    }
  }
}
