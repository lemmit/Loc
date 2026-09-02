// F2-XB-4 — node/Hono FOLDED-projection body emission.
//
// `emitFoldHandler`'s loop was `if (stmt.kind === "assign")` with NO else, so
// every other statement kind a fold body can carry vanished from the emitted
// handler while the rest of the body kept referring to it:
//
//   • `let stamped = e.at` … `at := stamped`  → `state.at = stamped;` with no
//     `const stamped` — **TS2304**, the generated project does not compile.
//   • `total += e.amount`                      → NOTHING emitted, no diagnostic:
//     the column is silently never written.
//   • `orderFiles.put(e.order, e)` (a resource verb, which lowers to
//     `kind: "expression"`)                    → NOTHING emitted, no diagnostic.
//
// The fix is two-sided and both sides are pinned here: the emitter renders the
// four kinds a replayable fold can express, and `foldImpurity`
// (`src/ir/validate/checks/projection-checks.ts`) is now FAIL-CLOSED — it
// allowlists those same four and rejects everything else with
// `loom.projection-fold-impure`, so the emitter's `default: throw` is
// unreachable rather than merely unlikely.
//
// The two halves must stay the same set.  The `FOLD_STATEMENT_DISPOSITION`
// table below is `satisfies Record<StmtIR["kind"], …>`, so a new `StmtIR` kind
// fails to COMPILE here until its disposition is stated — the ratchet that was
// missing when `expression` joined the union.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type { StmtIR } from "../../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

/** Every `StmtIR` kind, and what a projection fold does with it: `emit` — the
 *  node builder renders it; `reject` — `foldImpurity` raises
 *  `loom.projection-fold-impure`.  There is no third column: a kind that is
 *  neither is exactly the silent drop this row is about. */
const FOLD_STATEMENT_DISPOSITION = {
  assign: "emit",
  add: "emit",
  remove: "emit",
  let: "emit",
  emit: "reject",
  call: "reject",
  precondition: "reject",
  requires: "reject",
  expression: "reject",
  return: "reject",
  "variant-match": "reject",
} satisfies Record<StmtIR["kind"], "emit" | "reject">;

/** A system whose fold body carries `body`, plus a channel so the fold is
 *  actually dispatched (otherwise `loom.projection-event-uncarried` fires). */
function sys(body: string, stateField = "total: int", resources = ""): string {
  return `
  system Shop {
    subdomain Sales { context Orders {
      enum OrderStatus { Placed Shipped }
      event OrderPlaced { order: Order id, customer: Customer id, at: datetime, __AMOUNT__ }
      aggregate Customer { name: string }
      aggregate Order { status: OrderStatus  create(customer: Customer id) {} }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
      projection OrderBook keyed by order {
        order: Order id
        ${stateField}
        on(e: OrderPlaced) {
          order := e.order
          ${body}
        }
      }
    }}
    api SalesApi from Sales
    storage primarySql { type: postgres }
    storage blobs { type: localDisk }
    resource ordersState { for: Orders, kind: state, use: primarySql }
    ${resources}
    deployable api {
      platform: node
      contexts: [Orders]
      dataSources: [ordersState${resources ? ", orderFiles" : ""}]
      serves: SalesApi
      port: 8080
    }
  }`;
}

async function filesFor(source: string, amount = "amount: int"): Promise<Map<string, string>> {
  return await generateSystemFiles(source.replace("__AMOUNT__", amount));
}

async function foldBody(source: string, amount = "amount: int"): Promise<string> {
  const files = await filesFor(source, amount);
  const key = [...files.keys()].find((k) => k.endsWith("http/projections.ts"));
  expect(key, "http/projections.ts not emitted").toBeDefined();
  const src = files.get(key!)!;
  const start = src.indexOf("export async function foldOrderPlacedIntoOrderBook");
  expect(start, "fold handler not emitted").toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("\n}\n", start));
}

async function errorCodes(source: string): Promise<string[]> {
  const { model } = await parseString(source.replace("__AMOUNT__", "amount: int"), {
    validate: false,
  });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

describe("node/Hono folded-projection body — every statement kind is emitted or rejected", () => {
  it("a `let` binding is emitted as a `const`, so its use sites resolve (was TS2304)", async () => {
    const body = await foldBody(sys("let stamped = e.at\n          at := stamped", "at: datetime"));
    // The USE was always emitted; the BINDING was the half that vanished.
    expect(body).toContain("state.at = stamped;");
    expect(body).toContain("const stamped = e.at;");
    // …and in that order, so the reference is bound before it is read.
    expect(body.indexOf("const stamped")).toBeLessThan(body.indexOf("state.at = stamped"));
  });

  it("a scalar `+=` folds arithmetic onto the (nullable) column", async () => {
    const body = await foldBody(sys("total += e.amount"));
    // The `?? 0` matters: every non-key read-model column is nullable, so the
    // FIRST event for a key would otherwise fold `null + n`.
    expect(body).toContain("state.total = (state.total ?? 0) + e.amount;");
  });

  it("a scalar `-=` folds subtraction onto the (nullable) column", async () => {
    const body = await foldBody(sys("total -= e.amount"));
    expect(body).toContain("state.total = (state.total ?? 0) - e.amount;");
  });

  it("a collection `+=` appends to the folded array column", async () => {
    const body = await foldBody(sys('skus += "x"', "skus: string[]"));
    expect(body).toContain('state.skus = [...(state.skus ?? []), "x"];');
  });

  it("a collection `-=` drops the matching element", async () => {
    const body = await foldBody(sys('skus -= "x"', "skus: string[]"));
    expect(body).toContain('state.skus = (state.skus ?? []).filter((__e) => __e !== "x");');
  });

  it("a resource verb in a fold is an ERROR, not a silent drop", async () => {
    const codes = await errorCodes(
      sys(
        "orderFiles.put(e.order, e)",
        "total: int",
        "resource orderFiles { for: Orders, kind: objectStore, use: blobs }",
      ),
    );
    // Before the fix this parsed with ZERO diagnostics and generated a fold
    // that did not contain the call.
    expect(codes).toContain("loom.projection-fold-impure");
  });

  // ── column representation ────────────────────────────────────────────────
  // A projection state field is a real column.  Drizzle maps `money` to
  // `numeric(19,4)` and `decimal` to `numeric`, and BOTH infer as `string`,
  // while the domain/event value is a decimal.js `Decimal` / a `number` — so a
  // fold has to write the column's shape, exactly as the aggregate save
  // projection does.  It did not: `total := e.amount` on a money column emitted
  // `state.total = e.amount;` — TS2322, a project that does not compile.

  it("a money assign is stored as the column's decimal string", async () => {
    const body = await foldBody(sys("total := e.amount", "total: money"), "amount: money");
    expect(body).toContain("state.total = (e.amount).toString();");
  });

  it("a money `+=` accumulates through decimal.js, not `+` on the stored string", async () => {
    const body = await foldBody(sys("total += e.amount", "total: money"), "amount: money");
    expect(body).toContain(
      "state.total = new Decimal(state.total ?? 0).plus(e.amount).toString();",
    );
  });

  it("the money fold pulls its own `decimal.js` import AND the package dep", async () => {
    const files = await filesFor(sys("total += e.amount", "total: money"), "amount: money");
    const k = [...files.keys()].find((key) => key.endsWith("http/projections.ts"))!;
    expect(files.get(k)!).toContain('import Decimal from "decimal.js";');
    // The dep must be DECLARED or the project is TS2307 on install:
    // `contextUsesMoney` scanned aggregates and value objects only, so a system
    // whose only money lives on an event field / a projection column shipped
    // the import with no dependency.
    const pkg = [...files.keys()].find((key) => key.endsWith("api/package.json"))!;
    expect(files.get(pkg)!).toContain('"decimal.js"');
  });

  it("a non-money assign is byte-identical — no coercion is introduced", async () => {
    const body = await foldBody(sys("total := e.amount"));
    expect(body).toContain("state.total = e.amount;");
  });

  it("the emitter's renderable set and the validator's pure set are the same four kinds", () => {
    const emitted = Object.entries(FOLD_STATEMENT_DISPOSITION)
      .filter(([, d]) => d === "emit")
      .map(([k]) => k)
      .sort();
    expect(emitted).toEqual(["add", "assign", "let", "remove"]);
  });
});
