// Money / decimal inside an Ash `expr()` macro (calculations + filters) must
// render with the NATIVE operators and bare literals — Ash lowers them to the
// data layer (Postgres `numeric`).  The Elixir `Decimal.*` struct API used in
// native op-bodies (`Decimal.compare` / `Decimal.sub` / `Decimal.new`) is
// invalid inside `expr()` ("Invalid reference! Decimal.new") and fails
// `mix compile`.  Regression guard for the Ash-expr rendering target (PR #1542).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const SOURCE = `system Banking {
  subdomain Ledger {
    context Ledger {
      aggregate Account ids guid {
        balance: money
        fee: money

        // Comparison against a money literal — previously emitted
        // \`Decimal.compare(record.balance, Decimal.new("0.0")) == :lt\`.
        derived overdrawn: bool = balance < 0.0
        // Money arithmetic — previously emitted \`Decimal.sub(...)\`.
        derived net: money = balance - fee
      }
      repository Accounts for Account { }
    }
  }

  api LedgerApi from Ledger

  deployable phoenixApp {
    platform: elixir { foundation: ash }
    contexts: [Ledger]
    serves: LedgerApi
    port: 4000
  }
}
`;

async function build(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ashexpr-"));
  const file = path.join(dir, "calc.ddd");
  fs.writeFileSync(file, SOURCE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error("Validation errors:\n" + errors.map((e) => `  ${e.message}`).join("\n"));
  }
  const files = generateSystems(doc.parseResult.value as Model).files;
  return files.get("phoenix_app/lib/phoenix_app/ledger/account.ex")!;
}

describe("Ash expr() — money/decimal render natively (data-layer lowering)", () => {
  it("renders a money comparison calculation with the native operator", async () => {
    const resource = await build();
    expect(resource).toContain("calculate :overdrawn, :boolean, expr(record.balance < 0.0)");
    expect(resource).not.toMatch(/calculate :overdrawn[\s\S]*Decimal\.compare/);
  });

  it("renders a money arithmetic calculation with the native operator", async () => {
    const resource = await build();
    expect(resource).toContain("calculate :net, :decimal, expr(record.balance - record.fee)");
    expect(resource).not.toMatch(/calculate :net[\s\S]*Decimal\.(sub|add|mult|div)/);
  });

  it("does not emit Decimal.new inside any expr() (Ash rejects it)", async () => {
    const resource = await build();
    for (const line of resource.split("\n")) {
      if (line.includes("expr(")) expect(line).not.toContain("Decimal.new");
    }
  });
});
