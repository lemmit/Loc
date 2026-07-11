import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CLI gate for the destructive-change policy (A8.3 / audit finding 19).  A
// re-generate that would ADD a required (NOT NULL, no default) column to a
// table that already exists in the previous snapshot must abort — unless the
// operator passes --allow-destructive, which emits the safe
// add-nullable / backfill-TODO / SET NOT NULL sequence instead.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${cli} ${args.join(" ")}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

const V1 = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { total: int }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
}
`;

// V2 adds a required (NOT NULL) column to the already-migrated `orders` table.
const V2 = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { total: int  status: string }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
}
`;

describe("generate system — destructive-change gate", () => {
  it("aborts a NOT-NULL-add delta without --allow-destructive, then applies it with the flag", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-destructive-"));
    const dddPath = path.join(tmp, "main.ddd");
    const out = path.join(tmp, "out");

    // 1) Initial generate — writes the baseline snapshot.
    fs.writeFileSync(dddPath, V1);
    const first = runCli(["generate", "system", dddPath, "-o", out]);
    expect(first.status).toBe(0);
    expect(fs.existsSync(path.join(out, ".loom", "snapshots", "Sales.snapshot.json"))).toBe(true);

    // 2) Re-generate with the required column added → destructive abort.
    fs.writeFileSync(dddPath, V2);
    const blocked = runCli(["generate", "system", dddPath, "-o", out]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/destructive/i);
    expect(blocked.stderr).toMatch(/status/);

    // 3) Re-generate with --allow-destructive → succeeds, and the delta
    //    migration uses the safe add-nullable / backfill / SET NOT NULL path.
    const allowed = runCli(["generate", "system", dddPath, "-o", out, "--allow-destructive"]);
    expect(allowed.status).toBe(0);
    const migDir = path.join(out, "api", "db", "migrations");
    const delta = fs
      .readdirSync(migDir)
      .filter((f) => f.endsWith(".sql") && !f.includes("Initial"))
      .map((f) => fs.readFileSync(path.join(migDir, f), "utf8"))
      .join("\n");
    // The context defaults to its own `orders` Postgres schema, so the
    // relation is schema-qualified `orders.orders`.
    expect(delta).toMatch(/ADD COLUMN "status" TEXT NULL/);
    expect(delta).toMatch(/-- TODO backfill orders\.orders\.status/);
    expect(delta).toMatch(/ALTER COLUMN "status" SET NOT NULL/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
