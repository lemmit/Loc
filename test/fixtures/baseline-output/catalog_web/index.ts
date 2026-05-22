// Auto-generated.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { serve } from "@hono/node-server";
import * as schema from "./db/schema";
import { createApp } from "./http/index";
import { baseLogger } from "./obs/log";

// Fail fast on a missing DATABASE_URL.  Without this an unset value
// surfaces as a confusing pg connection refusal mid-request; we'd
// rather die at boot with a clear pointer to the env var.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required.  Set it in the environment " +
      "(e.g. postgres://user:pass@host:5432/db).",
  );
}

const port = Number(process.env.PORT ?? 3000);
baseLogger.info({ event: "server_starting", port, env: process.env.NODE_ENV ?? "development" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
const app = createApp(db);
const server = serve({ fetch: app.fetch, port });
baseLogger.info({ event: "server_listening", port });

// Graceful shutdown — close the HTTP server (stops accepting,
// drains in-flight), then close the pg pool.  Without this SIGTERM
// drops in-flight work and leaves pg connections lingering.  Both
// SIGTERM (orchestrator) and SIGINT (Ctrl-C) are handled.
async function shutdown(signal: string): Promise<void> {
  baseLogger.info({ event: "server_shutdown", signal });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  baseLogger.info({ event: "server_drained" });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
