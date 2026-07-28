// Folded-projection persistence-adapter gate (`loom.projection-persistence-unsupported`).
//
// A FOLDED (materialized) projection emits its read-model table + fold + read
// route only through each backend's DEFAULT persistence adapter (drizzle on
// node, EF Core on dotnet). The MikroORM adapter emits no projection wiring
// (a read 404s) and the .NET Dapper adapter's read controller is EF-Core-coupled
// (won't compile). The gate rejects `folded projection` + `persistence:
// mikroorm|dapper` HONESTLY at compile time instead of emitting broken code.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** A one-context system with a folded projection, over a `platform` clause that
 *  may carry a `{ persistence: … }` realization block. */
const SYS = (platformClause: string) => `
system Shop {
  subdomain Orders {
    context Orders {
      enum BoardStatus { Placed Shipped }
      aggregate Order with crudish {
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { orderRef: id }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { orderRef: Order id }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
      projection OrderBoard keyed by orderRef {
        orderRef: Order id
        status: BoardStatus
        on(e: OrderPlaced) { orderRef := e.orderRef  status := Placed }
      }
    }
  }
  api A from Orders
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platformClause}  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function errorCodes(platformClause: string): Promise<string[]> {
  const { model } = await parseString(SYS(platformClause), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

describe("folded-projection persistence-adapter gate", () => {
  it("rejects a folded projection on the node MikroORM adapter", async () => {
    expect(await errorCodes("node { persistence: mikroorm }")).toContain(
      "loom.projection-persistence-unsupported",
    );
  });

  it("rejects a folded projection on the .NET Dapper adapter", async () => {
    expect(await errorCodes("dotnet { persistence: dapper }")).toContain(
      "loom.projection-persistence-unsupported",
    );
  });

  it("allows a folded projection on the node default (drizzle) adapter", async () => {
    expect(await errorCodes("node")).not.toContain("loom.projection-persistence-unsupported");
    expect(await errorCodes("node { persistence: drizzle }")).not.toContain(
      "loom.projection-persistence-unsupported",
    );
  });

  it("allows a folded projection on the .NET default (EF Core) adapter", async () => {
    expect(await errorCodes("dotnet")).not.toContain("loom.projection-persistence-unsupported");
    expect(await errorCodes("dotnet { persistence: efcore }")).not.toContain(
      "loom.projection-persistence-unsupported",
    );
  });

  it("does not fire on the other first-class backends", async () => {
    for (const platform of ["python", "java", "elixir"]) {
      expect(await errorCodes(platform)).not.toContain("loom.projection-persistence-unsupported");
    }
  });
});
