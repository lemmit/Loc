// Seed rows may give a `datetime` field as a STRING literal
// (`createdAt: "2024-01-01T00:00:00Z"`).  The Hono and Python seed emitters
// used to pass the bare string through to the driver, which CRASHES THE BOOT
// (drizzle: `value.toISOString is not a function`; asyncpg: "expected a
// datetime.date or datetime.datetime instance") — the backend dies before it
// serves /openapi.json, failing the conformance-parity gate at the spec
// fetch.  Each backend must coerce the literal to a real datetime value
// (.NET and Java have the same coercion, pinned in their own seed tests).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const src = (platform: string, port: number): string => `
  system S {
    subdomain Core {
      context Catalog {
        aggregate Project {
          name: string
          startedAt: datetime
        }
        repository Projects for Project {}
        seed default {
          Project { name: "Alpha", startedAt: "2024-01-01T00:00:00Z" }
        }
      }
    }
    api A from Core
    deployable svc { platform: ${platform}  contexts: [Catalog]  serves: A  port: ${port} }
  }
`;

async function build(platform: string, port: number): Promise<Map<string, string>> {
  return generateSystems(await parseValid(src(platform, port))).files;
}

function find(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending ${suffix}; have:\n${[...files.keys()].join("\n")}`);
  return files.get(key)!;
}

describe("seed datetime string literals coerce to real datetime values", () => {
  it("hono: new Date(...) for a drizzle timestamp column", async () => {
    const seed = find(await build("node", 3000), "db/seed.ts");
    expect(seed).toContain('startedAt: new Date("2024-01-01T00:00:00Z")');
    expect(seed).not.toContain('startedAt: "2024-01-01T00:00:00Z"');
  });

  it("hono: db/seed.ts carries no self-run guard (the CLI entry owns direct runs)", async () => {
    // db/seed.ts is BUNDLED into dist/index.js, where any self-run guard on
    // `import.meta.url` can misfire and race the app's own migrate+seed boot
    // (the conformance-parity ECONNREFUSED on :3000).  The structure fix:
    // seed.ts only EXPORTS runSeeds; the standalone `npm run db:seed` entry
    // lives in db/seed-cli.ts, which never rides the bundle.
    const files = await build("node", 3000);
    const seed = find(files, "db/seed.ts");
    expect(seed).not.toContain("import.meta.url");
    const cli = find(files, "db/seed-cli.ts");
    expect(cli).toContain("runSeeds(db)");
  });

  it("python: datetime.fromisoformat(...) for an asyncpg timestamptz bind", async () => {
    const seed = find(await build("python", 8000), "app/db/seed.py");
    expect(seed).toContain('started_at=datetime.fromisoformat("2024-01-01T00:00:00Z")');
    expect(seed).toContain("from datetime import UTC, datetime");
  });
});
