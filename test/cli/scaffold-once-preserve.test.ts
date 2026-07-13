// `ddd generate system` preserves scaffold-once files on regen
// (docs/old/proposals/extern-domain-extension-point.md, Slice 1 — the
// regeneration-preservation mechanic slices 2–5 reuse).
//
// The Elixir `extern` impl module (`<Agg>ExternImpl`) is scaffolded ONCE, then
// owned by the user.  A `generate system` re-run must NOT clobber the user's
// hand-written implementation.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execSync(`node ${cli} ${args.join(" ")}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

const SYSTEM = `
system S {
  subdomain M {
    context C {
      aggregate Order {
        status: string
        operation confirm() extern { precondition status == "draft" }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: C, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [C], dataSources: [ordersState], port: 4000 }
}
`;

describe("generate system — scaffold-once preservation", () => {
  it("scaffolds the extern impl once, then preserves the user's edit on regen", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-scaffold-once-"));
    const dddPath = path.join(tmp, "main.ddd");
    fs.writeFileSync(dddPath, SYSTEM);
    const out = path.join(tmp, "out");
    const implPath = path.join(out, "api/lib/api/c/order_extern_impl.ex");

    // First generate — the impl is scaffolded (a raising stub).
    expect(runCli(["generate", "system", dddPath, "-o", out]).status).toBe(0);
    expect(fs.existsSync(implPath)).toBe(true);
    expect(fs.readFileSync(implPath, "utf8")).toContain("raise");

    // The user fills it in.
    const userImpl = `# loom:scaffold-once
defmodule Api.C.OrderExternImpl do
  @behaviour Api.C.OrderExtern
  @impl true
  def confirm(%Api.C.Order{} = record, _params) do
    {:ok, %{record | status: "confirmed"}}
  end
end
`;
    fs.writeFileSync(implPath, userImpl);

    // Regenerate — the user's impl must survive untouched, and the run reports it.
    const regen = runCli(["generate", "system", dddPath, "-o", out]);
    expect(regen.status).toBe(0);
    expect(regen.stdout).toContain("preserved (scaffold-once)");
    expect(fs.readFileSync(implPath, "utf8")).toBe(userImpl);
  });
});
